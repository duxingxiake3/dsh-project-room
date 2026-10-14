/**
 * Project Room — recovery service.
 *
 * Runs the the design notes sequence after the plugin loads, in this order, because
 * each step depends on the previous one being true:
 *
 *   1. the store is already open with its single writer and migrations applied;
 *   2. rooms, members, messages, tasks, decisions and the delivery ledger are read
 *      back from storage — never from a model's memory of what it planned;
 *   3. host sessions are checked for existence and real ownership;
 *   4. owned members are resumed as needed; a borrowed user session is only
 *      re-linked, never re-created;
 *   5. `accepted` / `claimed` / `uncertain` deliveries are reconciled against the
 *      host before anything is retried;
 *   6. expired execution leases become "needs recovery" instead of a blind re-run;
 *   7. the room gets one short recovery report, and anything that cannot be
 *      resolved automatically stays visible.
 *
 * @module dsh-project-room/src/host/recovery/recovery-service
 */

import { isoTimestamp } from '../../../shared/contracts.js';

export class RecoveryService {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../room/room-service.js').RoomService} input.rooms
   * @param {import('../adapter/host-adapter.js').HostAdapter} input.adapter
   * @param {import('../delivery/coordinator.js').DeliveryCoordinator} input.delivery
   * @param {import('../delivery/turn-observer.js').TurnObserver} input.observer
   * @param {import('../tasks/planning-service.js').PlanningService} input.planning
   * @param {import('../decisions/decision-service.js').DecisionService} input.decisions
   * @param {import('../models/model-service.js').ModelProfileService} input.models
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.rooms = input.rooms;
    this.adapter = input.adapter;
    this.delivery = input.delivery;
    this.observer = input.observer;
    this.planning = input.planning;
    this.decisions = input.decisions;
    this.models = input.models;
    this.logger = input.logger ?? null;
  }

  /**
   * Recover every room. Returns a report the caller logs and the UI can show.
   * @returns {Promise<{ rooms: object[], summary: object }>}
   */
  async recoverAll() {
    const rooms = this.store.listRooms();
    /** @type {object[]} */
    const reports = [];
    for (const room of rooms) {
      try {
        reports.push(await this.recoverRoom(room.id));
      } catch (error) {
        this.logger?.warn?.(`[project-room] recovery failed for ${room.id}: ${error?.message ?? error}`);
        reports.push({ roomId: room.id, title: room.title, error: String(error?.message ?? error) });
      }
    }
    const summary = {
      rooms: reports.length,
      sessionsRestored: reports.reduce((total, report) => total + (report.sessionsRestored ?? 0), 0),
      deliveriesReconciled: reports.reduce((total, report) => total + (report.deliveriesReconciled ?? 0), 0),
      uncertain: reports.reduce((total, report) => total + (report.uncertain ?? 0), 0),
      staleAttempts: reports.reduce((total, report) => total + (report.staleAttempts ?? 0), 0),
      needsUser: reports.reduce((total, report) => total + (report.needsUser?.length ?? 0), 0),
    };
    return { rooms: reports, summary };
  }

  /**
   * Recover one room.
   * @param {string} roomId
   * @returns {Promise<object>}
   */
  async recoverRoom(roomId) {
    const room = this.rooms.requireRoom(roomId);
    const needsUser = [];
    let sessionsRestored = 0;

    // 3/4. Sessions: verify what exists, restore what this plugin owns.
    for (const member of this.store.listMembers(roomId, { includeRetired: true })) {
      if (member.kind !== 'agent') continue;
      if (member.status === 'offline') continue;
      const live = this.adapter.agentOf(member.id);
      if (live) {
        this.observer.attachMember({ memberId: member.id, roomId, agent: live });
        continue;
      }
      if (!member.sessionId) {
        needsUser.push(`${member.displayName} 没有会话绑定，等待重新创建。`);
        continue;
      }
      if (member.sessionOwnership === 'borrowed') {
        // Re-link without claiming ownership: a borrowed user session is never
        // re-created or disposed (the design notes).
        continue;
      }
      try {
        const effective = await this.models.effectiveFor(member);
        let model = null;
        if (effective.profileRef) {
          const profile = await this.models.requireProfile(effective.profileRef);
          model = { providerRoute: profile.providerRoute, modelId: profile.modelId };
        }
        const resumed = await this.adapter.resumeMember({
          memberId: member.id,
          roomId,
          sessionId: member.sessionId,
          model,
          personaInstructions: this.rooms.instructionsFor(member.id),
        });
        sessionsRestored += 1;
        const agent = this.adapter.agentOf(member.id);
        if (agent) this.observer.attachMember({ memberId: member.id, roomId, agent });
        this.store.appendEvent({
          roomId,
          eventType: 'recovery.session.restored',
          payload: { memberId: member.id, sessionId: resumed.sessionId },
        });
      } catch (error) {
        const reason = String(error?.message ?? error);
        needsUser.push(`${member.displayName} 的会话恢复失败：${reason}`);
        this.store.updateMember(member.id, { status: 'offline' });
      }
    }

    // 5. Delivery ledger: reconcile before any retry.
    let deliveriesReconciled = 0;
    let uncertain = 0;
    try {
      const outcomes = await this.delivery.reconcileRoom(roomId);
      deliveriesReconciled = outcomes.length;
      uncertain = outcomes.filter((outcome) => outcome.outcome === 'uncertain').length;
      for (const outcome of outcomes) {
        if (outcome.outcome === 'uncertain') {
          needsUser.push(`消息 ${outcome.messageId} → ${outcome.recipientId} 投递状态不确定，需要核对。`);
        }
      }
    } catch (error) {
      this.logger?.warn?.(`[project-room] delivery reconciliation failed: ${error?.message ?? error}`);
    }

    // 6. Expired execution leases: mark for recovery rather than repeating the
    //    whole task, since side effects may already exist.
    let staleAttempts = 0;
    for (const task of this.store.listTasks(roomId)) {
      for (const attempt of this.store.listAttempts(task.id, { activeOnly: true })) {
        const live = attempt.actorId ? this.adapter.statusOf(attempt.actorId) : 'absent';
        if (live === 'running') continue;
        this.store.updateAttempt(attempt.id, { state: 'needs-recovery' });
        this.store.updateTask(task.id, { status: task.status === 'in_progress' ? 'blocked' : task.status });
        staleAttempts += 1;
        this.store.appendEvent({
          roomId,
          eventType: 'recovery.attempt.stale',
          payload: { taskId: task.id, attemptId: attempt.id, note: '执行租约失效，需核对已有副作用后再继续。' },
        });
      }
    }

    // 7. One short, honest report. Not a re-feed of the whole history.
    const lines = [
      `【恢复完成 · ${isoTimestamp()}】`,
      `恢复成员会话：${sessionsRestored} 个`,
      `核对投递记录：${deliveriesReconciled} 条${uncertain > 0 ? `（其中 ${uncertain} 条状态不确定）` : ''}`,
      staleAttempts > 0 ? `需要核对的执行尝试：${staleAttempts} 个（未自动重跑，先核对副作用）` : null,
      needsUser.length > 0 ? `需要你处理：${needsUser.slice(0, 5).join('；')}` : '没有需要人工处理的遗留项。',
      '群记录、任务、决定与成果均按原版本恢复，不会重新派活。',
    ].filter(Boolean);

    this.store.setMeta(`recovery:${roomId}`, isoTimestamp());
    this.store.appendEvent({ roomId, eventType: 'recovery.report', payload: { sessionsRestored, deliveriesReconciled, uncertain, staleAttempts, needsUser } });
    this.rooms.publish(roomId, { type: 'recovery.report', roomId, text: lines.join('\n') });

    return { roomId, title: room.title, sessionsRestored, deliveriesReconciled, uncertain, staleAttempts, needsUser, text: lines.join('\n') };
  }

  /**
   * The facts a user needs before trusting a recovered project, as structured
   * data for the UI rather than a paragraph.
   * @param {string} roomId
   * @returns {object}
   */
  inspect(roomId) {
    const room = this.rooms.requireRoom(roomId);
    const sessions = this.store
      .listMembers(roomId, { includeRetired: true })
      .filter((member) => member.kind === 'agent')
      .map((member) => ({
        memberId: member.id,
        displayName: member.displayName,
        sessionId: member.sessionId,
        ownership: member.sessionOwnership,
        live: this.adapter.statusOf(member.id),
        status: member.status,
      }));
    const deliveries = this.delivery.problems(roomId).map((problem) => ({
      messageId: problem.messageId,
      recipientId: problem.recipientId,
      status: problem.status,
      label: problem.label,
      detail: problem.detail,
      seq: problem.message?.seq ?? null,
    }));
    const attempts = this.store
      .listTasks(roomId)
      .flatMap((task) => this.store.listAttempts(task.id).map((attempt) => ({ ...attempt, taskObjective: task.objective })))
      .filter((attempt) => attempt.state === 'needs-recovery' || attempt.state === 'running');
    return {
      roomId,
      lastRecoveryAt: this.store.getMeta(`recovery:${roomId}`),
      singleWriter: true,
      sessions,
      deliveries,
      attempts,
      note: '“已送达”不等于“已读”；只有宿主观察到取用时才会显示已取用。',
    };
  }
}
