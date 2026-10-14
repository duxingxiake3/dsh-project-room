/**
 * Turn-observer tests — the path that carries a member's answer back into the room.
 *
 * These exist because a level-of-nesting mistake here silently deleted every answer
 * a member ever produced. The durable event shapes are asserted against the real
 * `SessionEventMap` declarations, not against an assumed shape:
 *
 *   'user/message'      : UserMessage                      (payload IS the message)
 *   'assistant/message' : { turn, step, message, stream }   (payload WRAPS the message)
 *
 * Reading `event.content` on the wrapped form yields `[]` every time, so the reply
 * is dropped while everything else looks healthy. That is the failure these cover.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { rmSync } from 'node:fs';

import { TurnObserver, extractText, readAssistantEnvelope } from '../../src/host/delivery/turn-observer.js';
import { RoomStore, temporaryDatabasePath } from '../../src/host/storage/store.js';
import { createRelayMessage } from '../../src/host/adapter/host-adapter.js';

/** @type {RoomStore} */
let store;
/** @type {string} */
let file;

before(() => {
  file = temporaryDatabasePath();
  store = new RoomStore({ file, lockFile: `${file}.lock` });
  store.open();
  store.insertRoom({ id: 'room_turns', title: '回合测试群', ownerRef: 'tester' });
  store.insertMember({
    id: 'member_coordinator',
    roomId: 'room_turns',
    kind: 'agent',
    role: 'coordinator',
    displayName: '主代理',
    handle: 'coordinator',
    aliases: [],
    status: 'idle',
    sessionId: 'session_coordinator',
    sessionOwnership: 'owned',
  });
});

