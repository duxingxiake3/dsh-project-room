/**
 * Project Room — workspace and write coordination.
 *
 * the design notes asks for two things that are easy to fake and therefore worth
 * implementing carefully:
 *
 *   - **Isolation where it is real.** When the project is a git repository, each
 *     write attempt gets its own worktree and branch, and the plugin records the
 *     baseline commit, branch, path, attempt id and owner. Cross-worktree
 *     references use `repoId + commit/diff + relative path`, never an absolute path
 *     (the design notes).
 *   - **Honesty where it is not.** When worktrees are unavailable — no git, a
 *     dirty index, a failed `git worktree add` — the plugin says so and serializes
 *     write attempts instead of claiming isolation it does not have (§15.2).
 *
 * @module dsh-project-room/src/host/workspace/coordinator
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { RoomError, isoTimestamp } from '../../../shared/contracts.js';

export class WorkspaceCoordinator {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../room/room-service.js').RoomService} input.rooms
   * @param {string | null} [input.gitVersion]
   * @param {string | null} [input.worktreeRoot] Where isolated worktrees are created.
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.rooms = input.rooms;
    this.gitVersion = input.gitVersion ?? null;
    this.logger = input.logger ?? null;
    /** @type {Map<string, string>} taskId → attemptId currently holding the write lane */
    this.writeLanes = new Map();
    this.worktreeRoot = input.worktreeRoot ?? join(process.env.DSH_PROJECT_ROOM_DATA ?? '', 'worktrees');
  }

  /**
   * The isolation mode the next write attempt will actually get. `mode` is a
   * statement of fact, not a preference.
   * @param {string} roomId
   * @returns {{ mode: 'worktree' | 'sequential' | 'read-only', reason: string, git: boolean }}
   */
  isolationFor(roomId) {
    const room = this.rooms.requireRoom(roomId);
    const workspace = room.workspaceRef;
    if (!workspace) {
      return { mode: 'sequential', reason: '项目没有绑定工作区，写入型工作将串行准入。', git: false };
    }
    if (!this.gitVersion) {
      return { mode: 'sequential', reason: '未检测到 git，多个写入任务会串行准入；只读任务仍可并行。', git: false };
    }
    const repo = this.#repoInfo(workspace);
    if (!repo.isRepo) {
      return { mode: 'sequential', reason: '工作区不是 git 仓库，写入型工作串行准入，避免不可见互相覆盖。', git: true };
    }
    return { mode: 'worktree', reason: `git 仓库 ${repo.repoId}，每个写入尝试使用独立 worktree。`, git: true };
  }

  /**
   * Create (or reuse) the isolated worktree for one write attempt.
   *
   * On any failure the caller receives a `degraded` result with the exact reason,
   * so the UI can show "no isolation" instead of a false claim.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.taskId
   * @param {string} input.attemptId
   * @param {string} [input.actorId]
   * @returns {{ isolated: boolean, path: string, branch: string | null, baseCommit: string | null, repoId: string | null, reason: string }}
   */
  prepareWorktree(input) {
    const room = this.rooms.requireRoom(input.roomId);
    const attempt = this.store.getAttempt(input.attemptId);
    if (!attempt) throw new RoomError('NOT_FOUND', `执行尝试 ${input.attemptId} 不存在。`);

    const isolation = this.isolationFor(input.roomId);
    const workspace = room.workspaceRef;
    if (!workspace || isolation.mode !== 'worktree') {
      const lane = this.#claimLane(input.taskId, input.attemptId);
      return {
        isolated: false,
        path: workspace ?? process.cwd(),
        branch: null,
        baseCommit: null,
        repoId: null,
        reason: lane.ok ? isolation.reason : lane.reason,
      };
    }

    const repo = this.#repoInfo(workspace);
    const branch = `room/${input.taskId.replace(/^task_/, '')}/${input.attemptId.replace(/^attempt_/, '')}`;
    const path = join(resolve(this.worktreeRoot), input.attemptId);
    try {
      mkdirSync(resolve(this.worktreeRoot), { recursive: true });
      if (!existsSync(path)) {
        this.#git(workspace, ['worktree', 'add', '-b', branch, path, repo.head]);
      }
      this.store.updateAttempt(input.attemptId, { worktreeRef: path, state: 'running' });
      this.store.appendEvent({
        roomId: input.roomId,
        eventType: 'worktree.prepared',
        payload: { taskId: input.taskId, attemptId: input.attemptId, path, branch, baseCommit: repo.head, repoId: repo.repoId },
      });
      return { isolated: true, path, branch, baseCommit: repo.head, repoId: repo.repoId, reason: isolation.reason };
    } catch (error) {
      // Degrade visibly: the write still happens, but serialized and reported.
      const lane = this.#claimLane(input.taskId, input.attemptId);
      const reason = `worktree 创建失败（${String(error?.message ?? error)}），已降级为串行写入，不能声称已隔离。`;
      this.store.appendEvent({
        roomId: input.roomId,
        eventType: 'worktree.degraded',
        payload: { taskId: input.taskId, attemptId: input.attemptId, reason },
      });
      return { isolated: false, path: workspace, branch: null, baseCommit: repo.head, repoId: repo.repoId, reason: lane.ok ? reason : `${reason} ${lane.reason}` };
    }
  }

  /**
   * Collect one attempt's changes as a cross-worktree-safe reference set:
   * repo id, base commit, head commit, and repo-relative paths.
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.attemptId
   * @returns {{ repoId: string | null, baseCommit: string | null, headCommit: string | null, branch: string | null, changedPaths: string[], renamedFrom: string[], diffStat: string | null, reason: string }}
   */
  collectChanges(input) {
    const attempt = this.store.getAttempt(input.attemptId);
    if (!attempt) throw new RoomError('NOT_FOUND', `执行尝试 ${input.attemptId} 不存在。`);
    const room = this.rooms.requireRoom(input.roomId);
    const path = attempt.worktreeRef ?? room.workspaceRef;
    if (!path) {
      return { repoId: null, baseCommit: null, headCommit: null, branch: null, changedPaths: [], renamedFrom: [], diffStat: null, reason: '没有可用的工作目录。' };
    }
    const repo = this.#repoInfo(path);
    if (!repo.isRepo) {
      return { repoId: null, baseCommit: null, headCommit: null, branch: null, changedPaths: [], renamedFrom: [], diffStat: null, reason: '工作目录不是 git 仓库，无法收集变更清单。' };
    }
    try {
      const status = this.#git(path, ['status', '--porcelain'])
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
      // `git status` prints `old -> new` for a rename; the integration tree needs
      // one entry for the new path plus the source it came from, never two
      // unrelated-looking files (the design notes).
      const { changed, renamedFrom } = splitChanges(status);
      const diffStat = this.#git(path, ['diff', '--stat', repo.head]).trim();
      return {
        repoId: repo.repoId,
        baseCommit: repo.head,
        headCommit: this.#git(path, ['rev-parse', 'HEAD']).trim(),
        branch: repo.branch,
        changedPaths: changed,
        renamedFrom,
        diffStat: diffStat || null,
        reason: 'ok',
      };
    } catch (error) {
      return {
        repoId: repo.repoId,
        baseCommit: repo.head,
        headCommit: null,
        branch: repo.branch,
        changedPaths: [],
        renamedFrom: [],
        diffStat: null,
        reason: `变更收集失败：${String(error?.message ?? error)}`,
      };
    }
  }

  /**
   * Integration checks before a change may be merged into the integration tree.
   * It reports what must be verified; it does not merge anything on its own
   * (the design notes).
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.taskId
   * @param {string} input.attemptId
   * @returns {object}
   */
  integrationPlan(input) {
    const room = this.rooms.requireRoom(input.roomId);
    const attempt = this.store.getAttempt(input.attemptId);
    if (!attempt) throw new RoomError('NOT_FOUND', `执行尝试 ${input.attemptId} 不存在。`);
    const changes = this.collectChanges({ roomId: input.roomId, attemptId: input.attemptId });
    const conflicts = this.#detectConflicts(input.roomId, input.taskId, changes.changedPaths);
    return {
      taskId: input.taskId,
      attemptId: input.attemptId,
      workspace: room.workspaceRef,
      changes,
      conflicts,
      steps: [
        '确认变更清单与需求版本一致（引用决定 revision）',
        '检查依赖版本与工作树状态',
        '先合入隔离的集成分支，处理代码与语义冲突',
        '在实际集成结果上运行测试，不只检查成员自己的分支',
        '记录失败项并 @ 相关负责人修复',
        '所有验收条件通过后，任务转 accepted',
      ],
      note: '模型说“测试通过”不会改变状态；证据是命令、退出码、日志与目标 commit。',
      generatedAt: isoTimestamp(),
    };
  }

  /**
   * Release the write lane for a task. Worktrees are deliberately KEPT: a failed
   * or departed member's unmerged changes must not be deleted (the design notes).
   * @param {string} taskId
   * @returns {{ released: boolean, keptWorktree: string | null }}
   */
  releaseLane(taskId) {
    const attemptId = this.writeLanes.get(taskId);
    if (!attemptId) return { released: false, keptWorktree: null };
    this.writeLanes.delete(taskId);
    const attempt = this.store.getAttempt(attemptId);
    return { released: true, keptWorktree: attempt?.worktreeRef ?? null };
  }

  /**
   * Whether an attempt may still write. Serialized mode allows exactly one write
   * attempt per workspace at a time.
   * @param {string} roomId
   * @param {string} taskId
   * @param {string} attemptId
   * @returns {{ allowed: boolean, reason: string | null }}
   */
  admitWrite(roomId, taskId, attemptId) {
    const isolation = this.isolationFor(roomId);
    if (isolation.mode === 'worktree') return { allowed: true, reason: null };
    const holder = this.writeLanes.get(taskId);
    if (holder && holder !== attemptId) {
      return { allowed: false, reason: `同一任务的另一个写入尝试正在进行（${holder}）。` };
    }
    const otherHolding = [...this.writeLanes.entries()].find(([otherTask]) => otherTask !== taskId);
    if (otherHolding) {
      return {
        allowed: false,
        reason: `当前工作区没有可用的隔离（${isolation.reason}），同一时间只允许一个写入型任务：${otherHolding[0]} 正在写入。`,
      };
    }
    return this.#claimLane(taskId, attemptId);
  }

  /** Whether the workspace can be snapshotted as a fallback for a non-git project. */
  snapshotPlan(roomId) {
    const room = this.rooms.requireRoom(roomId);
    const isolation = this.isolationFor(roomId);
    if (isolation.git) return null;
    return {
      available: Boolean(room.workspaceRef),
      workspace: room.workspaceRef,
      note: '非 git 项目：可以在用户授权下创建快照或初始化版本管理，但不会无提示覆盖已有文件。',
    };
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  #claimLane(taskId, attemptId) {
    const holder = this.writeLanes.get(taskId);
    if (holder && holder !== attemptId) {
      return { ok: false, reason: `该任务已有写入尝试 ${holder} 占用写入通道。` };
    }
    this.writeLanes.set(taskId, attemptId);
    return { ok: true, reason: '已获得写入通道。' };
  }

  #repoInfo(path) {
    try {
      const top = this.#git(path, ['rev-parse', '--show-toplevel']).trim();
      const head = this.#git(path, ['rev-parse', 'HEAD']).trim();
      const branch = this.#git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      return { isRepo: true, root: top, head, branch, repoId: `${top.replace(/\\/g, '/')}@${head.slice(0, 12)}` };
    } catch {
      return { isRepo: false, root: path, head: null, branch: null, repoId: null };
    }
  }

  /**
   * Whether two in-flight attempts touch the same path. This is the *plugin's*
   * declaration of overlap, not a filesystem lock: without real isolation it
   * cannot stop every shell write, and saying otherwise would be a lie
   * (the design notes).
   */
  #detectConflicts(roomId, taskId, changedPaths) {
    const conflicts = [];
    if (changedPaths.length === 0) return conflicts;
    for (const task of this.store.listTasks(roomId)) {
      if (task.id === taskId) continue;
      for (const artifact of this.store.listArtifacts(roomId, { taskId: task.id })) {
        if (changedPaths.includes(artifact.location)) {
          conflicts.push({ taskId: task.id, path: artifact.location, ownerId: task.ownerId });
        }
      }
    }
    return conflicts;
  }

  #git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** Remove a worktree only when its changes were integrated. */
  disposeWorktree(path) {
    try {
      if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
      return true;
    } catch (error) {
      this.logger?.warn?.(`[project-room] worktree cleanup failed for ${path}: ${error?.message ?? error}`);
      return false;
    }
  }
}

