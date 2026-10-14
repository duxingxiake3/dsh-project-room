/**
 * Per-member model routing — the claim R19/AT36 rests on.
 *
 * "Each member picks its own model" is only true if a member's REAL request carries
 * that model. A panel that shows different names while one route serves everyone is
 * exactly what the design forbids, so this asserts the mechanism at the only point
 * that decides a model call: the agent-scoped `agent/request` waterfall that
 * `HostAdapter` installs during `createMember`/`resumeMember`.
 *
 * The adapter's listener is exercised directly against a fake agent context here;
 * the integration suite separately asserts that the room services hand different
 * routes to different members.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HostAdapter } from '../../src/host/adapter/host-adapter.js';

/**
 * A Cordis-shaped context that records what the adapter registers and lets the test
 * fire `agent/request` the way the loop does.
 * @param {{ capabilities?: object }} [options]
 */
function fakeHost(options = {}) {
  /** @type {Map<string, { listeners: Map<string, Function[]>, agent: object }>} */
  const agents = new Map();
  const created = [];

  const makeAgentCtx = (sessionId) => {
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
      sessionId,
    };
  };

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(key) {
      if (key === 'agents') return true;
      if (key === 'agentLoop') return true;
      if (key === 'sessionPersistence') return true;
      if (key === 'llm') return options.llm ?? undefined;
      if (key === 'agentDefaultModel') return options.defaultModel;
      return undefined;
    },
    agents: {
      async create(createOptions) {
        const agentCtx = makeAgentCtx(createOptions.sessionId);
        const agent = {
          id: createOptions.sessionId,
          session: { id: createOptions.sessionId },
          status: 'idle',
          inbox: { nextTurn: [], nextStep: [] },
          options: createOptions.agentOptions ?? {},
          ctx: agentCtx,
          followup() {},
          steer() {},
          cancel() {},
          async whenIdle() {},
        };
        if (typeof createOptions.setup === 'function') await createOptions.setup(agentCtx, agent);
        agents.set(createOptions.sessionId, { listeners: agentCtx.listeners, agent });
        created.push({ sessionId: createOptions.sessionId, agentOptions: createOptions.agentOptions, agent });
        return { agent, dispose: async () => {} };
      },
      async resume(resumeOptions) {
        return this.create({ sessionId: resumeOptions.resumeSessionId, agentOptions: resumeOptions.agentOptions, setup: resumeOptions.setup });
      },
    },
  };
  return { ctx, agents, created, makeAgentCtx };
}

/** Fire `agent/request` the way the loop's prepareRequest does. */
async function fireRequest(agentCtx, seed) {
  const listeners = agentCtx.listeners.get('agent/request') ?? [];
  assert.ok(listeners.length > 0, 'the adapter must install an agent/request listener');
  let next = async () => seed;
  let call = next;
  for (const listener of listeners) {
    const previous = call;
    call = () => listener({ turn: 1, step: 1, signal: new AbortController().signal }, previous);
  }
  return call();
}

