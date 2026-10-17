/**
 * Project Room — reminder expiry.
 *
 * Reminder expiry covers reminders that are durable, deduplicated, and — the part with
 * real product consequences — **invalidated when the reason for them is gone**:
 *
 *   "任务已完成、回复已收到或成员已退出时，提醒失效。
 *    提醒消息本身不自动触发『提醒的提醒』。"
 *
 * A reminder that fires after the task was accepted is worse than no reminder, so
 * every invalidation rule gets an assertion here rather than being assumed to work
 * because the happy path does.
 *
 * These run against the real services through `createRoomStack`; only the clock is
 * controlled, because a test that waits 30 real minutes is a test nobody runs.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createRoomStack, createStandardRoom, useTemporaryDataDir } from './harness.js';

/**
 * A reminder due in the past, so a scan always considers it claimable.
 *
 * Deliberately bypasses `task-service`'s own reminder creation: this test is about
 * what the *scanner* does with a due row, and a helper that reached through the
 * production write path could not create the states under test (a reminder for an
 * already-accepted task, for instance).
 */
function overdueReminder(stack, { roomId, taskId, ownerId, dedupeKey }) {
  stack.store.upsertReminder({
    id: `reminder_test_${Math.random().toString(36).slice(2, 10)}`,
    roomId,
    taskId,
    targetId: ownerId,
    dueAt: new Date(Date.now() - 60_000).toISOString(),
    dedupeKey,
    state: 'pending',
  });
}

/** Messages the reminder service actually posted into the room. */
function reminderMessages(stack, roomId) {
  return stack.store
    .listMessages(roomId, { limit: 200 })
    .filter((message) => String(message.clientMessageId ?? '').startsWith('reminder:'));
}

/** A real workspace with a real file, so an artifact can be genuinely verified. */
function workspaceWithFile(name = 'login.md') {
  const dir = mkdtempSync(join(tmpdir(), 'room-reminder-ws-'));
  writeFileSync(join(dir, name), '# 登录接口\n', 'utf8');
  return dir;
}

/**
 * Walk a task all the way to `accepted` through the real state machine, so the
 * "task is finished" expiry rule is tested against a genuinely finished task.
 */
async function completeTask(stack, { room, agents, objective, workspaceRef, file }) {
  const task = stack.tasks.propose({
    roomId: room.id,
    objective,
    actorId: agents.coordinator.id,
    suggestedOwnerId: agents.backend.id,
    acceptance: ['接口可用'],
  });
  stack.tasks.assign({ roomId: room.id, taskId: task.id, memberId: agents.backend.id, actorId: agents.coordinator.id });
  stack.tasks.update({ roomId: room.id, taskId: task.id, actorId: agents.backend.id, status: 'in_progress' });
  // A real artifact first: acceptance requires at least one verified product,
  // so a task cannot reach `accepted` on a sentence.
  stack.artifacts.publish({
    roomId: room.id,
    taskId: task.id,
    actorId: agents.backend.id,
    kind: 'file',
    location: file,
    summary: '登录接口说明',
    workspaceRef,
  });
  stack.tasks.update({
    roomId: room.id,
    taskId: task.id,
    actorId: agents.backend.id,
    status: 'submitted',
    evidenceRefs: [file],
  });
  // `submitted → verifying` is driven by `verify()` itself; calling `update` for it
  // is rejected, because the transition is owned by the acceptance flow.
  await stack.tasks.verify({
    roomId: room.id,
    taskId: task.id,
    actorId: agents.coordinator.id,
    passed: true,
    evidenceRefs: [file],
  });
  const finished = stack.store.getTask(task.id);
  assert.equal(finished.status, 'accepted', 'the fixture must really reach accepted');
  return finished;
}

