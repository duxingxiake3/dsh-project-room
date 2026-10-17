/**
 * Project Room — room and membership service.
 *
 * Owns rooms, the member table, aliases, and the room timeline. It does not
 * deliver anything: delivery belongs to {@link DeliveryCoordinator}, which keeps
 * "the message is saved" and "the host accepted the input" as the two different
 * facts they are.
 *
 * @module dsh-project-room/src/host/room/room-service
 */

import { randomUUID } from 'node:crypto';

import {
  ROLE_TEMPLATES,
  RoomError,
  TASK_STATUS_LABELS,
  isoTimestamp,
  roleTemplate,
} from '../../../shared/contracts.js';
import { MentionResolver, mergeMentions, normalizeName } from '../../../shared/mention-resolver.js';
import { DEFAULT_MODEL_SETTINGS } from '../models/model-service.js';
import { composeCoordinatorInstructions, composePersonaInstructions, DEFAULT_PERSONA } from './persona.js';

/** Room-level defaults. */
export const DEFAULT_ROOM_CONFIG = Object.freeze({
  collaboration: {
    topology: 'all-to-all',
    maxActiveAgents: 4,
    autoResumeAfterRestart: true,
  },
  models: { ...DEFAULT_MODEL_SETTINGS },
  planning: {
    defaultMode: 'plan-and-execute-authorized',
    decomposeProjectGoals: true,
    reuseExistingMembers: true,
    autoCreateMissingRoles: true,
    requireAcyclicDependencies: true,
    requireAcceptanceCriteria: true,
  },
  mentions: {
    avatarMenu: true,
    picker: true,
    plainText: true,
    fullWidthAt: true,
    unresolved: 'ask-or-send-as-text',
  },
  delivery: {
    preferredMode: 'steer',
    unsupportedSteerFallback: 'queue-with-visible-status',
    uncertainDelivery: 'reconcile-before-retry',
  },
  conversation: {
    defaultHumanRecipient: 'coordinator',
    publishFinalReplies: true,
    proactiveTaskCommunication: true,
    automaticCourtesyReplies: false,
  },
  persona: { ...DEFAULT_PERSONA },
  execution: {
    gitIsolation: 'worktree-per-write-attempt',
    nonGitWriteMode: 'sequential',
    preserveHostPermissions: true,
  },
  loopHandling: {
    deduplicateRequests: true,
    detectNonProductiveCycles: true,
    pauseOnlyAffectedAutomaticChain: true,
  },
  budget: { softLimit: null, hardLimit: null },
});

