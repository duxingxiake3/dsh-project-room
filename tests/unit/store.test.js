/**
 * Store tests — schemas, sequences, idempotency, revision conflicts and the
 * single-writer lock. These are the guarantees the rest of the plugin builds
 * on, so they are tested against a real SQLite file, not a fake.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { RoomError, isoTimestamp } from '../../shared/contracts.js';
import { RoomStore, SCHEMA_VERSION, payloadHash, temporaryDatabasePath } from '../../src/host/storage/store.js';

/** @type {RoomStore} */
let store;
/** @type {string} */
let file;

before(() => {
  file = temporaryDatabasePath();
  store = new RoomStore({ file, lockFile: `${file}.lock` });
  store.open();
});

after(() => {
  store.close();
  // Windows keeps a closed-but-recently-mapped file locked for a moment; a
  // leftover temp file is harmless, so cleanup must not fail the suite.
  try {
    for (const suffix of ['', '.lock', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function createRoom(id = 'room_test') {
  return store.insertRoom({ id, title: '测试项目群', ownerRef: 'user_local', workspaceRef: 'E:\\demo' });
}

describe('store — rooms, members and aliases', () => {
  it('creates a room and reads it back with UTC ISO timestamps', () => {
    const room = createRoom();
    assert.equal(room.id, 'room_test');
    assert.equal(room.status, 'active');
    assert.equal(room.lastSeq, 0);
    assert.equal(room.membershipRevision, 0);
    assert.match(room.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('bumps membership and plan revisions monotonically', () => {
    assert.equal(store.bumpMembershipRevision('room_test'), 1);
    assert.equal(store.bumpMembershipRevision('room_test'), 2);
    assert.equal(store.bumpPlanRevision('room_test'), 1);
    assert.equal(store.getRoom('room_test').planRevision, 1);
  });

  it('stores members with aliases and reports them as camelCase', () => {
    const member = store.insertMember({
      id: 'member_backend',
      roomId: 'room_test',
      kind: 'agent',
      role: 'backend',
      displayName: '后端·阿北',
      handle: 'backend',
      aliases: ['后端', '阿北'],
      status: 'idle',
    });
    assert.deepEqual(member.aliases, ['后端', '阿北']);
    assert.equal(member.modelLocked, true);
    assert.equal(member.selectionMode, 'fixed');
  });

  it('refuses a second active owner for one alias', () => {
    store.registerAlias({ roomId: 'room_test', normalizedAlias: '后端', memberId: 'member_backend' });
    assert.throws(
      () => store.registerAlias({ roomId: 'room_test', normalizedAlias: '后端', memberId: 'member_other' }),
      (error) => error instanceof RoomError && error.code === 'MENTION_AMBIGUOUS',
    );
    // Re-registering the same owner is a no-op, not an error: a resume path
    // legitimately replays this call.
    assert.equal(
      store.registerAlias({ roomId: 'room_test', normalizedAlias: '后端', memberId: 'member_backend' }),
      'already-owned',
    );
  });

  it('turns a departed member’s aliases into tombstones', () => {
    store.retireAliases('member_backend', 'room_test');
    assert.deepEqual(store.listTombstones('room_test'), ['后端']);
  });
});

describe('store — sequence, messages and idempotency', () => {
  it('shares one seq between a message and its created event', () => {
    const createdAt = isoTimestamp();
    const { seq } = store.appendEvent({
      roomId: 'room_test',
      eventType: 'message.created',
      payload: { placeholder: true },
    });
    const message = store.insertMessage({
      id: 'msg_1',
      roomId: 'room_test',
      seq,
      authorId: 'member_backend',
      authorKind: 'agent',
      body: '@前端 接口字段改了',
      mentions: [{ targetMemberId: 'member_frontend', origin: 'typed', displaySnapshot: '前端', span: null }],
      causalRootId: 'msg_1',
      clientMessageId: 'client_1',
      payloadHash: payloadHash({ body: '@前端 接口字段改了' }),
      createdAt,
    });
    assert.equal(message.seq, seq);
    assert.equal(store.getRoom('room_test').lastSeq, seq);
    assert.equal(store.listMessages('room_test')[0].id, 'msg_1');
  });

  it('enforces one row per (room, author, clientMessageId)', () => {
    const second = store.findMessageByClientKey('room_test', 'member_backend', 'client_1');
    assert.equal(second.id, 'msg_1');
    assert.throws(() =>
      store.insertMessage({
        id: 'msg_dup',
        roomId: 'room_test',
        seq: 99,
        authorId: 'member_backend',
        authorKind: 'agent',
        body: '不同内容',
        mentions: [],
        causalRootId: 'msg_dup',
        clientMessageId: 'client_1',
        payloadHash: 'x',
        createdAt: isoTimestamp(),
      }),
    );
  });

  it('orders messages by seq and honours a cursor', () => {
    for (let index = 0; index < 3; index += 1) {
      const { seq } = store.appendEvent({ roomId: 'room_test', eventType: 'message.created', payload: {} });
      store.insertMessage({
        id: `msg_${index + 2}`,
        roomId: 'room_test',
        seq,
        authorId: 'member_backend',
        authorKind: 'agent',
        body: `第 ${index + 2} 条`,
        mentions: [],
        causalRootId: `msg_${index + 2}`,
        clientMessageId: `client_${index + 2}`,
        payloadHash: 'x',
        createdAt: isoTimestamp(),
      });
    }
    const all = store.listMessages('room_test');
    assert.deepEqual(
      all.map((message) => message.seq),
      [...all.map((message) => message.seq)].sort((a, b) => a - b),
    );
    const afterFirst = store.listMessages('room_test', { afterSeq: all[0].seq });
    assert.equal(afterFirst.length, all.length - 1);
  });
});

describe('store — deliveries', () => {
  it('upserts a delivery and lists only unfinished work', () => {
    store.upsertDelivery({
      messageId: 'msg_1',
      recipientId: 'member_frontend',
      status: 'pending',
      requestedMode: 'queue',
      deliveryAttempt: 0,
    });
    assert.equal(store.listPendingDeliveries('room_test').length, 1);

    const accepted = store.upsertDelivery({
      messageId: 'msg_1',
      recipientId: 'member_frontend',
      status: 'accepted',
      requestedMode: 'queue',
      actualMode: 'queue',
      hostMessageId: 'host_1',
      deliveryAttempt: 1,
    });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.hostMessageId, 'host_1');
    assert.equal(store.listPendingDeliveries('room_test').length, 0);
    assert.equal(store.listOpenDeliveries('room_test', 'member_frontend').length, 1);
  });

  it('keeps hostMessageId when a later update omits it', () => {
    const claimed = store.upsertDelivery({
      messageId: 'msg_1',
      recipientId: 'member_frontend',
      status: 'claimed',
      requestedMode: 'queue',
      deliveryAttempt: 2,
    });
    assert.equal(claimed.hostMessageId, 'host_1');
  });
});

describe('store — tasks, plans and decisions', () => {
  it('creates a task and rejects an illegal status jump', () => {
    const task = store.insertTask({
      id: 'task_login',
      roomId: 'room_test',
      objective: '实现登录页面',
      ownerId: 'member_backend',
      requiredRole: 'frontend',
      acceptance: ['输入错误验证码有明确提示'],
      dependencies: [],
      status: 'ready',
    });
    assert.equal(task.revision, 1);
    assert.deepEqual(task.acceptance, ['输入错误验证码有明确提示']);
    assert.equal(task.needsSync, false);

    assert.throws(
      () => store.updateTask('task_login', { status: 'accepted' }),
      (error) => error instanceof RoomError && error.code === 'INVALID_REQUEST',
    );
  });

  it('rejects a stale expectedRevision instead of overwriting', () => {
    const updated = store.updateTask('task_login', { status: 'in_progress' }, { expectedRevision: 1 });
    assert.equal(updated.revision, 2);
    assert.throws(
      () => store.updateTask('task_login', { status: 'submitted' }, { expectedRevision: 1 }),
      (error) => error instanceof RoomError && error.code === 'REVISION_CONFLICT',
    );
  });

  it('records attempts and keeps them addressable after the task moves on', () => {
    const attempt = store.insertAttempt({
      id: 'attempt_1',
      taskId: 'task_login',
      roomId: 'room_test',
      actorId: 'member_backend',
      baseRevision: 2,
      state: 'running',
    });
    assert.equal(attempt.state, 'running');
    assert.equal(store.listAttempts('task_login', { activeOnly: true }).length, 1);
    store.updateAttempt('attempt_1', { state: 'submitted' });
    assert.equal(store.listAttempts('task_login', { activeOnly: true }).length, 0);
    assert.equal(store.getAttempt('attempt_1').state, 'submitted');
  });

  it('numbers decisions monotonically inside a room', () => {
    const first = store.insertDecision({
      id: 'decision_1',
      roomId: 'room_test',
      sourceMessageId: 'msg_1',
      scope: 'auth',
      statement: '验证码错误返回 code，不返回 HTTP 状态码',
      affectedTaskIds: ['task_login'],
    });
    const second = store.insertDecision({
      id: 'decision_2',
      roomId: 'room_test',
      sourceMessageId: 'msg_2',
      scope: 'auth',
      statement: '重发频率由服务端限流决定',
    });
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.deepEqual(first.affectedTaskIds, ['task_login']);
  });

  it('records decision acks per member without overwriting history', () => {
    store.upsertDecisionAck({ decisionId: 'decision_1', memberId: 'member_backend', state: 'pending' });
    store.upsertDecisionAck({
      decisionId: 'decision_1',
      memberId: 'member_backend',
      state: 'synced',
      appliedTaskRevision: 3,
    });
    const acks = store.listDecisionAcks('decision_1');
    assert.equal(acks.length, 1);
    assert.equal(acks[0].state, 'synced');
    assert.equal(acks[0].appliedTaskRevision, 3);
  });
});

describe('store — idempotent dispatch and transactions', () => {
  it('claims a dispatch key exactly once', () => {
    const key = 'room_test|plan1|task_login|a1';
    assert.equal(store.claimDispatch({ dispatchKey: key, roomId: 'room_test', taskId: 'task_login' }).claimed, true);
    assert.equal(store.claimDispatch({ dispatchKey: key, roomId: 'room_test', taskId: 'task_login' }).claimed, false);
  });

  it('rolls the whole transaction back on failure', () => {
    const before = store.getRoom('room_test').lastSeq;
    assert.throws(() =>
      store.transaction(() => {
        store.appendEvent({ roomId: 'room_test', eventType: 'transaction.probe', payload: {} });
        throw new Error('boom');
      }),
    );
    assert.equal(store.getRoom('room_test').lastSeq, before);
  });

  it('joins a nested transaction rather than opening a second one', () => {
    const result = store.transaction(() => {
      store.appendEvent({ roomId: 'room_test', eventType: 'outer', payload: {} });
      return store.transaction(() => store.appendEvent({ roomId: 'room_test', eventType: 'inner', payload: {} }).seq);
    });
    assert.equal(typeof result, 'number');
    assert.equal(store.getRoom('room_test').lastSeq, result);
  });
});

describe('store — single writer', () => {
  it('refuses a second live writer for the same database', () => {
    const second = new RoomStore({ file, lockFile: `${file}.lock` });
    assert.throws(
      () => second.open(),
      (error) => error instanceof RoomError && error.code === 'FORBIDDEN',
    );
    assert.equal(existsSync(`${file}.lock`), true, 'the refused writer must not steal the lock');
  });

  it('replaces a stale lock left by a dead process', () => {
    const stale = temporaryDatabasePath();
    const lock = `${stale}.lock`;
    // pid 999999 is not a live process; the store must treat the lock as stale.
    writeFileSync(lock, '999999|2020-01-01T00:00:00.000Z', 'utf8');
    const recovered = new RoomStore({ file: stale, lockFile: lock });
    recovered.open();
    assert.equal(recovered.getMeta('schemaVersion'), String(SCHEMA_VERSION));
    assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid}\\|`));
    recovered.close();
    assert.equal(existsSync(lock), false, 'closing must release our own lock');
  });
});

describe('store — room status is a closed set', () => {
  it('accepts active, paused and archived', () => {
    createRoom('room_status_ok');
    for (const status of ['paused', 'archived', 'active']) {
      assert.equal(store.updateRoom('room_status_ok', { status }).status, status);
    }
  });

  it('refuses a status no execution gate recognises', () => {
    // Every gate reads this column (delivery, recovery, reminders). A typo like
    // "Archived" would otherwise leave a room that none of them treat as dormant.
    createRoom('room_status_bad');
    assert.throws(
      () => store.updateRoom('room_status_bad', { status: 'Archived' }),
      (error) => error instanceof RoomError && error.code === 'INVALID_REQUEST',
    );
    assert.throws(
      () => store.updateRoom('room_status_bad', { status: 'deleted' }),
      (error) => error instanceof RoomError && error.code === 'INVALID_REQUEST',
    );
    assert.equal(store.getRoom('room_status_bad').status, 'active', 'a refused write must not change the row');
  });
});
