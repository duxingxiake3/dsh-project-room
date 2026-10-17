/**
 * Project Room — project lifecycle.
 *
 * This service owns the lifecycle of ONE project (one room id): pause, resume,
 * archive, restore, move to the recycle bin, restore from it, and permanent
 * purge. It deliberately does not own chats, plans or tasks; those stay in the
 * existing services. What it adds is a revisioned, idempotent gate around them.
 *
 * Truthfulness rules enforced here:
 *
 *   - a transition **fences first**: the room status/state that blocks new work
 *     is persisted before any running agent is asked to stop, so a crash during
 *     the stop leaves a visible `BLOCKED` project rather than an open one;
 *   - a stop request is never reported as a confirmed stop. `confirmed` is a
 *     re-read of the host's real agent status after the request; when it cannot
 *     be proven, the project stops in `BLOCKED` and a human must reconcile or
 *     cancel the pending request;
 *   - a trash operation is a **soft delete**: the room, messages, tasks and
 *     decisions remain in SQLite; the source workspace is never touched;
 *   - a restore verifies the structural snapshot taken at trash time, and comes
 *     back as PAUSED, not ACTIVE — the user decides when to run again;
 *   - a purge refuses while an agent is still running, releases only
 *     plugin-owned resources through the ownership ledger, and keeps a minimal
 *     tombstone plus deletion audit after deleting the project's plugin data;
 *     a partial failure lands in `PURGE_BLOCKED` with the exact failed refs and
 *     can be retried idempotently;
 *   - the source workspace and worktrees are never deleted by this module.
 *     Optional source cleanup is a separate, explicitly unauthorised operation.
 *
 * @module dsh-project-room/src/host/lifecycle/lifecycle-service
 */

import { createHash, randomUUID } from 'node:crypto';

import { RoomError, isoTimestamp } from '../../../shared/contracts.js';
import { ResourceLedger } from './resource-ledger.js';

/** How long a trashed project stays recoverable before the UI says it expired. */
export const DEFAULT_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Lifecycle states a transition may start from. */
const ALLOWED_FROM = Object.freeze({
  pause: new Set(['ACTIVE']),
  resume: new Set(['PAUSED']),
  archive: new Set(['ACTIVE', 'PAUSED']),
  restore: new Set(['ARCHIVED', 'TRASHED', 'PURGE_BLOCKED', 'BLOCKED']),
  trash: new Set(['ACTIVE', 'PAUSED', 'ARCHIVED']),
  purge: new Set(['TRASHED', 'PURGE_BLOCKED']),
  reconcile: new Set(['PAUSING', 'QUIESCING', 'BLOCKED', 'PURGE_BLOCKED']),
  cancel: new Set(['QUIESCING', 'BLOCKED']),
});

/** Transient states a crash may leave behind; never auto-completed. */
const TRANSIENT_STATES = new Set(['PAUSING', 'QUIESCING', 'PURGING']);

/** Structural counts that must still match when a trashed project is restored. */
const SNAPSHOT_KEYS = Object.freeze(['members', 'agents', 'ownedSessions', 'borrowedSessions', 'tasks', 'decisions', 'artifacts', 'plans', 'discussions']);

/**
 * The lifecycle state shown to the UI. Prefers the persisted state; a room from
 * an older schema derives it from the status the gates already use.
 * @param {string} status
 * @param {string} [state]
 * @returns {string}
 */
export function lifecycleStateOf(status, state) {
  if (state) return state;
  if (status === 'trashed') return 'TRASHED';
  if (status === 'archived') return 'ARCHIVED';
  if (status === 'paused') return 'PAUSED';
  if (status === 'quiescing') return 'QUIESCING';
  if (status === 'purging') return 'PURGING';
  return 'ACTIVE';
}

/** The admission status that belongs to a finished lifecycle state. */
function statusOfState(state) {
  if (state === 'ACTIVE' || state === 'PAUSING') return 'active';
  if (state === 'PAUSED' || state === 'BLOCKED') return 'paused';
  if (state === 'QUIESCING') return 'quiescing';
  if (state === 'ARCHIVED') return 'archived';
  if (state === 'TRASHED' || state === 'PURGE_BLOCKED') return 'trashed';
  if (state === 'PURGING') return 'purging';
  return 'paused';
}

/**
 * A stable digest of the structural snapshot. Mutable ledgers (messages,
 * events, deliveries) are intentionally not part of it: a late reply that was
 * fenced by the trash must not block an otherwise intact restore.
 * @param {object} counts
 * @returns {string}
 */
function snapshotDigest(counts) {
  const stable = SNAPSHOT_KEYS.map((key) => `${key}:${Number(counts[key] ?? 0)}`).join('|');
  return createHash('sha256').update(stable).digest('hex');
}

/** Whole days until an ISO timestamp, floored at zero. */
function daysUntil(value) {
  if (!value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 86_400_000));
}

