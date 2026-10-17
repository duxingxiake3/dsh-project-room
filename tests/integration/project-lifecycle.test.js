/**
 * Project Room — / project lifecycle.
 *
 * These tests use the real lifecycle service, store, resource ledger,
 * message/task services and the fake host's real agent handles. The acceptance
 * cases they cover map to of the integration spec; a case that
 * needs a real host capability it does not have is named as limited in the
 * checkpoint instead of being faked here.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createRoomStack, createStandardRoom, receivedByMember } from './harness.js';
import { resolveLifecycleActor } from '../../src/host/api/route.js';

/**
 * A fresh stack and a standard four-member room. `workspaceRef` is a real
 * temporary directory so "the source is preserved" is a file-system assertion,
 * not a boolean the service reports about itself.
 * @param {import('node:test').TestContext} t
 * @param {object} [input]
 */
async function freshRoom(t, input = {}) {
  const stack = createRoomStack({ retentionMs: input.retentionMs ?? undefined, ...input.stackOptions });
  t.after(() => stack.close());
  const team = await createStandardRoom(stack, input);
  return { stack, ...team };
}

/** A workspace directory with one source file. */
function sourceWorkspace(t, name = 'src.js', content = 'export const ok = true;\n') {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-source-'));
  writeFileSync(join(workspace, name), content, 'utf8');
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return { workspace, file: join(workspace, name), content };
}

/** @param {object} stack @param {string} memberId @param {string} status */
function setAgentStatus(stack, memberId, status) {
  const agent = stack.adapter.agentOf(memberId);
  assert.ok(agent, `member ${memberId} must have a live agent`);
  agent.status = status;
  return agent;
}

/**
 * Make every stop request a no-op: the host "accepts" it but the agent keeps
 * reporting `running`. This is the honest unknown the lifecycle must surface as
 * BLOCKED, never as a completed stop.
 */
function blockStopRequests(stack) {
  const original = stack.adapter.requestStop;
  stack.adapter.requestStop = () => true;
  return () => {
    stack.adapter.requestStop = original;
  };
}

describe('project lifecycle — identity and read-only isolation', () => {
  it('keeps two projects with the same title independent', async (t) => {
    const stack = createRoomStack();
    t.after(() => stack.close());

    const first = await createStandardRoom(stack, { title: '同名项目' });
    const second = await createStandardRoom(stack, { title: '同名项目' });
    assert.notEqual(first.room.id, second.room.id, '同名项目必须是两个不可变 id');
    assert.equal(stack.store.listRooms().filter((room) => room.title === '同名项目').length, 2);

    const archived = await stack.lifecycle.archive(first.room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'same-title-archive',
      requestedBy: first.human.id,
    });
    assert.equal(archived.room.status, 'archived');
    assert.equal(archived.room.lifecycleState, 'ARCHIVED');
    assert.equal(stack.store.getRoom(second.room.id).status, 'active', '归档一个项目不能影响另一个');

    const listed = stack.lifecycle.list();
    assert.equal(listed.find((room) => room.id === first.room.id).lifecycleState, 'ARCHIVED');
    assert.equal(listed.find((room) => room.id === second.room.id).lifecycleState, 'ACTIVE');
  });

  it('archives after a confirmed stop and never wakes a member', async (t) => {
    const { stack, room, agents, human } = await freshRoom(t);
    const backendAgent = setAgentStatus(stack, agents.backend.id, 'running');
    const backendSession = backendAgent.id;
    const before = receivedByMember(stack, agents.backend.id).length;

    const archived = await stack.lifecycle.archive(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'archive-1',
      requestedBy: human.id,
    });
    assert.equal(archived.room.status, 'archived');
    assert.equal(archived.room.lifecycleState, 'ARCHIVED');
    assert.equal(archived.stop.running.length, 1, '运行中的成员被要求停止');
    assert.equal(archived.stop.requested, 1);
    assert.equal(archived.stop.confirmed, true, '假宿主会同步确认取消，confirmed 必须来自真实复查');
    assert.equal(backendAgent.status, 'idle');

    await assert.rejects(
      stack.messages.send({
        roomId: room.id,
        authorId: agents.backend.id,
        body: '归档后代理不应再自动发言',
        clientMessageId: 'archive-agent-send',
      }),
      (error) => error.code === 'ROOM_PAUSED',
    );

    // : opening the archived room and @-ing a member is history-only. The
    // message may be stored, but no delivery is admitted and no model call runs.
    const sessionBefore = stack.host.createdAgents().length;
    await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      body: '@后端 看一下历史',
      mentions: [{ targetMemberId: agents.backend.id, origin: 'picker', displaySnapshot: agents.backend.displayName, span: null }],
      clientMessageId: 'archive-human-send',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(receivedByMember(stack, agents.backend.id).length, before, '归档项目不会向成员投递新轮次');
    assert.equal(stack.host.createdAgents().length, sessionBefore, '归档项目不会新建模型会话');

    assert.throws(
      () => stack.tasks.propose({ roomId: room.id, actorId: human.id, objective: '归档项目里的任务' }),
      (error) => error.code === 'ROOM_ARCHIVED',
    );

    const restored = await stack.lifecycle.restore(room.id, {
      expectedLifecycleRevision: archived.room.lifecycleRevision,
      idempotencyKey: 'archive-restore',
      requestedBy: human.id,
    });
    assert.equal(restored.room.status, 'paused', '恢复归档先落在暂停态，不自动启动');
    assert.equal(restored.room.lifecycleState, 'PAUSED');
    assert.equal(backendAgent.status, 'idle', '恢复本身不会唤醒成员');
    assert.equal(backendSession.length > 0, true);
  });
});