describe('per-member model routing', () => {
  it('returns the member’s own route from the agent/request waterfall', async () => {
    const host = fakeHost();
    const adapter = new HostAdapter({ ctx: host.ctx, logger: host.ctx.logger });

    await adapter.createMember({
      memberId: 'member_backend',
      roomId: 'room_a',
      displayName: '后端·阿北',
      handle: 'backend',
      role: 'backend',
      cwd: 'E:\\demo',
      model: { providerRoute: 'deepseek-official', modelId: 'deepseek-v4-pro' },
      personaInstructions: '你是后端成员。',
    });

    const entry = host.agents.get([...host.agents.keys()][0]);
    // The loop seeds the request from AgentOptions; the listener must win.
    const config = await fireRequest(entry.agent.ctx, { provider: 'seeded', model: 'seeded' });
    assert.equal(config.provider, 'deepseek-official');
    assert.equal(config.model, 'deepseek-v4-pro');
  });

  it('keeps two members on two different routes in the same room', async () => {
    const host = fakeHost();
    const adapter = new HostAdapter({ ctx: host.ctx, logger: host.ctx.logger });

    await adapter.createMember({
      memberId: 'member_backend',
      roomId: 'room_a',
      displayName: '后端',
      handle: 'backend',
      role: 'backend',
      cwd: 'E:\\demo',
      model: { providerRoute: 'deepseek-official', modelId: 'deepseek-v4-pro' },
      personaInstructions: '后端',
    });
    await adapter.createMember({
      memberId: 'member_frontend',
      roomId: 'room_a',
      displayName: '前端',
      handle: 'frontend',
      role: 'frontend',
      cwd: 'E:\\demo',
      model: { providerRoute: 'pi-ai', modelId: 'glm-4.6' },
      personaInstructions: '前端',
    });

    const [first, second] = [...host.agents.values()];
    const a = await fireRequest(first.agent.ctx, { provider: 'seeded', model: 'seeded' });
    const b = await fireRequest(second.agent.ctx, { provider: 'seeded', model: 'seeded' });
    assert.deepEqual([a.provider, a.model], ['deepseek-official', 'deepseek-v4-pro']);
    assert.deepEqual([b.provider, b.model], ['pi-ai', 'glm-4.6']);
    assert.notDeepEqual([a.provider, a.model], [b.provider, b.model], 'two members must not share one route silently');

    // The observed-route ledger is the evidence a user can check afterwards.
    const routes = adapter.observedRoutes().map((route) => `${route.memberId}:${route.providerRoute}/${route.modelId}`).sort();
    assert.deepEqual(routes, ['member_backend:deepseek-official/deepseek-v4-pro', 'member_frontend:pi-ai/glm-4.6']);
  });

  it('switches a member’s route on the next request without recreating the session', async () => {
    const host = fakeHost();
    const adapter = new HostAdapter({ ctx: host.ctx, logger: host.ctx.logger });
    const before = await adapter.createMember({
      memberId: 'member_tester',
      roomId: 'room_a',
      displayName: '测试',
      handle: 'tester',
      role: 'tester',
      cwd: 'E:\\demo',
      model: { providerRoute: 'deepseek-official', modelId: 'deepseek-flash' },
      personaInstructions: '测试',
    });
    const entry = [...host.agents.values()][0];

    const firstConfig = await fireRequest(entry.agent.ctx, { provider: 'seeded', model: 'seeded' });
    assert.equal(firstConfig.model, 'deepseek-flash');

    adapter.rebindModel({ memberId: 'member_tester', nextProfile: { providerRoute: 'deepseek-official', modelId: 'deepseek-v4-pro' } });

    const secondConfig = await fireRequest(entry.agent.ctx, { provider: 'seeded', model: 'seeded' });
    assert.equal(secondConfig.model, 'deepseek-v4-pro', 'the next request must use the new route');
    assert.equal(adapter.agentOf('member_tester').id, before.sessionId, 'the session must NOT be recreated');
    assert.equal(adapter.statusOf('member_tester'), 'idle');
  });

  it('leaves the host’s own settings alone when the plugin has no pinned model', async () => {
    const host = fakeHost();
    const adapter = new HostAdapter({ ctx: host.ctx, logger: host.ctx.logger });
    await adapter.createMember({
      memberId: 'member_docs',
      roomId: 'room_a',
      displayName: '文档',
      handle: 'docs',
      role: 'docs',
      cwd: 'E:\\demo',
      model: null,
      personaInstructions: '文档',
    });
    const entry = [...host.agents.values()][0];
    const config = await fireRequest(entry.agent.ctx, { provider: 'host-provider', model: 'host-model' });
    // No pinned model means the plugin must not invent one: the seed stands.
    assert.deepEqual([config.provider, config.model], ['host-provider', 'host-model']);
  });
});
