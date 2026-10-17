/**
 * Member sessions and Agent presets.
 *
 * "Members get file and shell tools" is only true if the preset is MOUNTED into the
 * agent context. `meta.agentPreset` alone only writes the session creation header —
 * measured 2026-10-17, a fresh member created with that header still listed 16 room
 * tools and no `pwsh`/`write`. The registry mounts the plugin tree through
 * `agentPresets.mount(agentCtx, id)` inside `setup`, and that is what this asserts.
 *
 * The second half matters just as much: a configured preset that cannot be mounted
 * must fail loudly on creation (not silently leave the member tool-less), and must
 * NOT throw on resume (one bad preset must not break recovery of every room).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HostAdapter } from '../../src/host/adapter/host-adapter.js';

/**
 * A Cordis-shaped host whose preset registry records what the adapter asks of it.
 *
 * @param {{ presets?: object | null, resumeHeader?: object, mountAddsTools?: string[] }} [options]
 *   `presets: null` means the host has no registry at all.
 */
function fakeHost(options = {}) {
  const created = [];
  const restrictCalls = [];
  const exposed = [];
  const presetCalls = { resolve: [], mount: [], mountedInto: [] };
  const events = [];

  const mountAddsTools = options.mountAddsTools ?? [];

  const presets =
    options.presets === null
      ? undefined
      : options.presets ?? {
          async resolve(id) {
            presetCalls.resolve.push(id);
            return { id };
          },
          async mount(agentCtx, id) {
            presetCalls.mount.push(id);
            presetCalls.mountedInto.push(agentCtx);
            // A real mount registers the preset's tool plugins in this context, so
            // the tools only become visible at this point in `setup`.
            exposed.push(...mountAddsTools);
            return { id };
          },
        };

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
      tools: {
        schemas: () => exposed.map((name) => ({ name, inputSchema: {} })),
        restrict(filter) {
          restrictCalls.push(filter);
        },
      },
      systemPrompt: { section() {} },
      get() {
        return undefined;
      },
      sessionId,
    };
  };

  const makeAgent = (sessionId, header = {}) => {
    const agentCtx = makeAgentCtx(sessionId);
    const agent = {
      id: sessionId,
      session: { id: sessionId, header: { ...header } },
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
      options: {},
      ctx: agentCtx,
      followup() {},
      steer() {},
      cancel() {},
      async whenIdle() {},
    };
    return { agent, agentCtx };
  };

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(key) {
      if (key === 'agents') return true;
      if (key === 'agentLoop') return true;
      if (key === 'sessionPersistence') return true;
      if (key === 'agentPresets') return presets;
      return undefined;
    },
    agents: {
      async create(createOptions) {
        const { agent, agentCtx } = makeAgent(createOptions.sessionId);
        agent.options = createOptions.agentOptions ?? {};
        created.push({ createOptions, agent, agentCtx });
        if (typeof createOptions.setup === 'function') await createOptions.setup(agentCtx, agent);
        return { agent, dispose: async () => {} };
      },
      async resume(resumeOptions) {
        // A resumed session already HAS a header on disk, so it must exist before
        // `setup` runs: that is exactly the value the adapter has to read.
        const { agent, agentCtx } = makeAgent(resumeOptions.resumeSessionId, options.resumeHeader);
        agent.options = resumeOptions.agentOptions ?? {};
        created.push({ createOptions: resumeOptions, agent, agentCtx });
        if (typeof resumeOptions.setup === 'function') await resumeOptions.setup(agentCtx, agent);
        return { agent, dispose: async () => {} };
      },
    },
  };

  const adapter = new HostAdapter({ ctx, logger: ctx.logger });
  adapter.onEvent((event) => events.push(event));

  return { adapter, created, restrictCalls, exposed, presetCalls, events };
}

const baseMember = {
  roomId: 'room_a',
  displayName: '后端·阿北',
  handle: 'backend',
  role: 'backend',
  cwd: 'C:\\demo',
  model: null,
  personaInstructions: '你是后端成员。',
};