describe('project lifecycle — a stop request is not a confirmation', () => {
  it('stops in BLOCKED when the host does not confirm a stop, and cancels safely', async (t) => {
    const { stack, room, agents, human } = await freshRoom(t);
    setAgentStatus(stack, agents.coordinator.id, 'running');
    setAgentStatus(stack, agents.backend.id, 'running');
    const restoreStops = blockStopRequests(stack);

    const archived = await stack.lifecycle.archive(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'archive-blocked',
      requestedBy: human.id,
    });
    assert.equal(archived.blocked, true);
    assert.equal(archived.room.status, 'archived', '阻断状态立即生效，但显示为“停止未确认”');
    assert.equal(archived.room.lifecycleState, 'BLOCKED');
    assert.equal(archived.stop.confirmed, false);
    assert.equal(archived.stop.requested, 2);
    assert.equal(archived.stop.stillRunning.length, 2, '未确认的成员必须逐一点名');

    const inspected = stack.lifecycle.inspect(room.id);
    assert.equal(inspected.actions.cancel, true);
    assert.equal(inspected.actions.reconcile, true);
    assert.equal(inspected.actions.archive, false, '阻塞期间不能再次归档');
    assert.match(inspected.actions.blockedReason, /停止尚未确认/);

    // Still unknown: reconcile must not claim success either.
    const stillBlocked = await stack.lifecycle.reconcile(room.id, {
      expectedLifecycleRevision: archived.room.lifecycleRevision,
      idempotencyKey: 'reconcile-still-blocked',
      requestedBy: human.id,
    });
    assert.equal(stillBlocked.blocked, true);
    assert.equal(stillBlocked.room.lifecycleState, 'BLOCKED');

    restoreStops();
    for (const member of [agents.coordinator, agents.backend]) setAgentStatus(stack, member.id, 'idle');
    const cancelled = await stack.lifecycle.cancel(room.id, {
      expectedLifecycleRevision: stillBlocked.room.lifecycleRevision,
      idempotencyKey: 'cancel-blocked-archive',
      requestedBy: human.id,
    });
    assert.equal(cancelled.room.status, 'active');
    assert.equal(cancelled.room.lifecycleState, 'ACTIVE');
    assert.equal(cancelled.room.lifecyclePending, null);
  });

  it('keeps an unconfirmed trash out of the recycle bin until reconcile confirms', async (t) => {
    const { stack, room, agents, human } = await freshRoom(t);
    setAgentStatus(stack, agents.backend.id, 'running');
    const restoreStops = blockStopRequests(stack);

    const attempted = await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'trash-blocked',
      requestedBy: human.id,
    });
    assert.equal(attempted.blocked, true);
    assert.equal(attempted.to, 'quiescing');
    const quiescing = stack.store.getRoom(room.id);
    assert.equal(quiescing.status, 'quiescing', '未确认停止不得进入回收站');
    assert.equal(quiescing.lifecycleState, 'BLOCKED');
    assert.equal(stack.store.getTrashSnapshot(room.id), null, '未确认停止不得固化快照并宣称删除完成');

    await assert.rejects(
      stack.messages.send({
        roomId: room.id,
        authorId: human.id,
        body: '停止未确认时不能发新消息',
        clientMessageId: 'quiescing-send',
      }),
      (error) => error.code === 'ROOM_QUIESCING',
    );
    assert.throws(
      () => stack.tasks.propose({ roomId: room.id, actorId: human.id, objective: '停止未确认时不能创建任务' }),
      (error) => error.code === 'ROOM_QUIESCING',
    );

    restoreStops();
    const reconciled = await stack.lifecycle.reconcile(room.id, {
      expectedLifecycleRevision: quiescing.lifecycleRevision,
      idempotencyKey: 'reconcile-trash',
      requestedBy: human.id,
    });
    assert.equal(reconciled.blocked, false);
    assert.equal(reconciled.room.status, 'trashed');
    assert.equal(reconciled.room.lifecycleState, 'TRASHED');
    assert.ok(stack.store.getTrashSnapshot(room.id));
  });

  it('reports exactly which member blocked a multi-agent stop', async (t) => {
    const { stack, room, agents, human } = await freshRoom(t);
    setAgentStatus(stack, agents.coordinator.id, 'running');
    setAgentStatus(stack, agents.backend.id, 'running');
    const original = stack.adapter.requestStop;
    stack.adapter.requestStop = (memberId) => (memberId === agents.backend.id ? true : original.call(stack.adapter, memberId));

    const archived = await stack.lifecycle.archive(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'archive-partial-stop',
      requestedBy: human.id,
    });
    assert.equal(archived.blocked, true);
    assert.deepEqual(archived.stop.stillRunning.map((entry) => entry.memberId), [agents.backend.id]);
    assert.equal(stack.adapter.agentOf(agents.coordinator.id).status, 'idle', '已确认的成员保持停止');
    assert.equal(stack.adapter.agentOf(agents.backend.id).status, 'running', '未确认的成员保持原状态');
  });
});

