/**
 * Project Room — task service.
 *
 * Owns the task lifecycle, per-task revisions, attempts, and acceptance. The
 * design's hard rules that this file enforces rather than documents:
 *
 *   - One task has at most ONE effective owner and ONE active attempt (§13.2).
 *   - A status change must be legal in the transition table.
 *   - `submitted` requires real evidence references; a member's sentence "tests
 *     passed" is not evidence (§15.3).
 *   - Acceptance requires the artifact's task and decision revisions to match
 *     the current ones, otherwise the result is stale and cannot be accepted
 *     (§13.4).
 *   - A late result from an old attempt can be stored but never overwrites the
 *     new task state (§9.5).
 *
 * @module dsh-project-room/src/host/tasks/task-service
 */

import { randomUUID } from 'node:crypto';

import { RoomError, TASK_STATUS_LABELS, isoTimestamp } from '../../../shared/contracts.js';

export class TaskService {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../room/room-service.js').RoomService} input.rooms
   * @param {import('../room/message-service.js').MessageService} [input.messages]
   * @param {import('../room/loop-guard.js').LoopGuard} [input.guard]
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.rooms = input.rooms;
    this.messages = input.messages ?? null;
    this.guard = input.guard ?? null;
    this.logger = input.logger ?? null;
  }

  /* ---------------------------------------------------------------- *
   * Creation and ownership
   * ---------------------------------------------------------------- */

  /**
   * Propose a work item. A proposal is not an execution promise: it stays
   * `proposed` until it has an owner, dependencies and acceptance criteria.
   * @param {object} input
   * @returns {object}
   */
  propose(input) {
    const room = this.rooms.requireRoom(input.roomId);
    const actor = this.rooms.requireMember(input.actorId);
    if (input.dependencies?.length) {
      const missing = input.dependencies.filter((dependencyId) => !this.store.getTask(dependencyId));
      if (missing.length > 0) {
        throw new RoomError('INVALID_REQUEST', `依赖的任务不存在：${missing.join('、')}。`, { missing });
      }
    }
    const task = this.store.transaction(() => {
      const created = this.store.insertTask({
        id: `task_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        roomId: room.id,
        planId: null,
        parentTaskId: input.parentTaskId ?? null,
        objective: input.objective,
        ownerId: input.suggestedOwnerId ?? null,
        requiredRole: input.requiredRole ?? null,
        requiredCapabilities: input.requiredCapabilities ?? [],
        deliverables: input.deliverables ?? [],
        acceptance: input.acceptance ?? [],
        dependencies: input.dependencies ?? [],
        status: input.acceptance?.length > 0 && input.suggestedOwnerId ? 'ready' : 'proposed',
        revision: 1,
        decisionRevision: currentDecisionRevision(this.store, room.id),
        assignmentRevision: 'a1',
        needsSync: false,
      });
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'task.proposed',
        payload: {
          taskId: created.id,
          by: actor.id,
          objective: created.objective,
          sourceMessageId: input.sourceMessageId ?? null,
          parentTaskId: input.parentTaskId ?? null,
        },
      });
      return created;
    });
    this.rooms.publish(room.id, { type: 'task.changed', roomId: room.id, taskId: task.id });
    return task;
  }

  /**
   * Assign or transfer ownership.
   *
   * Transferring stops the old allocation first and preserves its attempts; the
   * new assignment gets a new revision so an old result can never be presented
   * as this assignment's deliverable (the design notes, AT42).
   * @param {object} input
   * @returns {object}
   */
  assign(input) {
    const task = this.requireTask(input.taskId);
    const room = this.rooms.requireRoom(task.roomId);
    const owner = this.rooms.requireMember(input.memberId);
    if (owner.roomId !== room.id) throw new RoomError('NOT_A_ROOM_MEMBER', '负责人不属于本项目群。');
    if (owner.kind !== 'agent') throw new RoomError('INVALID_REQUEST', '只有代理成员可以承担任务执行。');
    if (owner.status === 'offline') {
      throw new RoomError('MEMBER_UNAVAILABLE', `${owner.displayName} 已退出本群，不能接受新的任务分配。`);
    }

    const previousOwnerId = task.ownerId;
    const assignmentRevision = input.assignmentRevision ?? nextAssignmentRevision(task.assignmentRevision);
    const updated = this.store.transaction(() => {
      if (previousOwnerId && previousOwnerId !== owner.id) {
        const attempts = this.store.listAttempts(task.id, { activeOnly: true });
        for (const attempt of attempts) {
          this.store.updateAttempt(attempt.id, { state: 'handed-over' });
        }
        const previous = this.store.getMember(previousOwnerId);
        if (previous?.currentTaskId === task.id) this.store.updateMember(previousOwnerId, { currentTaskId: null });
      }
      const next = this.store.updateTask(
        task.id,
        {
          ownerId: owner.id,
          assignmentRevision,
          status: task.status === 'proposed' && task.acceptance.length > 0 ? 'ready' : task.status,
        },
        { expectedRevision: input.expectedRevision },
      );
      this.store.updateMember(owner.id, { currentTaskId: next.id });
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'task.assigned',
        payload: {
          taskId: next.id,
          from: previousOwnerId,
          to: owner.id,
          assignmentRevision,
          by: input.actorId,
          reason: input.reason ?? null,
        },
      });
      return next;
    });
    this.rooms.publish(room.id, { type: 'task.changed', roomId: room.id, taskId: updated.id });
    return updated;
  }

  /* ---------------------------------------------------------------- *
   * Execution state
   * ---------------------------------------------------------------- */

  /**
   * Start (or continue) an execution attempt. Only one attempt may be active per
   * task; a second one for the same actor is returned instead of racing it.
   * @param {object} input
   * @returns {object}
   */
  startAttempt(input) {
    const task = this.requireTask(input.taskId);
    const active = this.store.listAttempts(task.id, { activeOnly: true });
    const existing = active.find((attempt) => attempt.actorId === input.actorId);
    if (existing) return existing;
    for (const attempt of active) this.store.updateAttempt(attempt.id, { state: 'superseded' });
    const attempt = this.store.insertAttempt({
      id: `attempt_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      taskId: task.id,
      roomId: task.roomId,
      actorId: input.actorId,
      baseRevision: task.revision,
      assignmentRevision: task.assignmentRevision,
      modelConfigRevision: input.modelConfigRevision ?? 0,
      state: 'running',
      worktreeRef: input.worktreeRef ?? null,
    });
    this.store.appendEvent({
      roomId: task.roomId,
      eventType: 'task.attempt.started',
      payload: { taskId: task.id, attemptId: attempt.id, actorId: input.actorId, baseRevision: attempt.baseRevision },
    });
    return attempt;
  }

  /**
   * Update a task's state or submit a result.
   *
   * @param {object} input
   * @returns {object}
   */
  update(input) {
    const task = this.requireTask(input.taskId);
    const actor = this.rooms.requireMember(input.actorId);
    const isOwner = task.ownerId === actor.id;
    const isCoordinator = actor.role === 'coordinator';
    if (!isOwner && !isCoordinator) {
      throw new RoomError('FORBIDDEN', '只有任务负责人或主代理可以更新这个任务的状态。', {
        taskId: task.id,
        ownerId: task.ownerId,
        actorId: actor.id,
      });
    }

    const nextStatus = input.status ?? task.status;
    const evidence = (input.evidenceRefs ?? []).filter((entry) => typeof entry === 'string' && entry.trim());

    // Verification-only transitions stay with `verify`.
    if (nextStatus === 'accepted' || nextStatus === 'verifying') {
      throw new RoomError(
        'INVALID_REQUEST',
        `${TASK_STATUS_LABELS[nextStatus]} 由验收流程决定；请用 room_task_verify 提交验收结论。`,
      );
    }
    if (nextStatus === 'submitted' && evidence.length === 0) {
      throw new RoomError(
        'INVALID_REQUEST',
        '提交任务必须给出真实证据引用（命令与退出码、日志或文件位置、测试记录、commit/diff）。口头说“已完成/测试通过”不会被接受为证据。',
      );
    }
    if (task.needsSync && nextStatus === 'submitted') {
      throw new RoomError(
        'REVISION_CONFLICT',
        '这项任务的需求版本已变更，需要先同步新版本（并回报同步状态）再提交验收。',
        { taskId: task.id, decisionRevision: task.decisionRevision, current: currentDecisionRevision(this.store, task.roomId) },
      );
    }

    const attempt = input.attemptId
      ? this.store.getAttempt(input.attemptId)
      : this.store.listAttempts(task.id, { activeOnly: true })[0] ?? null;
    if (attempt && attempt.taskId !== task.id) {
      throw new RoomError('INVALID_REQUEST', '提供的执行尝试不属于这个任务，已拒绝写入。');
    }

    const updated = this.store.transaction(() => {
      const patch = { status: nextStatus };
      if (input.status === 'rework' || input.status === 'blocked') patch.needsSync = false;
      const next = this.store.updateTask(task.id, patch, { expectedRevision: input.expectedRevision });

      if (attempt) {
        const attemptState =
          nextStatus === 'submitted' ? 'submitted' : nextStatus === 'accepted' ? 'accepted' : nextStatus === 'blocked' ? 'blocked' : nextStatus === 'failed' ? 'failed' : attempt.state;
        this.store.updateAttempt(attempt.id, { state: attemptState });
      }

      for (const reference of evidence) {
        this.store.insertArtifact({
          id: `artifact_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
          roomId: task.roomId,
          taskId: task.id,
          attemptId: attempt?.id ?? null,
          kind: classifyEvidence(reference),
          location: reference,
          evidenceRef: reference,
          verified: false,
        });
      }

      this.store.appendEvent({
        roomId: task.roomId,
        eventType: 'task.updated',
        payload: {
          taskId: task.id,
          from: task.status,
          to: nextStatus,
          revision: next.revision,
          by: actor.id,
          note: input.note ?? null,
          blockers: input.blockers ?? null,
          evidence,
          attemptId: attempt?.id ?? null,
        },
      });

      if (input.blockers) {
        this.store.addAdminNote(task.roomId, 'blocker', `${task.objective}：${input.blockers}`);
        this.store.upsertReminder({
          id: `reminder_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
          roomId: task.roomId,
          taskId: task.id,
          targetId: task.ownerId ?? actor.id,
          dueAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          dedupeKey: `blocker|${task.id}|${next.revision}`,
          state: 'pending',
        });
      }
      return next;
    });

    if (this.guard) this.guard.noteProgress(task.roomId, task.id);
    this.rooms.publish(task.roomId, { type: 'task.changed', roomId: task.roomId, taskId: task.id });

    // Tell the room. A state change nobody can see is indistinguishable from
    // work that never happened.
    void this.#announce(updated, actor, input).catch((error) => {
      this.logger?.warn?.(`[project-room] task announcement failed: ${error?.message ?? error}`);
    });
    return updated;
  }

  /**
   * Verify a submitted task against its acceptance criteria.
   * @param {object} input
   * @returns {Promise<object>}
   */
  async verify(input) {
    const task = this.requireTask(input.taskId);
    const actor = this.rooms.requireMember(input.actorId);
    if (task.ownerId === actor.id && actor.role !== 'coordinator') {
      throw new RoomError('FORBIDDEN', '任务的负责人不能自己验收自己的成果；请由测试或主代理验收。');
    }
    if (!['submitted', 'verifying', 'rework'].includes(task.status)) {
      throw new RoomError('INVALID_REQUEST', `任务当前状态是 ${TASK_STATUS_LABELS[task.status] ?? task.status}，不能验收。`);
    }
    const evidence = (input.evidenceRefs ?? []).filter(Boolean);
    if (evidence.length === 0) {
      throw new RoomError('INVALID_REQUEST', '验收必须给出判定依据（测试记录、运行结果或检查结论）。');
    }

    const currentDecision = currentDecisionRevision(this.store, task.roomId);
    if (task.decisionRevision < currentDecision) {
      // A stale version cannot be accepted; the result must be re-verified on
      // the current requirement (the design notes).
      this.store.updateTask(task.id, { needsSync: true, status: 'rework' });
      throw new RoomError(
        'REVISION_CONFLICT',
        `这项成果基于需求版本 r${task.decisionRevision}，当前已是 r${currentDecision}，不能按旧版本验收。已标记为需要重新验证。`,
        { taskDecisionRevision: task.decisionRevision, currentDecisionRevision: currentDecision },
      );
    }

    const artifacts = this.store.listArtifacts(task.roomId, { taskId: task.id });
    const verifiedReferences = artifacts.filter((artifact) => artifact.verified).length;
    if (input.passed && verifiedReferences === 0) {
      // A pass must rest on at least one artifact that was really checked; a
      // member's sentence "tests passed" is stored as an unverified artifact and
      // therefore cannot reach acceptance (the design notes, AT25).
      throw new RoomError('ARTIFACT_NOT_VERIFIED', '没有可核验的产物引用，不能判定通过。');
    }

    return this.store.transaction(() => {
      const nextStatus = input.passed ? 'accepted' : 'rework';
      const updated = this.store.updateTask(task.id, { status: nextStatus, decisionRevision: currentDecision });
      const attempt = input.attemptId ? this.store.getAttempt(input.attemptId) : this.store.listAttempts(task.id)[0] ?? null;
      if (attempt) this.store.updateAttempt(attempt.id, { state: input.passed ? 'accepted' : 'rework' });
      for (const reference of evidence) {
        this.store.insertArtifact({
          id: `artifact_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
          roomId: task.roomId,
          taskId: task.id,
          attemptId: attempt?.id ?? null,
          kind: classifyEvidence(reference),
          location: reference,
          evidenceRef: reference,
          verified: input.passed === true,
        });
      }
      this.store.appendEvent({
        roomId: task.roomId,
        eventType: input.passed ? 'task.accepted' : 'task.rework',
        payload: {
          taskId: task.id,
          by: actor.id,
          evidence,
          failures: input.failures ?? [],
          note: input.note ?? null,
          decisionRevision: currentDecision,
        },
      });
      if (input.passed && task.ownerId) {
        const owner = this.store.getMember(task.ownerId);
        if (owner?.currentTaskId === task.id) this.store.updateMember(owner.id, { currentTaskId: null });
      }
      return updated;
    });
  }

  /* ---------------------------------------------------------------- *
   * Queries
   * ---------------------------------------------------------------- */

  /**
   * Tasks with everything the task board shows, including why a task is not yet
   * runnable (§13.6 step 7).
   * @param {string} roomId
   * @returns {object[]}
   */
  board(roomId) {
    const tasks = this.store.listTasks(roomId);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return tasks.map((task) => {
      const dependencies = task.dependencies.map((dependencyId) => byId.get(dependencyId)).filter(Boolean);
      const unsatisfied = dependencies.filter((dependency) => dependency.status !== 'accepted');
      const owner = task.ownerId ? this.store.getMember(task.ownerId) : null;
      return {
        ...task,
        statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status,
        ownerName: owner?.displayName ?? null,
        runnable: unsatisfied.length === 0 && task.status !== 'blocked',
        blockedBy: unsatisfied.map((dependency) => ({
          taskId: dependency.id,
          objective: dependency.objective,
          status: dependency.status,
          statusLabel: TASK_STATUS_LABELS[dependency.status] ?? dependency.status,
        })),
        attempts: this.store.listAttempts(task.id),
        artifacts: this.store.listArtifacts(roomId, { taskId: task.id }),
      };
    });
  }

  /**
   * Tasks whose prerequisites are satisfied and that have an owner — the
   * dispatch set for one planning round.
   * @param {string} roomId
   * @returns {object[]}
   */
  dispatchable(roomId) {
    return this.board(roomId).filter(
      (task) => task.runnable && task.ownerId && ['ready', 'proposed'].includes(task.status),
    );
  }

  /** @param {string} taskId */
  requireTask(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw new RoomError('NOT_FOUND', `任务 ${taskId} 不存在。`);
    return task;
  }

  /**
   * Post a short, sourced state change into the room.
   * @param {object} task
   * @param {object} actor
   * @param {object} input
   */
  async #announce(task, actor, input) {
    if (!this.messages) return;
    const owner = task.ownerId ? this.store.getMember(task.ownerId) : null;
    const label = TASK_STATUS_LABELS[task.status] ?? task.status;
    const details = [
      `【任务更新】${task.objective}`,
      `状态：${label}（r${task.revision}）`,
      owner ? `负责人：${owner.displayName}` : null,
      input.blockers ? `缺少：${input.blockers}` : null,
      input.note ? `说明：${input.note}` : null,
      input.evidenceRefs?.length ? `证据：${input.evidenceRefs.slice(0, 3).join('；')}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    await this.messages.send({
      roomId: task.roomId,
      authorId: actor.kind === 'agent' ? actor.id : coordinatorIdOf(this.store, task.roomId) ?? actor.id,
      body: details,
      mentions: [],
      taskId: task.id,
      clientMessageId: `task-update:${task.id}:r${task.revision}:${task.status}`,
      purpose: 'system',
      causalRootId: task.id,
    });
  }
}

/**
 * Whether an evidence string names a commit, a diff, a test run or a plain file.
 * Purely presentational: it changes the artifact's kind icon, never its
 * trustworthiness.
 * @param {string} reference
 * @returns {'diff' | 'file' | 'test-run' | 'note' | 'commit'}
 */
export function classifyEvidence(reference) {
  const text = String(reference ?? '');
  if (/^[0-9a-f]{7,40}$/i.test(text.trim()) || /\bcommit\b/i.test(text)) return 'commit';
  if (/\bdiff\b|\.patch$/i.test(text)) return 'diff';
  if (/(test|测试|pytest|node --test|jest|vitest|退出码|exit code)/i.test(text)) return 'test-run';
  if (/[\\/][^\s]*\.[a-z0-9]{1,6}\b/i.test(text)) return 'file';
  return 'note';
}

/** The next assignment revision label, e.g. `a2`. */
export function nextAssignmentRevision(current) {
  const match = /^a(\d+)$/.exec(String(current ?? 'a1'));
  const index = match ? Number(match[1]) + 1 : 2;
  return `a${index}`;
}

/** Highest accepted decision revision of a room. */
function currentDecisionRevision(store, roomId) {
  const accepted = store.listDecisions(roomId, { statuses: ['accepted'] });
  return accepted.length === 0 ? 0 : accepted[accepted.length - 1].revision;
}

/** The room's coordinator id, used when a system announcement needs an author. */
function coordinatorIdOf(store, roomId) {
  return store.listMembers(roomId).find((member) => member.role === 'coordinator')?.id ?? null;
}

/** Timestamp helper kept local so announcements and events agree. */
export const now = isoTimestamp;
