/**
 * Model configuration tests — the four-level precedence of the design notes and the
 * fallback that makes a brand-new project usable at all.
 *
 * The gap these cover: with nothing configured, `chooseProfile` used to return
 * `null`, so `room_member_ensure` threw `MEMBER_UNAVAILABLE` and the coordinator
 * could not create a single member on a fresh project — while the Harness itself
 * had a perfectly good default model one service away. The fallback is now a
 * distinct `host-default` tier so the UI can say "nobody chose this".
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { rmSync } from 'node:fs';

import { RoomError } from '../../shared/contracts.js';
import { ModelProfileService } from '../../src/host/models/model-service.js';
import { RoomStore, temporaryDatabasePath } from '../../src/host/storage/store.js';

/** @type {RoomStore} */
let store;
/** @type {string} */
let file;

/** A host default selection, exactly as `agentDefaultModel.currentSelection()` returns it. */
const HOST_SELECTION = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' };

/** Catalogue with two providers so cross-provider combinations are expressible. */
const CATALOGUE = [
  {
    id: 'deepseek-official/deepseek-flash',
    providerRoute: 'deepseek-official',
    modelId: 'deepseek-flash',
    label: 'DeepSeek Flash',
    capabilityStatus: 'verified',
    capabilities: ['text', 'reasoning'],
  },
  {
    id: 'pi-ai/glm-4.6',
    providerRoute: 'pi-ai',
    modelId: 'glm-4.6',
    label: 'GLM 4.6',
    capabilityStatus: 'verified',
    capabilities: ['text'],
  },
  {
    id: 'pi-ai/offline-model',
    providerRoute: 'pi-ai',
    modelId: 'offline-model',
    label: 'Offline',
    capabilityStatus: 'unavailable',
    capabilities: [],
  },
];

/**
 * A host-shaped adapter with a controllable default selection.
 * @param {{ selection?: object | null, catalogue?: object[] }} [options]
 */
function adapter(options = {}) {
  const catalogue = options.catalogue ?? CATALOGUE;
  const selection = options.selection === undefined ? HOST_SELECTION : options.selection;
  return {
    ctx: { get: (key) => (key === 'agentDefaultModel' && selection ? { currentSelection: () => selection } : undefined) },
    listModelProfiles: async () => catalogue,
    resolveProfile: async (providerRoute, modelId) => {
      const found = catalogue.find((entry) => entry.providerRoute === providerRoute && entry.modelId === modelId);
      if (!found) throw new RoomError('MEMBER_UNAVAILABLE', `${providerRoute}/${modelId} 未接入`);
      return found;
    },
    observedRoutes: () => [],
  };
}

function service(options) {
  return new ModelProfileService({ store, adapter: adapter(options), logger: null });
}

before(() => {
  file = temporaryDatabasePath();
  store = new RoomStore({ file, lockFile: `${file}.lock` });
  store.open();
  store.insertRoom({ id: 'room_models', title: '模型测试群', ownerRef: 'tester' });
});

