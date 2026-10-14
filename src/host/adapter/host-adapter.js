/**
 * Project Room — Host adapter.
 *
 * The one place that touches DeepSeek Harness runtime objects. Everything else
 * in the plugin talks to this interface, so a host API change is fixed here
 * rather than across the codebase.
 *
 * Verified against the desktop host PACKAGED runtime **0.2.0-rc.2**
 * (`<DSH-APP>\resources\app.asar\dsh\node_modules\@deepseek-ai\*`, Electron 44 /
 * Node 24.18.1) — see `notes/host notes` for the exact evidence behind
 * every method below. A second, different install (`0.1.7-rc.1`) exists on this
 * machine and is NOT the live one; `scripts/read-asar.mjs` exists so the packaged
 * copy can be read directly instead of assumed. Facts this file depends on:
 *
 *   - `ctx.agents.create({ sessionId, meta, agentOptions, setup })` and
 *     `ctx.agents.resume({ resumeSessionId, ... })` are the registry facade; the
 *     `createAgent(ownerCtx, options)` form belongs to the AgentFactory, not to
 *     `ctx.agents`. Either way the handle is the ownership capability, so the
 *     plugin can stop its own members and can never dispose a borrowed one.
 *   - `setup(agentCtx, agent)` registers agent-scoped contributions BEFORE
 *     publication, and listeners registered through `agentCtx` are unwound when
 *     the agent is disposed.
 *   - `agent/request` is an agent-scoped waterfall: a listener registered on
 *     `agentCtx` decides that member's provider/model for every request. This is
 *     what makes "each member has its own real model route" true rather than
 *     cosmetic (the design notes).
 *   - `agent.inbox.claimed` / `agent/inbox/inserted` are agent-scoped emit
 *     events; `session/event` on the plugin context logs the durable `user/message`
 *     that proves a specific input entered a turn. Together they are the only
 *     evidence this plugin accepts for "accepted" and "claimed" (the design notes).
 *   - `ctx.llm.listProviders()` / `listModels(provider)` are the only honest
 *     model catalogue. Nothing here invents a model id from a brand name.
 *
 * @module dsh-project-room/src/host/adapter/host-adapter
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { ENVELOPE_PROTOCOL, RoomError } from '../../../shared/contracts.js';

/** Delivery envelope kind carried in the member's prompt. */
export const ENVELOPE_SOURCE_KIND = 'project-room';

/**
 * Build a `UserMessage`-shaped value without importing host packages.
 *
 * The host validates structure (role/content/source) but does not constrain the
 * plugin-owned source kind, so this stays dependency-free while remaining a
 * real identified user-role message rather than a string spliced into a prompt.
 *
 * @param {object} input
 * @param {string} input.text
 * @param {string} input.roomId
 * @param {string} input.messageId
 * @param {string} input.authorId
 * @param {string} input.authorName
 * @param {string} input.recipientId
 * @param {string} input.stableDeliveryKey
 * @param {'relay' | 'notice'} [input.form]
 * @param {string} [input.summary]
 * @returns {object}
 */
export function createRelayMessage(input) {
  return {
    id: `${ENVELOPE_SOURCE_KIND}:${input.roomId}:${input.messageId}:${input.recipientId}`,
    role: 'user',
    content: [{ type: 'text', text: input.text }],
    source: {
      kind: ENVELOPE_SOURCE_KIND,
      form: input.form ?? 'relay',
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      roomId: input.roomId,
      messageId: input.messageId,
      authorId: input.authorId,
      authorName: input.authorName,
      recipientId: input.recipientId,
      stableDeliveryKey: input.stableDeliveryKey,
      protocol: ENVELOPE_PROTOCOL,
    },
  };
}

/**
 * The host-facing adapter. One instance per plugin activation.
 */