describe('reminders — a due reminder is posted once and recorded', () => {
  let stack;
  let room;
  let agents;
  let task;

  before(async () => {
    useTemporaryDataDir('reminder');
    stack = createRoomStack();
    ({ room, agents } = await createStandardRoom(stack));
    task = stack.tasks.propose({
      roomId: room.id,
      objective: '把验证码接口接上',
      actorId: agents.coordinator.id,
      suggestedOwnerId: agents.backend.id,
    });
  });

  after(async () => {
    await stack.close();
  });

  it('posts the reminder into the room and marks the row fired', async () => {
    overdueReminder(stack, {
      roomId: room.id,
      taskId: task.id,
      ownerId: agents.backend.id,
      dedupeKey: `blocker|${task.id}|r1`,
    });

    const pass = await stack.reminders.scan();
    assert.equal(pass.examined, 1, 'the overdue reminder must be examined');
    assert.equal(pass.fired, 1, 'a reminder whose premise still holds must fire');

    const posted = reminderMessages(stack, room.id);
    assert.equal(posted.length, 1, 'exactly one reminder message must be in the room');
    assert.match(posted[0].body, /@backend/, 'the reminder must name the member it is chasing');
    assert.match(posted[0].body, /把验证码接口接上/, 'the reminder must carry the task objective');
    assert.match(posted[0].body, new RegExp(task.id), 'the reminder must reference the task id');
    assert.match(posted[0].body, /提议中/, 'the reminder must report the real task state');

    const rows = stack.store.listReminders(room.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'fired');
    assert.ok(rows[0].firedAt, 'a fired reminder records when it fired');
  });

  it('is idempotent: a second scan does not send a second copy', async () => {
    const before = reminderMessages(stack, room.id).length;
    const pass = await stack.reminders.scan();
    assert.equal(pass.examined, 0, 'a settled reminder is no longer due');
    assert.equal(pass.fired, 0);
    assert.equal(reminderMessages(stack, room.id).length, before, 'no duplicate reminder may appear');
  });

  it('never mentions anyone, so a reminder cannot start a new causal chain', async () => {
    const posted = reminderMessages(stack, room.id)[0];
    assert.equal(posted.mentions.length, 0, 'a reminder must not trigger reminders of its own');
  });

  it('records a reminder.fired event an operator can trace', async () => {
    const events = stack.store
      .listRoomEvents(room.id, { limit: 200 })
      .filter((event) => event.eventType === 'reminder.fired');
    assert.equal(events.length, 1, 'firing must leave one durable event');
    assert.equal(events[0].payload.targetId, agents.backend.id);
  });
});

