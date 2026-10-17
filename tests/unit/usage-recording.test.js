/**
 * Real token usage per member call.
 *
 * The capability table ends with "用量费用：记录实际用量；可靠价格缺失时显示未知
 * 或估算". Before this test the `model_invocation` table existed but nothing ever
 * wrote to it, so "how much did this project cost" had no answer at all.
 *
 * What makes the claim true is *where* the number comes from: the member's own
 * `llm/stream` waterfall, whose `{ type: 'usage' }` chunk carries the provider's real
 * `TokenUsage`. So these tests fire that waterfall with a realistic chunk sequence
 * and assert the recorded row.
 *
 * The subtle failure this guards is attribution: at the moment `llm/stream` runs,
 * `options.provider`/`options.model` still hold the HOST's default, because the
 * `agent/request` listener rewrites them on its way out. A naive implementation
 * records the wrong model for every member — which would look plausible and be
 * useless. The assertions below therefore check the model named in the row is the
 * member's own route, never the seed the test passed in.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HostAdapter } from '../../src/host/adapter/host-adapter.js';

/**
 * A Cordis-shaped context that records the per-agent listeners the adapter
 * installs, so a test can fire the real waterfall.
 */
function fakeHost() {
  const makeAgentCtx = () => {
    const listeners = new Map();
    return {
      listeners,
      on(event, listener) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return () => {};
      },
      off() {},
      effect(fn) {
        return fn();
      },
      tools: { restrict() {}, schemas: () => [] },
      systemPrompt: { section() {} },
      get() {
        return undefined;
      },
    };
  };

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(key) {
      if (key === 'agents') return true;
      if (key === 'agentLoop') return true;
      if (key === 'sessionPersistence') return true;
      return undefined;
    },
    agents: {
      async create(createOptions) {
        const agentCtx = makeAgentCtx();
        const agent = {
          id: createOptions.sessionId,
          session: { id: createOptions.sessionId },
          status: 'idle',
          inbox: { nextTurn: [], nextStep: [] },
          followup() {},
          steer() {},
          cancel() {},
          async whenIdle() {},
          // The real Agent exposes its scoped context; `agentOf(member).ctx` is how
          // this test reaches the listeners the adapter installed.
          ctx: agentCtx,
        };
        if (typeof createOptions.setup === 'function') await createOptions.setup(agentCtx, agent);
        return { agent, dispose: async () => {} };
      },
      async resume(resumeOptions) {
        return this.create({
          sessionId: resumeOptions.resumeSessionId,
          agentOptions: resumeOptions.agentOptions,
          setup: resumeOptions.setup,
        });
      },
    },
  };
  return { ctx, makeAgentCtx };
}

/** Fire `agent/request` first, exactly as the loop does before each model call. */
async function fireRequest(agentCtx, seed, turn = 1, step = 1) {
  const listeners = agentCtx.listeners.get('agent/request') ?? [];
  assert.ok(listeners.length > 0, 'the adapter must install an agent/request listener');
  let call = async () => seed;
  for (const listener of listeners) {
    const previous = call;
    call = () => listener({ turn, step, signal: new AbortController().signal }, previous);
  }
  return call();
}

/**
 * Drive the member's `llm/stream` waterfall with a realistic chunk sequence and
 * return what the wrapper handed back to the loop.
 */
async function runStream(agentCtx, chunks, options = { provider: 'seed-provider', model: 'seed-model' }) {
  const listeners = agentCtx.listeners.get('llm/stream') ?? [];
  assert.ok(listeners.length > 0, 'the adapter must install an llm/stream listener');
  const seed = async function* () {
    for (const chunk of chunks) yield chunk;
  };
  let call = () => seed();
  for (const listener of listeners) {
    const previous = call;
    call = () => listener(options, previous);
  }
  const passed = [];
  for await (const chunk of await call()) passed.push(chunk);
  return passed;
}

const USAGE = Object.freeze({ inputTokens: 1200, outputTokens: 340, totalTokens: 1540, cacheReadTokens: 900 });