export class ProjectLifecycleService {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../adapter/host-adapter.js').HostAdapter} input.adapter
   * @param {(input: object) => Promise<object>} [input.ensureMemberSession]
   * @param {(roomId: string) => object[]} [input.researchSessionRows]
   * @param {object} [input.logger]
   * @param {number} [input.retentionMs]
   */
  constructor(input) {
    this.store = input.store;
    this.adapter = input.adapter;
    this.ensureMemberSession = input.ensureMemberSession ?? null;
    this.logger = input.logger ?? null;
    this.retentionMs = Number.isFinite(input.retentionMs) && input.retentionMs > 0 ? input.retentionMs : DEFAULT_TRASH_RETENTION_MS;
    this.resources = new ResourceLedger({
      store: this.store,
      adapter: this.adapter,
      researchSessionRows: input.researchSessionRows ?? (() => []),
      logger: this.logger,
    });
  }

  /** All projects, including archived and trashed, decorated for the UI. */
  list() {
    return this.store.listRooms().map((room) => this.#decorate(room));
  }

  /** One project's lifecycle view: status, revision, counts, stop state, actions. */
  inspect(roomId) {
    const room = this.#requireRoom(roomId);
    const counts = this.store.roomStats(roomId);
    const stop = this.#stopSummary(roomId);
    const ledger = this.resources.preview(roomId);
    return {
      ...this.#decorate(room),
      counts,
      stop,
      resources: ledger,
      trashSnapshot: this.store.getTrashSnapshot(roomId),
      deletionAudits: this.store.listDeletionAudits(roomId),
      actions: this.#availableActions(room, stop, counts),
      sourceWorkspacePreserved: true,
    };
  }

  /** The cleanup preview shown before a permanent delete. */
  preview(roomId) {
    const room = this.#requireRoom(roomId);
    const counts = this.store.roomStats(roomId);
    const ledger = this.resources.preview(roomId);
    return {
      projectId: room.id,
      title: room.title,
      status: room.status,
      lifecycleState: lifecycleStateOf(room.status, room.lifecycleState),
      lifecycleRevision: room.lifecycleRevision,
      lifecyclePending: room.lifecyclePending ?? null,
      workspaceRef: room.workspaceRef ?? null,
      trashExpiresAt: room.trashExpiresAt ?? null,
      trashDaysLeft: daysUntil(room.trashExpiresAt),
      counts,
      pluginManagedData: [
        `群消息 ${counts.messages} 条、投递 ${counts.deliveries} 条`,
        `成员绑定 ${counts.members} 个（AI ${counts.agents} 个）`,
        `任务 ${counts.tasks} 个、计划 ${counts.plans} 个、决定 ${counts.decisions} 个`,
        `成果索引 ${counts.artifacts} 个、专题 ${counts.discussions} 个、提醒 ${counts.reminders} 条`,
        '生命周期操作日志、资源归属清单与回收站快照',
      ],
      deletableOwnedResources: ledger.deletableOwnedResources,
      protectedResources: ledger.protectedResources,
      sharedResources: ledger.sharedResources,
      unknownResources: ledger.unknownResources,
      deletionAudits: this.store.listDeletionAudits(room.id),
      sourceWorkspacePreserved: true,
      approvalRequired: true,
      note: '永久删除只清理插件私有数据，并保留最小审计墓碑；源代码、借用会话和宿主日志默认保留。',
    };
  }

  /** Pause a project and ask running agents to stop at a safe point. */
  async pause(roomId, input = {}) {
    return this.#transition('pause', roomId, input, async (room, operationId) => {
      const started = this.#begin(room, {
        status: 'paused',
        lifecycleState: 'PAUSING',
        pending: this.#pending('pause', 'PAUSED', room.status, operationId),
      });
      const stop = await this.#requestStopAndVerify(room.id);
      if (stop.confirmed) {
        const finished = this.#finish(started, { lifecycleState: 'PAUSED', pending: null });
        this.#event(finished, 'pause', room.status, stop, operationId);
        return { room: finished, stop, blocked: false, to: 'paused' };
      }
      const blocked = this.#finish(started, { lifecycleState: 'BLOCKED', pending: { ...started.lifecyclePending, stop } });
      this.#event(blocked, 'pause.blocked', room.status, stop, operationId);
      return { room: blocked, stop, blocked: true, to: 'paused' };
    });
  }

  /** Resume a paused project. Sessions are re-created after the status is durable. */
  async resume(roomId, input = {}) {
    return this.#transition('resume', roomId, input, async (room, operationId) => {
      const updated = this.store.transaction(() => {
        const next = this.store.updateRoom(room.id, {
          status: 'active',
          lifecycleState: 'ACTIVE',
          lifecycleRevision: room.lifecycleRevision + 1,
          lifecycleEpoch: room.lifecycleEpoch + 1,
          lifecyclePending: null,
          lastLifecycleOpId: operationId,
        });
        this.#event(next, 'resume', room.status, null, operationId);
        return next;
      });
      const sessions = await this.#ensureSessions(room.id);
      return { room: this.store.getRoom(room.id) ?? updated, sessions, blocked: false, to: 'active' };
    });
  }

  /** Archive a project: read-only history, no automatic execution. */
  async archive(roomId, input = {}) {
    return this.#transition('archive', roomId, input, async (room, operationId) => {
      const started = this.#begin(room, {
        status: 'archived',
        lifecycleState: 'QUIESCING',
        pending: this.#pending('archive', 'ARCHIVED', room.status, operationId),
      });
      const stop = await this.#requestStopAndVerify(room.id);
      if (stop.confirmed) {
        const finished = this.#finish(started, { lifecycleState: 'ARCHIVED', pending: null });
        this.#event(finished, 'archive', room.status, stop, operationId);
        return { room: finished, stop, blocked: false, to: 'archived' };
      }
      const blocked = this.#finish(started, { lifecycleState: 'BLOCKED', pending: { ...started.lifecyclePending, stop } });
      this.#event(blocked, 'archive.blocked', room.status, stop, operationId);
      return { room: blocked, stop, blocked: true, to: 'archived' };
    });
  }

  /**
   * Restore an archived project, or a trashed one after verifying its snapshot.
   * Restore always lands in PAUSED; the user starts work explicitly.
   */
  async restore(roomId, input = {}) {
    return this.#transition('restore', roomId, input, async (room, operationId) => {
      const state = lifecycleStateOf(room.status, room.lifecycleState);
      if (state === 'PURGING' || room.status === 'purging') {
        throw new RoomError('PROJECT_BUSY', '永久删除正在进行或中断待核对，不能直接恢复；请先重试核对清理。', { lifecycleState: state });
      }
      let snapshot = null;
      let resourceDrift = null;
      if (room.status === 'trashed') {
        snapshot = this.store.getTrashSnapshot(room.id);
        if (!snapshot) {
          throw new RoomError('PROJECT_SNAPSHOT_MISSING', '这个项目在回收站里没有可核验的恢复快照，已拒绝恢复。');
        }
        const counts = this.store.roomStats(room.id);
        if (snapshotDigest(counts) !== snapshot.snapshotDigest) {
          throw new RoomError('PROJECT_SNAPSHOT_MISMATCH', '回收站快照与当前项目结构不一致，已拒绝恢复；请保留现场并检查数据库。', {
            expected: snapshot.snapshotDigest,
            actual: snapshotDigest(counts),
          });
        }
        const currentResources = ResourceLedger.refsDigest(this.store.listRoomResources(room.id));
        if (snapshot.counts?.resourceDigest && snapshot.counts.resourceDigest !== currentResources) {
          resourceDrift = { expected: snapshot.counts.resourceDigest, actual: currentResources };
        }
      }
      const updated = this.store.transaction(() => {
        const next = this.store.updateRoom(room.id, {
          status: 'paused',
          lifecycleState: 'PAUSED',
          lifecycleRevision: room.lifecycleRevision + 1,
          lifecycleEpoch: room.lifecycleEpoch + 1,
          lifecyclePending: null,
          deletedAt: null,
          trashExpiresAt: null,
          lastLifecycleOpId: operationId,
        });
        this.store.deleteTrashSnapshot(room.id);
        this.#event(next, 'restore', room.status, null, operationId);
        return next;
      });
      return {
        room: updated,
        snapshotVerified: Boolean(snapshot),
        resourceDrift,
        abandonedCleanup: state === 'PURGE_BLOCKED',
        blocked: false,
        to: 'paused',
      };
    });
  }

  /** Move to the recycle bin: fence, stop, snapshot, keep all plugin data. */
  async trash(roomId, input = {}) {
    return this.#transition('trash', roomId, input, async (room, operationId) => {
      const started = this.#begin(room, {
        status: 'quiescing',
        lifecycleState: 'QUIESCING',
        pending: this.#pending('trash', 'TRASHED', room.status, operationId),
      });
      const stop = await this.#requestStopAndVerify(room.id);
      if (!stop.confirmed) {
        const blocked = this.#finish(started, { lifecycleState: 'BLOCKED', pending: { ...started.lifecyclePending, stop } });
        this.#event(blocked, 'trash.blocked', room.status, stop, operationId);
        return { room: blocked, stop, blocked: true, stopPending: true, to: 'quiescing' };
      }
      const trashed = this.#commitTrash(started, started.lifecyclePending, operationId, stop);
      return {
        room: trashed.room,
        stop,
        blocked: false,
        to: 'trashed',
        trashExpiresAt: trashed.trashExpiresAt,
        daysLeft: trashed.daysLeft,
      };
    });
  }

  /**
   * Permanently delete the plugin-private data of a trashed project. Requires
   * the exact project title and an explicit acknowledgement; refuses while any
   * agent is still running. Source, worktrees and borrowed sessions stay.
   *
   * The irreversible work is a small saga: fence to PURGING, release each owned
   * resource independently, then delete the rows in one transaction. A failed
   * release flips to PURGE_BLOCKED and keeps the project recoverable; a retry
   * skips what was already released.
   */
  async purge(roomId, input = {}) {
    return this.#transition('purge', roomId, input, async (room, operationId) => {
      if (input.confirmTitle !== room.title) {
        throw new RoomError('INVALID_REQUEST', '永久删除需要输入完整的项目名称作为二次确认。');
      }
      if (input.acknowledgeIrreversible !== true) {
        throw new RoomError('INVALID_REQUEST', '永久删除需要明确确认“插件数据不可恢复”。');
      }
      const stop = this.#stopSummary(room.id);
      if (stop.running.length > 0) {
        throw new RoomError('PROJECT_BUSY', '仍有成员正在执行，已拒绝永久删除；请先停止并核对后再试。', {
          running: stop.running,
        });
      }

      const purging = this.#begin(room, {
        status: 'purging',
        lifecycleState: 'PURGING',
        pending: { action: 'purge', operationId, requestedAt: isoTimestamp(), requestedBy: input.requestedBy ?? null },
      });
      const resources = this.resources.syncRoom(room.id);
      const ownedRefs = resources.filter((resource) => resource.ownership === 'owned');
      const refsDigest = ResourceLedger.refsDigest(resources);
      const release = await this.resources.releaseOwned(room.id);
      const counts = this.store.roomStats(room.id);

      if (release.failed.length > 0) {
        const blocked = this.store.transaction(() => {
          this.store.insertDeletionAudit({
            operationId,
            projectId: room.id,
            humanActorRef: input.requestedBy ?? null,
            approvedScopeDigest: input.operationScopeDigest ?? null,
            affectedRefsDigest: refsDigest,
            result: 'blocked',
            failedRefs: release.failed,
          });
          const next = this.store.updateRoom(room.id, {
            status: 'trashed',
            lifecycleState: 'PURGE_BLOCKED',
            lifecycleRevision: purging.lifecycleRevision + 1,
            lifecycleEpoch: purging.lifecycleEpoch + 1,
            lifecyclePending: {
              action: 'purge',
              operationId,
              requestedAt: isoTimestamp(),
              failedRefs: release.failed,
              releasedRefs: release.released,
              refsDigest,
            },
            lastLifecycleOpId: operationId,
          });
          this.#event(next, 'purge.blocked', room.status, null, operationId);
          return next;
        });
        throw new RoomError('PROJECT_PURGE_BLOCKED', '部分独占资源未能释放；项目数据已保留并进入“清理受阻”，请处理残留后重试。', {
          failedRefs: release.failed,
          releasedRefs: release.released,
          lifecycleState: lifecycleStateOf(blocked.status, blocked.lifecycleState),
        });
      }

      const audit = {
        operationId,
        projectId: room.id,
        humanActorRef: input.requestedBy ?? null,
        approvedScopeDigest: input.operationScopeDigest ?? null,
        affectedRefsDigest: refsDigest,
        result: 'purged',
        failedRefs: [],
      };
      const purged = this.store.transaction(() => {
        this.store.insertDeletionAudit(audit);
        return this.store.purgeRoom(room.id, {
          operationId,
          projectId: room.id,
          action: 'purge',
          result: 'purged',
          counts,
        });
      });
      return {
        purged: true,
        to: 'purged',
        projectId: room.id,
        title: room.title,
        counts,
        releasedOwnedResources: release.released,
        failedOwnedResources: [],
        skippedResources: release.skipped,
        ownedResourceCount: ownedRefs.length,
        retainedBorrowedSessions: resources
          .filter((resource) => resource.ownership === 'borrowed' && resource.kind === 'member-session')
          .map((resource) => String(resource.evidenceRef ?? '').replace(/^member:/, '') || resource.id),
        protectedResources: this.store.listRoomResources(room.id).filter((resource) => resource.ownership !== 'owned').length,
        sourceWorkspacePreserved: true,
        workspaceRef: room.workspaceRef ?? null,
        refsDigest,
        audit,
        tombstone: purged.tombstone ?? null,
      };
    });
  }

  /**
   * A human re-check after a stop came back unknown. It re-reads the host's real
   * agent status; only a confirmed stop completes the pending transition. A
   * purge residue is reported for an explicit retry rather than retried here.
   * @param {string} roomId
   * @param {object} [input]
   */
  async reconcile(roomId, input = {}) {
    return this.#transition('reconcile', roomId, input, async (room, operationId) => {
      const state = lifecycleStateOf(room.status, room.lifecycleState);
      if (state === 'PURGE_BLOCKED') {
        const failedRefs = room.lifecyclePending?.failedRefs ?? [];
        return {
          room,
          blocked: true,
          reason: 'PURGE_BLOCKED',
          failedRefs,
          message: '永久删除仍有残留资源；请审计后重试永久删除，或从回收站恢复项目。',
          to: 'trashed',
        };
      }
      const pending = room.lifecyclePending;
      if (!pending) throw new RoomError('INVALID_REQUEST', '没有待核对的停止请求。');
      const stop = await this.#requestStopAndVerify(room.id);
      if (!stop.confirmed) {
        const blocked = this.#finish(room, { lifecycleState: 'BLOCKED', pending: { ...pending, stop, lastCheckedAt: isoTimestamp() } });
        this.#event(blocked, `${pending.action}.blocked`, room.status, stop, operationId);
        return { room: blocked, stop, blocked: true, to: statusOfState(blocked.lifecycleState) };
      }
      const finished = await this.#completePending(room, pending, operationId, stop);
      return { room: finished.room, stop, blocked: false, to: finished.to, trashExpiresAt: finished.trashExpiresAt ?? null };
    });
  }

  /**
   * Cancel a pending stop that has not caused an irreversible deletion. The room
   * returns to the status it had before the request; a purge cannot be cancelled.
   * @param {string} roomId
   * @param {object} [input]
   */
  async cancel(roomId, input = {}) {
    return this.#transition('cancel', roomId, input, async (room, operationId) => {
      const pending = room.lifecyclePending;
      if (!pending) throw new RoomError('INVALID_REQUEST', '没有待取消的生命周期请求。');
      if (pending.action === 'purge') {
        throw new RoomError('INVALID_REQUEST', '永久删除不可取消；请重试清理，或从回收站恢复项目。');
      }
      const previousStatus = pending.previousStatus;
      if (!['active', 'paused', 'archived', 'trashed'].includes(previousStatus)) {
        throw new RoomError('INVALID_REQUEST', '待取消请求没有可恢复的原状态。');
      }
      const updated = this.store.transaction(() => {
        const next = this.store.updateRoom(room.id, {
          status: previousStatus,
          lifecycleState: previousStatus === 'active' ? 'ACTIVE' : previousStatus === 'paused' ? 'PAUSED' : previousStatus === 'archived' ? 'ARCHIVED' : 'TRASHED',
          lifecycleRevision: room.lifecycleRevision + 1,
          lifecycleEpoch: room.lifecycleEpoch + 1,
          lifecyclePending: null,
          lastLifecycleOpId: operationId,
        });
        this.#event(next, `${pending.action}.cancelled`, room.status, null, operationId);
        return next;
      });
      return { room: updated, cancelled: true, blocked: false, to: previousStatus };
    });
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  /**
   * A process can die after fencing a project and before the transition commits
   * its result. On restart, never guess that the transition succeeded: mark the
   * operation failed and put the room in the honest blocked state that requires
   * a human reconcile (or an explicit purge retry).
   * @returns {{ recovered: number, blocked: number }}
   */
  recoverStaleOperations() {
    const running = this.store.listLifecycleOperations('running');
    let recovered = 0;
    const handledRooms = new Set();
    for (const operation of running) {
      const room = this.store.getRoom(operation.roomId);
      const detail = room
        ? `进程重启时生命周期操作未完成；项目当前状态为 ${room.status}，请核对后重试。`
        : '进程重启时生命周期操作未完成，项目已不存在。';
      this.store.updateLifecycleOperation(operation.id, {
        state: 'failed',
        detail,
        finishedAt: isoTimestamp(),
      });
      if (room) {
        this.store.appendEvent({
          roomId: operation.roomId,
          eventType: 'lifecycle.recovered',
          payload: { operationId: operation.id, action: operation.action, roomStatus: room.status },
        });
        handledRooms.add(operation.roomId);
      }
      recovered += 1;
    }

    let blocked = 0;
    for (const room of this.store.listRooms()) {
      const state = lifecycleStateOf(room.status, room.lifecycleState);
      const transient = TRANSIENT_STATES.has(state) || room.status === 'quiescing' || room.status === 'purging';
      if (!transient) continue;
      const operationId = room.lastLifecycleOpId ?? `recover-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      this.#recoverRoom(room, operationId);
      blocked += 1;
      if (!handledRooms.has(room.id)) handledRooms.add(room.id);
    }
    if (recovered > 0) this.logger?.warn?.(`[project-room] marked ${recovered} interrupted lifecycle operation(s) as failed`);
    if (blocked > 0) this.logger?.warn?.(`[project-room] ${blocked} project(s) require lifecycle reconciliation after restart`);
    return { recovered, blocked };
  }

  /** @param {string} roomId */
  #requireRoom(roomId) {
    const room = this.store.getRoom(roomId);
    if (!room) throw new RoomError('NOT_FOUND', `项目 ${roomId} 不存在。`);
    return room;
  }

  #decorate(room) {
    const lifecycleState = lifecycleStateOf(room.status, room.lifecycleState);
    return {
      ...room,
      projectId: room.id,
      lifecycleState,
      lifecyclePending: room.lifecyclePending ?? null,
      trashDaysLeft: daysUntil(room.trashExpiresAt),
    };
  }

  #availableActions(room, stop, counts) {
    const state = lifecycleStateOf(room.status, room.lifecycleState);
    const running = stop.running.length > 0;
    const pending = room.lifecyclePending ?? null;
    const blocked = state === 'BLOCKED' || state === 'QUIESCING' || state === 'PAUSING';
    return {
      pause: state === 'ACTIVE',
      resume: state === 'PAUSED',
      archive: state === 'ACTIVE' || state === 'PAUSED',
      restore: state === 'ARCHIVED' || state === 'TRASHED' || state === 'PURGE_BLOCKED' || (state === 'BLOCKED' && pending?.action !== 'trash'),
      trash: state === 'ACTIVE' || state === 'PAUSED' || state === 'ARCHIVED',
      purge: (state === 'TRASHED' || state === 'PURGE_BLOCKED') && !running && state !== 'PURGING',
      preview: room.status === 'trashed' || state === 'PURGE_BLOCKED',
      reconcile: Boolean(blocked || state === 'PURGE_BLOCKED'),
      cancel: Boolean(blocked && pending && pending.action !== 'purge'),
      stopPending: Boolean(pending && pending.action !== 'purge'),
      blockedReason:
        state === 'BLOCKED'
          ? '停止尚未确认；请重试核对，或取消尚未造成不可逆删除的请求。'
          : state === 'PURGE_BLOCKED'
            ? '部分独占资源未能释放；请审计残留后重试永久删除。'
            : running
              ? '仍有成员正在执行；永久删除会拒绝，先停止并核对。'
              : null,
      counts,
    };
  }

  #stopSummary(roomId) {
    const members = this.store.listMembers(roomId, { includeRetired: false }).filter((member) => member.kind === 'agent');
    const running = [];
    const idle = [];
    const absent = [];
    for (const member of members) {
      const status = this.adapter.statusOf(member.id);
      if (status === 'running') running.push({ memberId: member.id, displayName: member.displayName });
      else if (status === 'idle') idle.push({ memberId: member.id, displayName: member.displayName });
      else absent.push({ memberId: member.id, displayName: member.displayName });
    }
    return { running, idle, absent, requested: 0, confirmed: false };
  }

  /**
   * Ask every running agent to stop, then RE-READ the host status. A request is
   * not a confirmation: `confirmed` is true only when no member still reports
   * `running` after the request.
   * @param {string} roomId
   * @returns {Promise<object>}
   */
  async #requestStopAndVerify(roomId) {
    const summary = this.#stopSummary(roomId);
    let requested = 0;
    for (const entry of summary.running) {
      try {
        if (this.adapter.requestStop(entry.memberId)) requested += 1;
      } catch (error) {
        this.logger?.warn?.(`[project-room] stop ${entry.memberId} failed: ${error?.message ?? error}`);
      }
    }
    const stillRunning = [];
    for (const entry of summary.running) {
      if (this.adapter.statusOf(entry.memberId) === 'running') stillRunning.push(entry);
    }
    return {
      running: summary.running,
      idle: summary.idle,
      absent: summary.absent,
      requested,
      stillRunning,
      confirmed: stillRunning.length === 0,
      checkedAt: isoTimestamp(),
    };
  }

  #pending(action, target, previousStatus, operationId) {
    return {
      action,
      target,
      previousStatus,
      operationId,
      requestedAt: isoTimestamp(),
      running: [],
      requested: 0,
    };
  }

  /**
   * Persist the fence before any stop request. This increments both the
   * optimistic-concurrency revision and the fencing epoch.
   * @param {object} room
   * @param {{ status: string, lifecycleState: string, pending: object }} next
   */
  #begin(room, next) {
    return this.store.updateRoom(room.id, {
      status: next.status,
      lifecycleState: next.lifecycleState,
      lifecyclePending: next.pending,
      lifecycleRevision: room.lifecycleRevision + 1,
      lifecycleEpoch: room.lifecycleEpoch + 1,
      lastLifecycleOpId: next.pending?.operationId ?? room.lastLifecycleOpId,
    });
  }

  /** Persist the completed (or blocked) state; the fence status may change again. */
  #finish(room, patch) {
    return this.store.updateRoom(room.id, {
      ...patch,
      lifecycleRevision: room.lifecycleRevision + 1,
      lifecycleEpoch: room.lifecycleEpoch + 1,
    });
  }

  /**
   * Complete a pending target after a confirmed stop: pause/archive finish where
   * they already are, trash writes the recoverable snapshot and moves to the bin.
   * @param {object} room
   * @param {object} pending
   * @param {string} operationId
   * @param {object} stop
   */
  async #completePending(room, pending, operationId, stop) {
    if (pending.target === 'TRASHED') {
      const trashed = this.#commitTrash(room, pending, operationId, stop);
      return { room: trashed.room, to: 'trashed', trashExpiresAt: trashed.trashExpiresAt };
    }
    const lifecycleState = pending.target;
    const updated = this.store.transaction(() => {
      const next = this.store.updateRoom(room.id, {
        lifecycleState,
        lifecyclePending: null,
        lifecycleRevision: room.lifecycleRevision + 1,
        lifecycleEpoch: room.lifecycleEpoch + 1,
        lastLifecycleOpId: operationId,
      });
      this.#event(next, 'reconcile', room.status, stop, operationId);
      return next;
    });
    return { room: updated, to: statusOfState(lifecycleState) };
  }

  /**
   * Write the recoverable snapshot and enter the recycle bin, in one transaction.
   * @param {object} room
   * @param {object} pending
   * @param {string} operationId
   * @param {object} stop
   */
  #commitTrash(room, pending, operationId, stop) {
    const now = isoTimestamp();
    const expiresAt = new Date(Date.now() + this.retentionMs).toISOString();
    const roomId = room.id;
    const store = this.store;
    const resources = this.resources.syncRoom(roomId);
    const resourceDigest = ResourceLedger.refsDigest(resources);
    const updated = store.transaction(() => {
      const next = store.updateRoom(roomId, {
        status: 'trashed',
        lifecycleState: 'TRASHED',
        lifecycleRevision: room.lifecycleRevision + 1,
        lifecycleEpoch: room.lifecycleEpoch + 1,
        lifecyclePending: null,
        lastLifecycleOpId: operationId,
        deletedAt: now,
        trashExpiresAt: expiresAt,
      });
      store.appendEvent({
        roomId,
        eventType: 'project.lifecycle.changed',
        payload: {
          action: 'trash',
          from: pending.previousStatus,
          to: 'trashed',
          lifecycleRevision: next.lifecycleRevision,
          operationId,
          stop: stop ? { requested: stop.requested, running: stop.running.length, confirmed: stop.confirmed } : null,
        },
      });
      const counts = store.roomStats(roomId);
      store.saveTrashSnapshot({
        roomId,
        snapshotRef: `room:${roomId}@r${next.lifecycleRevision}`,
        snapshotDigest: snapshotDigest(counts),
        counts: { ...counts, resourceDigest },
        revision: next.lifecycleRevision,
        expiresAt,
      });
      return next;
    });
    return { room: updated, trashExpiresAt: expiresAt, daysLeft: daysUntil(expiresAt) };
  }

  /**
   * Restart recovery for one transient room. A purge in flight becomes
   * PURGE_BLOCKED (the released resources are already recorded, so a retry is
   * safe); a stop in flight becomes BLOCKED and needs a human reconcile.
   * @param {object} room
   * @param {string} operationId
   */
  #recoverRoom(room, operationId) {
    const state = lifecycleStateOf(room.status, room.lifecycleState);
    if (state === 'PURGING' || room.status === 'purging') {
      const failedRefs = room.lifecyclePending?.failedRefs ?? [{ reason: '进程重启时永久删除中断，残留清单未知；请审计后重试。' }];
      this.store.transaction(() => {
        this.store.insertDeletionAudit({
          operationId,
          projectId: room.id,
          humanActorRef: null,
          approvedScopeDigest: room.lifecyclePending?.refsDigest ?? null,
          affectedRefsDigest: room.lifecyclePending?.refsDigest ?? null,
          result: 'blocked',
          failedRefs,
        });
        const next = this.store.updateRoom(room.id, {
          status: 'trashed',
          lifecycleState: 'PURGE_BLOCKED',
          lifecycleRevision: room.lifecycleRevision + 1,
          lifecycleEpoch: room.lifecycleEpoch + 1,
          lifecyclePending: {
            action: 'purge',
            operationId,
            requestedAt: isoTimestamp(),
            failedRefs,
            releasedRefs: room.lifecyclePending?.releasedRefs ?? [],
            note: 'PROCESS_RESTART',
          },
        });
        this.store.appendEvent({
          roomId: room.id,
          eventType: 'project.lifecycle.recovered',
          payload: { operationId, action: 'purge', lifecycleState: next.lifecycleState },
        });
      });
      return;
    }
    const pending = room.lifecyclePending ?? {
      action: state === 'PAUSING' ? 'pause' : 'trash',
      target: state === 'PAUSING' ? 'PAUSED' : 'TRASHED',
      previousStatus: room.status === 'quiescing' ? 'paused' : room.status,
      operationId,
      requestedAt: isoTimestamp(),
    };
    const next = this.store.updateRoom(room.id, {
      lifecycleState: 'BLOCKED',
      lifecyclePending: { ...pending, lastCheckedAt: isoTimestamp(), note: 'PROCESS_RESTART' },
      lifecycleRevision: room.lifecycleRevision + 1,
      lifecycleEpoch: room.lifecycleEpoch + 1,
    });
    this.store.appendEvent({
      roomId: room.id,
      eventType: 'project.lifecycle.recovered',
      payload: { operationId, action: pending.action, lifecycleState: next.lifecycleState },
    });
  }

  async #ensureSessions(roomId) {
    if (!this.ensureMemberSession) return { resumed: 0, failed: [] };
    const members = this.store.listMembers(roomId, { includeRetired: false }).filter((member) => member.kind === 'agent' && member.status !== 'offline');
    let resumed = 0;
    const failed = [];
    for (const member of members) {
      try {
        await this.ensureMemberSession({ memberId: member.id, roomId });
        resumed += 1;
      } catch (error) {
        failed.push({ memberId: member.id, message: String(error?.message ?? error) });
        this.logger?.warn?.(`[project-room] resume ${member.id} after lifecycle resume failed: ${error?.message ?? error}`);
      }
    }
    return { resumed, failed };
  }

  #event(room, action, from, stop, operationId) {
    try {
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'project.lifecycle.changed',
        payload: {
          action,
          from,
          to: room.status,
          lifecycleState: room.lifecycleState,
          lifecycleRevision: room.lifecycleRevision,
          operationId,
          stop: stop ? { requested: stop.requested, running: stop.running.length, confirmed: stop.confirmed } : null,
        },
      });
    } catch (error) {
      // The status change is already durable; a failed audit event must be visible
      // to the operator but must not roll back the lifecycle transition.
      this.logger?.warn?.(`[project-room] lifecycle event failed: ${error?.message ?? error}`);
    }
  }

  async #transition(action, roomId, input, apply) {
    const key = String(input.idempotencyKey ?? `life-${randomUUID()}`);
    const existing = this.store.findLifecycleOperationByKey(key);
    if (existing) {
      if (existing.roomId !== roomId || existing.action !== action) {
        throw new RoomError('REVISION_CONFLICT', '这个幂等键已经用于另一个项目或另一种操作，已拒绝复用。', {
          idempotencyKey: key,
        });
      }
      if (existing.state === 'running') {
        throw new RoomError('PROJECT_BUSY', '同一项目生命周期操作正在执行，请稍后重试。', { operationId: existing.id });
      }
      if (existing.state === 'done' && existing.result) {
        return { ...existing.result, duplicate: true, operation: existing };
      }
      throw new RoomError('INVALID_REQUEST', `上一次生命周期操作失败：${existing.detail ?? '未知原因'}`, { operationId: existing.id });
    }

    const room = this.#requireRoom(roomId);
    const state = lifecycleStateOf(room.status, room.lifecycleState);
    if (!ALLOWED_FROM[action]?.has(state)) {
      throw new RoomError('INVALID_REQUEST', `项目当前状态是 ${state}，不能执行 ${action}。`, {
        lifecycleState: state,
        status: room.status,
        action,
      });
    }
    if (action === 'restore' && state === 'BLOCKED' && room.lifecyclePending?.action === 'trash') {
      throw new RoomError('INVALID_REQUEST', '回收站请求仍在等待停止确认；请先核对或取消该请求。', { lifecycleState: state });
    }
    if (input.expectedLifecycleRevision !== undefined && input.expectedLifecycleRevision !== room.lifecycleRevision) {
      throw new RoomError('REVISION_CONFLICT', '项目生命周期版本已变化，请刷新后再试。', {
        expected: input.expectedLifecycleRevision,
        actual: room.lifecycleRevision,
      });
    }

    const operation = this.store.insertLifecycleOperation({
      id: `op_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      roomId,
      action,
      state: 'running',
      expectedRevision: input.expectedLifecycleRevision ?? room.lifecycleRevision,
      requestedBy: input.requestedBy ?? null,
      idempotencyKey: key,
    });

    try {
      const outcome = await apply(room, operation.id);
      const result = {
        action,
        projectId: room.id,
        from: state,
        to: outcome?.to ?? (action === 'purge' ? 'purged' : lifecycleStateOf(this.store.getRoom(room.id)?.status, this.store.getRoom(room.id)?.lifecycleState)),
        room: outcome?.room ?? null,
        ...outcome,
      };
      const finished = this.store.updateLifecycleOperation(operation.id, {
        state: 'done',
        result,
        finishedAt: isoTimestamp(),
      });
      try {
        this.onTransition?.(action, roomId, result);
      } catch (error) {
        this.logger?.warn?.(`[project-room] lifecycle transition hook failed: ${error?.message ?? error}`);
      }
      return { ...result, operation: finished };
    } catch (error) {
      this.store.updateLifecycleOperation(operation.id, {
        state: 'failed',
        detail: String(error?.message ?? error),
        finishedAt: isoTimestamp(),
      });
      throw error;
    }
  }
}