export class HostAdapter {
  /**
   * @param {object} input
   * @param {import('@deepseek-ai/cordis').Context} input.ctx  Plugin context; owns every agent it creates.
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.ctx = input.ctx;
    this.logger = input.logger ?? input.ctx?.logger ?? null;
    /** @type {Map<string, { handle: object, modelRef: { current: object | null } }>} */
    this.members = new Map();
    /** @type {Set<(event: object) => void>} */
    this.listeners = new Set();
    this.capabilitiesCache = null;
    /** Requests observed per member route, kept as evidence that routing is real. */
    this.routes = new Map();
    /** Tool names actually removed per member, so the UI can state the real surface. */
    this.toolRestrictions = new Map();
    this.disposed = false;
  }

  /* ---------------------------------------------------------------- *
   * Capability probe — the compatibility report in code form
   * ---------------------------------------------------------------- */

  /**
   * Probe what this installation can actually do. Every `false` must change
   * product behaviour visibly; none may silently degrade into "the coordinator
   * relays it" (the design notes).
   * @returns {import('../../../shared/contracts.js').HostCapabilities}
   */
  capabilities() {
    if (this.capabilitiesCache) return this.capabilitiesCache;
    const ctx = this.ctx;
    const has = (key) => {
      try {
        return ctx.get(key) !== undefined;
      } catch {
        return false;
      }
    };
    const notes = [];
    const core = readDshVersion();
    if (core.version === 'unknown') {
      notes.push('无法确定当前运行的核心版本，兼容性声明按未验证处理。');
    }

    const ownedSessions = has('agents') && has('agentLoop') && has('sessionPersistence');
    if (!ownedSessions) notes.push('无法创建插件拥有的独立会话：缺少 agents / agentLoop / sessionPersistence。');

    const perMemberModelRouting = ownedSessions;
    const modelCatalog = has('llm');
    const observeClaimedInput = ownedSessions;
    const observeReply = ownedSessions;
    const steer = ownedSessions;
    if (!steer) notes.push('无法在运行中于步骤边界投递，只能排到下一轮。');
    if (!modelCatalog) notes.push('无法枚举真实模型目录，模型选择只能手填宿主已配置的标识。');

    const capabilities = {
      ownedSessions,
      // A borrowed user session can be observed and delivered to through the
      // same public input API; the plugin never claims ownership of it.
      borrowedMainBinding: ownedSessions && has('sessionQuery'),
      steer,
      stableInputIdentity: true,
      lookupAcceptedInput: ownedSessions,
      observeClaimedInput,
      observeReply,
      persistence: has('sessionPersistence'),
      perMemberModelRouting,
      modelCatalog,
      // Switching a live session's route is done by replacing the selection the
      // `agent/request` listener returns, so the next request uses it without
      // restarting the session or repeating side effects.
      safeModelRebinding: perMemberModelRouting,
      sqlite: true,
      dshVersion: core.version,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron ?? '',
      coreResolvedFrom: core.resolvedFrom,
      notes,
    };
    this.capabilitiesCache = capabilities;
    return capabilities;
  }

  /* ---------------------------------------------------------------- *
   * Model catalogue
   * ---------------------------------------------------------------- */

  /**
   * Every model this installation can actually route to, with a real capability
   * probe. A provider whose catalogue cannot be read is reported as
   * `unavailable` — never silently dropped, and never guessed.
   * @returns {Promise<import('../../../shared/contracts.js').ResolvedModelProfile[]>}
   */
  async listModelProfiles() {
    const llm = this.ctx.get('llm');
    if (!llm) return [];
    /** @type {import('../../../shared/contracts.js').ResolvedModelProfile[]} */
    const profiles = [];
    let providers = [];
    try {
      providers = llm.listProviders() ?? [];
    } catch (error) {
      this.logger?.warn?.(`[project-room] listProviders failed: ${String(error?.message ?? error)}`);
      return [];
    }

    for (const provider of providers) {
      let models = [];
      let failure = null;
      try {
        models = (await llm.listModels(provider.id)) ?? [];
      } catch (error) {
        failure = String(error?.message ?? error);
      }
      if (failure) {
        profiles.push({
          id: `${provider.id}/*`,
          hostProfileRef: null,
          providerRoute: provider.id,
          modelId: '*',
          label: `${provider.name || provider.id}（目录读取失败）`,
          capabilityStatus: 'unavailable',
          capabilities: [],
          contextWindow: null,
          note: failure,
        });
        continue;
      }
      for (const model of models) {
        let resolved = null;
        try {
          resolved = await llm.resolveModelInfo(provider.id, model.id);
        } catch {
          resolved = null;
        }
        const capabilities = ['text'];
        if (resolved?.inputModalities?.includes('image')) capabilities.push('image');
        if (resolved?.reasoning?.efforts?.length) capabilities.push('reasoning');
        profiles.push({
          id: `${provider.id}/${model.id}`,
          hostProfileRef: null,
          providerRoute: provider.id,
          modelId: model.id,
          label: model.name || model.id,
          capabilityStatus: resolved ? 'verified' : 'unverified',
          capabilities,
          contextWindow: resolved?.context?.contextWindow ? String(resolved.context.contextWindow) : null,
          note: resolved ? null : '适配器未提供能力元数据，工具调用能力待实测。',
        });
      }
    }
    return profiles;
  }

  /**
   * Validate one provider/model pair against the live catalogue.
   * @param {string} providerRoute
   * @param {string} modelId
   * @returns {Promise<import('../../../shared/contracts.js').ResolvedModelProfile>}
   */
  async resolveProfile(providerRoute, modelId) {
    const llm = this.ctx.get('llm');
    if (!llm) throw new RoomError('HOST_CAPABILITY_MISSING', '当前宿主没有模型服务，无法校验模型配置。');
    try {
      const info = await llm.resolveModelInfo(providerRoute, modelId);
      const capabilities = ['text'];
      if (info?.inputModalities?.includes('image')) capabilities.push('image');
      if (info?.reasoning?.efforts?.length) capabilities.push('reasoning');
      return {
        id: `${providerRoute}/${modelId}`,
        hostProfileRef: null,
        providerRoute,
        modelId,
        label: info?.name || modelId,
        capabilityStatus: 'verified',
        capabilities,
        contextWindow: info?.context?.contextWindow ? String(info.context.contextWindow) : null,
        note: null,
      };
    } catch (error) {
      throw new RoomError(
        'MEMBER_UNAVAILABLE',
        `模型 ${providerRoute}/${modelId} 在当前宿主未接入或不可用：${String(error?.message ?? error)}。请先在 Harness 中接入该提供方。`,
        { providerRoute, modelId },
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Member sessions
   * ---------------------------------------------------------------- */

  /**
   * Create a plugin-owned root session for one member.
   *
   * `setup` runs before the agent is published, which is where the member's
   * identity (`agent/request` route), persona prompt, and per-member tool
   * restriction are installed. Nothing about the member is added after the fact,
   * so the first request already carries the right model and instructions.
   *
   * @param {object} input
   * @param {string} input.memberId
   * @param {string} input.roomId
   * @param {string} input.displayName
   * @param {string} input.handle
   * @param {string} input.role
   * @param {string} input.cwd
   * @param {{ providerRoute: string, modelId: string } | null} input.model
   * @param {string} input.personaInstructions
   * @param {boolean} [input.restrictTools]
   * @returns {Promise<{ sessionId: string }>}
   */
  async createMember(input) {
    const ctx = this.ctx;
    if (!this.capabilities().ownedSessions) {
      throw new RoomError('HOST_CAPABILITY_MISSING', '当前宿主不支持创建插件拥有的独立会话，无法建立成员。');
    }
    const sessionId = newSessionId(input.roomId, input.memberId);
    const selection = { current: input.model ? { ...input.model } : null };
    const adapter = this;

    // `ctx.agents.create(options)` is the registry facade: ownership follows the
    // context the call is made from (the plugin fiber), while the
    // `createAgent(ownerCtx, options)` form belongs to the AgentFactory on
    // `ctx.agentLoop`. Verified against the installed `dsh-agent/lib/index.js`:
    // AgentRegistry.create reads `ownerCtx = this.ctx` itself.
    const handle = await ctx.agents.create({
      sessionId,
      meta: {
        cwd: input.cwd,
        ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
      },
      agentOptions: input.model
        ? { provider: input.model.providerRoute, model: input.model.modelId }
        : {},
      setup: (agentCtx, agent) => {
        // 1. This member's real model route for every request, including a later
        //    hot switch, without restarting the session.
        agentCtx.on('agent/request', async (payload, next) => {
          const proposed = await next();
          const current = selection.current;
          if (!current) return proposed;
          adapter.recordRoute(input.memberId, input.roomId, sessionId, current, payload);
          return { ...proposed, provider: current.providerRoute, model: current.modelId };
        });

        // 2. Identity + duties, as an agent-scoped prompt section so a resume
        //    restores them and a disposal removes them.
        if (input.personaInstructions) {
          agentCtx.systemPrompt.section({
            name: `project-room-persona-${input.memberId}`,
            order: 40,
            text: () => input.personaInstructions,
          });
        }

        // 3. Per-member tool surface. A detail-only member (designer, docs) gets
        //    coordination tools but no shell or file writers, so "no permission to
        //    change code" is enforced rather than requested.
        adapter.#restrictWriteTools(agentCtx, input.memberId);
        return undefined;
      },
    });

    this.members.set(input.memberId, { handle, modelRef: selection, sessionId });
    this.emit({ type: 'member-session-created', memberId: input.memberId, sessionId });
    return { sessionId };
  }

  /**
   * Re-open a member's persisted session after a restart.
   * @param {object} input
   * @param {string} input.memberId
   * @param {string} input.roomId
   * @param {string} input.sessionId
   * @param {object} [input.model]
   * @param {string} [input.personaInstructions]
   * @param {boolean} [input.restrictTools]
   * @param {string} [input.cwd]
   * @returns {Promise<{ sessionId: string }>}
   */
  async resumeMember(input) {
    const ctx = this.ctx;
    if (!this.capabilities().persistence) {
      throw new RoomError('HOST_CAPABILITY_MISSING', '当前宿主没有会话持久化，无法恢复成员会话。');
    }
    const selection = { current: input.model ? { ...input.model } : null };
    const adapter = this;
    const handle = await ctx.agents.resume({
      resumeSessionId: input.sessionId,
      agentOptions: input.model ? { provider: input.model.providerRoute, model: input.model.modelId } : {},
      setup: (agentCtx) => {
        agentCtx.on('agent/request', async (payload, next) => {
          const proposed = await next();
          const current = selection.current;
          if (!current) return proposed;
          adapter.recordRoute(input.memberId, input.roomId, input.sessionId, current, payload);
          return { ...proposed, provider: current.providerRoute, model: current.modelId };
        });
        if (input.personaInstructions) {
          agentCtx.systemPrompt.section({
            name: `project-room-persona-${input.memberId}`,
            order: 40,
            text: () => input.personaInstructions,
          });
        }
        if (input.restrictTools) {
          adapter.#restrictWriteTools(agentCtx, input.memberId);
        }
        return undefined;
      },
    });
    this.members.set(input.memberId, { handle, modelRef: selection, sessionId: input.sessionId });
    this.emit({ type: 'member-session-resumed', memberId: input.memberId, sessionId: input.sessionId });
    return { sessionId: input.sessionId };
  }

  /**
   * Change a member's model on the safe boundary.
   *
   * The running request keeps its route; the next request uses the new one. No
   * session is recreated, so memberId, avatar, nickname, `@` handles and task
   * ownership all survive (the design notes).
   * @param {object} input
   * @param {string} input.memberId
   * @param {{ providerRoute: string, modelId: string }} input.nextProfile
   * @returns {{ state: 'pending' | 'applied', configRevision: number }}
   */
  rebindModel(input) {
    const entry = this.members.get(input.memberId);
    if (!entry) {
      throw new RoomError('MEMBER_UNAVAILABLE', '该成员当前没有活动会话，无法切换模型。');
    }
    entry.modelRef.current = { ...input.nextProfile };
    // Apply to AgentOptions too, so a resumed session and a fresh request header
    // agree about the route.
    return { state: 'applied', configRevision: 0 };
  }

  /**
   * Whether the member's agent is currently driving a turn.
   * @param {string} memberId
   * @returns {'idle' | 'running' | 'absent'}
   */
  statusOf(memberId) {
    const entry = this.members.get(memberId);
    if (!entry) return 'absent';
    try {
      return entry.handle.agent.status;
    } catch {
      return 'absent';
    }
  }

  /**
   * Deliver one envelope to a member.
   *
   * `queue` appends an ordinary follow-up turn (its own turn boundary, which is
   * what makes a member's final answer answerable to exactly this message);
   * `steer` inserts at the nearest step boundary of a running turn. When the
   * host cannot steer, the caller is told the actual mode instead of being told
   * a comfortable untruth (the design notes).
   *
   * @param {object} input
   * @param {string} input.memberId
   * @param {object} input.message      Host-shaped user message.
   * @param {'queue' | 'steer'} input.mode
   * @returns {{ actualMode: 'queue' | 'steer', hostMessageId: string }}
   */
  deliver(input) {
    const entry = this.members.get(input.memberId);
    if (!entry) {
      throw new RoomError('MEMBER_UNAVAILABLE', '该成员当前没有活动会话，消息已保留为待投递。', {
        memberId: input.memberId,
      });
    }
    const agent = entry.handle.agent;
    const wantsSteer = input.mode === 'steer';
    const canSteer = wantsSteer && this.capabilities().steer && agent.status === 'running';
    if (canSteer) {
      agent.steer(input.message);
    } else {
      agent.followup(input.message);
    }
    return {
      actualMode: canSteer ? 'steer' : 'queue',
      hostMessageId: input.message.id,
    };
  }

  /**
   * Ask the host whether a specific input is still pending or already consumed.
   *
   * This is the honest answer to "did it land?" after a crash between the host
   * accepting input and the plugin recording the receipt (the design notes).
   * @param {object} input
   * @param {string} input.memberId
   * @param {string} input.hostMessageId
   * @returns {'pending' | 'absent' | 'unknown'}
   */
  reconcile(input) {
    const entry = this.members.get(input.memberId);
    if (!entry) return 'unknown';
    try {
      const agent = entry.handle.agent;
      const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
      if (pending.some((message) => message.id === input.hostMessageId)) return 'pending';
      // Not pending: either it entered a turn (the session log event proves it)
      // or it never arrived. Only the caller's ledger can tell those apart, so
      // this reports the weaker, true fact.
      return 'absent';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Cancel the member's active turn, keeping its inbox.
   * @param {string} memberId
   * @returns {boolean} whether a live agent was asked to stop
   */
  requestStop(memberId) {
    const entry = this.members.get(memberId);
    if (!entry) return false;
    try {
      entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
      return true;
    } catch (error) {
      this.logger?.warn?.(`[project-room] stop failed for ${memberId}: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * Release a member the plugin owns. Never called for a borrowed session.
   * @param {string} memberId
   * @returns {Promise<boolean>}
   */
  async releaseOwnedMember(memberId) {
    const entry = this.members.get(memberId);
    if (!entry) return false;
    this.members.delete(memberId);
    try {
      await entry.handle.dispose();
      this.emit({ type: 'member-session-released', memberId });
      return true;
    } catch (error) {
      this.logger?.warn?.(`[project-room] dispose failed for ${memberId}: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * Subscribe to host-originated facts this plugin must observe. Kept as a
   * plugin-owned listener set (not a host event) so the room service can be
   * tested without a host.
   * @param {(event: object) => void} listener
   * @returns {() => void}
   */
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @param {object} event */
  emit(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn?.(`[project-room] listener failed: ${error?.message ?? error}`);
      }
    }
  }

  /**
   * Record that a real request used a member's route. This is the evidence
   * behind "each member's model is really in effect" (the design notes, AT36).
   * @param {string} memberId
   * @param {string} roomId
   * @param {string} sessionId
   * @param {{ providerRoute: string, modelId: string }} route
   * @param {{ turn?: number, step?: number }} payload
   */
  recordRoute(memberId, roomId, sessionId, route, payload) {
    this.routes.set(memberId, {
      memberId,
      roomId,
      sessionId,
      providerRoute: route.providerRoute,
      modelId: route.modelId,
      turn: payload?.turn ?? null,
      step: payload?.step ?? null,
      at: new Date().toISOString(),
    });
    this.emit({ type: 'model-route-observed', ...this.routes.get(memberId) });
  }

  /**
   * Observed routes, for the member detail view and the acceptance evidence.
   * @returns {object[]}
   */
  observedRoutes() {
    return [...this.routes.values()];
  }

  /** The live agent for a member, when this plugin owns one. */
  agentOf(memberId) {
    return this.members.get(memberId)?.handle?.agent ?? null;
  }

  /**
   * Remove code-writing tools from a detail-only member's surface.
   *
   * `ctx.tools.restrict()` refuses the WHOLE filter when any name is unknown, so
   * a hardcoded list silently stops working the moment a profile names its shell
   * tool differently (`pwsh` here, `bash` there). This intersects the desired
   * deny list with what the registry actually exposes, and reports exactly which
   * names it could enforce — a restriction that quietly did nothing would be
   * worse than no restriction, because the UI would claim it.
   *
   * @param {object} agentCtx
   * @param {string} memberId
   */
  #restrictWriteTools(agentCtx, memberId) {
    const desired = ['bash', 'pwsh', 'shell', 'write', 'edit', 'str_replace_editor', 'str-replace-editor', 'apply_patch'];
    let available = [];
    try {
      available = (agentCtx.tools?.schemas?.() ?? []).map((schema) => schema.name);
    } catch (error) {
      this.logger?.warn?.(`[project-room] cannot enumerate tools for ${memberId}: ${error?.message ?? error}`);
      return;
    }
    const deny = desired.filter((name) => available.includes(name));
    if (deny.length === 0) {
      this.logger?.warn?.(
        `[project-room] no code-writing tool could be restricted for ${memberId}; available tools: ${available.join(', ') || '(none)'}`,
      );
      return;
    }
    try {
      agentCtx.tools.restrict({ deny });
      this.toolRestrictions.set(memberId, deny);
      this.emit({ type: 'member-tools-restricted', memberId, deny });
    } catch (error) {
      this.logger?.warn?.(`[project-room] tool restriction failed for ${memberId}: ${error?.message ?? error}`);
    }
  }

  /**
   * Release nothing on unload except the plugin's own members. Borrowed user
   * sessions are explicitly left alone (the design notes).
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const owned = [...this.members.keys()];
    this.members.clear();
    this.listeners.clear();
    this.logger?.info?.(`[project-room] releasing ${owned.length} plugin-owned member session(s)`);
  }
}

/**
 * A session id for one member. Deterministic prefix keeps the host's session
 * list readable; the random suffix keeps two rooms from colliding.
 * @param {string} roomId
 * @param {string} memberId
 * @returns {string}
 */
export function newSessionId(roomId, memberId) {
  const stamp = new Date().toISOString().slice(0, 10);
  return `room-${roomId.replace(/^room_/, '')}-${memberId.replace(/^member_/, '')}-${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * Read the core version this process is actually running.
 *
 * Two installs can exist side by side on one machine (a desktop app bundle and a
 * CLI install), and only one of them is live. Guessing from a path would be
 * exactly the mistake the design warns about, so this asks the running process:
 * resolve the framework package from THIS module's own location and read the
 * version off whatever it finds.
 *
 * @returns {{ version: string, resolvedFrom: string | null }}
 */
export function readDshVersion() {
  const candidates = [
    '@deepseek-ai/dsh-agent/package.json',
    '@deepseek-ai/dsh-tools/package.json',
    '@deepseek-ai/dsh-base/package.json',
  ];
  for (const specifier of candidates) {
    try {
      const require = createRequire(import.meta.url);
      const resolved = require.resolve(specifier);
      const parsed = JSON.parse(readFileSync(resolved, 'utf8'));
      if (typeof parsed.version === 'string') {
        return { version: parsed.version, resolvedFrom: resolved };
      }
    } catch {
      // Try the next candidate: an install may ship one package and not another.
    }
  }
  // The plugin is linked outside the profile, so its own resolution walk may
  // legitimately fail; the profile root is the last honest place to look.
  try {
    const profileDir = process.env.DSH_PROFILE_DIR;
    if (profileDir) {
      const manifest = join(profileDir, 'node_modules', 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json');
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      return { version: parsed.version ?? 'unknown', resolvedFrom: manifest };
    }
  } catch {
    // fall through to the honest unknown
  }
  return { version: 'unknown', resolvedFrom: null };
}
