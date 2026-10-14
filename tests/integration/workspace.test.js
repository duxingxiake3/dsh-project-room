/**
 * Project Room — workspace isolation and write coordination.
 *
 * These tests use REAL git repositories (a throwaway repo with one commit, and a
 * plain non-repo directory) because the whole point of the design notes is that the
 * isolation mode is a statement of fact: "worktree" must mean a worktree really
 * exists, and "sequential" must come with the reason it degraded.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RoomError } from '../../shared/contracts.js';
import { splitChanges } from '../../src/host/workspace/coordinator.js';
import { createRoomStack, createStandardRoom, useTemporaryDataDir } from './harness.js';

/** The git version string the coordinator treats as "git is available". */
const GIT_VERSION = 'git version 2.43.0';

/** Run git in one directory, failing the test on a non-zero exit. */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A throwaway git repository with exactly one commit, so HEAD exists and a
 * worktree can be created from it.
 * @param {string} [label]
 */
function initRepo(label = 'repo') {
  const dir = mkdtempSync(join(tmpdir(), `room-${label}-`));
  git(dir, ['-c', 'init.defaultBranch=main', 'init']);
  writeFileSync(join(dir, 'README.md'), '# demo\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, [
    '-c',
    'user.name=project-room-test',
    '-c',
    'user.email=room@test.local',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'init',
  ]);
  return dir;
}

/** A throwaway directory that is deliberately NOT a git repository. */
function plainDir(label = 'plain') {
  return mkdtempSync(join(tmpdir(), `room-${label}-`));
}

/**
 * A stack whose workspace coordinator reports the given git availability.
 * @param {import('node:test').TestContext} t
 * @param {{ gitVersion?: string | null, label?: string }} [input]
 */
function freshStack(t, input = {}) {
  const dataDir = useTemporaryDataDir(input.label ?? 'workspace');
  const stack = createRoomStack({
    dataDir,
    gitVersion: input.gitVersion === undefined ? GIT_VERSION : input.gitVersion,
    worktreeRoot: join(dataDir, 'worktrees'),
  });
  t.after(() => stack.close());
  return stack;
}

/** A ready task owned by one of the standard members. */
function readyTask(stack, team, input) {
  return stack.tasks.propose({
    roomId: team.room.id,
    actorId: team.agents.coordinator.id,
    objective: input.objective,
    suggestedOwnerId: input.owner.id,
    acceptance: input.acceptance ?? ['变更可核验'],
  });
}

describe('workspace — splitChanges', () => {
  it('reports a rename once, keeping its source, and leaves plain paths alone', () => {
    assert.deepEqual(splitChanges(['src/login.tsx', 'src/old.ts -> src/new.ts', '  ', 'src/api/auth.ts']), {
      changed: ['src/login.tsx', 'src/new.ts', 'src/api/auth.ts'],
      renamedFrom: ['src/old.ts'],
    });
    assert.deepEqual(splitChanges([]), { changed: [], renamedFrom: [] });
    assert.deepEqual(splitChanges(undefined), { changed: [], renamedFrom: [] });
    // A git-quoted path is unquoted, not torn in half at its space.
    assert.deepEqual(splitChanges(['"src/my file.ts" -> "src/renamed file.ts"']), {
      changed: ['src/renamed file.ts'],
      renamedFrom: ['src/my file.ts'],
    });
  });
});

