/**
 * Project Room — planning and assignment service.
 *
 * The coordinator proposes; this service validates and writes. These rules are
 * the specification:
 *
 *   - **Transaction.** Plan revision, tasks, owners and the pending-dispatch rows
 *     are written together, so a failure leaves no half-valid plan.
 *   - **Idempotency.** Dispatch keys are `roomId|planRevision|taskId|assignmentRevision`.
 *     Reprocessing the same source message cannot build the team twice, and a
 *     user asking for more work produces a NEW revision rather than being
 *     deduplicated by text similarity.
 *   - **Dependencies.** A cycle is refused with the actual cycle named, before
 *     anything is written.
 *   - **Concurrency.** The plan is checked against `expectedPlanRevision`; a
 *     stale commit is a conflict, not an overwrite.
 *
 * @module dsh-project-room/src/host/tasks/planning-service
 */

import { randomUUID } from 'node:crypto';

import { RoomError, TASK_STATUS_LABELS } from '../../../shared/contracts.js';
import { detectDependencyCycle } from '../room/loop-guard.js';

export class PlanningService {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../room/room-service.js').RoomService} input.rooms
   * @param {import('../models/model-service.js').ModelProfileService} input.models
   * @param {import('../tasks/task-service.js').TaskService} input.tasks
   * @param {import('../room/message-service.js').MessageService} [input.messages]
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.rooms = input.rooms;
    this.models = input.models;
    this.tasks = input.tasks;
    this.messages = input.messages ?? null;
    this.logger = input.logger ?? null;
    /**
     * Creates a member's host session. Injected by the plugin so planning stays
     * testable and the host boundary keeps exactly one implementation.
     * @type {(input: object) => Promise<object>}
     */
    this.createSession = input.createSession ?? (async () => ({}));
  }

  /* ---------------------------------------------------------------- *
   * Proposal
   * ---------------------------------------------------------------- */

  /**
   * Validate and persist a plan proposal, without committing it for execution.
   *
   * Validation performed here is deterministic and explainable: dependency
   * cycles, unknown dependencies, missing acceptance criteria, and members that
   * cannot be resolved. None of it is delegated to a model.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.authorId
   * @param {string | null} input.sourceMessageId
   * @param {string} [input.scope]
   * @param {string[]} [input.assumptions]
   * @param {Array<object>} input.tasks
   * @returns {{ planId: string, revision: number, issues: string[], coverage: object, tasks: object[] }}
   */
  propose(input) {
    const room = this.rooms.requireRoom(input.roomId);
    const settings = room.config?.planning ?? {};
    const proposed = Array.isArray(input.tasks) ? input.tasks : [];
    if (proposed.length === 0) {
      throw new RoomError('INVALID_REQUEST', '计划至少要有一个工作项。');
    }

    const issues = [];
    const localIds = new Set();
    for (const task of proposed) {
      if (!task.localId) throw new RoomError('INVALID_REQUEST', '每个工作项都需要 localId，用于表达依赖。');
      if (localIds.has(task.localId)) {
        throw new RoomError('INVALID_REQUEST', `工作项 localId 重复：${task.localId}。`);
      }
      localIds.add(task.localId);
      if (!task.objective || !String(task.objective).trim()) {
        throw new RoomError('INVALID_REQUEST', `工作项 ${task.localId} 缺少目标描述。`);
      }
    }

    const unknownDependencies = [];
    for (const task of proposed) {
      for (const dependency of task.dependencies ?? []) {
        if (!localIds.has(dependency)) unknownDependencies.push(`${task.localId} → ${dependency}`);
      }
    }
    if (unknownDependencies.length > 0) {
      throw new RoomError('INVALID_REQUEST', `依赖引用了不存在的工作项：${unknownDependencies.join('、')}。`, {
        unknownDependencies,
      });
    }

    const { acyclic, cycle } = detectDependencyCycle(proposed.map((task) => ({ id: task.localId, dependencies: task.dependencies ?? [] })));
    if (!acyclic && settings.requireAcyclicDependencies !== false) {
      throw new RoomError('INVALID_REQUEST', `依赖存在循环，已拒绝提交：${cycle.join(' → ')}。`, { cycle });
    }

    if (settings.requireAcceptanceCriteria !== false) {
      for (const task of proposed) {
        if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
          issues.push(`工作项 ${task.localId}（${task.objective}）没有验收条件。`);
        }
      }
    }

    const members = this.store.listMembers(room.id);
    for (const task of proposed) {
      if (task.ownerId && !members.some((member) => member.id === task.ownerId)) {
        issues.push(`工作项 ${task.localId} 指定的负责人不在本群。`);
      }
      if (!task.ownerId && !task.requiredRole && members.filter((member) => member.kind === 'agent').length <= 1) {
        issues.push(`工作项 ${task.localId} 还没有负责人，且群里没有可承担该角色的成员。`);
      }
    }

    const coverage = coverageOf(proposed);
    const plan = this.store.transaction(() => {
      const created = this.store.insertPlan({
        id: `plan_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        roomId: room.id,
        sourceMessageId: input.sourceMessageId ?? null,
        scope: input.scope ?? '',
        status: 'proposed',
        taskIds: [],
        assumptions: input.assumptions ?? [],
        coverage,
      });
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'plan.proposed',
        payload: {
          planId: created.id,
          revision: created.revision,
          by: input.authorId,
          workItems: proposed.map((task) => ({ localId: task.localId, objective: task.objective, role: task.requiredRole ?? null })),
          issues,
        },
      });
      return created;
    });

    // Keep the proposal's work items on the plan so a later commit writes exactly
    // what was reviewed, not a re-derived guess.
    this.store.updatePlan(plan.id, { coverage: { ...coverage, proposed } });
    this.rooms.publish(room.id, { type: 'plan.proposed', roomId: room.id, planId: plan.id });
    return { planId: plan.id, revision: plan.revision, issues, coverage, tasks: proposed };
  }

  /* ---------------------------------------------------------------- *
   * Commit and dispatch
   * ---------------------------------------------------------------- */

  /**
   * Commit a reviewed plan: write tasks, owners and pending dispatch rows in one
   * transaction, then dispatch what is ready.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.planId
   * @param {number} [input.expectedPlanRevision]
   * @param {string} [input.clientRequestId]
   * @param {string} [input.actorId]
   * @param {string} [input.cwd]
   * @returns {Promise<{ plan: object, tasks: object[], dispatched: object[], skipped: object[] }>}
   */
  async commit(input) {
    const room = this.rooms.assertActive(input.roomId, '提交计划');
    const plan = this.store.getPlan(input.planId);
    if (!plan || plan.roomId !== room.id) throw new RoomError('NOT_FOUND', `计划 ${input.planId} 不存在。`);
    if (
      Number.isFinite(input.expectedPlanRevision) &&
      input.expectedPlanRevision !== room.planRevision
    ) {
      throw new RoomError('REVISION_CONFLICT', `项目计划版本已更新（当前 r${room.planRevision}）。请重新读取后再提交。`, {
        current: room.planRevision,
        expected: input.expectedPlanRevision,
      });
    }
    if (plan.status === 'committed') {
      return { plan, tasks: plan.taskIds.map((id) => this.store.getTask(id)).filter(Boolean), dispatched: [], skipped: [] };
    }

    const proposed = plan.coverage?.proposed ?? [];
    if (proposed.length === 0) {
      throw new RoomError('INVALID_REQUEST', '这份计划没有工作项，无法提交。');
    }

    /** @type {Map<string, string>} localId → taskId */
    const idMap = new Map();
    const created = this.store.transaction(() => {
      const revision = this.store.bumpPlanRevision(room.id);
      /** @type {object[]} */
      const tasks = [];
      // Two passes: create every task first so dependencies can reference real ids.
      for (const item of proposed) {
        const task = this.store.insertTask({
          id: `task_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
          roomId: room.id,
          planId: plan.id,
          parentTaskId: null,
          objective: item.objective,
          ownerId: item.ownerId ?? null,
          requiredRole: item.requiredRole ?? null,
          requiredCapabilities: item.requiredCapabilities ?? [],
          deliverables: item.deliverables ?? [],
          acceptance: item.acceptance ?? [],
          dependencies: [],
          status: 'proposed',
          revision: 1,
          decisionRevision: currentDecisionRevision(this.store, room.id),
          assignmentRevision: 'a1',
          needsSync: false,
        });
        idMap.set(item.localId, task.id);
        tasks.push(task);
      }
      for (let index = 0; index < proposed.length; index += 1) {
        const item = proposed[index];
        const task = tasks[index];
        const dependencyIds = (item.dependencies ?? []).map((localId) => idMap.get(localId)).filter(Boolean);
        const ready = Boolean(task.ownerId) && dependencyIds.length === 0 && task.acceptance.length > 0;
        const updated = this.store.updateTask(task.id, {
          dependencies: dependencyIds,
          status: ready ? 'ready' : 'proposed',
        });
        tasks[index] = updated;
        if (updated.ownerId) this.store.updateMember(updated.ownerId, { currentTaskId: updated.id });
      }
      const committedPlan = this.store.updatePlan(plan.id, {
        status: 'committed',
        revision,
        taskIds: tasks.map((task) => task.id),
      });
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'plan.committed',
        payload: {
          planId: plan.id,
          revision,
          by: input.actorId ?? null,
          taskIds: tasks.map((task) => task.id),
          clientRequestId: input.clientRequestId ?? null,
        },
      });
      return { plan: committedPlan, tasks };
    });

    // Dispatch is a separate, idempotent step: an interruption between commit and
    // dispatch is recoverable from the ledger instead of duplicating work.
    const dispatch = await this.dispatchReady({
      roomId: room.id,
      planRevision: created.plan.revision,
      cwd: input.cwd,
      actorId: input.actorId ?? null,
    });

    return { plan: created.plan, tasks: created.tasks, dispatched: dispatch.dispatched, skipped: dispatch.skipped };
  }

  /**
   * Dispatch every ready task that has not been dispatched for this plan
   * revision. Safe to call repeatedly and after a restart.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {number} [input.planRevision]
   * @param {string} [input.cwd]
   * @param {string} [input.actorId]
   * @returns {Promise<{ dispatched: object[], skipped: object[] }>}
   */
  async dispatchReady(input) {
    const room = this.rooms.assertActive(input.roomId, '派发任务');
    const planRevision = input.planRevision ?? room.planRevision;
    const dispatched = [];
    const skipped = [];

    for (const task of this.tasks.dispatchable(room.id)) {
      const key = `${room.id}|${planRevision}|${task.id}|${task.assignmentRevision}`;
      const claim = this.store.claimDispatch({
        dispatchKey: key,
        roomId: room.id,
        planId: task.planId,
        taskId: task.id,
        memberId: task.ownerId,
        state: 'pending',
      });
      if (!claim.claimed) {
        skipped.push({ taskId: task.id, reason: '这次派发已经执行过，不重复派活。' });
        continue;
      }

      const owner = this.store.getMember(task.ownerId);
      if (!owner || owner.status === 'offline') {
        this.store.updateDispatch(key, { state: 'blocked', detail: '负责人不可用。' });
        skipped.push({ taskId: task.id, reason: `${task.ownerId} 当前不可用，任务保持就绪但未派发。` });
        continue;
      }

      try {
        const attempt = this.tasks.startAttempt({ taskId: task.id, actorId: owner.id });
        const inProgress = this.store.updateTask(task.id, { status: 'in_progress' });
        await this.sendTaskDispatch({ room: room, task: inProgress, owner, attempt, actorId: input.actorId });
        this.store.updateDispatch(key, { state: 'dispatched', detail: JSON.stringify({ attemptId: attempt.id }) });
        dispatched.push({ taskId: task.id, memberId: owner.id, attemptId: attempt.id });
      } catch (error) {
        this.store.updateDispatch(key, { state: 'failed', detail: String(error?.message ?? error) });
        skipped.push({ taskId: task.id, reason: `派发失败：${String(error?.message ?? error)}` });
      }
    }

    if (dispatched.length > 0) {
      this.store.appendEvent({ roomId: room.id, eventType: 'plan.dispatched', payload: { planRevision, dispatched } });
    }
    return { dispatched, skipped };
  }

  /**
   * Wake one owner with their task. The member gets a sourced envelope, not a
   * bare instruction, so the first thing it sees is the task's acceptance
   * criteria and dependencies.
   * @param {object} input
   */
  async sendTaskDispatch(input) {
    if (!this.messages) return;
    const { room, task, owner, attempt } = input;
    this.rooms.assertActive(room.id, '派发任务');
    const coordinator = this.store.listMembers(room.id).find((member) => member.role === 'coordinator');
    const body = [
      `【任务派发】${task.objective}`,
      `任务 id：${task.id}｜执行尝试：${attempt.id}｜版本：r${task.revision}`,
      task.deliverables.length > 0 ? `交付物：${task.deliverables.join('；')}` : null,
      task.acceptance.length > 0 ? `验收条件：${task.acceptance.join('；')}` : null,
      task.dependencies.length > 0 ? `已满足的前置：${task.dependencies.join('、')}` : null,
      '需要澄清时直接在群里 @ 相关成员；完成后用 room_task_update 提交，并附上真实证据。',
    ]
      .filter(Boolean)
      .join('\n');
    await this.messages.send({
      roomId: room.id,
      authorId: coordinator?.id ?? owner.id,
      body,
      mentions: [{ targetMemberId: owner.id, origin: 'picker', displaySnapshot: owner.displayName, span: null }],
      taskId: task.id,
      clientMessageId: `dispatch:${task.id}:${attempt.id}`,
      purpose: 'handoff',
      causalRootId: task.id,
      schedule: true,
      mode: 'queue',
    });
  }

  /* ---------------------------------------------------------------- *
   * Team building
   * ---------------------------------------------------------------- */

  /**
   * Create or reuse a member for a role, idempotently and honestly.
   *
   * The member row is written before the host session is created, so an
   * interruption is reconciled against the recorded intent instead of producing
   * a second member.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.role
   * @param {string | null} [input.displayName]
   * @param {string | null} [input.handle]
   * @param {string | null} [input.modelProfileRef]
   * @param {string} [input.requestKey]
   * @param {string | null} [input.reason]
   * @param {string} [input.actorId]
   * @param {string} [input.cwd]
   * @returns {Promise<object>}
   */
  async ensureMember(input) {
    const room = this.rooms.assertActive(input.roomId, '添加成员');
    const settings = room.config?.planning ?? {};
    const existing = this.store
      .listMembers(room.id)
      .find((member) => member.role === input.role && member.status !== 'offline' && !input.displayName);
    if (existing && settings.reuseExistingMembers !== false) {
      return { member: existing, created: false, modelChoice: null, warning: null };
    }

    const choice = await this.models.chooseProfile({
      roomId: room.id,
      role: input.role,
      requiredCapabilities: input.requiredCapabilities ?? [],
      preferredProfileRef: input.modelProfileRef ?? null,
    });
    if (!choice.profileRef) {
      throw new RoomError(
        'MEMBER_UNAVAILABLE',
        `无法为角色 ${input.role} 确定模型：项目没有默认模型，也没有为该角色配置。请先在项目设置中指定模型。`,
      );
    }
    // Validate the route before creating anything: a member that cannot run is
    // worse than a reported gap.
    const profile = await this.models.requireProfile(choice.profileRef);

    const result = await this.rooms.ensureMember({
      roomId: room.id,
      role: input.role,
      displayName: input.displayName ?? null,
      handle: input.handle ?? null,
      modelProfileRef: profile.id,
      requestKey: input.requestKey ?? `${room.id}|${input.role}`,
      cwd: input.cwd,
      createSession: async (sessionInput) => {
        await this.createSession({ ...sessionInput, model: { providerRoute: profile.providerRoute, modelId: profile.modelId } });
      },
    });

    this.store.appendEvent({
      roomId: room.id,
      eventType: 'member.ensured',
      payload: {
        memberId: result.member.id,
        role: input.role,
        created: result.created,
        reason: input.reason ?? null,
        model: { providerRoute: profile.providerRoute, modelId: profile.modelId },
        modelReason: choice.reason,
        by: input.actorId ?? null,
      },
    });
    if (result.created && this.messages) {
      await this.messages.send({
        roomId: room.id,
        authorId: input.actorId ?? result.member.id,
        body: `【组队】新增成员 ${result.member.displayName}（@${result.member.handle}，${input.role}），模型 ${profile.providerRoute}/${profile.modelId}。${input.reason ? `原因：${input.reason}` : ''}`,
        mentions: [{ targetMemberId: result.member.id, origin: 'picker', displaySnapshot: result.member.displayName, span: null }],
        clientMessageId: `member-ensure:${result.member.id}`,
        purpose: 'system',
      });
    }
    return { member: result.member, created: result.created, modelChoice: choice, warning: result.warning };
  }

  /**
   * Re-check circular waits after a plan round and report them instead of
   * retrying forever.
   * @param {string} roomId
   * @returns {{ detected: boolean, tasks: string[] }}
   */
  detectStall(roomId) {
    const tasks = this.store.listTasks(roomId);
    const blocked = tasks.filter((task) => task.status === 'blocked');
    if (blocked.length < 2) return { detected: false, tasks: [] };
    const blockedIds = new Set(blocked.map((task) => task.id));
    const circular = blocked.filter((task) => task.dependencies.some((dependency) => blockedIds.has(dependency)));
    return { detected: circular.length >= 2, tasks: circular.map((task) => task.id) };
  }
}

/**
 * Requirement coverage: which work items claim to satisfy which acceptance
 * areas. Reported, never asserted as complete — a model check cannot guarantee
 * that nothing was missed.
 * @param {Array<object>} proposed
 * @returns {{ workItems: number, withAcceptance: number, roles: string[], parallelizable: string[] }}
 */
export function coverageOf(proposed) {
  const withAcceptance = proposed.filter((task) => (task.acceptance ?? []).length > 0);
  const depended = new Set(proposed.flatMap((task) => task.dependencies ?? []));
  return {
    workItems: proposed.length,
    withAcceptance: withAcceptance.length,
    roles: [...new Set(proposed.map((task) => task.requiredRole).filter(Boolean))],
    parallelizable: proposed.filter((task) => !depended.has(task.localId)).map((task) => task.localId),
  };
}

/** Highest accepted decision revision of a room. */
function currentDecisionRevision(store, roomId) {
  const accepted = store.listDecisions(roomId, { statuses: ['accepted'] });
  return accepted.length === 0 ? 0 : accepted[accepted.length - 1].revision;
}

/** Human label for a task status, used in dispatch text. */
export function statusLabel(status) {
  return TASK_STATUS_LABELS[status] ?? status;
}