describe('reminders — invalidation when the premise is gone', () => {
  let stack;

  before(() => {
    useTemporaryDataDir('reminder-expiry');
    stack = createRoomStack();
  });

  after(async () => {
    await stack.close();
  });

  it('expires rather than fires when the task was already accepted', async () => {
    const workspaceRef = workspaceWithFile();
    const { room, agents } = await createStandardRoom(stack, { title: '已完成的任务', workspaceRef });
    const task = await completeTask(stack, {
      room,
      agents,
      objective: '已经做完的事',
      workspaceRef,
      file: 'login.md',
    });

    overdueReminder(stack, {
      roomId: room.id,
      taskId: task.id,
      ownerId: agents.backend.id,
      dedupeKey: `blocker|${task.id}|late`,
    });

    const pass = await stack.reminders.scan();
    assert.equal(pass.fired, 0, 'a finished task must not be chased');
    assert.equal(pass.expired, 1);
    assert.equal(reminderMessages(stack, room.id).length, 0, 'no reminder message may be posted for a finished task');
    const row = stack.store.listReminders(room.id, { state: 'expired' })[0];
    assert.equal(row.reason, 'task-accepted', 'the reason must name why it was retired');
  });

  it('expires when the recipient has left the room', async () => {
    const { room, agents } = await createStandardRoom(stack, { title: '有人退出的任务' });
    const task = stack.tasks.propose({
      roomId: room.id,
      objective: '负责人已经退出',
      actorId: agents.coordinator.id,
      suggestedOwnerId: agents.tester.id,
    });
    stack.rooms.retireMember(agents.tester.id);

    overdueReminder(stack, {
      roomId: room.id,
      taskId: task.id,
      ownerId: agents.tester.id,
      dedupeKey: `blocker|${task.id}|gone`,
    });

    const pass = await stack.reminders.scan();
    assert.equal(pass.fired, 0, 'a retired member cannot be chased');
    assert.equal(pass.expired, 1);
    assert.equal(stack.store.listReminders(room.id, { state: 'expired' })[0].reason, 'recipient-gone');
  });

  it('expires when the room is archived', async () => {
    const { room, agents } = await createStandardRoom(stack, { title: '归档的任务' });
    const task = stack.tasks.propose({
      roomId: room.id,
      objective: '项目已经归档',
      actorId: agents.coordinator.id,
      suggestedOwnerId: agents.backend.id,
    });
    stack.store.updateRoom(room.id, { status: 'archived' });

    overdueReminder(stack, {
      roomId: room.id,
      taskId: task.id,
      ownerId: agents.backend.id,
      dedupeKey: `blocker|${task.id}|archived`,
    });

    const pass = await stack.reminders.scan();
    assert.equal(pass.fired, 0);
    assert.equal(pass.expired, 1);
    assert.equal(stack.store.listReminders(room.id, { state: 'expired' })[0].reason, 'room-archived');
  });

  it('fires the service-created reminder for a blocked task, carrying the recorded blocker', async () => {
    const { room, agents } = await createStandardRoom(stack, { title: '受阻的任务' });
    const task = stack.tasks.propose({
      roomId: room.id,
      objective: '缺少短信服务凭据',
      actorId: agents.coordinator.id,
      suggestedOwnerId: agents.backend.id,
    });
    stack.tasks.assign({ roomId: room.id, taskId: task.id, memberId: agents.backend.id, actorId: agents.coordinator.id });
    // The production path creates the reminder here; nothing in this test inserts one.
    stack.tasks.update({
      roomId: room.id,
      taskId: task.id,
      actorId: agents.backend.id,
      status: 'blocked',
      blockers: '缺少短信服务的测试凭据',
    });

    const created = stack.store.listReminders(room.id, { state: 'pending' });
    assert.equal(created.length, 1, 'blocking a task must create exactly one pending reminder');
    // Force it due without waiting 30 minutes.
    stack.store.upsertReminder({ ...created[0], dueAt: new Date(Date.now() - 60_000).toISOString(), state: 'pending' });

    const pass = await stack.reminders.scan();
    assert.equal(pass.fired, 1, 'a blocked task is exactly what a reminder is for');
    const posted = reminderMessages(stack, room.id);
    assert.equal(posted.length, 1);
    assert.match(posted[0].body, /受阻/, 'the reminder reports the blocked state');
    assert.match(posted[0].body, /缺少短信服务的测试凭据/, 'the reminder carries the recorded blocker, not just the task title');
  });
});

describe('reminders — the scanner is a timer, not a leak', () => {
  it('start/stop is idempotent and leaves no pending timer', async () => {
    useTemporaryDataDir('reminder-timer');
    const stack = createRoomStack();
    try {
      const stopFirst = stack.reminders.start();
      assert.ok(stack.reminders.timer, 'start must create a timer');
      // A second start is a no-op, so a double activation cannot double-scan.
      stack.reminders.start();
      stopFirst();
      assert.equal(stack.reminders.timer, null, 'stop must clear the timer');
      stopFirst();
      assert.equal(stack.reminders.timer, null, 'stopping twice is safe');
    } finally {
      await stack.close();
    }
  });

  it('a scan of an empty database reports nothing rather than throwing', async () => {
    useTemporaryDataDir('reminder-empty');
    const stack = createRoomStack();
    try {
      const pass = await stack.reminders.scan();
      assert.deepEqual(
        { examined: pass.examined, fired: pass.fired, expired: pass.expired, failed: pass.failed },
        { examined: 0, fired: 0, expired: 0, failed: 0 },
      );
    } finally {
      await stack.close();
    }
  });
});