describe('project lifecycle — recycle bin and restore', () => {
  it('trashes without deleting the source, messages or members, then restores', async (t) => {
    const { workspace, file, content } = sourceWorkspace(t);
    const { stack, room, agents, human } = await freshRoom(t, { workspaceRef: workspace });

    const sent = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      body: '这条消息必须在回收站里继续存在，恢复后还能看到。',
      clientMessageId: 'trash-keeps-message',
    });
    assert.equal(sent.message.id.length > 0, true);

    const trashed = await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'trash-1',
      requestedBy: human.id,
    });
    assert.equal(trashed.room.status, 'trashed');
    assert.equal(trashed.room.lifecycleState, 'TRASHED');
    assert.equal(trashed.room.lifecycleRevision, 2, '先固化阻断状态，再固化回收站状态');
    assert.match(trashed.room.deletedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(trashed.room.trashExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(trashed.daysLeft, 30);
    assert.equal(existsSync(file), true, '移入回收站绝不删除源码');
    assert.equal(readFileSync(file, 'utf8'), content);
    assert.equal(stack.store.listMessages(room.id).length, 1, '群消息仍在库中');
    assert.equal(stack.store.listMembers(room.id, { includeRetired: true }).length, 5);
    assert.ok(stack.store.getTrashSnapshot(room.id), '移入回收站时要固化结构快照');

    await assert.rejects(
      stack.messages.send({
        roomId: room.id,
        authorId: human.id,
        body: '回收站中不能发新消息',
        clientMessageId: 'trash-send',
      }),
      (error) => error.code === 'ROOM_TRASHED',
    );
    assert.throws(
      () => stack.tasks.propose({ roomId: room.id, actorId: human.id, objective: '不应当在回收站中创建任务' }),
      (error) => error.code === 'ROOM_TRASHED',
    );

    const restored = await stack.lifecycle.restore(room.id, {
      expectedLifecycleRevision: trashed.room.lifecycleRevision,
      idempotencyKey: 'trash-restore',
      requestedBy: human.id,
    });
    assert.equal(restored.room.status, 'paused', '从回收站恢复只能到暂停态');
    assert.equal(restored.room.lifecycleState, 'PAUSED');
    assert.equal(restored.snapshotVerified, true);
    assert.equal(restored.room.deletedAt, null);
    assert.equal(restored.room.trashExpiresAt, null);
    assert.equal(stack.store.listMessages(room.id).length, 1, '恢复不重放外部副作用，历史也一条不少');
    assert.equal(stack.store.getTrashSnapshot(room.id), null);
    assert.equal(existsSync(file), true);
    assert.ok(agents.backend.id);
  });

  it('previews only plugin data as deletable, with source and borrowed sessions protected', async (t) => {
    const { workspace } = sourceWorkspace(t);
    const { stack, room, human } = await freshRoom(t, { workspaceRef: workspace });
    stack.store.updateMember(human.id, { sessionId: 'borrowed-preview-session', sessionOwnership: 'borrowed' });
    await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'trash-preview',
      requestedBy: human.id,
    });

    const preview = stack.lifecycle.preview(room.id);
    assert.equal(preview.sourceWorkspacePreserved, true);
    assert.equal(preview.approvalRequired, true);
    assert.equal(preview.workspaceRef, workspace);
    assert.equal(preview.counts.members, 5);
    assert.ok(preview.counts.messages >= 0);
    assert.equal(preview.deletableOwnedResources.length, 4, '四个插件拥有的成员会话可释放');
    assert.ok(preview.deletableOwnedResources.every((resource) => resource.ownership === 'owned'));
    assert.ok(preview.protectedResources.some((resource) => resource.kind === 'source'));
    assert.ok(preview.protectedResources.some((resource) => resource.kind === 'borrowed-session'));
    assert.ok(preview.protectedResources.some((resource) => resource.kind === 'worktree'));
    assert.ok(preview.protectedResources.some((resource) => resource.kind === 'host-log'));
    assert.ok(preview.pluginManagedData.some((line) => line.includes('群消息')));
    assert.equal(preview.actions ?? null, null, 'preview 不是 inspect，不返回可执行动作');
  });

  it('refuses to restore when the trash snapshot digest does not match', async (t) => {
    const { stack, room, human } = await freshRoom(t);
    await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'trash-tamper',
      requestedBy: human.id,
    });
    const snapshot = stack.store.getTrashSnapshot(room.id);
    stack.store.saveTrashSnapshot({ ...snapshot, snapshotDigest: '0'.repeat(64) });

    await assert.rejects(
      stack.lifecycle.restore(room.id, {
        expectedLifecycleRevision: stack.store.getRoom(room.id).lifecycleRevision,
        idempotencyKey: 'restore-tampered',
        requestedBy: human.id,
      }),
      (error) => error.code === 'PROJECT_SNAPSHOT_MISMATCH',
    );
    assert.equal(stack.store.getRoom(room.id).status, 'trashed', '拒绝恢复不能改变项目状态');
  });

  it('shows the retention date but never expires a project by itself', async (t) => {
    const { stack, room, human } = await freshRoom(t);
    await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'trash-retention',
      requestedBy: human.id,
    });
    stack.store.updateRoom(room.id, { trashExpiresAt: '2020-01-01T00:00:00.000Z' });
    const inspected = stack.lifecycle.inspect(room.id);
    assert.equal(inspected.trashDaysLeft, 0);
    assert.equal(inspected.status, 'trashed');
    assert.equal(stack.store.getRoom(room.id).status, 'trashed', '到期只是日期提示，不自动物理删除');
  });
});