describe('workspace — isolation is a fact, not a preference', () => {
  it('reports worktree for a real repo and sequential with an explicit reason otherwise', async (t) => {
    const repo = initRepo('isolation');
    const plain = plainDir('isolation-plain');
    const stack = freshStack(t, { label: 'isolation' });
    const team = await createStandardRoom(stack, { workspaceRef: repo });
    const roomId = team.room.id;

    const isolated = stack.workspace.isolationFor(roomId);
    assert.equal(isolated.mode, 'worktree', '有 git 仓库时每个写入尝试都该有独立工作树');
    assert.equal(isolated.git, true);
    assert.match(isolated.reason, /worktree/);

    // The same room pointed at a non-repo directory must degrade visibly.
    stack.store.updateRoom(roomId, { workspaceRef: plain });
    const sequential = stack.workspace.isolationFor(roomId);
    assert.equal(sequential.mode, 'sequential');
    assert.equal(sequential.git, true, 'git 本身可用，只是这个目录不是仓库');
    assert.match(sequential.reason, /不是 git 仓库/, '降级必须带上原因');
    assert.match(String(stack.workspace.snapshotPlan(roomId).note), /快照|版本管理/);

    // And with no git at all, the mode is sequential for a different reason.
    const withoutGit = freshStack(t, { gitVersion: null, label: 'no-git' });
    const teamWithoutGit = await createStandardRoom(withoutGit, { workspaceRef: repo });
    const noGit = withoutGit.workspace.isolationFor(teamWithoutGit.room.id);
    assert.equal(noGit.mode, 'sequential');
    assert.match(noGit.reason, /未检测到 git/);
    assert.equal(withoutGit.workspace.snapshotPlan(teamWithoutGit.room.id).available, true);
  });

  it('degrades to a reported sequential write when no worktree can be created', async (t) => {
    const plain = plainDir('degrade');
    const stack = freshStack(t, { label: 'degrade' });
    const team = await createStandardRoom(stack, { workspaceRef: plain });
    const task = readyTask(stack, team, { objective: '整理说明', owner: team.agents.tester });
    const attempt = stack.tasks.startAttempt({ taskId: task.id, actorId: team.agents.tester.id });

    const prepared = stack.workspace.prepareWorktree({ roomId: team.room.id, taskId: task.id, attemptId: attempt.id });
    assert.equal(prepared.isolated, false, '没有隔离就必须说没有');
    assert.equal(prepared.branch, null);
    assert.equal(prepared.baseCommit, null);
    assert.match(prepared.reason, /不是 git 仓库|串行/);
    assert.equal(stack.store.getAttempt(attempt.id).worktreeRef, null);
  });
});

describe('workspace — one serialized writer without isolation', () => {
  it('admits the first writer, refuses the second with a reason, and frees the lane', async (t) => {
    const plain = plainDir('lanes');
    const stack = freshStack(t, { label: 'lanes' });
    const team = await createStandardRoom(stack, { workspaceRef: plain });
    const roomId = team.room.id;

    const taskA = readyTask(stack, team, { objective: '改前端入口', owner: team.agents.frontend });
    const taskB = readyTask(stack, team, { objective: '改后端接口', owner: team.agents.backend });
    const attemptA = stack.tasks.startAttempt({ taskId: taskA.id, actorId: team.agents.frontend.id });
    const attemptB = stack.tasks.startAttempt({ taskId: taskB.id, actorId: team.agents.backend.id });

    const first = stack.workspace.admitWrite(roomId, taskA.id, attemptA.id);
    assert.equal(first.allowed, true);
    assert.match(first.reason, /写入通道/);

    const second = stack.workspace.admitWrite(roomId, taskB.id, attemptB.id);
    assert.equal(second.allowed, false, '没有隔离时同一时间只允许一个写入型任务');
    assert.match(second.reason, /只允许一个写入型任务/);
    assert.match(second.reason, /不是 git 仓库/, '拒绝时必须解释为什么没有隔离');

    // The holder may keep writing.
    assert.equal(stack.workspace.admitWrite(roomId, taskA.id, attemptA.id).allowed, true);

    // A second attempt on the SAME task is refused as well.
    const attemptA2 = stack.tasks.startAttempt({ taskId: taskA.id, actorId: team.agents.backend.id });
    assert.notEqual(attemptA2.id, attemptA.id);
    const sameTask = stack.workspace.admitWrite(roomId, taskA.id, attemptA2.id);
    assert.equal(sameTask.allowed, false);
    assert.match(sameTask.reason, /另一个写入尝试/);

    const released = stack.workspace.releaseLane(taskA.id);
    assert.equal(released.released, true);
    assert.equal(released.keptWorktree, null, '串行模式下没有工作树可保留');
    assert.equal(stack.workspace.releaseLane(taskA.id).released, false, '重复释放是空操作');
    assert.equal(
      stack.workspace.admitWrite(roomId, taskB.id, attemptB.id).allowed,
      true,
      '释放后另一个任务可以获得写通道',
    );
  });

  it('allows several writers when each attempt really has its own worktree', async (t) => {
    const repo = initRepo('parallel');
    const stack = freshStack(t, { label: 'parallel' });
    const team = await createStandardRoom(stack, { workspaceRef: repo });
    const roomId = team.room.id;
    const taskA = readyTask(stack, team, { objective: '改前端入口', owner: team.agents.frontend });
    const taskB = readyTask(stack, team, { objective: '改后端接口', owner: team.agents.backend });
    const attemptA = stack.tasks.startAttempt({ taskId: taskA.id, actorId: team.agents.frontend.id });
    const attemptB = stack.tasks.startAttempt({ taskId: taskB.id, actorId: team.agents.backend.id });

    const preparedA = stack.workspace.prepareWorktree({ roomId, taskId: taskA.id, attemptId: attemptA.id });
    const preparedB = stack.workspace.prepareWorktree({ roomId, taskId: taskB.id, attemptId: attemptB.id });
    assert.equal(preparedA.isolated, true);
    assert.equal(preparedB.isolated, true);
    assert.notEqual(preparedA.path, preparedB.path, '两个写入尝试不能共用同一个目录');
    assert.notEqual(preparedA.branch, preparedB.branch);
    assert.equal(stack.workspace.admitWrite(roomId, taskA.id, attemptA.id).allowed, true);
    assert.equal(stack.workspace.admitWrite(roomId, taskB.id, attemptB.id).allowed, true, '有隔离时可以并行写入');
  });
});