/** A member with its own route, plus the sink the composition root would pass. */
async function memberWithUsage(route = { providerRoute: 'pi-ai', modelId: 'glm-4.6' }) {
  const host = fakeHost();
  const recorded = [];
  const adapter = new HostAdapter({
    ctx: host.ctx,
    logger: host.ctx.logger,
    onUsage: (invocation) => recorded.push(invocation),
  });
  await adapter.createMember({
    memberId: 'member_backend',
    roomId: 'room_a',
    displayName: '后端·阿北',
    handle: 'backend',
    role: 'backend',
    cwd: process.cwd(),
    model: route,
  });
  const agentCtx = adapter.agentOf('member_backend').ctx;
  return { adapter, agentCtx, recorded };
}

describe('usage — the observation is scoped to the member the host named', () => {
  it('ignores a stream the host addressed to a different session', async () => {
    // The live desktop host recorded four members with identical token counts at the
    // same instant, repeatedly. One model call observed four times would inflate a
    // cost report 4x and invent work nobody did, so an explicitly different session
    // must be dropped rather than attributed.
    const { agentCtx, recorded } = await memberWithUsage();
    await fireRequest(agentCtx, { provider: 'seed-provider', model: 'seed-model' });
    await runStream(
      agentCtx,
      [{ type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }],
      { provider: 'seed-provider', model: 'seed-model', sessionId: 'somebody-elses-session' },
    );
    assert.equal(recorded.length, 0, 'a call the host attributed elsewhere must not be recorded here');
  });

  it('records and marks attributed when the host names this member’s own session', async () => {
    const { adapter, agentCtx, recorded } = await memberWithUsage();
    await fireRequest(agentCtx, { provider: 'seed-provider', model: 'seed-model' });
    const own = adapter.agentOf('member_backend').session.id;
    await runStream(
      agentCtx,
      [{ type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }],
      { provider: 'seed-provider', model: 'seed-model', sessionId: own },
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].attributed, true, 'a stream naming this member is attributable to it');
  });

  it('records but marks unattributed when the host names no session', async () => {
    const { agentCtx, recorded } = await memberWithUsage();
    await fireRequest(agentCtx, { provider: 'seed-provider', model: 'seed-model' });
    await runStream(agentCtx, [{ type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }]);
    assert.equal(recorded.length, 1, 'a nameless stream is the only evidence available, so it is kept');
    assert.equal(recorded[0].attributed, false, 'and it is labelled as not attributable on evidence');
  });
});