describe('project lifecycle — permanent purge', () => {
  it('refuses a purge without the exact title, the acknowledgement, or while a member is running', async (t) => {
    const { stack, room, agents, human } = await freshRoom(t);
    await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'purge-guard-trash',
      requestedBy: human.id,
    });
    const revision = stack.store.getRoom(room.id).lifecycleRevision;

    await assert.rejects(
      stack.lifecycle.purge(room.id, {
        expectedLifecycleRevision: revision,
        idempotencyKey: 'purge-no-title',
        requestedBy: human.id,
        confirmTitle: '错误的名字',
        acknowledgeIrreversible: true,
      }),
      (error) => error.code === 'INVALID_REQUEST',
    );
    await assert.rejects(
      stack.lifecycle.purge(room.id, {
        expectedLifecycleRevision: revision,
        idempotencyKey: 'purge-no-ack',
        requestedBy: human.id,
        confirmTitle: room.title,
        acknowledgeIrreversible: false,
      }),
      (error) => error.code === 'INVALID_REQUEST',
    );

    setAgentStatus(stack, agents.backend.id, 'running');
    await assert.rejects(
      stack.lifecycle.purge(room.id, {
        expectedLifecycleRevision: revision,
        idempotencyKey: 'purge-busy',
        requestedBy: human.id,
        confirmTitle: room.title,
        acknowledgeIrreversible: true,
      }),
      (error) => error.code === 'PROJECT_BUSY',
    );
    assert.equal(stack.store.getRoom(room.id).status, 'trashed', '被拒绝的删除不能改变项目');

    // : no agent-addressable tool can purge or approve a deletion.
    const agentToolNames = stack.host.tools.map((tool) => tool.name);
    assert.equal(agentToolNames.some((name) => /purge|lifecycle|project\./i.test(name)), false);
  });

  it('purges plugin data only, keeps the source, borrowed sessions and a tombstone', async (t) => {
    const { workspace, file, content } = sourceWorkspace(t, 'main.js', 'console.log("keep me");\n');
    const { stack, room, agents, human } = await freshRoom(t, { workspaceRef: workspace });
    stack.store.updateMember(human.id, { sessionId: 'borrowed-human-session', sessionOwnership: 'borrowed' });

    await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      body: 'purge 前的历史',
      clientMessageId: 'purge-history',
    });
    await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'purge-trash',
      requestedBy: human.id,
    });

    const released = [];
    const originalRelease = stack.adapter.releaseOwnedMember.bind(stack.adapter);
    stack.adapter.releaseOwnedMember = async (memberId) => {
      released.push(memberId);
      return originalRelease(memberId);
    };

    const purged = await stack.lifecycle.purge(room.id, {
      expectedLifecycleRevision: stack.store.getRoom(room.id).lifecycleRevision,
      idempotencyKey: 'purge-1',
      requestedBy: human.id,
      confirmTitle: room.title,
      acknowledgeIrreversible: true,
    });

    assert.equal(purged.purged, true);
    assert.equal(purged.sourceWorkspacePreserved, true);
    assert.equal(purged.workspaceRef, workspace);
    assert.equal(existsSync(file), true, '永久删除默认保留源码文件');
    assert.equal(readFileSync(file, 'utf8'), content);
    assert.equal(stack.store.getRoom(room.id), null, '插件私有项目行已删除');
    assert.equal(stack.store.listMessages(room.id).length, 0);
    assert.equal(stack.store.listMembers(room.id, { includeRetired: true }).length, 0);
    assert.equal(stack.store.getTrashSnapshot(room.id), null);
    assert.equal(stack.store.getProjectTombstone(room.id).result, 'purged');
    const audit = stack.store.listDeletionAudits(room.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].result, 'purged');
    assert.equal(audit[0].projectId, room.id);
    assert.equal(audit[0].humanActorRef, human.id);
    assert.ok(released.includes(agents.backend.id), '插件拥有的会话会被释放');
    assert.equal(released.includes(human.id), false, '借用的人类会话不能被释放');
    assert.ok(purged.retainedBorrowedSessions.includes(human.id));
    assert.equal(stack.adapter.agentOf(agents.backend.id), null, '宿主句柄确实被释放，不只是账本标记');

    // Retry with the same idempotency key after the project row is gone: the
    // durable operation result answers, not a second physical delete.
    const again = await stack.lifecycle.purge(room.id, {
      expectedLifecycleRevision: purged.room?.lifecycleRevision ?? 0,
      idempotencyKey: 'purge-1',
      requestedBy: human.id,
      confirmTitle: room.title,
      acknowledgeIrreversible: true,
    });
    assert.equal(again.duplicate, true);
    assert.equal(again.purged, true);
  });

  it('enters PURGE_BLOCKED on a partial release and retries idempotently', async (t) => {
    const { workspace, file } = sourceWorkspace(t);
    const { stack, room, agents, human } = await freshRoom(t, { workspaceRef: workspace });
    await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'purge-blocked-trash',
      requestedBy: human.id,
    });

    const originalRelease = stack.adapter.releaseOwnedMember.bind(stack.adapter);
    const releasedBeforeFailure = [];
    stack.adapter.releaseOwnedMember = async (memberId) => {
      if (memberId === agents.backend.id) return false;
      const ok = await originalRelease(memberId);
      if (ok) releasedBeforeFailure.push(memberId);
      return ok;
    };

    await assert.rejects(
      stack.lifecycle.purge(room.id, {
        expectedLifecycleRevision: stack.store.getRoom(room.id).lifecycleRevision,
        idempotencyKey: 'purge-blocked',
        requestedBy: human.id,
        confirmTitle: room.title,
        acknowledgeIrreversible: true,
      }),
      (error) => error.code === 'PROJECT_PURGE_BLOCKED' && error.details.failedRefs.length === 1,
    );

    const blocked = stack.store.getRoom(room.id);
    assert.equal(blocked.status, 'trashed', '清理受阻必须保留项目数据');
    assert.equal(blocked.lifecycleState, 'PURGE_BLOCKED');
    assert.equal(blocked.lifecyclePending.action, 'purge');
    assert.ok(blocked.lifecyclePending.failedRefs.length === 1);
    assert.equal(stack.store.listDeletionAudits(room.id)[0].result, 'blocked');
    assert.equal(existsSync(file), true);
    assert.ok(releasedBeforeFailure.length >= 1, '已成功释放的资源不会被回滚');

    stack.adapter.releaseOwnedMember = originalRelease;
    const retried = await stack.lifecycle.purge(room.id, {
      expectedLifecycleRevision: blocked.lifecycleRevision,
      idempotencyKey: 'purge-blocked-retry',
      requestedBy: human.id,
      confirmTitle: room.title,
      acknowledgeIrreversible: true,
    });
    assert.equal(retried.purged, true);
    assert.equal(stack.store.getRoom(room.id), null);
    assert.equal(existsSync(file), true);
  });

  it('does not delete a shared workspace or the other project', async (t) => {
    const { workspace, file } = sourceWorkspace(t);
    const stack = createRoomStack();
    t.after(() => stack.close());
    const first = await createStandardRoom(stack, { workspaceRef: workspace, title: '共享目录 A' });
    const second = await createStandardRoom(stack, { workspaceRef: workspace, title: '共享目录 B' });

    // Register both projects first, then read the ledger; a preview is a snapshot
    // of the shares that existed when it ran.
    stack.lifecycle.preview(first.room.id);
    const previewB = stack.lifecycle.preview(second.room.id);
    const previewA = stack.lifecycle.preview(first.room.id);
    assert.equal(previewB.sharedResources.length, 1, '两个项目共享同一 canonical 目录');
    assert.equal(previewB.sharedResources[0].refCount, 2);
    assert.equal(previewA.sharedResources[0].refCount, 2);

    await stack.lifecycle.trash(first.room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'shared-trash-a',
      requestedBy: first.human.id,
    });
    const purged = await stack.lifecycle.purge(first.room.id, {
      expectedLifecycleRevision: stack.store.getRoom(first.room.id).lifecycleRevision,
      idempotencyKey: 'shared-purge-a',
      requestedBy: first.human.id,
      confirmTitle: first.room.title,
      acknowledgeIrreversible: true,
    });
    assert.equal(purged.purged, true);
    assert.equal(existsSync(file), true, '共享源码目录绝不能被一个项目删除');
    assert.equal(stack.store.getRoom(second.room.id).status, 'active', '另一个项目不受影响');
    const after = stack.lifecycle.preview(second.room.id);
    assert.ok(after.protectedResources.some((resource) => resource.kind === 'source'));
    assert.equal(after.sharedResources.length, 0, '另一个项目释放后不再共享');
  });

  it('restores from PURGE_BLOCKED by abandoning the cleanup, not by claiming success', async (t) => {
    const { workspace } = sourceWorkspace(t);
    const { stack, room, agents, human } = await freshRoom(t, { workspaceRef: workspace });
    await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'abandon-trash',
      requestedBy: human.id,
    });
    const originalRelease = stack.adapter.releaseOwnedMember.bind(stack.adapter);
    stack.adapter.releaseOwnedMember = async (memberId) => (memberId === agents.backend.id ? false : originalRelease(memberId));
    await assert.rejects(
      stack.lifecycle.purge(room.id, {
        expectedLifecycleRevision: stack.store.getRoom(room.id).lifecycleRevision,
        idempotencyKey: 'abandon-purge',
        requestedBy: human.id,
        confirmTitle: room.title,
        acknowledgeIrreversible: true,
      }),
      (error) => error.code === 'PROJECT_PURGE_BLOCKED',
    );
    stack.adapter.releaseOwnedMember = originalRelease;

    const restored = await stack.lifecycle.restore(room.id, {
      expectedLifecycleRevision: stack.store.getRoom(room.id).lifecycleRevision,
      idempotencyKey: 'abandon-restore',
      requestedBy: human.id,
    });
    assert.equal(restored.room.status, 'paused');
    assert.equal(restored.room.lifecycleState, 'PAUSED');
    assert.equal(restored.abandonedCleanup, true, '恢复必须说明这是放弃清理，而不是清理成功');
    assert.equal(existsSync(workspace), true);
  });
});

