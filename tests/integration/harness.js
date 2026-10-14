/**
 * Project Room — integration test harness.
 *
 * An in-process fake of the DeepSeek Harness surfaces the plugin actually
 * touches, plus a wiring helper that composes the REAL host services on top of
 * it. Nothing here reimplements a business rule: every room, delivery, task,
 * decision and workspace behaviour under test is the production code.
 *
 * Faked, and only this much:
 *
 *   - `ctx` with `get` / `on` / `off` / `effect` / `logger`, and the `agents`,
 *     `llm`, `tools` and `webServer` services the adapter and the composition
 *     root look for. `ctx.get(key)` is `undefined` for anything else.
 *   - `ctx.agents.createAgent(ownerCtx, options)` / `agents.resume(...)`
 *     returning a real `{ agent, dispose }` handle, running `options.setup`
 *     before returning, and recording `agentOptions` + `meta` so a test can
 *     prove per-member model routing really happened.
 *   - `agent.inbox` / `followup` / `steer` / `cancel` / `status`, so "did this
 *     envelope reach THIS member's session" is answerable.
 *   - `ctx.llm` with a small deterministic catalogue (`deepseek-official`,
 *     `pi-ai`) whose `resolveModelInfo` throws for a pair it does not know.
 *
 * @module dsh-project-room/tests/integration/harness
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RoomError } from '../../shared/contracts.js';
import { HostAdapter } from '../../src/host/adapter/host-adapter.js';
import { DecisionService } from '../../src/host/decisions/decision-service.js';
import { DeliveryCoordinator } from '../../src/host/delivery/coordinator.js';
import { TurnObserver, extractText } from '../../src/host/delivery/turn-observer.js';
import { ModelProfileService } from '../../src/host/models/model-service.js';
import { RecoveryService } from '../../src/host/recovery/recovery-service.js';
import { ReminderService } from '../../src/host/reminders/reminder-service.js';
import { ContextBuilder } from '../../src/host/room/context-builder.js';
import { LoopGuard } from '../../src/host/room/loop-guard.js';
import { MessageService } from '../../src/host/room/message-service.js';
import { RoomService } from '../../src/host/room/room-service.js';
import { RoomStore, temporaryDatabasePath } from '../../src/host/storage/store.js';
import { PlanningService } from '../../src/host/tasks/planning-service.js';
import { TaskService } from '../../src/host/tasks/task-service.js';
import { ArtifactService } from '../../src/host/workspace/artifact-service.js';
import { WorkspaceCoordinator } from '../../src/host/workspace/coordinator.js';

/** Two real provider routes with different model ids, as the host would report. */
export const MODEL_CATALOGUE = Object.freeze({
  'deepseek-official': [
    { id: 'deepseek-flash', name: 'DeepSeek Flash' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ],
  'pi-ai': [{ id: 'glm-4.6', name: 'GLM-4.6' }],
});

/** Model routes used by the standard team: two providers, four members. */
export const MODEL_REFS = Object.freeze({
  flash: 'deepseek-official/deepseek-flash',
  glm: 'pi-ai/glm-4.6',
});

/**
 * Point the plugin's durable state at a throwaway directory so a test run can
 * never touch the user's real room data.
 * @param {string} [label]
 * @returns {string} the directory that is now `DSH_PROJECT_ROOM_DATA`
 */
export function useTemporaryDataDir(label = 'run') {
  const dir = mkdtempSync(join(tmpdir(), `dsh-project-room-${label}-`));
  process.env.DSH_PROJECT_ROOM_DATA = dir;
  return dir;
}

/**
 * Recover the member id a session id was built from.
 *
 * The real adapter does not put `memberId` in `meta`, so this reads it back out
 * of the session id `newSessionId()` composed. A caller that does set
 * `meta.memberId` wins.
 * @param {string} sessionId
 * @returns {string | null}
 */
export function memberIdFromSession(sessionId) {
  const parts = String(sessionId ?? '').split('-');
  if (parts.length < 4 || parts[0] !== 'room') return null;
  return `member_${parts[2]}`;
}

/**
 * Build the fake host.
 * @param {object} [options]
 * @returns {object} the fake host, with `ctx` and the observation helpers
 */
export function createFakeHost(options = {}) {
  /** @type {Map<string, object>} sessionId → created-agent record */
  const records = new Map();
  /** @type {Array<object>} creation order */
  const order = [];
  /** @type {Map<string, Set<Function>>} context-level event listeners */
  const listeners = new Map();
  /** @type {Array<() => void>} */
  const effects = [];
  /** @type {object[]} */
  const tools = [];
  /** @type {object[]} */
  const routes = [];
  const logs = { info: [], warn: [], error: [], debug: [] };

  const silentLogger = {
    info: (message) => logs.info.push(String(message)),
    warn: (message) => logs.warn.push(String(message)),
    error: (message) => logs.error.push(String(message)),
    debug: (message) => logs.debug.push(String(message)),
  };

  /**
   * The agent-scoped context a member's `setup` receives. Listeners registered
   * here belong to that agent and are dropped when its handle is disposed — the
   * same lifetime rule the plugin relies on for `agent/request`.
   */
  function createAgentCtx(record) {
    return {
      on(event, listener) {
        const set = record.listeners.get(event) ?? new Set();
        set.add(listener);
        record.listeners.set(event, set);
        return () => set.delete(listener);
      },
      off(event, listener) {
        record.listeners.get(event)?.delete(listener);
      },
      tools: {
        /** Record a per-member tool restriction request. */
        restrict(definition) {
          record.toolRestrictions.push(definition);
          return () => {};
        },
        /**
         * The tool names this member's surface currently exposes. The adapter
         * intersects its deny list with whatever the registry really has, so a
         * fake that returned nothing would silently hide that logic.
         */
        schemas() {
          return [
            { name: 'read' },
            { name: 'bash' },
            { name: 'write' },
            { name: 'edit' },
            { name: 'room_send' },
          ];
        },
      },
      systemPrompt: {
        /** Record an agent-scoped prompt section. */
        section(section) {
          record.promptSections.push(section);
          return () => {};
        },
      },
    };
  }

  /**
   * Create one agent handle the way `ctx.agents` does: `setup` runs before the
   * handle is published, so the first request already carries the member's
   * identity.
   */
  function spawn(input) {
    const { sessionId, agentOptions = {}, meta = {} } = input;
    /** @type {object} */
    const record = {
      sessionId,
      memberId: meta.memberId ?? memberIdFromSession(sessionId),
      meta: { ...meta },
      agentOptions: { ...agentOptions },
      service: input.service,
      received: [],
      cancels: [],
      toolRestrictions: [],
      promptSections: [],
      /** @type {Map<string, Set<Function>>} */
      listeners: new Map(),
      disposed: false,
      recovered: [],
    };

    const session = { id: sessionId, events: [] };
    const agentCtx = createAgentCtx(record);
    const agent = {
      id: sessionId,
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
      session,
      ctx: agentCtx,
      /** A queued turn: exactly what the adapter's `queue` mode produces. */
      followup(message) {
        record.received.push({ mode: 'queue', message });
        agent.inbox.nextTurn.push(message);
      },
      /** A step-boundary insert: the adapter only uses this for a live turn. */
      steer(message) {
        record.received.push({ mode: 'steer', message });
        agent.inbox.nextStep.push(message);
      },
      cancel(reason, cancelOptions) {
        record.cancels.push({ reason, options: cancelOptions });
        agent.status = 'idle';
      },
    };
    record.agent = agent;

    records.set(sessionId, record);
    order.push(record);

    if (typeof input.setup === 'function') input.setup(agentCtx, agent);
    const handle = {
      agent,
      async dispose() {
        record.disposed = true;
        record.listeners.clear();
        agent.status = 'idle';
      },
    };
    record.handle = handle;
    return handle;
  }

  const agentsService = {
    /**
     * The registry facade the adapter calls: ownership follows the context the
     * call is made from, so no owner context is passed here.
     * @param {object} agentOptions
     */
    async create(agentOptions) {
      return spawn({ ...agentOptions, service: 'create' });
    },
    /**
     * The AgentFactory form (`createAgent(ownerCtx, options)`). Kept because the
     * plugin has called both shapes; the fake answers whichever one is used.
     * @param {object} _ownerCtx
     * @param {object} agentOptions
     */
    async createAgent(_ownerCtx, agentOptions) {
      return spawn({ ...agentOptions, service: 'createAgent' });
    },
    /**
     * @param {object} resumeOptions
     */
    async resume(resumeOptions) {
      const handle = spawn({
        ...resumeOptions,
        sessionId: resumeOptions.resumeSessionId,
        service: 'resume',
      });
      records.get(resumeOptions.resumeSessionId)?.recovered.push(resumeOptions.resumeSessionId);
      return handle;
    },
  };

  const llm = {
    listProviders() {
      return Object.keys(MODEL_CATALOGUE).map((id) => ({ id, name: id }));
    },
    listModels(provider) {
      const models = MODEL_CATALOGUE[provider];
      if (!models) throw new Error(`unknown provider: ${provider}`);
      return models.map((model) => ({ ...model }));
    },
    resolveModelInfo(provider, model) {
      const found = (MODEL_CATALOGUE[provider] ?? []).find((entry) => entry.id === model);
      if (!found) throw new Error(`unknown model ${provider}/${model}`);
      return {
        name: found.name,
        inputModalities: ['text'],
        reasoning: { efforts: ['standard'] },
        context: { contextWindow: 128000 },
      };
    },
  };

  const toolsService = {
    register(definition) {
      tools.push(definition);
      return () => {
        const index = tools.indexOf(definition);
        if (index >= 0) tools.splice(index, 1);
      };
    },
  };

  const webServerService = {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };

  const services = {
    agents: agentsService,
    // Present so the adapter's capability probe reports the two facts this fake
    // really provides: plugin-owned sessions and their persistence.
    agentLoop: { kind: 'fake-agent-loop' },
    sessionPersistence: { kind: 'fake-session-persistence' },
    sessionQuery: { kind: 'fake-session-query' },
    llm,
    tools: toolsService,
    webServer: webServerService,
  };

  const ctx = {
    logger: silentLogger,
    agents: agentsService,
    llm,
    tools: toolsService,
    webServer: webServerService,
    get(key) {
      return services[key];
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    effect(callback) {
      const result = callback();
      const disposer = typeof result === 'function' ? result : () => {};
      effects.push(disposer);
      return () => {
        const index = effects.indexOf(disposer);
        if (index >= 0) effects.splice(index, 1);
        disposer();
      };
    },
  };

  /** @param {string} sessionId */
  function requireRecord(sessionId) {
    const record = records.get(sessionId);
    if (!record) throw new Error(`fake host has no session ${sessionId}`);
    return record;
  }

  return {
    ctx,
    logger: silentLogger,
    logs,
    tools,
    routes,

    /* ---------------------------------------------------------------- *
     * Observation
     * ---------------------------------------------------------------- */

    /** Every agent this fake host has published, in creation order. */
    createdAgents() {
      return order.map((record) => ({
        sessionId: record.sessionId,
        memberId: record.memberId,
        agentOptions: { ...record.agentOptions },
        meta: { ...record.meta },
        service: record.service,
      }));
    },

    /** @param {string} sessionId */
    record(sessionId) {
      return requireRecord(sessionId);
    },

    /**
     * What one session's agent was handed, oldest first.
     * @param {string} sessionId
     * @returns {Array<{ mode: 'queue' | 'steer', message: object, text: string }>}
     */
    received(sessionId) {
      const record = records.get(sessionId);
      if (!record) return [];
      return record.received.map((entry) => ({
        ...entry,
        text: extractText(entry.message?.content),
      }));
    },

    /** Messages still queued in one session's inbox. */
    inbox(sessionId) {
      const record = requireRecord(sessionId);
      return [...record.agent.inbox.nextStep, ...record.agent.inbox.nextTurn];
    },

    /**
     * Run the agent-scoped `agent/request` waterfall for one member, exactly as
     * the host would: each listener may call `next()` and override the route.
     * @param {string} sessionId
     * @param {{ turn?: number, step?: number }} [payload]
     * @param {{ provider: string, model: string }} [proposed]
     */
    async requestRoute(sessionId, payload = {}, proposed = { provider: 'host-default', model: 'host-default' }) {
      const record = requireRecord(sessionId);
      let route = { ...proposed };
      for (const listener of record.listeners.get('agent/request') ?? []) {
        route = await listener(payload, async () => route);
      }
      return route;
    },

    /* ---------------------------------------------------------------- *
     * Driving the host
     * ---------------------------------------------------------------- */

    /** Publish a durable session event, the way the host's log would. */
    emitSessionEvent(sessionId, event) {
      const record = requireRecord(sessionId);
      record.agent.session.events.push(event);
      ctx.emit('session/event', record.agent.session, event);
    },

    /** Publish an agent-scoped event (`agent/inbox/claimed`, `agent/status`). */
    emitAgentEvent(sessionId, event, payload) {
      const record = requireRecord(sessionId);
      for (const listener of [...(record.listeners.get(event) ?? [])]) listener(payload);
    },

    /** Set an agent's runtime status and tell its agent-scoped listeners. */
    setAgentStatus(sessionId, status, payload = {}) {
      const record = requireRecord(sessionId);
      record.agent.status = status;
      this.emitAgentEvent(sessionId, 'agent/status', { status, ...payload });
    },

    /**
     * Make the host forget one input identity, modelling a host that never
     * admitted it: the identity is gone from the inbox and no durable
     * `user/message` event proves it entered a turn.
     * @param {string} sessionId
     * @param {string} hostMessageId
     */
    forget(sessionId, hostMessageId) {
      const record = requireRecord(sessionId);
      const keep = (message) => message.id !== hostMessageId;
      record.agent.inbox.nextTurn = record.agent.inbox.nextTurn.filter(keep);
      record.agent.inbox.nextStep = record.agent.inbox.nextStep.filter(keep);
      record.agent.session.events = record.agent.session.events.filter((event) => event.id !== hostMessageId);
      record.received = record.received.filter((entry) => entry.message?.id !== hostMessageId);
    },

    /** Run every `ctx.effect` disposer, newest first (plugin unload). */
    async disposeAll() {
      for (const disposer of effects.splice(0).reverse()) {
        try {
          await disposer();
        } catch {
          /* teardown is best effort, exactly like the plugin's */
        }
      }
    },
  };
}

/**
 * Compose the real Project Room services over a fake host, the same way
 * `src/host/index.js` does at activation.
 *
 * @param {object} [options]
 * @param {string} [options.file]     Database file; a throwaway one by default.
 * @param {string} [options.dataDir]  `DSH_PROJECT_ROOM_DATA` target.
 * @param {string} [options.gitVersion] Reported git version (`null` = no git).
 * @param {string} [options.worktreeRoot]
 * @param {number} [options.maxAutomaticRounds]
 * @param {object} [options.host]     Reuse an existing fake host (restart tests).
 * @param {boolean} [options.delivery] Set false to wire MessageService without a coordinator.
 * @returns {object} the stack: fake host + every real service
 */
export function createRoomStack(options = {}) {
  const dataDir = options.dataDir ?? useTemporaryDataDir('stack');
  const file = options.file ?? temporaryDatabasePath();
  const host = options.host ?? createFakeHost();
  const logger = null;

  const store = new RoomStore({ file, lockFile: `${file}.lock`, logger });
  store.open();

  const adapter = new HostAdapter({ ctx: host.ctx, logger });
  const rooms = new RoomService({ store, adapter, logger });
  const context = new ContextBuilder({ store });
  const guard = new LoopGuard({ maxAutomaticRounds: options.maxAutomaticRounds });
  const models = new ModelProfileService({ store, adapter, logger });
  const tasks = new TaskService({ store, rooms, guard, logger });
  const artifacts = new ArtifactService({ store, rooms, tasks, logger });
  const workspace = new WorkspaceCoordinator({
    store,
    rooms,
    gitVersion: options.gitVersion ?? null,
    worktreeRoot: options.worktreeRoot,
    logger,
  });
  const delivery = new DeliveryCoordinator({ store, adapter, rooms, context, guard, logger });
  const messages = new MessageService({
    store,
    rooms,
    context,
    adapter,
    delivery: options.delivery === false ? null : delivery,
    logger,
  });
  tasks.messages = messages;
  artifacts.messages = messages;

  /** sessionId → memberId, the server-side identity map tools resolve through. */
  const sessionIndex = new Map();
  const sessionCreations = new Map();

  const memberOfSession = (sessionId) => {
    const memberId = sessionIndex.get(sessionId);
    return memberId ? store.getMember(memberId) : null;
  };

  // Rebuild the index from storage, so identity survives a plugin reload while
  // the host sessions stay alive (the design notes step 2).
  for (const room of store.listRooms()) {
    for (const member of store.listMembers(room.id, { includeRetired: true })) {
      if (member.sessionId) sessionIndex.set(member.sessionId, member.id);
    }
  }

  /**
   * Create (or reuse) the host session for a member. Mirrors the composition
   * root's `ensureMemberSession`, including the one-session-per-member guard.
   * @param {object} input
   */
  async function ensureMemberSession(input) {
    const member = store.getMember(input.memberId);
    if (!member) throw new RoomError('NOT_FOUND', `成员 ${input.memberId} 不存在。`);
    if (member.sessionId && adapter.agentOf(member.id)) return { sessionId: member.sessionId };
    const pending = sessionCreations.get(member.id);
    if (pending) return pending;

    const task = (async () => {
      const effective = await models.effectiveFor(member);
      let model = null;
      if (effective.profileRef) {
        const profile = await models.requireProfile(effective.profileRef);
        model = { providerRoute: profile.providerRoute, modelId: profile.modelId };
      }
      const personaInstructions = rooms.instructionsFor(member.id);
      const cwd = input.cwd ?? store.getRoom(member.roomId)?.workspaceRef ?? process.cwd();
      const reuse = Boolean(member.sessionId);
      const created = reuse
        ? await adapter.resumeMember({
            memberId: member.id,
            roomId: member.roomId,
            sessionId: member.sessionId,
            model,
            personaInstructions,
            cwd,
          })
        : await adapter.createMember({
            memberId: member.id,
            roomId: member.roomId,
            displayName: member.displayName,
            handle: member.handle,
            role: member.role,
            cwd,
            model,
            personaInstructions,
          });

      store.transaction(() => {
        store.updateMember(member.id, {
          sessionId: created.sessionId,
          sessionOwnership: 'owned',
          status: member.status === 'offline' ? 'idle' : member.status,
        });
        store.appendEvent({
          roomId: member.roomId,
          eventType: reuse ? 'member.session.resumed' : 'member.session.created',
          payload: { memberId: member.id, sessionId: created.sessionId, model },
        });
      });
      sessionIndex.set(created.sessionId, member.id);

      const agent = adapter.agentOf(member.id);
      if (agent) observer.attachMember({ memberId: member.id, roomId: member.roomId, agent });
      return created;
    })().finally(() => sessionCreations.delete(member.id));

    sessionCreations.set(member.id, task);
    return task;
  }

  const planning = new PlanningService({
    store,
    rooms,
    models,
    tasks,
    messages,
    logger,
    createSession: (input) => ensureMemberSession(input),
  });
  const decisions = new DecisionService({ store, rooms, tasks, messages, logger });
  const observer = new TurnObserver({ store, adapter, messages, delivery, logger });
  // Same wiring as the composition root: durable session events are what prove a
  // specific input entered a turn, and what publishes a member's final reply.
  observer.attachHost(host.ctx);
  const recovery = new RecoveryService({ store, rooms, adapter, delivery, observer, planning, decisions, models, logger });
  // Constructed but never started: tests drive `scan()` explicitly so the
  // invalidation rules are asserted against a clock they control, not a timer.
  const reminders = new ReminderService({ store, rooms, messages, logger });

  return {
    host,
    ctx: host.ctx,
    dataDir,
    file,
    store,
    adapter,
    rooms,
    context,
    guard,
    models,
    tasks,
    artifacts,
    workspace,
    delivery,
    messages,
    planning,
    decisions,
    observer,
    recovery,
    reminders,
    ensureMemberSession,
    memberOfSession,
    sessionIndex,

    /** Close the database and release every session this stack owns. */
    async close() {
      observer.dispose();
      await adapter.dispose();
      store.close();
    },
  };
}

/** The team every integration test starts from: four real member sessions. */
export const STANDARD_TEAM = Object.freeze([
  { role: 'coordinator', displayName: '主代理·小叶', handle: 'coordinator', modelProfileRef: MODEL_REFS.flash },
  { role: 'frontend', displayName: '前端·小林', handle: 'frontend', modelProfileRef: MODEL_REFS.flash },
  { role: 'backend', displayName: '后端·阿北', handle: 'backend', modelProfileRef: MODEL_REFS.glm },
  { role: 'tester', displayName: '测试·小可', handle: 'tester', modelProfileRef: MODEL_REFS.glm },
]);

/**
 * Build a room with the standard team and real host sessions for every agent
 * member; the human member exists as a real member row but has no session.
 *
 * @param {object} stack
 * @param {object} [input]
 * @returns {Promise<{ room: object, members: object[], agents: object, human: object, warnings: string[] }>}
 */
export async function createStandardRoom(stack, input = {}) {
  const result = await stack.rooms.createRoom({
    title: input.title ?? '验证码登录',
    ownerRef: 'user_local',
    workspaceRef: input.workspaceRef ?? null,
    goal: input.goal ?? '实现手机验证码登录，并给出运行说明',
    members: input.members ?? STANDARD_TEAM.map((member) => ({ ...member })),
    createSession: (sessionInput) => stack.ensureMemberSession(sessionInput),
  });
  const members = result.members;
  const agents = Object.fromEntries(
    members.filter((member) => member.kind === 'agent').map((member) => [member.handle, member]),
  );
  const human = members.find((member) => member.kind === 'human');
  return { room: result.room, members, agents, human, warnings: result.warnings };
}

/**
 * The envelopes one member's agent was actually handed, oldest first.
 * @param {object} stack
 * @param {string} memberId
 * @returns {Array<{ mode: string, id: string, text: string, source: object }>}
 */
export function receivedByMember(stack, memberId) {
  const agent = stack.adapter.agentOf(memberId);
  if (!agent) return [];
  return stack.host.received(agent.id).map((entry) => ({
    mode: entry.mode,
    id: entry.message.id,
    text: entry.text,
    source: entry.message.source,
  }));
}

/** How many envelopes one member's agent was handed. */
export function deliveryCountOf(stack, memberId) {
  return receivedByMember(stack, memberId).length;
}
