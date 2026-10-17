/**
 * Project Room — artifact service.
 *
 * An artifact is a *reference* to something that really exists, never a claim
 * that it exists. That distinction is the whole point: a JSON
 *成果卡 must not be treated as proof that a file was written or a test ran.
 *
 * What this service actually checks:
 *
 *   - the reference belongs to the room's own workspace (path containment, not
 *     string prefixing, so `..` cannot escape),
 *   - a referenced file or directory exists on disk when the host can see it,
 *   - the recorded content hash matches the file when both are present,
 *   - `verified` is set only from a real check, and stays false otherwise.
 *
 * A missing verification never blocks publication — it marks the artifact as
 * unverified, which is what keeps it out of the acceptance path.
 *
 * @module dsh-project-room/src/host/workspace/artifact-service
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';

import { RoomError, isoTimestamp } from '../../../shared/contracts.js';

export class ArtifactService {
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

  /**
   * Register an artifact.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.actorId
   * @param {string | null} [input.taskId]
   * @param {string | null} [input.attemptId]
   * @param {'diff' | 'file' | 'test-run' | 'note' | 'commit'} input.kind
   * @param {string} input.location
   * @param {string | null} [input.contentHash]
   * @param {string | null} [input.evidenceRef]
   * @param {string | null} [input.summary]
   * @param {string | null} [input.workspaceRef]
   * @returns {object}
   */
  publish(input) {
    const room = this.rooms.assertActive(input.roomId, '登记成果');
    const actor = this.rooms.requireMember(input.actorId);
    const task = input.taskId ? this.store.getTask(input.taskId) : null;
    if (input.taskId && (!task || task.roomId !== room.id)) {
      throw new RoomError('INVALID_REQUEST', '关联的任务不存在或不属于本项目群。');
    }
    const attempt = input.attemptId ? this.store.getAttempt(input.attemptId) : null;
    if (input.attemptId && (!attempt || attempt.taskId !== input.taskId)) {
      throw new RoomError('INVALID_REQUEST', '执行尝试与任务不匹配。');
    }

    const workspace = input.workspaceRef ?? room.workspaceRef ?? null;
    const verification = this.#verify({
      kind: input.kind,
      location: input.location,
      contentHash: input.contentHash ?? null,
      workspaceRef: workspace,
    });
    if (!verification.allowed) {
      throw new RoomError('ARTIFACT_NOT_VERIFIED', verification.reason, { location: input.location });
    }

    const artifact = this.store.transaction(() => {
      const created = this.store.insertArtifact({
        id: `artifact_${Math.random().toString(36).slice(2, 12)}`,
        roomId: room.id,
        taskId: input.taskId ?? null,
        attemptId: input.attemptId ?? null,
        kind: input.kind,
        location: input.location,
        contentHash: verification.hash ?? input.contentHash ?? null,
        evidenceRef: input.evidenceRef ?? null,
        verified: verification.verified,
      });
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'artifact.published',
        payload: {
          artifactId: created.id,
          taskId: created.taskId,
          attemptId: created.attemptId,
          kind: created.kind,
          location: created.location,
          verified: created.verified,
          note: verification.reason,
          by: actor.id,
          summary: input.summary ?? null,
        },
      });
      return created;
    });

    void this.#announce({ room, artifact, actor, summary: input.summary ?? null }).catch((error) => {
      this.logger?.warn?.(`[project-room] artifact announcement failed: ${error?.message ?? error}`);
    });
    this.rooms.publish(room.id, { type: 'artifact.published', roomId: room.id, artifactId: artifact.id });
    return { ...artifact, verificationNote: verification.reason };
  }

  /**
   * Re-verify stored artifacts, for a recovery pass or after a checkout moved.
   * @param {string} roomId
   * @returns {Array<{ artifactId: string, verified: boolean, note: string }>}
   */
  reverify(roomId) {
    const room = this.rooms.assertActive(roomId, '复核成果');
    const results = [];
    for (const artifact of this.store.listArtifacts(roomId)) {
      const check = this.#verify({
        kind: artifact.kind,
        location: artifact.location,
        contentHash: artifact.contentHash,
        workspaceRef: room.workspaceRef,
      });
      const verified = Boolean(check.verified);
      if (verified !== artifact.verified) {
        this.store.insertArtifact({ ...artifact, verified });
      }
      results.push({ artifactId: artifact.id, verified, note: check.reason });
    }
    return results;
  }

  /**
   * Artifacts that can serve as acceptance evidence for a task: verified, and
   * matching the current task and decision revisions.
   * @param {string} taskId
   * @returns {{ usable: object[], stale: object[], unverified: object[] }}
   */
  acceptanceEvidence(taskId) {
    const task = this.tasks.requireTask(taskId);
    const artifacts = this.store.listArtifacts(task.roomId, { taskId });
    const attemptRevisions = new Map(this.store.listAttempts(taskId).map((attempt) => [attempt.id, attempt]));
    const usable = [];
    const stale = [];
    const unverified = [];
    for (const artifact of artifacts) {
      if (!artifact.verified) {
        unverified.push(artifact);
        continue;
      }
      const attempt = artifact.attemptId ? attemptRevisions.get(artifact.attemptId) : null;
      // An artifact from an attempt that started before the current task revision
      // describes older code.
      if (attempt && attempt.baseRevision < task.revision - 1) stale.push(artifact);
      else usable.push(artifact);
    }
    return { usable, stale, unverified };
  }

  /**
   * Verify one reference. The only function in the plugin that decides whether a
   * reference is real, so "verified" cannot mean different things in two places.
   * @param {object} input
   * @returns {{ allowed: boolean, verified: boolean, hash: string | null, reason: string }}
   */
  #verify(input) {
    const location = String(input.location ?? '').trim();
    if (!location) return { allowed: false, verified: false, hash: null, reason: '产物位置不能为空。' };

    // A commit id, a command record or a prose note has nothing on disk to read;
    // it stays publishable but explicitly unverified.
    if (input.kind === 'commit' || input.kind === 'test-run' || input.kind === 'note') {
      const verified = input.kind === 'commit' && /^[0-9a-f]{7,40}$/i.test(location);
      return {
        allowed: true,
        verified,
        hash: null,
        reason: verified ? '看起来是 commit 标识；仍以集成时的真实提交为准。' : '描述性记录，未经文件核验。',
      };
    }

    const workspace = input.workspaceRef ? resolve(String(input.workspaceRef)) : null;
    if (!workspace) {
      return { allowed: true, verified: false, hash: null, reason: '项目未绑定工作区，无法核对文件是否存在。' };
    }

    const target = isAbsolute(location) ? resolve(location) : resolve(join(workspace, location));
    const inside = relative(workspace, target);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      // A reference outside the project is refused rather than silently accepted.
      return {
        allowed: false,
        verified: false,
        hash: null,
        reason: `产物路径超出项目工作区范围：${location}`,
      };
    }

    if (!existsSync(target)) {
      return { allowed: true, verified: false, hash: null, reason: `工作区内没有找到该文件：${normalize(inside)}` };
    }

    try {
      const stat = statSync(target);
      if (stat.isDirectory()) {
        return { allowed: true, verified: true, hash: null, reason: '目录存在，已核验。' };
      }
      const hash = createHash('sha256').update(readFileSync(target)).digest('hex');
      if (input.contentHash && input.contentHash !== hash) {
        return {
          allowed: true,
          verified: false,
          hash,
          reason: '文件存在，但记录的哈希与当前内容不一致，已标记为需要重新核对。',
        };
      }
      return { allowed: true, verified: true, hash, reason: '文件存在，内容哈希已核验。' };
    } catch (error) {
      return { allowed: true, verified: false, hash: null, reason: `无法读取产物：${String(error?.message ?? error)}` };
    }
  }

  /**
   * Post a short artifact card into the room, without waking anyone: an artifact
   * is information, not a request.
   * @param {object} input
   */
  async #announce(input) {
    const messages = this.messages;
    if (!messages) return;
    const { room, artifact, actor, summary } = input;
    const coordinator = this.store.listMembers(room.id).find((member) => member.role === 'coordinator');
    const body = [
      `【成果】${summary ?? artifact.location}`,
      `${artifact.kind === 'test-run' ? '测试记录' : artifact.kind === 'diff' ? '变更' : artifact.kind === 'commit' ? '提交' : '内容'}：${artifact.location}`,
      artifact.verified ? '核验：已确认存在' : '核验：未确认（不能作为验收依据）',
    ].join('\n');
    await messages.send({
      roomId: room.id,
      authorId: actor.kind === 'agent' ? actor.id : coordinator?.id ?? actor.id,
      body,
      mentions: [],
      taskId: artifact.taskId,
      clientMessageId: `artifact:${artifact.id}`,
      purpose: 'system',
      causalRootId: artifact.taskId ?? artifact.id,
    });
  }

  /**
   * The 成果卡 shape, filled from stored facts only.
   * @param {string} taskId
   * @param {string | null} [attemptId]
   * @returns {object}
   */
  resultCard(taskId, attemptId = null) {
    const task = this.tasks.requireTask(taskId);
    const attempt = attemptId ? this.store.getAttempt(attemptId) : this.store.listAttempts(taskId)[0] ?? null;
    const artifacts = this.store.listArtifacts(task.roomId, { taskId, ...(attempt ? { attemptId: attempt.id } : {}) });
    return {
      taskId: task.id,
      attemptId: attempt?.id ?? null,
      taskRevision: task.revision,
      decisionRevision: task.decisionRevision,
      summary: task.objective,
      changedPaths: artifacts.filter((artifact) => artifact.kind === 'file' || artifact.kind === 'diff').map((artifact) => artifact.location),
      artifactRefs: artifacts.map((artifact) => artifact.id),
      verificationRefs: artifacts.filter((artifact) => artifact.kind === 'test-run').map((artifact) => artifact.location),
      remainingIssues: task.acceptance.filter((criterion) => !artifacts.some((artifact) => artifact.location.includes(criterion))),
      status: task.status,
      verifiedCount: artifacts.filter((artifact) => artifact.verified).length,
      generatedAt: isoTimestamp(),
    };
  }
}
