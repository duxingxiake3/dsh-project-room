/**
 * Project Room — decision service.
 *
 * A "decision" is the unit that makes requirement changes survivable. When a
 * user changes their mind, the change becomes a new revision with a source, the
 * affected tasks are marked `needsSync`, the affected members are notified, and
 * each one reports back what actually happened on their side (the design notes).
 *
 * Two rules keep this from being theatre:
 *
 *   - An explicit human requirement is accepted directly. An agent may only
 *     accept a TECHNICAL decision inside its already-granted scope, and may never
 *     use one to override a human requirement — a contradiction becomes a
 *     visible conflict item instead.
 *   - A chat reply of "收到" is not a sync receipt. Only a recorded ack with the
 *     task revision it applied counts (`appliedTaskRevision`).
 *
 * @module dsh-project-room/src/host/decisions/decision-service
 */

import { randomUUID } from 'node:crypto';

import { RoomError, isoTimestamp } from '../../../shared/contracts.js';

export class DecisionService {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../room/room-service.js').RoomService} input.rooms
   * @param {import('../tasks/task-service.js').TaskService} input.tasks
   * @param {import('../room/message-service.js').MessageService} [input.messages]
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.rooms = input.rooms;
    this.tasks = input.tasks;
    this.messages = input.messages ?? null;
    this.logger = input.logger ?? null;
  }

  /* ---------------------------------------------------------------- *
   * Proposing and accepting
   * ---------------------------------------------------------------- */

  /**
   * Record a decision.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.actorId
   * @param {string | null} input.sourceMessageId
   * @param {string} input.scope
   * @param {string} input.statement
   * @param {string[]} [input.affectedTaskIds]
   * @param {boolean} [input.accept]
   * @param {string | null} [input.supersedes]
   * @returns {Promise<object>}
   */
  async propose(input) {
    const room = this.rooms.requireRoom(input.roomId);
    const actor = this.rooms.requireMember(input.actorId);
    if (!input.statement || !String(input.statement).trim()) {
      throw new RoomError('INVALID_REQUEST', '决定内容不能为空。');
    }

    const sourceMessage = input.sourceMessageId ? this.store.getMessage(input.sourceMessageId) : null;
    if (input.sourceMessageId && !sourceMessage) {
      throw new RoomError('INVALID_REQUEST', '决定必须引用一条真实存在的群消息作为来源。');
    }

    const humanSourced = sourceMessage?.authorKind === 'human';
    const wantsAccept = input.accept === true || humanSourced;

    // Authority: a human requirement is authoritative by construction. An agent
    // may adopt a technical decision, but only the coordinator may do so on
    // behalf of the team, and never over a human requirement.
    if (wantsAccept && !humanSourced && actor.role !== 'coordinator') {
      throw new RoomError(
        'FORBIDDEN',
        '代理只能在主代理或被授权范围内采纳技术决定；你可以先提出这个决定，由主代理或用户采纳。',
        { actorId: actor.id, role: actor.role },
      );
    }

    const conflict = wantsAccept && !humanSourced ? this.#findConflict(room.id, input.scope, input.statement) : null;
    if (conflict) {
      // Contradicting a human requirement is surfaced, never auto-resolved.
      return this.store.transaction(() => {
        const decision = this.store.insertDecision({
          id: `decision_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
          roomId: room.id,
          sourceMessageId: input.sourceMessageId ?? sourceMessage?.id ?? '',
          scope: input.scope ?? '',
          statement: input.statement,
          status: 'proposed',
          affectedTaskIds: input.affectedTaskIds ?? [],
          acceptedBy: null,
        });
        this.store.appendEvent({
          roomId: room.id,
          eventType: 'decision.conflict',
          payload: { decisionId: decision.id, conflictsWith: conflict.id, statement: input.statement },
        });
        this.store.addAdminNote(
          room.id,
          'decision-conflict',
          `决定 r${decision.revision} 与用户要求（决定 r${conflict.revision}）冲突：${input.statement}`,
        );
        return { ...decision, conflictWith: conflict, requiresUserDecision: true };
      });
    }

    const affected = (input.affectedTaskIds ?? []).filter((taskId) => {
      const task = this.store.getTask(taskId);
      return task && task.roomId === room.id;
    });
    const impacted = this.#impactOf(room.id, affected, input.scope);

    const decision = this.store.transaction(() => {
      const created = this.store.insertDecision({
        id: `decision_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        roomId: room.id,
        sourceMessageId: input.sourceMessageId ?? sourceMessage?.id ?? '',
        scope: input.scope ?? '',
        statement: input.statement,
        status: wantsAccept ? 'accepted' : 'proposed',
        affectedTaskIds: [...new Set([...affected, ...impacted.direct])],
        acceptedBy: wantsAccept ? actor.id : null,
        supersedes: input.supersedes ?? null,
      });

      if (wantsAccept) {
        for (const taskId of new Set([...affected, ...impacted.direct, ...impacted.inferred])) {
          const task = this.store.getTask(taskId);
          if (!task) continue;
          // A task that would keep producing the old shape must not be
          // submittable as an accepted result (the design notes step 6).
          this.store.updateTask(task.id, { needsSync: true, decisionRevision: created.revision });
        }
        for (const taskId of new Set([...affected, ...impacted.direct, ...impacted.inferred])) {
          const task = this.store.getTask(taskId);
          if (!task?.ownerId) continue;
          this.store.upsertDecisionAck({ decisionId: created.id, memberId: task.ownerId, state: 'pending' });
        }
      }

      this.store.appendEvent({
        roomId: room.id,
        eventType: wantsAccept ? 'decision.accepted' : 'decision.proposed',
        payload: {
          decisionId: created.id,
          revision: created.revision,
          scope: created.scope,
          statement: created.statement,
          sourceMessageId: created.sourceMessageId,
          affectedTaskIds: created.affectedTaskIds,
          inferredTaskIds: impacted.inferred,
          acceptedBy: created.acceptedBy,
          humanSourced,
        },
      });
      return created;
    });

    if (wantsAccept) {
      void this.#notifyAffected({ room, decision, impacted, actor }).catch((error) => {
        this.logger?.warn?.(`[project-room] decision notification failed: ${error?.message ?? error}`);
      });
    }
    this.rooms.publish(room.id, { type: 'decision.changed', roomId: room.id, decisionId: decision.id });
    return { ...decision, inferredTaskIds: impacted.inferred };
  }

  /**
   * Record one member's sync receipt.
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.actorId
   * @param {string} input.decisionId
   * @param {'synced' | 'needs_clarification' | 'rework' | 'unaffected' | 'pending'} input.state
   * @param {number | null} [input.appliedTaskRevision]
   * @param {string | null} [input.detail]
   * @returns {object}
   */
  ack(input) {
    const room = this.rooms.requireRoom(input.roomId);
    const actor = this.rooms.requireMember(input.actorId);
    const decision = this.store.getDecision(input.decisionId);
    if (!decision || decision.roomId !== room.id) throw new RoomError('NOT_FOUND', `决定 ${input.decisionId} 不存在。`);

    const valid = ['synced', 'needs_clarification', 'rework', 'unaffected', 'pending'];
    if (!valid.includes(input.state)) {
      throw new RoomError('INVALID_REQUEST', `未知的同步状态：${input.state}。`);
    }
    if (input.state === 'unaffected' && !input.detail) {
      throw new RoomError('INVALID_REQUEST', '回报“不受影响”需要说明理由。');
    }
    if (input.state === 'synced') {
      const owned = this.store.listTasks(room.id, { ownerId: actor.id });
      const needsSync = owned.filter((task) => task.needsSync);
      if (needsSync.length > 0 && !Number.isFinite(input.appliedTaskRevision)) {
        throw new RoomError(
          'REVISION_CONFLICT',
          '你名下仍有标记为需要同步的任务，回报“已同步”时必须给出完成适配后的任务版本（appliedTaskRevision）。',
          { tasks: needsSync.map((task) => ({ id: task.id, revision: task.revision })) },
        );
      }
    }

    const ack = this.store.transaction(() => {
      const recorded = this.store.upsertDecisionAck({
        decisionId: decision.id,
        memberId: actor.id,
        state: input.state,
        appliedTaskRevision: input.appliedTaskRevision ?? null,
        detail: input.detail ?? null,
      });
      if (input.state === 'synced' || input.state === 'unaffected') {
        // Clearing `needsSync` is what actually unblocks re-submission; the ack
        // alone is just a statement.
        for (const task of this.store.listTasks(room.id, { ownerId: actor.id })) {
          if (task.needsSync && task.decisionRevision <= decision.revision) {
            this.store.updateTask(task.id, { needsSync: false });
          }
        }
        this.store.updateMember(actor.id, { lastAppliedDecisionRevision: decision.revision });
      }
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'decision.ack',
        payload: {
          decisionId: decision.id,
          memberId: actor.id,
          state: input.state,
          appliedTaskRevision: input.appliedTaskRevision ?? null,
          detail: input.detail ?? null,
        },
      });
      return recorded;
    });

    this.rooms.publish(room.id, { type: 'decision.changed', roomId: room.id, decisionId: decision.id });
    return ack;
  }

  /**
   * A user's direct instruction, recorded as an accepted requirement plus its
   * deterministic impact. This is the programmatic form of the design notes.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.sourceMessageId
   * @param {string} input.statement
   * @param {string} [input.scope]
   * @param {string[]} [input.affectedTaskIds]
   * @param {string} input.actorId
   * @returns {Promise<object>}
   */
  async recordHumanChange(input) {
    const decision = await this.propose({
      roomId: input.roomId,
      actorId: input.actorId,
      sourceMessageId: input.sourceMessageId,
      scope: input.scope ?? '',
      statement: input.statement,
      affectedTaskIds: input.affectedTaskIds ?? [],
      accept: true,
    });
    return decision;
  }

  /**
   * Everything the decision panel needs: decisions, their acks, and which
   * members are still behind.
   * @param {string} roomId
   * @returns {object}
   */
  board(roomId) {
    const decisions = this.store.listDecisions(roomId);
    const members = this.store.listMembers(roomId);
    const latestAccepted = decisions.filter((decision) => decision.status === 'accepted').pop() ?? null;
    return {
      decisions: decisions.map((decision) => ({
        ...decision,
        acks: this.store.listDecisionAcks(decision.id),
      })),
      latestAcceptedRevision: latestAccepted?.revision ?? 0,
      lagging: latestAccepted
        ? members
            .filter((member) => member.kind === 'agent' && member.lastAppliedDecisionRevision < latestAccepted.revision)
            .map((member) => ({ memberId: member.id, displayName: member.displayName, applied: member.lastAppliedDecisionRevision }))
        : [],
    };
  }

  /**
   * Deterministic impact for a decision.
   *
   * Only dependency edges this plugin actually knows are "direct". Anything
   * inferred from the scope keyword is reported separately as `inferred`, because
   * claiming a complete impact graph would be a lie (§13.3 step 5).
   * @param {string} roomId
   * @param {string[]} explicit
   * @param {string} scope
   * @returns {{ direct: string[], inferred: string[] }}
   */
  #impactOf(roomId, explicit, scope) {
    const direct = new Set(explicit);
    for (const taskId of explicit) {
      for (const other of this.store.listTasks(roomId)) {
        if (other.dependencies.includes(taskId)) direct.add(other.id);
      }
    }
    const inferred = new Set();
    const keyword = String(scope ?? '').trim();
    if (keyword) {
      for (const task of this.store.listTasks(roomId)) {
        if (direct.has(task.id)) continue;
        const haystack = `${task.objective} ${task.deliverables.join(' ')} ${task.acceptance.join(' ')}`;
        if (haystack.includes(keyword)) inferred.add(task.id);
      }
    }
    return { direct: [...direct], inferred: [...inferred] };
  }

  /**
   * Tell every affected member, in the room, with the decision revision and the
   * task revision they must reach. Notifications are grouped so a change that
   * touches three tasks does not produce three separate wake-ups.
   * @param {object} input
   */
  async #notifyAffected(input) {
    if (!this.messages) return;
    const { room, decision, impacted, actor } = input;
    const affected = [...new Set([...decision.affectedTaskIds, ...impacted.inferred])];
    if (affected.length === 0) return;
    const owners = new Map();
    for (const taskId of affected) {
      const task = this.store.getTask(taskId);
      if (task?.ownerId) {
        owners.set(task.ownerId, [...(owners.get(task.ownerId) ?? []), task]);
      }
    }
    if (owners.size === 0) return;

    const body = [
      `【需求变更 · 决定 r${decision.revision}】${decision.statement}`,
      `来源：${actor.kind === 'human' ? '用户' : actor.displayName}${decision.sourceMessageId ? `（消息 #${this.store.getMessage(decision.sourceMessageId)?.seq ?? '?'}）` : ''}`,
      `受影响任务：${affected.map((taskId) => `${taskId}（r${this.store.getTask(taskId)?.revision ?? '?'}）`).join('、')}`,
      impacted.inferred.length > 0 ? `其中由关键词推断的影响需要各自确认：${impacted.inferred.join('、')}` : null,
      '请在安全边界同步这次变更，然后用 room_decision_ack 回报：已同步 / 需要澄清 / 已有结果需返工 / 不受影响（说明理由）。',
      '注意：旧版本的通过结果不能直接沿用，需要按新版本重新验证。',
    ]
      .filter(Boolean)
      .join('\n');

    await this.messages.send({
      roomId: room.id,
      authorId: actor.id,
      body,
      mentions: [...owners.keys()].map((memberId) => ({
        targetMemberId: memberId,
        origin: 'picker',
        displaySnapshot: this.store.getMember(memberId)?.displayName ?? '',
        span: null,
      })),
      clientMessageId: `decision:${decision.id}:notify`,
      purpose: 'handover',
      causalRootId: decision.id,
      mode: 'queue',
    });
  }

  /**
   * Whether a proposed technical decision contradicts an accepted human
   * requirement in the same scope.
   * @param {string} roomId
   * @param {string} scope
   * @param {string} statement
   * @returns {object | null}
   */
  #findConflict(roomId, scope, statement) {
    const accepted = this.store.listDecisions(roomId, { statuses: ['accepted'] });
    for (const decision of accepted) {
      if (scope && decision.scope && decision.scope !== scope) continue;
      const source = decision.sourceMessageId ? this.store.getMessage(decision.sourceMessageId) : null;
      if (source?.authorKind !== 'human') continue;
      // A different statement in the same human-owned scope is a candidate
      // conflict; the caller surfaces it instead of resolving it.
      if (normalize(decision.statement) !== normalize(statement)) return decision;
    }
    return null;
  }
}

/** Normalize text for a conflict comparison only — never for identity. */
function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Timestamp helper, shared so acks and events agree. */
export const now = isoTimestamp;