describe('workspace — change collection reports one entry per rename', () => {
  it('collectChanges reports the destination path and the renamed-from source', async (t) => {
    const repo = initRepo('collect');
    const stack = freshStack(t, { label: 'collect' });
    const team = await createStandardRoom(stack, { workspaceRef: repo });
    const roomId = team.room.id;
    const task = readyTask(stack, team, { objective: '重命名入口文件', owner: team.agents.frontend });
    const attempt = stack.tasks.startAttempt({ taskId: task.id, actorId: team.agents.frontend.id });
    const prepared = stack.workspace.prepareWorktree({ roomId, taskId: task.id, attemptId: attempt.id });
    assert.equal(prepared.isolated, true);
    assert.equal(existsSync(prepared.path), true);

    git(prepared.path, ['mv', 'README.md', 'GUIDE.md']);
    writeFileSync(join(prepared.path, 'src-note.md'), 'note\n', 'utf8');

    const changes = stack.workspace.collectChanges({ roomId, attemptId: attempt.id });
    assert.equal(changes.reason, 'ok');
    assert.deepEqual(changes.changedPaths.slice().sort(), ['GUIDE.md', 'src-note.md'], '重命名只算一个变更条目');
    assert.deepEqual(changes.renamedFrom, ['README.md'], '来源路径单独报告');
    assert.equal(changes.branch, prepared.branch);
    assert.equal(changes.baseCommit, prepared.baseCommit);
    assert.match(changes.repoId, /@/);
    assert.equal(changes.headCommit.length, 40);
  });
});

