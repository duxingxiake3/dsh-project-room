/**
 * Loop guard — the room-level automatic-wake budget.
 *
 * The per-chain counter alone is not enough, and the live AT39 trial proved it: each
 * reply quotes the message it answers, so every message carries its target's id as
 * `causalRootId`. Two members traded "无动作。" for minutes across **241 distinct
 * roots**, one round each, and `maxAutomaticRounds` never advanced.
 *
 * These tests pin the backstop that actually stops it, and the two properties that
 * keep it from being too strict: a user message resets it, and old wakes age out.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LoopGuard } from '../../src/host/room/loop-guard.js';

/** One automatic wake through the guard, recorded the way the delivery coordinator does. */
function wake(guard, { roomId = 'room_a', root, from = 'member_a', to = 'member_b' } = {}) {
  const input = {
    roomId,
    causalRootId: root,
    authorId: from,
    authorKind: 'agent',
    recipientIds: [to],
    body: '无动作。',
  };
  const decision = guard.check(input);
  if (decision.allowed) guard.record(input);
  return decision;
}

describe('loop guard — room-level automatic wake budget', () => {
  it('stops a ping-pong that forks a new root on every message', () => {
    let now = 1_700_000_000_000;
    const guard = new LoopGuard({ maxAutomaticRounds: 12, maxAutomaticWakesPerMinute: 5, now: () => now });

    for (let index = 0; index < 5; index += 1) {
      const decision = wake(guard, { root: `root-${index}` });
      assert.equal(decision.allowed, true, `wake ${index} is under the budget`);
      now += 500;
    }

    const denied = wake(guard, { root: 'root-5' });
    assert.equal(denied.allowed, false, 'the sixth wake inside a minute must be refused');
    assert.match(denied.reason, /自动唤醒/);
    assert.match(denied.reason, /用户发言/);
  });

  it('clears the budget and the block on a user message', () => {
    let now = 1_700_000_000_000;
    const guard = new LoopGuard({ maxAutomaticRounds: 12, maxAutomaticWakesPerMinute: 2, now: () => now });

    wake(guard, { root: 'r1' });
    wake(guard, { root: 'r2' });
    assert.equal(wake(guard, { root: 'r3' }).allowed, false);

    const human = guard.check({ roomId: 'room_a', causalRootId: 'r4', authorId: 'member_human', authorKind: 'human', recipientIds: ['member_b'], body: '继续做，别互相道谢。' });
    assert.equal(human.allowed, true, 'a user message always goes through');
    now += 10;

    assert.equal(wake(guard, { root: 'r5' }).allowed, true, 'the user restarted the allowance');
  });

  it('lets old wakes age out instead of blocking forever', () => {
    let now = 1_700_000_000_000;
    const guard = new LoopGuard({ maxAutomaticRounds: 12, maxAutomaticWakesPerMinute: 2, now: () => now });

    wake(guard, { root: 'r1' });
    wake(guard, { root: 'r2' });
    assert.equal(wake(guard, { root: 'r3' }).allowed, false);

    now += 61_000;
    assert.equal(wake(guard, { root: 'r4' }).allowed, true, 'the window only covers one minute');
  });

  it('keeps a productive discussion going: one human message resets, and real work passes', () => {
    let now = 1_700_000_000_000;
    const guard = new LoopGuard({ maxAutomaticRounds: 12, maxAutomaticWakesPerMinute: 3, now: () => now });

    for (let index = 0; index < 3; index += 1) {
      guard.check({ roomId: 'room_a', causalRootId: 'src', authorId: 'member_human', authorKind: 'human', recipientIds: ['member_a'], body: '开始' });
      const decision = guard.check({
        roomId: 'room_a',
        causalRootId: `task-${index}`,
        authorId: 'member_a',
        authorKind: 'agent',
        recipientIds: ['member_b'],
        body: `任务 ${index} 完成，测试命令 node tests/run.mjs 退出码 0`,
      });
      assert.equal(decision.allowed, true, 'a user message between rounds is normal collaboration');
      guard.record({ roomId: 'room_a', causalRootId: `task-${index}`, authorId: 'member_a', body: 'work' });
      now += 20_000;
    }
  });
});