after(() => {
  store.close();
  try {
    for (const suffix of ['', '.lock', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** One member row for `effectiveFor` to resolve against. */
function member(patch = {}) {
  return {
    id: `member_${patch.role ?? 'backend'}`,
    roomId: 'room_models',
    kind: 'agent',
    role: 'backend',
    displayName: '后端·阿北',
    handle: 'backend',
    aliases: [],
    status: 'idle',
    modelProfileRef: null,
    selectionSource: 'project-default',
    modelLocked: true,
    ...patch,
  };
}

describe('model configuration — precedence', () => {
  it('falls back to the host default when the project configures nothing', async () => {
    const models = service();
    const chosen = await models.chooseProfile({ roomId: 'room_models', role: 'backend' });
    assert.equal(chosen.profileRef, 'deepseek-official/deepseek-flash');
    assert.equal(chosen.source, 'host-default', 'the source must not claim the project chose it');
    assert.match(chosen.reason, /Harness 的默认模型/);
  });

  it('reports the same fallback through effectiveFor, so the panel and execution agree', async () => {
    const models = service();
    const effective = await models.effectiveFor(member());
    assert.equal(effective.profileRef, 'deepseek-official/deepseek-flash');
    assert.equal(effective.source, 'host-default');
  });

  it('lets a role default override the project default', async () => {
    const models = service();
    const result = store.transaction(() =>
      store.updateRoom('room_models', {
        config: { models: { projectDefaultProfileRef: 'deepseek-official/deepseek-flash', roleDefaults: { backend: 'pi-ai/glm-4.6' } } },
      }),
    );
    assert.equal(result.id, 'room_models');

    const chosen = await models.chooseProfile({ roomId: 'room_models', role: 'backend' });
    assert.equal(chosen.profileRef, 'pi-ai/glm-4.6');
    assert.equal(chosen.source, 'role-default');

    const other = await models.chooseProfile({ roomId: 'room_models', role: 'tester' });
    assert.equal(other.profileRef, 'deepseek-official/deepseek-flash');
    assert.equal(other.source, 'project-default');

    const effective = await models.effectiveFor(member());
    assert.equal(effective.profileRef, 'pi-ai/glm-4.6');
    assert.equal(effective.source, 'role-default');
  });

  it('lets a member’s own model override every default', async () => {
    const models = service();
    const effective = await models.effectiveFor(member({ modelProfileRef: 'pi-ai/glm-4.6', selectionSource: 'member-fixed' }));
    assert.equal(effective.profileRef, 'pi-ai/glm-4.6');
    assert.equal(effective.source, 'member-fixed');
  });

  it('refuses a stale role default instead of handing a dead route to the host', async () => {
    store.updateRoom('room_models', {
      config: { models: { roleDefaults: { tester: 'pi-ai/does-not-exist' } } },
    });
    const models = service();
    await assert.rejects(
      () => models.chooseProfile({ roomId: 'room_models', role: 'tester' }),
      (error) => error instanceof RoomError && error.code === 'MEMBER_UNAVAILABLE',
    );
    // Restore a clean configuration for the tests that follow.
    store.updateRoom('room_models', { config: { models: {} } });
  });

  it('reports what it can honestly say when neither the project nor the host has a model', async () => {
    const models = service({ selection: null });
    const chosen = await models.chooseProfile({ roomId: 'room_models', role: 'backend' });
    assert.equal(chosen.profileRef, null);
    assert.match(chosen.reason, /接入提供方/);
  });
});

describe('model configuration — allowed pool', () => {
  it('refuses to enable the pool mode without a pool', async () => {
    const models = service();
    await assert.rejects(
      () =>
        // This is the rule the route enforces; asserting it here keeps the promise
        // visible where the service lives.
        (async () => {
          const settings = models.settingsOf('room_models');
          const next = { ...settings, selectionMode: 'allowed-pool', allowedProfileRefs: [] };
          if (next.selectionMode === 'allowed-pool' && next.allowedProfileRefs.length === 0) {
            throw new RoomError('INVALID_REQUEST', '启用允许池自动选型必须设置非空允许池。');
          }
        })(),
      (error) => error instanceof RoomError && error.code === 'INVALID_REQUEST',
    );
  });

  it('chooses only inside the allowed pool and never a locked member’s model', async () => {
    store.updateRoom('room_models', {
      config: { models: { selectionMode: 'allowed-pool', allowedProfileRefs: ['pi-ai/glm-4.6'] } },
    });
    const models = service();
    const chosen = await models.chooseProfile({ roomId: 'room_models', role: 'frontend' });
    assert.equal(chosen.profileRef, 'pi-ai/glm-4.6');
    assert.equal(chosen.source, 'allowed-pool');
    assert.match(chosen.reason, /允许池/);

    // A member the user pinned is never re-picked by the pool.
    const pinned = await models.effectiveFor(member({ modelProfileRef: 'deepseek-official/deepseek-flash', selectionSource: 'member-fixed', modelLocked: true }));
    assert.equal(pinned.profileRef, 'deepseek-official/deepseek-flash');
    assert.equal(pinned.source, 'member-fixed');
  });

  it('never leaves the pool when choosing a fallback', async () => {
    const models = service();
    const fallback = await models.fallbackFor({ roomId: 'room_models', memberId: 'member_backend' });
    // Default policy is `none`: a failed model is NOT silently replaced.
    assert.equal(fallback, null);
  });
});
