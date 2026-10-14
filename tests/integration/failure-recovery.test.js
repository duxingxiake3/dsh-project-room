/**
 * Project Room — failure windows, pause/resume/retire and restart recovery.
 *
 * These tests drive the real delivery ledger and the real recovery service; the
 * fake host only stands in for the Harness runtime, and it is deliberately able
 * to lose an input identity so "the host cannot confirm" is testable.
 *
 * Acceptance cases covered here: AT15, AT16, AT26, AT28, AT31, AT33, AT35, plus
 * the restart/recovery sequence of the design notes.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import { DELIVERY_LABELS, RoomError } from '../../shared/contracts.js';
import { RoomStore } from '../../src/host/storage/store.js';
import { createRoomStack, createStandardRoom, deliveryCountOf, useTemporaryDataDir } from './harness.js';

/**
 * A fresh stack + standard four-member room for one test.
 * @param {import('node:test').TestContext} t
 * @param {{ stack?: object, room?: object }} [input]
 */
async function freshRoom(t, input = {}) {
  const stack = createRoomStack(input.stack ?? {});
  t.after(() => stack.close());
  const team = await createStandardRoom(stack, input.room ?? {});
  return { stack, ...team };
}

/** Room events of one type, read back from the ledger the services wrote. */
function eventsOfType(stack, roomId, eventType) {
  return stack.store.db
    .prepare('select seq, payload from room_event where room_id = ? and event_type = ? order by seq asc')
    .all(roomId, eventType)
    .map((row) => ({ seq: row.seq, payload: JSON.parse(row.payload) }));
}

describe('project room — crash between save and admission (AT15)', () => {
  it('keeps the message and delivers it on the next reconcile', async (t) => {
    // Delivery disabled: "the message is saved" and "the host admitted it" are
    // two different facts, and this models the gap between them.
    const stack = createRoomStack({ delivery: false });
    t.after(() => stack.close());
    const { room, agents, human } = await createStandardRoom(stack);

    const sent = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      clientMessageId: 'crash-1',
      body: '@backend 接口按 v2 实现，先别动数据库。',
    });
    const pending = stack.store.getDelivery(sent.message.id, agents.backend.id);
    assert.equal(pending.status, 'pending', '消息已落盘，投递尚未发生');
    assert.equal(pending.hostMessageId, null);
    assert.equal(pending.deliveryAttempt, 0);
    assert.equal(deliveryCountOf(stack, agents.backend.id), 0, '宿主还没有收到任何东西');
    assert.equal(stack.store.listMessages(room.id).length, 1, '群消息不因为投递没发生而丢失');

    // Recovery: the ledger is the source of truth, so the message is delivered.
    const outcomes = await stack.delivery.reconcileRoom(room.id);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, 'accepted');
    const delivered = stack.store.getDelivery(sent.message.id, agents.backend.id);
    assert.equal(delivered.status, 'accepted');
    assert.equal(delivered.deliveryAttempt, 1);
    assert.ok(delivered.hostMessageId, '回执必须记下宿主标识');
    assert.equal(deliveryCountOf(stack, agents.backend.id), 1, '消息最终进入目标会话');

    const again = await stack.delivery.reconcileRoom(room.id);
    assert.deepEqual(again, [], '已送达的投递不再是待处理工作');
    assert.equal(deliveryCountOf(stack, agents.backend.id), 1, '核对不会重复投递');
  });
});