describe('workspace — integration plan is a checklist, not a merge', () => {
  it('lists the steps, declares overlapping paths, and never claims a merge happened', async (t) => {
    const repo = initRepo('integrate');
    const stack = freshStack(t, { label: 'integrate' });
    const team = await createStandardRoom(stack, { workspaceRef: repo });
    const roomId = team.room.id;

    const frontendTask = readyTask(stack, team, { objective: '改前端入口', owner: team.agents.frontend });
    const backendTask = readyTask(stack, team, { objective: '改后端接口', owner: team.agents.backend });
    // The backend already published an artifact for README.md, so the frontend's
    // change to the same path is a declared overlap rather than a surprise.
    stack.artifacts.publish({
      roomId,
      actorId: team.agents.backend.id,
      taskId: backendTask.id,
      kind: 'file',
      location: 'README.md',
      summary: '后端改动说明',
    });

    const attempt = stack.tasks.startAttempt({ taskId: frontendTask.id, actorId: team.agents.frontend.id });
    const prepared = stack.workspace.prepareWorktree({ roomId, taskId: frontendTask.id, attemptId: attempt.id });
    assert.equal(prepared.isolated, true);
    writeFileSync(join(prepared.path, 'README.md'), '# demo changed\n', 'utf8');

    const plan = stack.workspace.integrationPlan({ roomId, taskId: frontendTask.id, attemptId: attempt.id });
    assert.deepEqual(plan.changes.changedPaths, ['README.md']);
    assert.equal(plan.taskId, frontendTask.id);
    assert.equal(plan.attemptId, attempt.id);
    assert.equal(plan.workspace, repo);
    assert.ok(Array.isArray(plan.steps) && plan.steps.length >= 4, '集成步骤必须列出来');
    assert.ok(plan.steps.some((step) => step.includes('测试')), '集成步骤要包含在真实结果上运行测试');
    assert.match(plan.note, /不会改变状态|证据/, '必须说明自述不能改状态');
    assert.deepEqual(
      plan.conflicts.map((conflict) => ({ taskId: conflict.taskId, path: conflict.path })),
      [{ taskId: backendTask.id, path: 'README.md' }],
      '同一路径的并行改动必须显式列出',
    );
    // The plan is a plan: nothing may read as "already merged".
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes('已合并'), false, '不能声称已经合并');
    assert.equal(Object.hasOwn(plan, 'merged'), false);
    assert.equal(Object.hasOwn(plan, 'integrated'), false);
    assert.equal(plan.generatedAt.endsWith('Z'), true);
    // The integration tree itself was not touched.
    assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false);
  });

  it('refuses to describe an attempt that does not exist', async (t) => {
    const repo = initRepo('missing');
    const stack = freshStack(t, { label: 'missing' });
    const team = await createStandardRoom(stack, { workspaceRef: repo });
    assert.throws(
      () => stack.workspace.integrationPlan({ roomId: team.room.id, taskId: 'task_none', attemptId: 'attempt_none' }),
      (error) => error instanceof RoomError && error.code === 'NOT_FOUND',
    );
    assert.throws(
      () => stack.workspace.collectChanges({ roomId: team.room.id, attemptId: 'attempt_none' }),
      (error) => error instanceof RoomError && error.code === 'NOT_FOUND',
    );
  });
});

describe('workspace — an unmerged worktree is preserved', () => {
  it('keeps the worktree and its changes when the write lane is released', async (t) => {
    const repo = initRepo('keep');
    const stack = freshStack(t, { label: 'keep' });
    const team = await createStandardRoom(stack, { workspaceRef: repo });
    const roomId = team.room.id;
    const task = readyTask(stack, team, { objective: '未合并的改动', owner: team.agents.frontend });
    const attempt = stack.tasks.startAttempt({ taskId: task.id, actorId: team.agents.frontend.id });
    const prepared = stack.workspace.prepareWorktree({ roomId, taskId: task.id, attemptId: attempt.id });
    assert.equal(prepared.isolated, true);
    writeFileSync(join(prepared.path, 'unmerged.txt'), 'not integrated yet\n', 'utf8');

    const released = stack.workspace.releaseLane(task.id);
    // A worktree needs no serialization lane, so there is nothing to release —
    // and nothing may be deleted either (the design notes).
    assert.equal(released.keptWorktree, null);
    assert.equal(existsSync(prepared.path), true, '成员退出后未合并的工作目录必须保留');
    assert.equal(existsSync(join(prepared.path, 'unmerged.txt')), true, '工作树里的实际改动必须保留');
    assert.equal(stack.store.getAttempt(attempt.id).worktreeRef, prepared.path, '账本仍然指向那棵工作树');

    // Cleanup is a separate, explicit action — never a side effect of releasing.
    assert.equal(stack.workspace.disposeWorktree(prepared.path), true);
    assert.equal(existsSync(prepared.path), false);
  });
});