describe('usage — a real call is recorded against the member that made it', () => {
  it('records the provider tokens the stream reported', async () => {
    const { agentCtx, recorded } = await memberWithUsage();
    await fireRequest(agentCtx, { provider: 'seed-provider', model: 'seed-model' });
    await runStream(agentCtx, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '好' },
      { type: 'usage', usage: USAGE },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);

    assert.equal(recorded.length, 1, 'one model call must produce one usage record');
    assert.deepEqual(recorded[0].usage, USAGE, 'the recorded numbers must be the provider’s own');
    assert.equal(recorded[0].memberId, 'member_backend');
    assert.equal(recorded[0].roomId, 'room_a');
    // The session id is composed by the adapter (it must be unique per member per
    // room), so it is matched rather than assumed to equal the member id.
    assert.match(recorded[0].sessionId, /backend/, 'the record must name the session that spent the tokens');
  });

  it('attributes the call to the member’s route, not the host default in the stream options', async () => {
    const { agentCtx, recorded } = await memberWithUsage({ providerRoute: 'pi-ai', modelId: 'glm-4.6' });
    await fireRequest(agentCtx, { provider: 'seed-provider', model: 'seed-model' });
    await runStream(agentCtx, [{ type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }]);

    assert.equal(recorded[0].providerRoute, 'pi-ai', 'the member’s route must win over the seed the loop passed');
    assert.equal(recorded[0].modelId, 'glm-4.6');
    assert.notEqual(recorded[0].providerRoute, 'seed-provider', 'recording the seed route would silently misattribute every member');
  });

  it('passes every chunk through untouched, including usage and finish', async () => {
    const { agentCtx } = await memberWithUsage();
    await fireRequest(agentCtx, { provider: 'seed-provider', model: 'seed-model' });
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '第一段' },
      { type: 'text-delta', index: 0, text: '第二段' },
      { type: 'usage', usage: USAGE },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const passed = await runStream(agentCtx, chunks);
    assert.deepEqual(passed, chunks, 'wrapping a stream must not swallow or reorder a single chunk');
  });

  it('records nothing when the provider never reported usage', async () => {
    const { agentCtx, recorded } = await memberWithUsage();
    await fireRequest(agentCtx, { provider: 'seed-provider', model: 'seed-model' });
    await runStream(agentCtx, [
      { type: 'text-delta', index: 0, text: '没有用量块' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    assert.equal(recorded.length, 0, 'an invented zero would read as "this call was free" rather than "unknown"');
  });

  it('keeps the turn and step so one call is one row, not one row per attempt', async () => {
    const { agentCtx, recorded } = await memberWithUsage();
    await fireRequest(agentCtx, { provider: 'seed-provider', model: 'seed-model' }, 7, 3);
    await runStream(agentCtx, [{ type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }]);
    assert.equal(recorded[0].turn, 7);
    assert.equal(recorded[0].step, 3);
    // A real (turn, step) pair is the only thing allowed to act as an idempotency
    // key, because only then does re-recording mean "the same call retried".
    assert.equal(recorded[0].invocationRef, 'member_backend:t7s3');
  });

  it('gives every observation its own identity when turn/step are unavailable', async () => {
    // This is the defect the live desktop host exposed: `agent/request` did not fire
    // alongside the observed streams, so every call carried turn=null/step=null and
    // the recorder keyed them all as `t0s0`. 104 real observations collapsed into 4
    // rows, and the stored total was far below the true one — silently.
    const { agentCtx, recorded } = await memberWithUsage();
    for (let index = 0; index < 5; index += 1) {
      await runStream(agentCtx, [{ type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }]);
    }
    assert.equal(recorded.length, 5, 'five calls must produce five records');
    assert.deepEqual(
      recorded.map((entry) => entry.turn),
      [null, null, null, null, null],
      'this host reported no turn coordinates',
    );
    assert.deepEqual(
      recorded.map((entry) => entry.invocationRef),
      [null, null, null, null, null],
      'without turn/step there is no honest idempotency key',
    );
    assert.equal(
      new Set(recorded.map((entry) => entry.sequence)).size,
      5,
      'each observation needs a distinct sequence number',
    );
  });

  it('is wired for a resumed session too, not only a freshly created one', async () => {    const host = fakeHost();
    const recorded = [];
    const adapter = new HostAdapter({
      ctx: host.ctx,
      logger: host.ctx.logger,
      onUsage: (invocation) => recorded.push(invocation),
    });
    await adapter.resumeMember({
      memberId: 'member_tester',
      roomId: 'room_a',
      sessionId: 'session_tester',
      model: { providerRoute: 'deepseek-official', modelId: 'deepseek-flash' },
    });
    const agentCtx = adapter.agentOf('member_tester').ctx;
    await fireRequest(agentCtx, { provider: 'seed-provider', model: 'seed-model' });
    await runStream(agentCtx, [{ type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }]);

    assert.equal(recorded.length, 1, 'a recovered session spends tokens too');
    assert.equal(recorded[0].sessionId, 'session_tester');
    assert.equal(recorded[0].modelId, 'deepseek-flash');
  });

  it('does nothing at all when no sink was supplied', async () => {
    const host = fakeHost();
    const adapter = new HostAdapter({ ctx: host.ctx, logger: host.ctx.logger });
    await adapter.createMember({
      memberId: 'member_docs',
      roomId: 'room_a',
      displayName: '文档',
      handle: 'docs',
      role: 'docs',
      cwd: process.cwd(),
      model: { providerRoute: 'pi-ai', modelId: 'glm-4.6' },
    });
    const agentCtx = adapter.agentOf('member_docs').ctx;
    await fireRequest(agentCtx, { provider: 'seed-provider', model: 'seed-model' });
    // Must not throw: usage bookkeeping is optional, a model call is not.
    const passed = await runStream(agentCtx, [{ type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }]);
    assert.equal(passed.length, 2);
  });
});