describe('project room — crash between admission and receipt (AT16)', () => {
  it('stays uncertain unless the host can prove absence', async (t) => {
    const stack = createRoomStack();
    t.after(() => stack.close());
    const { room, agents, human } = await createStandardRoom(stack);

    const sent = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      clientMessageId: 'uncertain-1',
      body: '@backend 这条要确认一下。',
    });
    const accepted = stack.store.getDelivery(sent.message.id, agents.backend.id);
    assert.equal(accepted.status, 'accepted');
    assert.ok(accepted.hostMessageId);
    const hostMessageId = accepted.hostMessageId;
    const backendSession = agents.backend.sessionId;
    assert.equal(stack.host.received(backendSession).length, 1);

    // Crash window: the host took the input, the receipt never landed.
    stack.store.upsertDelivery({ ...accepted, status: 'uncertain', detail: '宿主准入后回执未落盘' });
    // The host cannot confirm: this member has no live session at all.
    await stack.adapter.releaseOwnedMember(agents.backend.id);
    assert.equal(stack.adapter.statusOf(agents.backend.id), 'absent');

    const unconfirmed = await stack.delivery.reconcileRoom(room.id);
    assert.equal(unconfirmed.length, 1);
    assert.equal(unconfirmed[0].outcome, 'uncertain', '宿主无法确认时不能猜，也不能自动重发');
    const stillUncertain = stack.store.getDelivery(sent.message.id, agents.backend.id);
    assert.equal(stillUncertain.status, 'uncertain');
    assert.equal(stillUncertain.hostMessageId, hostMessageId, '宿主标识必须保留，供人工核对');
    assert.match(stillUncertain.detail, /无法确认/);
    assert.equal(stack.host.received(backendSession).length, 1, 'uncertain 状态不触发重发');

    // Absence is now provable: the member's session is back and the host has no
    // record of that input identity — it never entered the inbox and no durable
    // user/message event names it.
    await stack.ensureMemberSession({ memberId: agents.backend.id });
    assert.equal(stack.store.getMember(agents.backend.id).sessionId, backendSession, '恢复的是同一个会话身份');
    stack.host.forget(backendSession, hostMessageId);
    const beforeProof = stack.host.received(backendSession).length;

    const proven = await stack.delivery.reconcileRoom(room.id);
    assert.equal(proven.length, 1);
    assert.equal(proven[0].outcome, 'failed', '只有证明未收到时才判定失败');
    const failed = stack.store.getDelivery(sent.message.id, agents.backend.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.hostMessageId, hostMessageId, '失败记录同样保留宿主标识');
    assert.equal(failed.deliveryAttempt, 1, '判定失败不等于又投了一次');
    assert.equal(stack.host.received(backendSession).length, beforeProof, '失败也不自动重投，由人决定');
  });
});

