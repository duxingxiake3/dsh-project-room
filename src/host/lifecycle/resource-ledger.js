/**
 * Project Room — resource ownership ledger (resource ownership).
 *
 * The ledger answers one question before a permanent delete: **which objects
 * does this project actually own, and which are borrowed, shared or of unknown
 * provenance?** It is a projection of facts the plugin already persists (member
 * sessions, dedicated research sessions, the project workspace), re-derived on
 * demand, so a restart cannot leave it claiming ownership that no longer holds.
 *
 * Deliberate limits:
 *
 *   - The source workspace is always `protected`; this ledger never deletes a
 *     path, and no caller may turn preview output into a recursive delete.
 *   - Two projects that point at the same canonical directory share ONE resource
 *     row with one share each; releasing one project decrements the count.
 *   - A session with no recorded ownership is `unknown` and stays protected.
 *
 * @module dsh-project-room/src/host/lifecycle/resource-ledger
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { canonicalPath, pathIdentity } from '../security/safe-path.js';

/** Kinds this plugin can prove it created or observed. */
export const RESOURCE_KINDS = Object.freeze(['member-session', 'research-session', 'workspace']);

/** @param {string} sessionId */
function shortRef(sessionId) {
  const text = String(sessionId ?? '');
  return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-4)}` : text;
}

export class ResourceLedger {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../adapter/host-adapter.js').HostAdapter} input.adapter
   * @param {(roomId: string) => object[]} [input.researchSessionRows]
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.adapter = input.adapter;
    this.researchSessionRows = input.researchSessionRows ?? (() => []);
    this.logger = input.logger ?? null;
  }

  /**
   * Re-derive this project's resources from persisted facts and link them to the
   * project. Returns the ledger rows as stored.
   * @param {string} roomId
   * @returns {object[]}
   */
  syncRoom(roomId) {
    const room = this.store.getRoom(roomId);
    if (!room) return [];
    const desired = this.#desiredResources(room);
    const expected = new Set();

    for (const source of desired) {
      const resource = this.#upsert(source);
      if (!resource) continue;
      const linked = this.store.linkResource(resource.id, roomId, 'owner');
      // A workspace stops being `shared` when its last second project releases
      // its share; the remaining project still only borrows the user's source.
      if (linked?.resource?.kind === 'workspace' && linked.refCount <= 1 && linked.resource.ownership === 'shared') {
        this.store.updateResource(resource.id, { ownership: 'borrowed' });
      }
      expected.add(resource.id);
    }

    // A member session that was released (or a research session that was
    // disposed) is no longer a live obligation for this project.
    for (const resource of this.store.listRoomResources(roomId)) {
      if (expected.has(resource.id)) continue;
      if (resource.kind === 'workspace') {
        // Keep the workspace share: the project still points at that path even
        // if the field was cleared after the fact. Conservative retention.
        continue;
      }
      this.store.releaseResourceShare(resource.id, roomId);
    }
    return this.store.listRoomResources(roomId);
  }

  /**
   * The cleanup preview: what a purge may release, and what must stay.
   * @param {string} roomId
   * @returns {object}
   */
  preview(roomId) {
    const resources = this.syncRoom(roomId);
    const deletable = [];
    const protectedResources = [];
    const sharedResources = [];
    const unknownResources = [];

    for (const resource of resources) {
      const entry = {
        id: resource.id,
        kind: resource.kind,
        displayName: this.#displayName(resource),
        hostRef: resource.hostRef,
        path: resource.canonicalPath,
        ownership: resource.ownership,
        refCount: resource.refCount,
        safeDeleteStatus: resource.safeDeleteStatus,
        evidenceRef: resource.evidenceRef,
      };
      if (resource.ownership === 'shared' || resource.refCount > 1) {
        sharedResources.push({ ...entry, reason: `仍有 ${resource.refCount} 个项目引用；只减少本项目引用，不删除对象。` });
      }
      if (resource.ownership === 'unknown' || resource.safeDeleteStatus === 'unknown') {
        unknownResources.push({ ...entry, reason: '历史资源归属无法核对；保守保留，需人工处理。' });
        protectedResources.push({
          id: `unknown:${resource.id}`,
          kind: 'unknown-resource',
          path: resource.hostRef ?? resource.canonicalPath,
          reason: '归属未知，不能自动清理。',
        });
        continue;
      }
      if (resource.safeDeleteStatus === 'deletable' && resource.ownership === 'owned') {
        deletable.push(entry);
        continue;
      }
      if (resource.kind === 'workspace') {
        protectedResources.push({
          id: `source:${resource.id}`,
          kind: 'source',
          path: resource.canonicalPath,
          reason: '项目源码与用户工作区默认保留；本操作不会删除它们。',
        });
        continue;
      }
      if (resource.ownership === 'borrowed') {
        protectedResources.push({
          id: `borrowed:${resource.id}`,
          kind: 'borrowed-session',
          path: resource.hostRef,
          reason: '借用的用户主会话只解除项目关联，不销毁、不清理它的日志。',
        });
      }
    }

    // Fixed non-resources the purge can never touch. Reported explicitly rather
    // than omitted, so the UI cannot imply they were cleaned.
    protectedResources.push(
      {
        id: 'worktrees',
        kind: 'worktree',
        path: null,
        reason: '插件没有登记可清理的独占 worktree；默认保留，未提交改动不会被静默移除。',
      },
      {
        id: 'host-logs',
        kind: 'host-log',
        path: null,
        reason: '宿主自己的会话日志不受插件管理；插件不能声称已删除它们。',
      },
    );

    return { deletableOwnedResources: deletable, protectedResources, sharedResources, unknownResources };
  }

  /**
   * Release every owned, deletable resource of a project. Each release is
   * independent: a failure is returned as a failed ref instead of aborting the
   * whole purge, because a partial failure must land in PURGE_BLOCKED with an
   * accurate residue list.
   *
   * @param {string} roomId
   * @returns {Promise<{ released: object[], failed: object[], skipped: object[] }>}
   */
  async releaseOwned(roomId) {
    const resources = this.syncRoom(roomId);
    const released = [];
    const failed = [];
    const skipped = [];
    for (const resource of resources) {
      if (resource.ownership !== 'owned' || resource.safeDeleteStatus !== 'deletable') {
        skipped.push({ resourceId: resource.id, kind: resource.kind, reason: resource.safeDeleteStatus });
        continue;
      }
      try {
        const outcome = await this.#releaseOne(resource);
        if (outcome.released) {
          this.store.releaseResourceShare(resource.id, roomId);
          released.push({ resourceId: resource.id, kind: resource.kind, hostRef: resource.hostRef, mode: outcome.mode });
        } else {
          failed.push({ resourceId: resource.id, kind: resource.kind, hostRef: resource.hostRef, reason: outcome.reason });
        }
      } catch (error) {
        failed.push({ resourceId: resource.id, kind: resource.kind, hostRef: resource.hostRef, reason: String(error?.message ?? error) });
        this.logger?.warn?.(`[project-room] release ${resource.kind} ${resource.id} failed: ${error?.message ?? error}`);
      }
    }
    return { released, failed, skipped };
  }

  /** A digest of the exact resources a deletion covered; auditable, not a path list. */
  static refsDigest(resources) {
    const stable = [...resources]
      .map((resource) => `${resource.kind}:${resource.id}:${resource.ownership}:${resource.refCount}`)
      .sort()
      .join('|');
    return createHash('sha256').update(stable).digest('hex');
  }

  /* ------------------------------------------------------------------ *
   * Internals
   * ------------------------------------------------------------------ */

  /** @param {object} room */
  #desiredResources(room) {
    const desired = [];
    const members = this.store.listMembers(room.id, { includeRetired: true });
    for (const member of members) {
      if (!member.sessionId) continue;
      const ownership = member.sessionOwnership === 'owned' ? 'owned' : member.sessionOwnership === 'borrowed' ? 'borrowed' : 'unknown';
      desired.push({
        roomId: room.id,
        kind: 'member-session',
        provenance: 'host-session',
        hostRef: member.sessionId,
        canonicalPath: null,
        ownership,
        safeDeleteStatus: ownership === 'owned' ? 'deletable' : ownership === 'borrowed' ? 'protected' : 'unknown',
        lastKnownState: member.status,
        evidenceRef: `member:${member.id}`,
      });
    }
    for (const session of this.researchSessionRows(room.id) ?? []) {
      const disposed = session.status === 'disposed';
      desired.push({
        roomId: room.id,
        kind: 'research-session',
        provenance: 'plugin-research-session',
        hostRef: session.sessionId,
        canonicalPath: null,
        ownership: 'owned',
        safeDeleteStatus: disposed ? 'released' : 'deletable',
        lastKnownState: session.status,
        evidenceRef: `research:${session.researchId}`,
      });
    }
    if (room.workspaceRef) {
      const canonical = canonicalPath(room.workspaceRef);
      desired.push({
        roomId: room.id,
        kind: 'workspace',
        provenance: 'user-workspace',
        hostRef: null,
        canonicalPath: canonical,
        ownership: 'borrowed',
        safeDeleteStatus: 'protected',
        lastKnownState: 'retained',
        evidenceRef: `workspace:${room.id}`,
      });
    }
    return desired;
  }

  /** @param {object} source */
  #upsert(source) {
    // Workspaces are identified by their canonical path because two projects can
    // point at the same directory. Sessions are identified by their host id.
    let existing = null;
    if (source.kind === 'workspace') {
      existing = this.#findWorkspace(source.canonicalPath);
    } else {
      existing = this.store.findResource({ kind: source.kind, hostRef: source.hostRef });
    }
    if (existing) {
      return this.store.updateResource(existing.id, {
        safeDeleteStatus: source.safeDeleteStatus === 'protected' ? existing.safeDeleteStatus : source.safeDeleteStatus,
        lastKnownState: source.lastKnownState,
        evidenceRef: source.evidenceRef,
      });
    }
    const created = this.store.upsertResource(source);
    return created;
  }

  /** @param {string} canonical */
  #findWorkspace(canonical) {
    const identity = pathIdentity(canonical);
    return this.store.listResourcesByKind('workspace').find((resource) => resource.canonicalPath && pathIdentity(resource.canonicalPath) === identity) ?? null;
  }

  /** @param {object} resource */
  async #releaseOne(resource) {
    if (resource.kind === 'member-session') {
      const memberId = String(resource.evidenceRef ?? '').replace(/^member:/, '');
      if (!memberId || memberId === resource.evidenceRef) return { released: false, reason: '缺少成员归属证据' };
      const live = this.adapter.agentOf(memberId);
      if (!live) return { released: true, mode: 'already-absent' };
      const ok = await this.adapter.releaseOwnedMember(memberId);
      return ok ? { released: true, mode: 'disposed' } : { released: false, reason: '宿主释放会话失败' };
    }
    if (resource.kind === 'research-session') {
      if (!this.adapter.researchSession(resource.hostRef)) return { released: true, mode: 'already-absent' };
      const ok = await this.adapter.releaseResearchSession(resource.hostRef);
      return ok ? { released: true, mode: 'disposed' } : { released: false, reason: '宿主释放研究会话失败' };
    }
    return { released: false, reason: `不清理的资源类型：${resource.kind}` };
  }

  /** @param {object} resource */
  #displayName(resource) {
    if (resource.kind === 'workspace') return `工作区 ${basename(resource.canonicalPath ?? '') || resource.canonicalPath}`;
    if (resource.kind === 'research-session') return `研究会话 ${shortRef(resource.hostRef)}`;
    return `成员会话 ${shortRef(resource.hostRef)}`;
  }
}