describe('member agent presets', () => {
  it('mounts the configured preset and records it in the creation header', async () => {
    const host = fakeHost();

    await host.adapter.createMember({ ...baseMember, memberId: 'member_a', agentPreset: 'standard' });

    assert.deepEqual(host.presetCalls.resolve, ['standard'], 'the preset must be resolved by name');
    assert.deepEqual(host.presetCalls.mount, ['standard'], 'the preset must actually be mounted');
    assert.equal(host.created.length, 1);
    assert.equal(host.created[0].createOptions.meta.agentPreset, 'standard', 'the header must say which preset it started under');
    assert.equal(
      host.presetCalls.mountedInto[0],
      host.created[0].agentCtx,
      'the mount must target the member’s own agent context',
    );
  });

  it('leaves the host composition alone when no preset is configured', async () => {
    const host = fakeHost();

    await host.adapter.createMember({ ...baseMember, memberId: 'member_a' });

    assert.deepEqual(host.presetCalls.resolve, [], 'nothing to resolve');
    assert.deepEqual(host.presetCalls.mount, [], 'nothing to mount');
    assert.equal('agentPreset' in host.created[0].createOptions.meta, false, 'the header must stay unset');
  });

  it('fails loudly when the configured preset cannot be mounted', async () => {
    const host = fakeHost({
      presets: {
        async resolve(id) {
          return { id };
        },
        async mount() {
          throw new Error('preset tree is broken');
        },
      },
    });

    await assert.rejects(
      () => host.adapter.createMember({ ...baseMember, memberId: 'member_a', agentPreset: 'standard' }),
      /preset tree is broken/,
      'a configured preset that fails must not leave a tool-less member behind silently',
    );
  });

  it('fails loudly when the host has no preset registry', async () => {
    const host = fakeHost({ presets: null });

    await assert.rejects(
      () => host.adapter.createMember({ ...baseMember, memberId: 'member_a', agentPreset: 'standard' }),
      /agentPresets/,
    );
  });

  it('restricts a detail-only member AFTER the preset exposed its tools', async () => {
    const host = fakeHost({ mountAddsTools: ['write', 'edit', 'pwsh', 'read'] });

    await host.adapter.createMember({
      ...baseMember,
      memberId: 'member_designer',
      role: 'designer',
      restrictTools: true,
      agentPreset: 'standard',
    });

    assert.deepEqual(
      host.restrictCalls,
      [{ deny: ['pwsh', 'write', 'edit'] }],
      'the deny list is intersected with the mounted surface, not with the empty one',
    );
  });

  it('does not restrict a member that is allowed to write code', async () => {
    const host = fakeHost({ mountAddsTools: ['write', 'edit', 'pwsh'] });

    await host.adapter.createMember({
      ...baseMember,
      memberId: 'member_frontend',
      role: 'frontend',
      restrictTools: false,
      agentPreset: 'standard',
    });

    assert.deepEqual(host.restrictCalls, [], 'a frontend member must keep write tools');
  });

  it('re-mounts the preset a resumed session recorded', async () => {
    const host = fakeHost({ resumeHeader: { agentPreset: 'standard' }, mountAddsTools: ['pwsh'] });

    await host.adapter.resumeMember({ ...baseMember, memberId: 'member_a', sessionId: 'session_a' });

    assert.deepEqual(host.presetCalls.mount, ['standard'], 'a restart must not cost the member its tools');
  });

  it('falls back to the configured preset when the header recorded none', async () => {
    const host = fakeHost({ resumeHeader: {}, mountAddsTools: ['pwsh'] });

    await host.adapter.resumeMember({
      ...baseMember,
      memberId: 'member_a',
      sessionId: 'session_a',
      agentPreset: 'standard',
    });

    assert.deepEqual(host.presetCalls.mount, ['standard'], 'pre-fix sessions must be upgradable');
  });

  it('reports, rather than throws, when a resumed preset cannot be mounted', async () => {
    const host = fakeHost({
      resumeHeader: { agentPreset: 'standard' },
      presets: {
        async resolve(id) {
          return { id };
        },
        async mount() {
          throw new Error('registry is not ready');
        },
      },
    });

    await host.adapter.resumeMember({ ...baseMember, memberId: 'member_a', sessionId: 'session_a' });

    const failure = host.events.find((event) => event.type === 'member-preset-mount-failed');
    assert.ok(failure, 'the failure must be observable, not silent');
    assert.equal(failure.presetId, 'standard');
    assert.match(failure.reason, /registry is not ready/);
  });
});