after(() => {
  store.close();
  try {
    for (const suffix of ['', '.lock', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * Events exactly as the session log stores them.
 *
 * A `session/event` listener receives the LOG ENVELOPE `{ type, seq, time, data }`,
 * with the payload inside `data`. This shape was recorded from a live activation
 * (`eventShape` on `member.final-reply.skipped`), not assumed — reading the top level
 * is what silently discarded every member answer.
 */
function assistantEvent(id, blocks, turn = 1, step = 1) {
  return { type: 'assistant/message', seq: 7, time: 1, data: { turn, step, message: { id, role: 'assistant', content: blocks }, stream: [] } };
}

/** A `user/message` envelope: the payload inside `data` IS the message. */
function userEvent(text, id) {
  return { type: 'user/message', seq: 6, time: 1, data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'project-room', form: 'relay' } } };
}

/** A `turn/end` envelope. */
function turnEndEvent(turn, reason) {
  return { type: 'turn/end', seq: 9, time: 1, data: { turn, reason } };
}

/**
 * A TurnObserver with stub collaborators, driven the way the host drives it.
 */
function observerWith(overrides = {}) {
  const published = [];
  const events = [];
  const messages = {
    async publishFinalReply(input) {
      published.push(input);
      return { message: { id: 'msg_reply' } };
    },
  };
  const delivery = {
    observeClaimed() {},
    observeReplied(messageId, memberId) {
      events.push({ kind: 'replied', messageId, memberId });
    },
  };
  const observer = new TurnObserver({
    store,
    adapter: { reconcile: () => 'unknown' },
    messages: overrides.messages ?? messages,
    delivery,
    enabled: () => true,
    logger: { warn() {}, info() {} },
  });
  return { observer, published, events };
}

describe('turn observer — reading the durable event shapes', () => {
  it('finds the text inside the assistant/message envelope', () => {
    const envelope = readAssistantEnvelope(assistantEvent('evt_1', [{ type: 'text', text: '拆成两个任务。' }]));
    assert.equal(envelope.id, 'evt_1');
    assert.deepEqual(envelope.content, [{ type: 'text', text: '拆成两个任务。' }]);
    assert.equal(extractText(envelope.content), '拆成两个任务。');
  });

  it('still reads a bare message-shaped event, so one shape change cannot delete answers', () => {
    const envelope = readAssistantEnvelope({ id: 'evt_2', content: [{ type: 'text', text: '裸形状' }] });
    assert.equal(envelope.id, 'evt_2');
    assert.equal(extractText(envelope.content), '裸形状');
  });

  it('excludes reasoning and tool calls from what the group sees', () => {
    const content = [
      { type: 'reasoning', text: '内部推理不应进群' },
      { type: 'tool-call', name: 'room_send', arguments: '{}' },
      { type: 'text', text: '结论：先拆成两个任务。' },
    ];
    assert.equal(extractText(content), '结论：先拆成两个任务。');
  });
});

describe('turn observer — publishing the answer back to the room', () => {
  it('publishes the text of a room-driven turn and marks the delivery replied', async () => {
    const { observer, published, events } = observerWith();

    // Register the room message the member consumed.
    const relay = createRelayMessage({
      text: 'envelope',
      roomId: 'room_turns',
      messageId: 'msg_consumed',
      authorId: 'member_coordinator',
      authorName: '主代理',
      recipientId: 'member_coordinator',
      stableDeliveryKey: 'k',
    });

    const host = { listener: null };
    observer.attachHost({ on: (event, listener) => { host.listener = listener; }, off: () => {} });
    const session = { id: 'session_coordinator' };

    // A room-driven turn: the relay enters, the model answers, the turn closes.
    host.listener(session, userEvent('把目标拆一下', relay.id));
    host.listener(session, assistantEvent('evt_a', [{ type: 'reasoning', text: '内部' }, { type: 'text', text: '拆成后端与测试两个任务。' }]));
    host.listener(session, turnEndEvent(1, { kind: 'completed' }));
    await observer.flush('member_coordinator');

    assert.equal(published.length, 1, 'the answer must reach the room');
    assert.equal(published[0].body, '拆成后端与测试两个任务。');
    assert.deepEqual(published[0].inputMessageIds, ['msg_consumed']);
    assert.equal(events.filter((entry) => entry.kind === 'replied').length, 1, 'the delivery must be marked replied');
  });

  it('records WHY nothing was published instead of failing silently', async () => {
    const { observer } = observerWith();
    const host = { listener: null };
    observer.attachHost({ on: (event, listener) => { host.listener = listener; }, off: () => {} });

    const relay = createRelayMessage({
      text: 'envelope',
      roomId: 'room_turns',
      messageId: 'msg_toolonly',
      authorId: 'member_coordinator',
      authorName: '主代理',
      recipientId: 'member_coordinator',
      stableDeliveryKey: 'k2',
    });
    host.listener({ id: 'session_coordinator' }, userEvent('做点事', relay.id));
    // A turn whose only output is a tool call: nothing publishable.
    host.listener({ id: 'session_coordinator' }, assistantEvent('evt_b', [{ type: 'tool-call', name: 'room_task_propose', arguments: '{}' }]));
    host.listener({ id: 'session_coordinator' }, turnEndEvent(1, { kind: 'completed' }));
    await observer.flush('member_coordinator');

    const skipped = store
      .listRoomEvents('room_turns', { eventTypes: ['member.final-reply.skipped'] })
      .filter((event) => event.payload.memberId === 'member_coordinator');
    assert.ok(skipped.length > 0, 'a silent turn must leave a stated reason');
    assert.equal(skipped[skipped.length - 1].payload.reason, 'assistant-message-had-no-text');
  });

  it('marks a failed turn and does not publish a stale answer from it', async () => {
    const { observer, published } = observerWith();
    const host = { listener: null };
    observer.attachHost({ on: (event, listener) => { host.listener = listener; }, off: () => {} });

    const relay = createRelayMessage({
      text: 'envelope',
      roomId: 'room_turns',
      messageId: 'msg_failed',
      authorId: 'member_coordinator',
      authorName: '主代理',
      recipientId: 'member_coordinator',
      stableDeliveryKey: 'k3',
    });
    host.listener({ id: 'session_coordinator' }, userEvent('做点事', relay.id));
    host.listener({ id: 'session_coordinator' }, turnEndEvent(1, { kind: 'aborted' }));
    await observer.flush('member_coordinator');

    const ended = store
      .listRoomEvents('room_turns', { eventTypes: ['member.turn.ended'] })
      .filter((event) => event.payload.memberId === 'member_coordinator');
    assert.ok(ended.length > 0, 'an aborted room-driven turn must be recorded');
    assert.equal(ended[ended.length - 1].payload.reason, 'aborted');
    assert.equal(published.length, 0, 'an aborted turn produces no answer');
  });

  it('never publishes for a turn that consumed no room message', async () => {
    const { observer, published } = observerWith();
    const host = { listener: null };
    observer.attachHost({ on: (event, listener) => { host.listener = listener; }, off: () => {} });

    // An unrelated turn in the same session — a borrowed user session's own work.
    host.listener({ id: 'session_coordinator' }, assistantEvent('evt_c', [{ type: 'text', text: '这是用户自己的会话内容' }]));
    host.listener({ id: 'session_coordinator' }, turnEndEvent(2, { kind: 'completed' }));
    await observer.flush('member_coordinator');

    assert.equal(published.length, 0, 'only room-driven turns are published');
  });
});