export class RoomService {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../adapter/host-adapter.js').HostAdapter} input.adapter
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.adapter = input.adapter;
    this.logger = input.logger ?? null;
    /** @type {Set<(event: object) => void>} */
    this.subscribers = new Set();
  }

  /* ---------------------------------------------------------------- *
   * Creation
   * ---------------------------------------------------------------- */

  /**
   * Create a room with its coordinator and optional specialist members.
   *
   * The room row, its members and the `room.created` event commit in ONE
   * transaction, so a failure never leaves a half-built team.
   * Sessions are created after the commit: the durable identity exists first,
   * which is what lets an interrupted creation be reconciled instead of
   * duplicated.
   *
   * @param {object} input
   * @param {string} input.title
   * @param {string} [input.workspaceRef]
   * @param {string} input.ownerRef
   * @param {string} [input.goal]
   * @param {Array<{ role: string, displayName?: string, handle?: string, aliases?: string[], modelProfileRef?: string | null, modelLocked?: boolean }>} [input.members]
   * @param {object} [input.config]
   * @param {string} [input.cwd]                 Working directory for member sessions.
   * @param {(input: object) => Promise<object>} [input.createSession] Injected session factory (the plugin wires the adapter here).
   * @returns {Promise<{ room: object, members: object[], warnings: string[] }>}
   */
  async createRoom(input) {
    const roomId = `room_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const coordinatorId = `member_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const humanId = `member_human_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const requested = Array.isArray(input.members) && input.members.length > 0 ? input.members : [{ role: 'coordinator' }];
    const hasCoordinator = requested.some((member) => member.role === 'coordinator');
    const plan = hasCoordinator ? requested : [{ role: 'coordinator' }, ...requested];

    const room = this.store.transaction(() => {
      const created = this.store.insertRoom({
        id: roomId,
        title: input.title || '未命名项目群',
        workspaceRef: input.workspaceRef ?? null,
        ownerRef: input.ownerRef,
        status: 'active',
        language: 'zh-CN',
        planRevision: 0,
        membershipRevision: 0,
        lastSeq: 0,
        config: mergeConfig(DEFAULT_ROOM_CONFIG, input.config),
      });

      // The human member is a real member: `@用户` must resolve, and the
      // timeline must show who is speaking.
      this.store.insertMember({
        id: humanId,
        roomId,
        kind: 'human',
        role: 'owner',
        displayName: '我',
        handle: 'user',
        aliases: ['用户', '老板'],
        status: 'idle',
        membershipRevision: 1,
      });
      this.#registerAliases(roomId, humanId, ['user', '用户', '老板', '我']);

      let revision = this.store.bumpMembershipRevision(roomId);
      for (const requestedMember of plan) {
        const template = roleTemplate(requestedMember.role) ?? ROLE_TEMPLATES[0];
        const memberId = requestedMember.role === 'coordinator' && !hasCoordinator ? coordinatorId : `member_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
        const handle = requestedMember.handle ?? this.#uniqueHandle(roomId, template.handle);
        const aliasCandidates = requestedMember.aliases ?? template.aliases;
        const member = this.store.insertMember({
          id: memberId,
          roomId,
          kind: 'agent',
          role: requestedMember.role,
          displayName: requestedMember.displayName ?? `${template.title}·${handle}`,
          handle,
          aliases: aliasCandidates,
          status: 'idle',
          membershipRevision: revision,
          modelProfileRef: requestedMember.modelProfileRef ?? null,
          selectionSource: requestedMember.modelProfileRef ? 'member-fixed' : 'project-default',
          modelLocked: requestedMember.modelLocked !== false,
        });
        this.#registerAliases(roomId, member.id, [handle, member.displayName, ...aliasCandidates]);
        revision = this.store.bumpMembershipRevision(roomId);
        this.store.updateMember(member.id, { membershipRevision: revision });
      }

      this.store.appendEvent({
        roomId,
        eventType: 'room.created',
        payload: { title: created.title, ownerRef: created.ownerRef, goal: input.goal ?? null },
      });
      if (input.goal) {
        this.store.appendEvent({
          roomId,
          eventType: 'room.goal',
          payload: { goal: input.goal, sourceMessageId: null },
        });
      }
      return this.store.getRoom(roomId);
    });

    const warnings = [];
    const members = this.store.listMembers(roomId);
    for (const member of members) {
      if (member.kind !== 'agent') continue;
      try {
        await input.createSession?.({
          memberId: member.id,
          roomId,
          roomTitle: room.title,
          displayName: member.displayName,
          handle: member.handle,
          role: member.role,
          cwd: input.cwd,
          goal: input.goal ?? '',
          member,
        });
      } catch (error) {
        warnings.push(`${member.displayName} 的会话创建失败：${String(error?.message ?? error)}`);
        this.store.updateMember(member.id, { status: 'offline' });
        this.store.appendEvent({
          roomId,
          eventType: 'member.session.failed',
          payload: { memberId: member.id, error: String(error?.message ?? error) },
        });
      }
    }

    this.publish(roomId, { type: 'room.created', roomId });
    return { room: this.store.getRoom(roomId), members: this.store.listMembers(roomId), warnings };
  }

  /* ---------------------------------------------------------------- *
   * Membership
   * ---------------------------------------------------------------- */

  /**
   * Add a member to an existing room, idempotently by `requestKey`.
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.role
   * @param {string} [input.displayName]
   * @param {string} [input.handle]
   * @param {string[]} [input.aliases]
   * @param {string | null} [input.modelProfileRef]
   * @param {string} [input.requestKey]
   * @param {string} [input.cwd]
   * @param {(input: object) => Promise<object>} [input.createSession]
   * @returns {Promise<{ member: object, created: boolean, warning: string | null }>}
   */
  async ensureMember(input) {
    const room = this.requireRoom(input.roomId);
    const requestKey = input.requestKey ?? `${input.roomId}|${input.role}|${input.displayName ?? ''}`;
    const dispatchKey = `member-ensure|${requestKey}`;
    const claim = this.store.claimDispatch({
      dispatchKey,
      roomId: input.roomId,
      memberId: null,
      state: 'pending',
      detail: JSON.stringify({ role: input.role, displayName: input.displayName ?? null }),
    });

    if (!claim.claimed) {
      const existingId = claim.record.memberId;
      const existing = existingId ? this.store.getMember(existingId) : null;
      if (existing) return { member: existing, created: false, warning: null };
      // The intent was recorded but the member never materialised: an
      // interrupted creation. Fall through and create it exactly once.
    }

    const template = roleTemplate(input.role) ?? { role: input.role, handle: input.role, title: input.role, aliases: [], duties: '' };
    const handle = input.handle ?? this.#uniqueHandle(input.roomId, template.handle);
    const aliases = (input.aliases ?? template.aliases).filter(Boolean);
    const memberId = `member_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

    const member = this.store.transaction(() => {
      const created = this.store.insertMember({
        id: memberId,
        roomId: input.roomId,
        kind: 'agent',
        role: input.role,
        displayName: input.displayName ?? `${template.title}·${handle}`,
        handle,
        aliases,
        status: 'idle',
        membershipRevision: this.store.getRoom(input.roomId).membershipRevision + 1,
        modelProfileRef: input.modelProfileRef ?? null,
        selectionSource: input.modelProfileRef ? 'member-fixed' : 'project-default',
        modelLocked: Boolean(input.modelProfileRef),
      });
      this.#registerAliases(input.roomId, created.id, [handle, created.displayName, ...aliases]);
      this.store.bumpMembershipRevision(input.roomId);
      this.store.appendEvent({
        roomId: input.roomId,
        eventType: 'member.joined',
        payload: { memberId: created.id, role: created.role, displayName: created.displayName, handle: created.handle },
      });
      return created;
    });
    this.store.updateDispatch(dispatchKey, {
      state: 'created',
      // Recording the member id on the intent row is what makes a retry reuse
      // this member instead of creating a second one.
      memberId: member.id,
      detail: JSON.stringify({ memberId: member.id }),
    });

    let warning = null;
    try {
      await input.createSession?.({
        memberId: member.id,
        roomId: input.roomId,
        roomTitle: room.title,
        displayName: member.displayName,
        handle: member.handle,
        role: member.role,
        cwd: input.cwd,
        goal: room.config?.goal ?? '',
        member,
      });
    } catch (error) {
      warning = `${member.displayName} 的会话创建失败：${String(error?.message ?? error)}`;
      this.store.updateMember(member.id, { status: 'offline' });
    }

    this.publish(input.roomId, { type: 'member.joined', roomId: input.roomId, memberId: member.id });
    return { member: this.store.getMember(member.id), created: true, warning };
  }

  /**
   * Change a member's member-level fields. Renaming keeps every existing
   * `memberId` reference valid, which is what makes renamed members keep
   * receiving the mentions that were bound to them.
   * @param {object} input
   * @param {string} input.memberId
   * @param {Partial<{ displayName: string, aliases: string[], role: string, status: string }>} input.patch
   * @param {number} [input.expectedRevision]
   * @returns {object}
   */
  updateMember(input) {
    const member = this.store.getMember(input.memberId);
    if (!member) throw new RoomError('NOT_FOUND', `成员 ${input.memberId} 不存在。`);
    if (Number.isFinite(input.expectedRevision) && input.expectedRevision !== member.membershipRevision) {
      throw new RoomError('REVISION_CONFLICT', '成员表已被更新，请刷新后重试。', {
        current: member.membershipRevision,
        expected: input.expectedRevision,
      });
    }

    const patch = { ...input.patch };
    const namesToRegister = [];
    if (patch.displayName && patch.displayName !== member.displayName) namesToRegister.push(patch.displayName);
    if (Array.isArray(patch.aliases)) namesToRegister.push(...patch.aliases);

    return this.store.transaction(() => {
      for (const name of namesToRegister) {
        const normalized = normalizeName(name);
        if (!normalized) throw new RoomError('INVALID_REQUEST', '别名不能为空。');
        this.store.registerAlias({ roomId: member.roomId, normalizedAlias: normalized, memberId: member.id });
      }
      const updated = this.store.updateMember(member.id, {
        ...patch,
        membershipRevision: this.store.getRoom(member.roomId).membershipRevision + 1,
      });
      this.store.bumpMembershipRevision(member.roomId);
      this.store.appendEvent({
        roomId: member.roomId,
        eventType: 'member.updated',
        payload: { memberId: member.id, patch: Object.keys(patch) },
      });
      return updated;
    });
  }

  /**
   * Pause a member: no new automatic execution, messages and tasks preserved.
   * @param {string} memberId
   * @returns {object}
   */
  pauseMember(memberId) {
    const member = this.store.getMember(memberId);
    if (!member) throw new RoomError('NOT_FOUND', `成员 ${memberId} 不存在。`);
    const updated = this.store.updateMember(memberId, { status: 'paused' });
    this.store.appendEvent({ roomId: member.roomId, eventType: 'member.paused', payload: { memberId } });
    this.publish(member.roomId, { type: 'member.updated', roomId: member.roomId, memberId });
    return updated;
  }

  /**
   * Resume a member: sync the versions they missed before work continues.
   * @param {string} memberId
   * @returns {object}
   */
  resumeMember(memberId) {
    const member = this.store.getMember(memberId);
    if (!member) throw new RoomError('NOT_FOUND', `成员 ${memberId} 不存在。`);
    const room = this.store.getRoom(member.roomId);
    const updated = this.store.updateMember(memberId, {
      status: 'idle',
      lastSeenSeq: room.lastSeq,
      lastAppliedDecisionRevision: currentDecisionRevision(this.store, member.roomId),
    });
    this.store.appendEvent({
      roomId: member.roomId,
      eventType: 'member.resumed',
      payload: { memberId, syncedToSeq: room.lastSeq },
    });
    this.publish(member.roomId, { type: 'member.updated', roomId: member.roomId, memberId });
    return updated;
  }

  /**
   * Retire a member: stop new assignments, keep their authorship, tombstone
   * their aliases, and hand their open tasks back as "needs handover".
   * @param {string} memberId
   * @returns {{ member: object, openTasks: object[] }}
   */
  retireMember(memberId) {
    const member = this.store.getMember(memberId);
    if (!member) throw new RoomError('NOT_FOUND', `成员 ${memberId} 不存在。`);
    const openTasks = this.store
      .listTasks(member.roomId, { ownerId: memberId })
      .filter((task) => !['accepted', 'cancelled', 'superseded'].includes(task.status));
    return this.store.transaction(() => {
      this.store.retireAliases(memberId, member.roomId);
      const updated = this.store.updateMember(memberId, { status: 'offline' });
      this.store.bumpMembershipRevision(member.roomId);
      this.store.appendEvent({
        roomId: member.roomId,
        eventType: 'member.retired',
        payload: { memberId, openTaskIds: openTasks.map((task) => task.id) },
      });
      for (const task of openTasks) {
        this.store.updateTask(task.id, { needsSync: true });
      }
      this.publish(member.roomId, { type: 'member.retired', roomId: member.roomId, memberId });
      return { member: updated, openTasks };
    });
  }

  /* ---------------------------------------------------------------- *
   * Timeline
   * ---------------------------------------------------------------- */

  /**
   * The room timeline after a cursor, with per-message delivery state. This is
   * what the client renders and what `room_read` returns.
   * @param {object} input
   * @param {string} input.roomId
   * @param {number} [input.afterSeq]
   * @param {number} [input.limit]
   * @param {string} [input.threadId]
   * @param {string} [input.taskId]
   * @returns {Promise<{ room: object, members: object[], messages: object[], events: object[], nextSeq: number, capabilities: object }>}
   */
  async snapshot(input) {
    const room = this.requireRoom(input.roomId);
    const messages = this.store.listMessages(input.roomId, {
      afterSeq: input.afterSeq ?? 0,
      limit: input.limit ?? 200,
      threadId: input.threadId,
      taskId: input.taskId,
    });
    const nextSeq = messages.length > 0 ? messages[messages.length - 1].seq : (input.afterSeq ?? 0);
    return {
      room,
      members: this.store.listMembers(input.roomId, { includeRetired: true }),
      messages,
      // A message and its `message.created` event share one seq, so "events
      // after the cursor" is the same cursor the timeline uses; a reconnect
      // therefore refills from storage instead of relying on a push.
      events: this.store
        .listMessages(input.roomId, { afterSeq: nextSeq, limit: 0 })
        .slice(0, 0),
      nextSeq,
      capabilities: this.adapter.capabilities(),
    };
  }

  /**
   * Everything the task/decision/artifact side panel needs.
   * @param {string} roomId
   * @returns {object}
   */
  board(roomId) {
    const room = this.requireRoom(roomId);
    const tasks = this.store.listTasks(roomId);
    const decisions = this.store.listDecisions(roomId);
    return {
      room,
      plan: this.store.listPlans(roomId)[0] ?? null,
      plans: this.store.listPlans(roomId),
      tasks: tasks.map((task) => ({
        ...task,
        statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status,
        attempts: this.store.listAttempts(task.id),
        artifacts: this.store.listArtifacts(roomId, { taskId: task.id }),
      })),
      decisions: decisions.map((decision) => ({
        ...decision,
        acks: this.store.listDecisionAcks(decision.id),
      })),
      discussions: this.store.listDiscussions(roomId),
      reminders: this.store.listReminders(roomId, { state: 'pending' }),
      notes: this.store.listAdminNotes(roomId, 20),
    };
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  /** @param {string} roomId */
  requireRoom(roomId) {
    const room = this.store.getRoom(roomId);
    if (!room) throw new RoomError('NOT_FOUND', `项目群 ${roomId} 不存在。`);
    return room;
  }

  /**
   * The execution gate shared by task, plan and artifact mutations. A paused,
   * archived or trashed project must not gain new work; only the lifecycle
   * service may move it back to `active`.
   * @param {string} roomId
   * @param {string} action
   * @returns {object}
   */
  assertActive(roomId, action = '执行工作') {
    const room = this.requireRoom(roomId);
    if (room.status === 'trashed') {
      throw new RoomError('ROOM_TRASHED', `项目在回收站中，已阻止${action}；请先恢复项目。`, { status: room.status });
    }
    if (room.status === 'purging') {
      throw new RoomError('ROOM_PURGING', `项目正在永久删除，已阻止${action}；不能在新工作中复活它。`, { status: room.status });
    }
    if (room.status === 'quiescing') {
      throw new RoomError('ROOM_QUIESCING', `项目正在停止执行，已阻止${action}；请等待核对完成。`, { status: room.status });
    }
    if (room.status === 'archived') {
      throw new RoomError('ROOM_ARCHIVED', `项目已归档，已阻止${action}；请先恢复为暂停态再启动。`, { status: room.status });
    }
    if (room.status === 'paused') {
      throw new RoomError('ROOM_PAUSED', `项目已暂停，已阻止${action}；请先恢复运行。`, { status: room.status });
    }
    return room;
  }

  /**
   * The read-only gate for management writes. Pausing stops execution but still
   * allows the owner to prepare members and models; archiving and the recycle bin
   * are read-only until restored.
   * @param {string} roomId
   * @param {string} action
   * @returns {object}
   */
  assertWritable(roomId, action = '修改项目') {
    const room = this.requireRoom(roomId);
    if (room.status === 'trashed') {
      throw new RoomError('ROOM_TRASHED', `项目在回收站中，已阻止${action}；请先恢复项目。`, { status: room.status });
    }
    if (room.status === 'purging') {
      throw new RoomError('ROOM_PURGING', `项目正在永久删除，已阻止${action}。`, { status: room.status });
    }
    if (room.status === 'quiescing') {
      throw new RoomError('ROOM_QUIESCING', `项目正在停止执行，已阻止${action}；请等待核对完成。`, { status: room.status });
    }
    if (room.status === 'archived') {
      throw new RoomError('ROOM_ARCHIVED', `项目已归档，已阻止${action}；请先恢复为暂停态。`, { status: room.status });
    }
    return room;
  }

  /** @param {string} memberId */
  requireMember(memberId) {
    const member = this.store.getMember(memberId);
    if (!member) throw new RoomError('NOT_A_ROOM_MEMBER', `成员 ${memberId} 不属于任何项目群。`);
    return member;
  }

  /**
   * A resolver pinned to the room's current member table revision.
   * @param {string} roomId
   * @returns {MentionResolver}
   */
  resolverFor(roomId) {
    const room = this.requireRoom(roomId);
    return new MentionResolver({
      members: this.store.listMembers(roomId),
      membershipRevision: room.membershipRevision,
      tombstones: this.store.listTombstones(roomId),
    });
  }

  /**
   * Resolve a body without sending — the client's preview path, using the same
   * library and the same rules as the server ( rule 11).
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.body
   * @param {import('../../../shared/contracts.js').Mention[]} [input.mentions]
   * @param {number} [input.membershipRevision]
   * @returns {object}
   */
  resolveMentions(input) {
    const room = this.requireRoom(input.roomId);
    const resolver = this.resolverFor(input.roomId);
    const merged = mergeMentions({
      body: input.body ?? '',
      mentions: input.mentions ?? [],
      resolver,
      membershipRevision: input.membershipRevision,
    });
    const members = this.store.listMembers(input.roomId);
    const nameOf = (memberId) => members.find((member) => member.id === memberId)?.displayName ?? memberId;
    return {
      targets: merged.targets.map((mention) => ({ ...mention, displayName: nameOf(mention.targetMemberId) })),
      unknownText: merged.unknownText,
      ambiguous: merged.ambiguous.map((entry) => ({
        ...entry,
        candidates: entry.candidates.map((candidate) => ({ memberId: candidate, displayName: nameOf(candidate) })),
      })),
      hints: merged.hints,
      stale: merged.stale || merged.stale === false ? merged.stale : false,
      membershipRevision: room.membershipRevision,
    };
  }

  /**
   * Publish a room event to subscribers (the client's live-update hook).
   * @param {string} roomId
   * @param {object} event
   */
  publish(roomId, event) {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber({ roomId, ...event, at: isoTimestamp() });
      } catch (error) {
        this.logger?.warn?.(`[project-room] subscriber failed: ${error?.message ?? error}`);
      }
    }
  }

  /** @param {(event: object) => void} subscriber */
  subscribe(subscriber) {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /**
   * The instruction block for one member, composed from current room state.
   * @param {string} memberId
   * @returns {string}
   */
  instructionsFor(memberId) {
    const member = this.requireMember(memberId);
    const room = this.requireRoom(member.roomId);
    const peers = this.store
      .listMembers(member.roomId)
      .filter((other) => other.id !== member.id)
      .map((other) => `${other.displayName}（@${other.handle}）`);
    const currentTask = member.currentTaskId ? this.store.getTask(member.currentTaskId) : null;
    const persona = composePersonaInstructions({
      displayName: member.displayName,
      role: member.role,
      handle: member.handle,
      roomTitle: room.title,
      peerNames: peers,
      duties: roleTemplate(member.role)?.duties ?? '',
      currentTask: currentTask ? `${currentTask.objective}（${TASK_STATUS_LABELS[currentTask.status] ?? currentTask.status}）` : null,
      persona: room.config?.persona,
    });
    if (member.role !== 'coordinator') return persona;
    const goal = room.config?.goal ?? '';
    return `${persona}\n\n${composeCoordinatorInstructions({ roomTitle: room.title, goal })}`;
  }

  #uniqueHandle(roomId, base) {
    const existing = new Set(this.store.listMembers(roomId, { includeRetired: true }).map((member) => member.handle));
    if (!existing.has(base)) return base;
    let index = 2;
    while (existing.has(`${base}${index}`)) index += 1;
    return `${base}${index}`;
  }

  #registerAliases(roomId, memberId, names) {
    for (const name of names) {
      const normalized = normalizeName(name);
      if (!normalized) continue;
      try {
        this.store.registerAlias({ roomId, normalizedAlias: normalized, memberId });
      } catch (error) {
        if (error instanceof RoomError && error.code === 'MENTION_AMBIGUOUS') {
          // A colliding alias is a configuration problem the user must resolve,
          // not a reason to fail the whole join. The member is still reachable by
          // handle and display name.
          this.store.addAdminNote(roomId, 'alias-conflict', `${memberId} 无法注册别名“${normalized}”：${error.message}`);
          continue;
        }
        throw error;
      }
    }
  }
}

/**
 * Merge user-supplied configuration over the defaults, one level deep per
 * section so a partial section does not erase its siblings.
 * @param {object} base
 * @param {object} [override]
 * @returns {object}
 */
export function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return { ...base };
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      merged[key] = { ...base[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Highest accepted decision revision in a room, used when a member resumes.
 * @param {import('../storage/store.js').RoomStore} store
 * @param {string} roomId
 * @returns {number}
 */
function currentDecisionRevision(store, roomId) {
  const accepted = store.listDecisions(roomId, { statuses: ['accepted'] });
  return accepted.length === 0 ? 0 : accepted[accepted.length - 1].revision;
}