describe('project room — pause, resume and retire (AT26/AT28)', () => {
  it('keeps messages while paused, syncs versions on resume, and hands over on retire', async (t) => {
    const { stack, room, agents, human } = await freshRoom(t);

    const added = await stack.rooms.ensureMember({
      roomId: room.id,
      role: 'devops',
      displayName: '运维·小周',
      handle: 'devops',
      createSession: (sessionInput) => stack.ensureMemberSession(sessionInput),
    });
    const devops = added.member;
    const buildTask = stack.tasks.propose({
      roomId: room.id,
      actorId: agents.coordinator.id,
      objective: '整理构建与启动说明',
      suggestedOwnerId: devops.id,
      acceptance: ['新环境可按说明复现'],
    });

    // --- pause: the message is kept, nothing is delivered ------------------
    const backendBefore = deliveryCountOf(stack, agents.backend.id);
    stack.rooms.pauseMember(agents.backend.id);
    assert.equal(stack.store.getMember(agents.backend.id).status, 'paused');
    const sent = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      clientMessageId: 'pause-1',
      body: '@backend 接口先别动，等我确认。',
    });
    const delivery = sent.message.deliveries[0];
    assert.equal(delivery.recipientId, agents.backend.id);
    assert.equal(delivery.status, 'paused', '暂停成员的消息保留为待处理，而不是被取消');
    assert.match(delivery.detail, /暂停/);
    assert.equal(deliveryCountOf(stack, agents.backend.id), backendBefore, '暂停期间不投递、不唤醒模型');
    assert.ok(
      stack.delivery.problems(room.id).some((problem) => problem.recipientId === agents.backend.id && problem.status === 'paused' && problem.label),
      '待处理状态必须对用户可见',
    );
    assert.equal(
      stack.store.listPendingDeliveries(room.id).some((row) => row.recipientId === agents.backend.id),
      true,
      '暂停的投递留在待处理账本里，恢复后仍可处理',
    );

    // --- resume: versions are synced before work continues -----------------
    const source = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      clientMessageId: 'decision-src',
      body: '@运维 运行说明按 Node 24 写。',
    });
    const decision = await stack.decisions.recordHumanChange({
      roomId: room.id,
      actorId: human.id,
      sourceMessageId: source.message.id,
      statement: '运行说明按 Node 24 编写',
      scope: '运行说明',
      affectedTaskIds: [buildTask.id],
    });
    assert.equal(decision.revision, 1);

    const lastSeqBeforeResume = stack.store.getRoom(room.id).lastSeq;
    assert.ok(lastSeqBeforeResume > 0, '暂停期间群里确实有未读内容');
    const resumed = stack.rooms.resumeMember(agents.backend.id);
    assert.equal(resumed.status, 'idle');
    assert.equal(resumed.lastSeenSeq, lastSeqBeforeResume, '恢复时同步到当时的群游标');
    assert.equal(resumed.lastAppliedDecisionRevision, decision.revision, '恢复时同步到当前决定版本');
    assert.equal(eventsOfType(stack, room.id, 'member.resumed').length, 1);

    // --- retire: aliases are tombstoned and open tasks need a handover -----
    const devopsDelivered = deliveryCountOf(stack, devops.id);
    assert.ok(devopsDelivered > 0, '退出之前他确实参与过协作');
    const retired = stack.rooms.retireMember(devops.id);
    assert.equal(retired.member.status, 'offline');
    assert.deepEqual(retired.openTasks.map((task) => task.id), [buildTask.id], '未完成的任务必须列出来交接');
    assert.equal(stack.store.getTask(buildTask.id).needsSync, true, '交接前不能当成已完成');
    const tombstones = stack.store.listTombstones(room.id);
    for (const name of ['devops', '运维', '部署']) {
      assert.ok(tombstones.includes(name), `${name} 必须变成不可复用的旧名`);
    }
    const mention = stack.rooms.resolveMentions({ roomId: room.id, body: '@devops 你看一下构建。' });
    assert.deepEqual(mention.targets, [], '退出成员的旧名不能悄悄改投别人');
    assert.deepEqual(mention.unknownText, ['@devops']);
    const afterRetire = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      clientMessageId: 'after-retire',
      body: '@devops 你看一下构建。',
    });
    assert.equal(
      afterRetire.message.deliveries.some((entry) => entry.recipientId === devops.id),
      false,
      '退出成员不会再收到任何投递',
    );
    assert.deepEqual(
      afterRetire.message.deliveries.map((entry) => entry.recipientId),
      [agents.coordinator.id],
      '点名无法解析时按普通文本处理：用户未点名的消息默认由主代理接收（the design notes）',
    );
    assert.ok(afterRetire.warnings.some((warning) => warning.includes('无法识别')));
    assert.equal(deliveryCountOf(stack, devops.id), devopsDelivered, '退出之后不会再收到任何投递');

    // --- a paused ROOM is not silently resumed by an ordinary message ------
    stack.store.updateRoom(room.id, { status: 'paused' });
    const testerBefore = deliveryCountOf(stack, agents.tester.id);
    const during = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      clientMessageId: 'room-paused-1',
      body: '@tester 用例先别跑。',
    });
    assert.equal(during.message.deliveries[0].status, 'paused');
    assert.equal(deliveryCountOf(stack, agents.tester.id), testerBefore, '暂停期间不唤醒成员');
    assert.equal(stack.store.getRoom(room.id).status, 'paused', '一条普通发言不能静默恢复项目');

    stack.store.updateRoom(room.id, { status: 'active' });
    const afterResume = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      clientMessageId: 'room-resumed-1',
      body: '@tester 可以跑了。',
    });
    assert.equal(afterResume.message.deliveries[0].status, 'accepted', '显式恢复后照常投递');
    assert.equal(deliveryCountOf(stack, agents.tester.id), testerBefore + 1);

    // --- AT28: unloading must not stop work or lose state ------------------
    const beforeUnload = stack.store.getTask(buildTask.id);
    const timelineBefore = stack.store.listMessages(room.id).map((message) => message.id);
    await stack.close();
    const reopened = new RoomStore({ file: stack.file, lockFile: `${stack.file}.lock` });
    reopened.open();
    try {
      const afterUnload = reopened.getTask(buildTask.id);
      assert.equal(afterUnload.status, beforeUnload.status, '卸载不会取消或停止任务');
      assert.equal(afterUnload.revision, beforeUnload.revision);
      assert.deepEqual(reopened.listMessages(room.id).map((message) => message.id), timelineBefore, '群记录一条不少');
    } finally {
      reopened.close();
    }
  });
});