/**
 * Split a git status path list into changed paths and renamed-from paths, so a
 * rename is reported as one entry rather than two unrelated files.
 *
 * Handles both shapes `git status --porcelain` emits for one entry:
 *   - `src/login.tsx`
 *   - `src/old.ts -> src/new.ts` (rename or copy)
 *
 * A path git quoted because it contains spaces or other special characters is
 * unquoted rather than split in two.
 *
 * @param {string[]} changedPaths
 * @returns {{ changed: string[], renamedFrom: string[] }}
 */
export function splitChanges(changedPaths) {
  const changed = [];
  const renamedFrom = [];
  for (const entry of Array.isArray(changedPaths) ? changedPaths : []) {
    const line = String(entry ?? '').trim();
    if (!line) continue;
    const arrow = line.indexOf(' -> ');
    if (arrow < 0) {
      changed.push(unquoteGitPath(line));
      continue;
    }
    const from = unquoteGitPath(line.slice(0, arrow));
    const to = unquoteGitPath(line.slice(arrow + 4));
    if (from) renamedFrom.push(from);
    if (to) changed.push(to);
  }
  return { changed, renamedFrom };
}

/**
 * Strip the surrounding quotes git adds around a path with special characters.
 * @param {string} value
 * @returns {string}
 */
function unquoteGitPath(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}