describe('project lifecycle — revision, recovery and fencing', () => {
  it('rejects a stale revision and replays only the same idempotency key', async (t) => {
    const { stack, room, human } = await freshRoom(t);

    await assert.rejects(
      stack.lifecycle.pause(room.id, {
        expectedLifecycleRevision: 99,
        idempotencyKey: 'pause-stale',
        requestedBy: human.id,
      }),
      (error) => error.code === 'REVISION_CONFLICT',
    );

    const paused = await stack.lifecycle.pause(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'pause-1',
      requestedBy: human.id,
    });
    assert.equal(paused.room.status, 'paused');
    assert.equal(paused.room.lifecycleState, 'PAUSED');
    assert.equal(paused.room.lifecycleRevision, 2);

    const replay = await stack.lifecycle.pause(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'pause-1',
      requestedBy: human.id,
    });
    assert.equal(replay.duplicate, true);
    assert.equal(stack.store.getRoom(room.id).lifecycleRevision, 2, '重放不能制造第三个版本');

    await assert.rejects(
      stack.lifecycle.resume(room.id, {
        expectedLifecycleRevision: 0,
        idempotencyKey: 'resume-stale',
        requestedBy: human.id,
      }),
      (error) => error.code === 'REVISION_CONFLICT',
    );

    const resumed = await stack.lifecycle.resume(room.id, {
      expectedLifecycleRevision: 2,
      idempotencyKey: 'resume-1',
      requestedBy: human.id,
    });
    assert.equal(resumed.room.status, 'active');
    assert.equal(resumed.room.lifecycleRevision, 3);
  });

  it('blocks task, plan and decision mutations while paused, archived or trashed', async (t) => {
    const { stack, room, human } = await freshRoom(t);
    const task = stack.tasks.propose({
      roomId: room.id,
      actorId: human.id,
      objective: '生命周期门禁测试任务',
      acceptance: ['真实测试记录'],
    });

    const paused = await stack.lifecycle.pause(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'gate-pause',
      requestedBy: human.id,
    });
    assert.throws(
      () => stack.tasks.update({ taskId: task.id, actorId: human.id, status: 'in_progress' }),
      (error) => error.code === 'ROOM_PAUSED',
    );

    const resumed = await stack.lifecycle.resume(room.id, {
      expectedLifecycleRevision: paused.room.lifecycleRevision,
      idempotencyKey: 'gate-resume',
      requestedBy: human.id,
    });
    const archived = await stack.lifecycle.archive(room.id, {
      expectedLifecycleRevision: resumed.room.lifecycleRevision,
      idempotencyKey: 'gate-archive',
      requestedBy: human.id,
    });
    assert.throws(
      () => stack.tasks.propose({ roomId: room.id, actorId: human.id, objective: '归档项目里的任务' }),
      (error) => error.code === 'ROOM_ARCHIVED',
    );
    await assert.rejects(
      stack.decisions.propose({ roomId: room.id, actorId: human.id, statement: '归档项目里的决定', accept: true }),
      (error) => error.code === 'ROOM_ARCHIVED',
    );

    const restored = await stack.lifecycle.restore(room.id, {
      expectedLifecycleRevision: archived.room.lifecycleRevision,
      idempotencyKey: 'gate-archived-restore',
      requestedBy: human.id,
    });
    const trashed = await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: restored.room.lifecycleRevision,
      idempotencyKey: 'gate-trash',
      requestedBy: human.id,
    });
    assert.equal(trashed.room.status, 'trashed');
    await assert.rejects(
      stack.planning.commit({ roomId: room.id, planId: 'plan_missing' }),
      (error) => error.code === 'ROOM_TRASHED',
    );
  });

  it('fails closed when lifecycle actions cannot identify one acting human', async (t) => {
    const { stack, room, human } = await freshRoom(t);
    assert.equal(resolveLifecycleActor(stack.store, room.id), human.id, '单个活跃人类可以执行生命周期操作');

    stack.store.insertMember({
      id: 'member_human_2',
      roomId: room.id,
      kind: 'human',
      role: 'owner',
      displayName: '第二个人',
      handle: 'user2',
      status: 'idle',
    });
    assert.throws(
      () => resolveLifecycleActor(stack.store, room.id),
      (error) => error.code === 'FORBIDDEN',
      '两个活跃人类时无法证明是谁点击，必须 fail-closed',
    );

    stack.store.updateMember('member_human_2', { status: 'offline' });
    assert.equal(resolveLifecycleActor(stack.store, room.id), human.id);
    stack.store.updateMember(human.id, { status: 'offline' });
    assert.throws(
      () => resolveLifecycleActor(stack.store, room.id),
      (error) => error.code === 'FORBIDDEN',
      '没有活跃人类时也不能猜一个操作人',
    );
  });

  it('marks an interrupted running operation failed and never guesses success', async (t) => {
    const { stack, room } = await freshRoom(t);
    stack.store.insertLifecycleOperation({
      id: 'op_crash_test',
      roomId: room.id,
      action: 'trash',
      state: 'running',
      expectedRevision: 0,
      idempotencyKey: 'crash-key',
    });
    stack.store.updateRoom(room.id, {
      status: 'quiescing',
      lifecycleState: 'QUIESCING',
      lifecyclePending: {
        action: 'trash',
        target: 'TRASHED',
        previousStatus: 'active',
        operationId: 'op_crash_test',
        requestedAt: '2026-10-17T00:00:00.000Z',
      },
    });
    const report = stack.lifecycle.recoverStaleOperations();
    assert.equal(report.recovered, 1);
    assert.equal(report.blocked, 1);
    const recovered = stack.store.findLifecycleOperationByKey('crash-key');
    assert.equal(recovered.state, 'failed');
    assert.match(recovered.detail, /进程重启/);
    const roomAfter = stack.store.getRoom(room.id);
    assert.equal(roomAfter.status, 'quiescing', '不确认停止就保持阻断');
    assert.equal(roomAfter.lifecycleState, 'BLOCKED');
    assert.equal(stack.store.getTrashSnapshot(room.id), null);

    const reconciled = await stack.lifecycle.reconcile(room.id, {
      expectedLifecycleRevision: roomAfter.lifecycleRevision,
      idempotencyKey: 'crash-reconcile',
      requestedBy: room.ownerRef,
    });
    assert.equal(reconciled.room.status, 'trashed');
    assert.ok(stack.store.getTrashSnapshot(room.id));
  });

  it('recovers a crash during purge into PURGE_BLOCKED and allows a retry', async (t) => {
    const { workspace, file } = sourceWorkspace(t);
    const { stack, room, human } = await freshRoom(t, { workspaceRef: workspace });
    await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'crash-purge-trash',
      requestedBy: human.id,
    });
    const revision = stack.store.getRoom(room.id).lifecycleRevision;
    stack.store.insertLifecycleOperation({
      id: 'op_crash_purge',
      roomId: room.id,
      action: 'purge',
      state: 'running',
      expectedRevision: revision,
      idempotencyKey: 'crash-purge',
    });
    stack.store.updateRoom(room.id, {
      status: 'purging',
      lifecycleState: 'PURGING',
      lifecyclePending: { action: 'purge', operationId: 'op_crash_purge', requestedAt: '2026-10-17T00:00:00.000Z' },
    });

    const report = stack.lifecycle.recoverStaleOperations();
    assert.equal(report.recovered, 1);
    const recovered = stack.store.findLifecycleOperationByKey('crash-purge');
    assert.equal(recovered.state, 'failed');
    const blocked = stack.store.getRoom(room.id);
    assert.equal(blocked.status, 'trashed');
    assert.equal(blocked.lifecycleState, 'PURGE_BLOCKED', '崩溃的删除不能显示为 PURGED');
    assert.equal(stack.store.listDeletionAudits(room.id)[0].result, 'blocked');
    assert.equal(existsSync(file), true);

    const retried = await stack.lifecycle.purge(room.id, {
      expectedLifecycleRevision: blocked.lifecycleRevision,
      idempotencyKey: 'crash-purge-retry',
      requestedBy: human.id,
      confirmTitle: room.title,
      acknowledgeIrreversible: true,
    });
    assert.equal(retried.purged, true);
    assert.equal(existsSync(file), true);
  });

  it('drops a late final reply after the project enters the recycle bin', async (t) => {
    const { stack, room, agents, human } = await freshRoom(t);
    const sent = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      body: '@后端 这个请求还在进行吗',
      mentions: [{ targetMemberId: agents.backend.id, origin: 'picker', displaySnapshot: agents.backend.displayName, span: null }],
      clientMessageId: 'late-reply-message',
    });
    const backendSession = stack.adapter.agentOf(agents.backend.id).id;
    const relayId = `project-room:${room.id}:${sent.message.id}:${agents.backend.id}`;
    stack.host.emitSessionEvent(backendSession, { type: 'user/message', data: { id: relayId } });
    stack.host.emitSessionEvent(backendSession, {
      type: 'assistant/message',
      data: { message: { id: 'late-assistant-1', content: [{ type: 'text', text: '迟到的回复不应出现在回收站里' }] } },
    });

    await stack.lifecycle.trash(room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'late-reply-trash',
      requestedBy: human.id,
    });
    const messageCount = stack.store.listMessages(room.id).length;
    stack.host.emitSessionEvent(backendSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    const flushed = await stack.observer.flush(agents.backend.id);
    assert.equal(flushed, null, '回收站里的迟到回复被丢弃，不复活项目');
    assert.equal(stack.store.listMessages(room.id).length, messageCount);
    assert.equal(stack.store.getRoom(room.id).status, 'trashed', '迟到事件不能重新激活项目');
  });

  it('keeps another project and its model routing intact when one is purged', async (t) => {
    const stack = createRoomStack();
    t.after(() => stack.close());
    const first = await createStandardRoom(stack, { title: '项目 A' });
    const second = await createStandardRoom(stack, { title: '项目 B' });
    const secondRefs = stack.store
      .listMembers(second.room.id)
      .map((member) => `${member.id}:${member.modelProfileRef}:${member.sessionId}`);
    const secondSessions = stack.store.listMembers(second.room.id).map((member) => member.sessionId).filter(Boolean);

    await stack.lifecycle.trash(first.room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'cross-trash-a',
      requestedBy: first.human.id,
    });
    await stack.lifecycle.purge(first.room.id, {
      expectedLifecycleRevision: stack.store.getRoom(first.room.id).lifecycleRevision,
      idempotencyKey: 'cross-purge-a',
      requestedBy: first.human.id,
      confirmTitle: first.room.title,
      acknowledgeIrreversible: true,
    });

    assert.equal(stack.store.getRoom(second.room.id).status, 'active');
    assert.deepEqual(
      stack.store.listMembers(second.room.id).map((member) => `${member.id}:${member.modelProfileRef}:${member.sessionId}`),
      secondRefs,
      '模型绑定与成员会话不受另一个项目的删除影响',
    );
    for (const sessionId of secondSessions) assert.ok(stack.host.record(sessionId), '另一个项目的宿主会话仍然可用');
  });

  it('runs the multi-project lifecycle end to end without leaking state', async (t) => {
    const stack = createRoomStack();
    t.after(() => stack.close());
    const sourceA = sourceWorkspace(t, 'a.js', 'export const a = 1;\n');
    const sourceB = sourceWorkspace(t, 'b.js', 'export const b = 2;\n');

    // A develops, then is archived.
    const projectA = await createStandardRoom(stack, { title: '项目 A', workspaceRef: sourceA.workspace });
    await stack.messages.send({
      roomId: projectA.room.id,
      authorId: projectA.human.id,
      body: 'A 的历史消息',
      clientMessageId: 'at88-a-message',
    });
    const archivedA = await stack.lifecycle.archive(projectA.room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'at88-archive-a',
      requestedBy: projectA.human.id,
    });
    assert.equal(archivedA.room.lifecycleState, 'ARCHIVED');

    // B is created and runs independently while A is archived.
    const projectB = await createStandardRoom(stack, { title: '项目 B', workspaceRef: sourceB.workspace });
    const taskB = stack.tasks.propose({
      roomId: projectB.room.id,
      actorId: projectB.human.id,
      objective: 'B 的独立任务',
      acceptance: ['真实记录'],
    });
    assert.equal(stack.store.getRoom(projectB.room.id).status, 'active');

    // A goes to the bin, comes back paused, then is permanently deleted.
    const trashedA = await stack.lifecycle.trash(projectA.room.id, {
      expectedLifecycleRevision: archivedA.room.lifecycleRevision,
      idempotencyKey: 'at88-trash-a',
      requestedBy: projectA.human.id,
    });
    assert.equal(trashedA.room.status, 'trashed');
    const restoredA = await stack.lifecycle.restore(projectA.room.id, {
      expectedLifecycleRevision: trashedA.room.lifecycleRevision,
      idempotencyKey: 'at88-restore-a',
      requestedBy: projectA.human.id,
    });
    assert.equal(restoredA.room.status, 'paused');
    assert.equal(stack.store.listMessages(projectA.room.id).length, 1, '恢复后 A 的历史仍在');
    const reTrashedA = await stack.lifecycle.trash(projectA.room.id, {
      expectedLifecycleRevision: restoredA.room.lifecycleRevision,
      idempotencyKey: 'at88-retrash-a',
      requestedBy: projectA.human.id,
    });
    assert.equal(reTrashedA.room.status, 'trashed');
    const purgedA = await stack.lifecycle.purge(projectA.room.id, {
      expectedLifecycleRevision: reTrashedA.room.lifecycleRevision,
      idempotencyKey: 'at88-purge-a',
      requestedBy: projectA.human.id,
      confirmTitle: projectA.room.title,
      acknowledgeIrreversible: true,
    });
    assert.equal(purgedA.purged, true);
    assert.equal(stack.store.getRoom(projectA.room.id), null);

    // B and both source trees are untouched; A's tombstone is the only residue.
    assert.equal(stack.store.getRoom(projectB.room.id).status, 'active');
    assert.equal(stack.store.getTask(taskB.id).status, 'proposed');
    assert.equal(readFileSync(sourceA.file, 'utf8'), sourceA.content, 'A 的源码不被删除');
    assert.equal(readFileSync(sourceB.file, 'utf8'), sourceB.content, 'B 的源码不受影响');
    assert.equal(stack.store.getProjectTombstone(projectA.room.id).result, 'purged');
  });
});