describe('project room — honest delivered/read states (AT31)', () => {
  it('says "delivered, not read" until the host really observes a claim', async (t) => {
    const { stack, room, agents, human } = await freshRoom(t);
    assert.equal(DELIVERY_LABELS.accepted, '已送达，尚未确认取用');
    assert.equal(
      Object.values(DELIVERY_LABELS).some((label) => label.includes('已读')),
      false,
      '任何时候都不能声称“已读”',
    );

    const sent = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      clientMessageId: 'read-1',
      body: '@backend 接口字段确认一下。',
    });
    const delivery = stack.store.getDelivery(sent.message.id, agents.backend.id);
    assert.equal(delivery.status, 'accepted');
    assert.equal(DELIVERY_LABELS[delivery.status], '已送达，尚未确认取用');

    // An unrelated session event is not a receipt for this message.
    stack.host.emitSessionEvent(agents.backend.sessionId, { type: 'user/message', id: 'not-a-relay-identity' });
    assert.equal(stack.store.getDelivery(sent.message.id, agents.backend.id).status, 'accepted');
    // Neither is an identity that belongs to someone else.
    assert.equal(
      stack.delivery.observeClaimed({ memberId: agents.backend.id, hostMessageId: 'someone-else:id:0:0' }),
      null,
    );
    assert.equal(stack.store.getDelivery(sent.message.id, agents.backend.id).status, 'accepted');

    // Only the host's own durable observation of THIS input moves it — and that
    // is a different label, still not "read".
    stack.host.emitSessionEvent(agents.backend.sessionId, { type: 'user/message', id: delivery.hostMessageId });
    const claimed = stack.store.getDelivery(sent.message.id, agents.backend.id);
    assert.equal(claimed.status, 'claimed');
    assert.equal(DELIVERY_LABELS.claimed, '对方本轮已取用');
  });
});

describe('project room — a native permission wait is not a chat approval (AT33)', () => {
  it('leaves task state untouched when a member is waiting for the host', async (t) => {
    const { stack, room, agents, human } = await freshRoom(t);

    const task = stack.tasks.propose({
      roomId: room.id,
      actorId: agents.coordinator.id,
      objective: '给部署脚本加只读检查',
      suggestedOwnerId: agents.backend.id,
      acceptance: ['脚本只读运行且不改动仓库'],
    });
    stack.tasks.update({ roomId: room.id, actorId: agents.backend.id, taskId: task.id, status: 'in_progress' });
    // The member is blocked on a native permission prompt, not on a chat message.
    stack.store.updateMember(agents.backend.id, { status: 'needs_user' });
    const before = stack.store.getTask(task.id);
    const receivedBefore = deliveryCountOf(stack, agents.backend.id);

    const sent = await stack.messages.send({
      roomId: room.id,
      authorId: human.id,
      clientMessageId: 'permission-1',
      body: '@backend 我批准了，继续执行部署脚本。',
    });
    assert.deepEqual(sent.message.deliveries.map((entry) => entry.recipientId), [agents.backend.id], '消息照常送达会话');

    const after = stack.store.getTask(task.id);
    assert.equal(after.status, before.status, '群里的聊天不能改变任务状态');
    assert.equal(after.revision, before.revision);
    assert.equal(after.needsSync, before.needsSync);
    assert.equal(eventsOfType(stack, room.id, 'task.accepted').length, 0);
    assert.equal(stack.store.listArtifacts(room.id, { taskId: task.id }).length, 0, '没有产物就不能有验收结论');
    assert.equal(stack.store.getMember(agents.backend.id).status, 'needs_user', '聊天不能替成员结束原生权限等待');
    assert.equal(deliveryCountOf(stack, agents.backend.id), receivedBefore + 1);
    assert.equal(
      eventsOfType(stack, room.id, 'task.updated').length,
      1,
      '只有成员自己推进的那一次任务更新，聊天没有产生第二次',
    );
  });
});