describe('project lifecycle — migration defaults', () => {
  it('derives a lifecycle state for a legacy room and keeps unknown resources protected', async (t) => {
    const { stack, room, human } = await freshRoom(t);
    // A member had a session but no recorded ownership. The ledger must
    // treat that as unknown/protected, never as plugin-owned.
    stack.store.updateMember(human.id, { sessionId: 'legacy-borrowed-session' });
    const resources = stack.lifecycle.resources.syncRoom(room.id);
    const legacy = resources.find((resource) => resource.hostRef === 'legacy-borrowed-session');
    assert.ok(legacy);
    assert.equal(legacy.ownership, 'unknown');
    assert.equal(legacy.safeDeleteStatus, 'unknown');
    const preview = stack.lifecycle.preview(room.id);
    assert.ok(preview.unknownResources.some((resource) => resource.hostRef === 'legacy-borrowed-session'));
    assert.ok(preview.protectedResources.some((resource) => resource.kind === 'unknown-resource'));

    // A room whose stored state lags its status is repaired by the v7→v8
    // migration; this asserts the same rule the migration uses.
    stack.store.updateRoom(room.id, { status: 'archived', lifecycleState: 'ACTIVE' });
    assert.equal(stack.lifecycle.inspect(room.id).lifecycleState, 'ACTIVE');
  });
});