describe('project room — single writer (AT35)', () => {
  it('refuses a second writer for the same database and keeps the first working', async (t) => {
    const stack = createRoomStack();
    t.after(() => stack.close());
    const lockFile = `${stack.file}.lock`;
    assert.equal(existsSync(lockFile), true);

    const second = new RoomStore({ file: stack.file, lockFile });
    assert.throws(
      () => second.open(),
      (error) => error instanceof RoomError && error.code === 'FORBIDDEN',
      '同一个数据库只允许一个有效所有者',
    );
    assert.equal(existsSync(lockFile), true, '被拒绝的写入者不能抢走锁');

    // The legitimate owner keeps working normally.
    const team = await createStandardRoom(stack);
    assert.equal(team.members.filter((member) => member.kind === 'agent').length, 4);
    assert.equal(stack.host.createdAgents().length, 4, '被拒绝的第二个写入者不能重复驱动成员');
  });
});

describe('project room — restart and recovery', () => {
  it('restores member sessions, marks stale attempts, and never claims work was re-run', async (t) => {
    const dataDir = useTemporaryDataDir('recovery');
    const stackA = createRoomStack({ dataDir });
    const teamA = await createStandardRoom(stackA, { goal: '实现手机验证码登录' });
    const roomId = teamA.room.id;
    const membersA = teamA.members.filter((member) => member.kind === 'agent');

    const task = stackA.tasks.propose({
      roomId,
      actorId: teamA.agents.coordinator.id,
      objective: '实现验证码登录接口',
      suggestedOwnerId: teamA.agents.backend.id,
      acceptance: ['正常/过期/错误三态可调用'],
    });
    stackA.tasks.update({ roomId, actorId: teamA.agents.backend.id, taskId: task.id, status: 'in_progress' });
    const attempt = stackA.tasks.startAttempt({ taskId: task.id, actorId: teamA.agents.backend.id });
    assert.equal(attempt.state, 'running');
    const timelineBefore = stackA.store.listMessages(roomId).map((message) => message.id);
    const file = stackA.file;

    // Unload the plugin the way a restart does: sessions released, store closed.
    await stackA.close();

    // Restart: a new store handle on the same file and a host with no live agents.
    const stackB = createRoomStack({ dataDir, file });
    t.after(() => stackB.close());
    assert.equal(stackB.adapter.statusOf(teamA.agents.backend.id), 'absent', '重启后没有任何活会话');

    const report = await stackB.recovery.recoverRoom(roomId);
    assert.equal(report.sessionsRestored, 4, '四个成员的会话都要重新建立');
    assert.equal(stackB.host.createdAgents().length, 4);
    for (const member of membersA) {
      const again = stackB.store.getMember(member.id);
      assert.equal(again.sessionId, member.sessionId, '恢复必须复用原来的会话身份');
      assert.equal(again.sessionOwnership, 'owned');
      assert.ok(stackB.adapter.agentOf(member.id), '恢复后 adapter 重新持有该成员的会话');
    }

    // The stale execution lease becomes "needs recovery", never a blind re-run.
    assert.equal(stackB.store.getAttempt(attempt.id).state, 'needs-recovery');
    assert.equal(stackB.store.getTask(task.id).status, 'blocked');
    assert.equal(stackB.store.listAttempts(task.id).length, 1, '恢复不会凭空再建一个 attempt');
    assert.equal(report.staleAttempts, 1);

    // The report states what was NOT done, and does not claim a re-run.
    assert.match(report.text, /不会重新派活/);
    assert.match(report.text, /未自动重跑/);
    assert.equal(/已重新运行|已完成重跑|已重新执行|已重新安装/.test(report.text), false, '报告不能声称重跑过工作');
    assert.notEqual(stackB.store.getMeta(`recovery:${roomId}`), null);

    // Nothing was lost or duplicated: same timeline, same ledger.
    assert.deepEqual(stackB.store.listMessages(roomId).map((message) => message.id), timelineBefore);
    const inspected = stackB.recovery.inspect(roomId);
    assert.equal(inspected.attempts.length, 1);
    assert.equal(inspected.attempts[0].id, attempt.id);
    assert.match(inspected.note, /已送达/);

    // A second recovery pass is safe: no extra sessions, no extra attempts.
    const again = await stackB.recovery.recoverRoom(roomId);
    assert.equal(stackB.host.createdAgents().length, 4, '重复恢复不重复建会话');
    assert.equal(stackB.store.listAttempts(task.id).length, 1);
    assert.equal(again.sessionsRestored, 0, '会话已经活着，就不再重复恢复');
  });
});
