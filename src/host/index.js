/**
 * Project Room — plugin entry point (host half).
 *
 * One project becomes one persistent group chat: a coordinator agent plus
 * specialist members, each a real Harness session this plugin legally owns,
 * talking through one room service. This module composes the pieces and owns their
 * lifecycle; it contains no business rules of its own.
 *
 * Composition order matters and is deliberate:
 *
 *   1. storage first (everything else needs the ledger),
 *   2. the host adapter and its capability probe (so a gap is reported, not
 *      discovered later as a silent misbehaviour),
 *   3. the room services,
 *   4. host observation listeners (receipts and final replies),
 *   5. the tool surface and the HTTP route.
 *
 * Unload reverses it: stop admitting, detach observers, release only the members
 * this plugin owns, close the database. A borrowed user session is never
 * disposed, and a project unrelated to a project room is never touched
 * (the design notes).
 *
 * @module dsh-project-room
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTE, RoomError } from '../../shared/contracts.js';
import { createRelayMessage, HostAdapter } from './adapter/host-adapter.js';
import { DecisionService } from './decisions/decision-service.js';
import { DeliveryCoordinator } from './delivery/coordinator.js';
import { TurnObserver } from './delivery/turn-observer.js';
import { ModelProfileService } from './models/model-service.js';
import { ContextBuilder } from './room/context-builder.js';
import { LoopGuard } from './room/loop-guard.js';
import { MessageService } from './room/message-service.js';
import { RoomService } from './room/room-service.js';
import { RoomStore } from './storage/store.js';
import { dataRoot } from './storage/paths.js';
import { installErrorHooks, trace, traceError, writeReport } from './diagnostics.js';
import { PlanningService } from './tasks/planning-service.js';
import { TaskService } from './tasks/task-service.js';
import { buildRoomTools } from './tools/room-tools.js';
import { ArtifactService } from './workspace/artifact-service.js';
import { registerRoomRoute } from './api/route.js';
import { RecoveryService } from './recovery/recovery-service.js';
import { ReminderService } from './reminders/reminder-service.js';
import { shouldRestrictTools } from './roles.js';
import { WorkspaceCoordinator } from './workspace/coordinator.js';
import { gitVersion } from './workspace/git.js';

/** Cordis plugin name. */
export const name = 'project-room';

/**
 * Services this plugin requires before `apply` runs.
 *
 * Cordis proxies `ctx.<service>` and REFUSES to hand back a service the plugin
 * has not declared here — reading `ctx.tools` without `inject: ['tools']` throws
 * `cannot get property "tools" without inject` and aborts activation. Declaring
 * them is therefore what makes the plugin load at all, and it also makes the
 * fiber wait for them instead of racing a half-built composition.
 *
 * `llm` is included because per-member model routing and the honest model
 * catalogue are core product promises rather than optional extras; a composition
 * without it would have to refuse the plugin's main feature, so it is better to
 * not activate at all than to activate and lie. The adapter still reports what it
 * can actually do (`capabilities()`), and `agentDefaultModel` is deliberately NOT
 * required: it is only a fallback for "no project default configured".
 */
export const inject = ['tools', 'webServer', 'agents', 'llm', 'systemPrompt'];

/**
 * Plugin configuration.
 *
 * Every key is optional: the defaults below ARE the design's proposed
 * configuration, and a profile patch may override any of them.
 *
 * The object is shaped as a Standard Schema, because that is what the loader
 * reads (`runtime.Config['~standard'].validate(config)`). Declaring it this way
 * keeps the plugin installable with zero runtime dependencies — no
 * `@deepseek-ai/schemastery` import is needed, which is also why the plugin works
 * on both the 0.1.7 and 0.2.x desktop runtimes.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-project-room',
    /**
     * Normalize and validate plugin configuration.
     * @param {unknown} value
     * @returns {{ value: object } | { issues: Array<{ message: string, path?: string[] }> }}
     */
    validate(value) {
      if (value === undefined || value === null) return { value: { ...DEFAULT_CONFIG } };
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'projectRoom 配置必须是一个对象。', path: [] }] };
      }
      const issues = [];
      const merged = { ...DEFAULT_CONFIG, ...value };
      const stringOrUndefined = (key) => {
        if (merged[key] !== undefined && merged[key] !== null && typeof merged[key] !== 'string') {
          issues.push({ message: `${key} 必须是字符串。`, path: [key] });
        }
      };
      stringOrUndefined('dataDir');
      stringOrUndefined('workspaceRoot');
      stringOrUndefined('memberAgentPreset');
      if (typeof merged.maxAutomaticRounds !== 'number' || !Number.isFinite(merged.maxAutomaticRounds) || merged.maxAutomaticRounds <= 0) {
        issues.push({ message: 'maxAutomaticRounds 必须是正数；0 或负数会让所有自动协作被立即暂停。', path: ['maxAutomaticRounds'] });
      }
      for (const key of ['httpRoute', 'autoCreateSessions', 'autoResume', 'publishFinalReplies', 'reminders']) {
        if (merged[key] !== undefined && typeof merged[key] !== 'boolean') {
          issues.push({ message: `${key} 必须是 true 或 false。`, path: [key] });
        }
      }
      if (!Array.isArray(merged.restrictedToolDeny) || merged.restrictedToolDeny.some((name) => typeof name !== 'string')) {
        issues.push({ message: 'restrictedToolDeny 必须是字符串数组。', path: ['restrictedToolDeny'] });
      }
      return issues.length > 0 ? { issues } : { value: merged };
    },
  },
};

/** The effective defaults, applied through {@link Config}. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Where room databases live; defaults to `<DSH_HOME>/storages/project-room`. */
  dataDir: undefined,
  /** Default working directory for member sessions (usually the project workspace). */
  workspaceRoot: undefined,
  /** Tools a detail-only member must not receive; intersected with what exists. */
  restrictedToolDeny: ['bash', 'pwsh', 'shell', 'write', 'edit', 'str_replace_editor', 'apply_patch'],
  /** Automatic wake-ups allowed per causal chain before the guard pauses it. */
  maxAutomaticRounds: 12,
  /** Whether the HTTP route is registered (tests disable it). */
  httpRoute: true,
  /** Whether member sessions are created on room creation. */
  autoCreateSessions: true,
  /** Whether recovery runs on activation. */
  autoResume: true,
  /** Whether a room-driven turn's final answer is published back to the room. */
  publishFinalReplies: true,
  /** Whether due reminders are swept and invalidated (the design notes). */
  reminders: true,
  /**
   * Which agent preset member sessions are created under.
   *
   * Deliberately `undefined` by default, i.e. "inherit whatever this host composes".
   * Leaving it unset is the behaviour that has been measured: on this machine members
   * then receive the room collaboration tools only, with no file or shell tools.
   * Setting it is the documented lever for a deployment that wants members to be able
   * to write and run code (the design notes), but **no preset name is guessed here**: which
   * value grants those tools is a property of the host's preset catalogue, and
   * hard-coding a guess would silently change every member's tool surface.
   */
  memberAgentPreset: undefined,
});

/**
 * Cordis `apply`.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;
  // The trace is written before anything else so a crash later in this function
  // still leaves a record of how far activation got. See ./diagnostics.js.
  const disposeHooks = installErrorHooks(logger);
  trace('apply.enter', { pid: process.pid });
  // The loader already validated and defaulted the config through `Config`, but
  // `apply` is also called directly by tests and by the recovery path, so the
  // defaults are applied once more here. Spreading `Config` itself would copy the
  // schema marker, hence DEFAULT_CONFIG.
  const options = { ...DEFAULT_CONFIG, ...config };
  const disposers = [disposeHooks];

  // What configuration actually arrived. Recorded because the AT39 trial established
  // that member sessions need an agent preset to receive file and shell tools, and two
  // attempts to supply one — a profile `config:` block on this row, then the plugin's
  // own bundle patch — both left members holding the room tools only. Without this line
  // there is no way to tell "the value never arrived" from "the value arrived and was
  // ignored", and those two have opposite fixes.
  trace('config.received', {
    keys: Object.keys(config ?? {}),
    memberAgentPreset: options.memberAgentPreset ?? null,
    reminders: options.reminders !== false,
  });
  logger.info?.(
    options.memberAgentPreset === undefined
      ? '[project-room] memberAgentPreset is UNSET: member sessions mount no agent preset and will ' +
          'receive coordination tools only (no file or shell tools).'
      : `[project-room] member sessions will mount agent preset "${options.memberAgentPreset}"`,
  );

  /* ------------------------------------------------------------------ *
   * 1. Storage
   * ------------------------------------------------------------------ */
  const store = new RoomStore({ logger, ...(options.dataDir ? { file: `${options.dataDir}/rooms.sqlite` } : {}) });
  trace('storage.opening', { file: store.file, singleWriter: store.singleWriter });
  try {
    store.open();
  } catch (error) {
    traceError('storage.open', error);
    throw error;
  }
  trace('storage.opened', { schemaVersion: store.getMeta('schemaVersion'), rooms: store.listRooms().length });
  disposers.push(() => store.close());

  /* ------------------------------------------------------------------ *
   * 2. Host adapter
   * ------------------------------------------------------------------ */
  const adapter = new HostAdapter({
    ctx,
    logger,
    // Recovery resumes members through its own path and a session created before
    // this option existed records no preset, so the configured default has to live
    // on the adapter: otherwise a restart silently costs existing rooms their tools.
    agentPreset: options.memberAgentPreset,
    // Preset mounting happens during recovery, before any room panel exists to show
    // an error. The activation trace is where that outcome survives a restart.
    trace: (phase, detail) => trace(phase, detail),
    // Real token usage from the member's own stream (the design notes). Wrapped so a
    // storage failure can never break a model call that already succeeded.
    onUsage: (invocation) => {
      try {
        store.recordInvocation({
          // `invocationRef` exists only when a real `(turn, step)` pair was observed,
          // which is the one case where re-recording means a retry rather than a
          // different call. Without it the sequence number makes every observation
          // distinct — the alternative silently merged 104 observations into 4 rows.
          id: invocation.invocationRef
            ? `inv_${invocation.memberId}_t${invocation.turn}s${invocation.step}`
            : `inv_${invocation.memberId}_${invocation.sequence}`,
          roomId: invocation.roomId,
          memberId: invocation.memberId,
          sessionId: invocation.sessionId,
          hostRequestRef: `${invocation.providerRoute}/${invocation.modelId}`,
          modelConfigRevision: store.getMember(invocation.memberId)?.modelConfigRevision ?? 0,
          providerRoute: invocation.providerRoute,
          modelId: invocation.modelId,
          usage: invocation.usage,
        });
        trace('usage.recorded', {
          memberId: invocation.memberId,
          model: `${invocation.providerRoute}/${invocation.modelId}`,
          // Carried into the trace so an operator can tell a per-turn call from one
          // this host reported without turn coordinates, and conversational work from
          // the host's own bookkeeping calls.
          turn: invocation.turn,
          step: invocation.step,
          purpose: invocation.purpose,
          // `false` means the host did not name this member's session on the stream,
          // so the number cannot be split per member on evidence alone.
          attributed: invocation.attributed,
          usage: invocation.usage,
        });
      } catch (error) {
        traceError('usage.record', error);
      }
    },
  });
  const capabilities = adapter.capabilities();
  trace('capabilities.probed', {
    dshVersion: capabilities.dshVersion,
    coreResolvedFrom: capabilities.coreResolvedFrom,
    ownedSessions: capabilities.ownedSessions,
    perMemberModelRouting: capabilities.perMemberModelRouting,
    steer: capabilities.steer,
    modelCatalog: capabilities.modelCatalog,
    notes: capabilities.notes,
  });
  logger.info?.(
    `[project-room] host ${capabilities.dshVersion} · node ${capabilities.nodeVersion} · electron ${capabilities.electronVersion || 'n/a'} · ` +
      `owned sessions ${capabilities.ownedSessions ? 'yes' : 'NO'} · per-member routing ${capabilities.perMemberModelRouting ? 'yes' : 'NO'} · ` +
      `steer ${capabilities.steer ? 'yes' : 'NO'} · model catalogue ${capabilities.modelCatalog ? 'yes' : 'NO'}`,
  );
  for (const note of capabilities.notes) logger.warn?.(`[project-room] capability gap: ${note}`);
  disposers.push(() => adapter.dispose());

  /* ------------------------------------------------------------------ *
   * 3. Services
   * ------------------------------------------------------------------ */
  const rooms = new RoomService({ store, adapter, logger });
  const context = new ContextBuilder({ store });
  const guard = new LoopGuard({ maxAutomaticRounds: options.maxAutomaticRounds });
  const models = new ModelProfileService({ store, adapter, logger });
  const tasks = new TaskService({ store, rooms, guard, logger });
  const artifacts = new ArtifactService({ store, rooms, tasks, logger });
  const workspace = new WorkspaceCoordinator({ store, rooms, gitVersion: probeGit(), logger });
  const delivery = new DeliveryCoordinator({ store, adapter, rooms, context, guard, logger });
  const messages = new MessageService({ store, rooms, context, adapter, delivery, logger });
  tasks.messages = messages;
  artifacts.messages = messages;
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
  const observer = new TurnObserver({
    store,
    adapter,
    messages,
    delivery,
    enabled: () => options.publishFinalReplies !== false,
    logger,
  });
  const recovery = new RecoveryService({ store, rooms, adapter, delivery, observer, planning, decisions, models, logger });
  // Reminders are constructed before recovery so that a recovery pass which
  // re-blocks a task can be chased in the same activation, not one restart later.
  const reminders = new ReminderService({ store, rooms, messages, logger });

  /**
   * sessionId → memberId. The server-side identity map that makes every tool call
   * attributable to a real member without trusting anything the model sends.
   * @type {Map<string, string>}
   */
  const sessionIndex = new Map();
  /** @type {Map<string, Promise<{ sessionId: string }>>} */
  const sessionCreations = new Map();
  /** @param {string} sessionId */
  const memberOfSession = (sessionId) => {
    const memberId = sessionIndex.get(sessionId);
    return memberId ? store.getMember(memberId) : null;
  };

  // Rebuild the index from storage so membership survives a plugin reload while
  // the host sessions stay alive.
  for (const room of store.listRooms()) {
    for (const member of store.listMembers(room.id, { includeRetired: true })) {
      if (member.sessionId) sessionIndex.set(member.sessionId, member.id);
    }
  }

  /**
   * Create (or reuse) the host session for a member and attach observation.
   *
   * Guarded by an in-flight promise map: a member added by the coordinator and
   * observed by the room subscriber must produce exactly ONE host session, never
   * two (the design notes "成员创建恢复").
   * @param {object} input
   * @returns {Promise<{ sessionId: string }>}
   */
  async function ensureMemberSession(input) {
    const member = store.getMember(input.memberId);
    if (!member) throw new RoomError('NOT_FOUND', `成员 ${input.memberId} 不存在。`);
    if (member.sessionId && adapter.agentOf(member.id)) {
      return { sessionId: member.sessionId };
    }
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
      const cwd = input.cwd ?? options.workspaceRoot ?? store.getRoom(member.roomId)?.workspaceRef ?? process.cwd();
      const restrictTools = shouldRestrictTools(member.role);

      const reuse = Boolean(member.sessionId) && capabilities.persistence;
      const created = reuse
        ? await adapter.resumeMember({
            memberId: member.id,
            roomId: member.roomId,
            sessionId: member.sessionId,
            model,
            personaInstructions,
            restrictTools,
            cwd,
            // Only a fallback: the session header is the truth about what a resumed
            // session started under. This matters for members created before the
            // option existed — they have no preset recorded and would otherwise
            // resume just as tool-less as they were created.
            agentPreset: options.memberAgentPreset,
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
            restrictTools,
            // Unset means "inherit the host's composition", which is the measured
            // behaviour. Setting it is how a deployment opts into a preset whose tool
            // surface includes file and shell tools (see `memberAgentPreset`).
            agentPreset: options.memberAgentPreset,
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

  /* ------------------------------------------------------------------ *
   * 4. Host observation
   * ------------------------------------------------------------------ */
  observer.attachHost(ctx);
  disposers.push(() => observer.dispose());

  // Members added later (through the UI or by the coordinator) must get their
  // sessions created at the same moment their durable identity appears.
  const unsubscribe = rooms.subscribe((event) => {
    if (event.type !== 'member.ensured') return;
    void ensureMemberSession({ memberId: event.memberId }).catch((error) => {
      logger.warn?.(`[project-room] deferred session creation failed for ${event.memberId}: ${error?.message ?? error}`);
    });
  });
  disposers.push(unsubscribe);

  /* ------------------------------------------------------------------ *
   * 5. Tools and route
   * ------------------------------------------------------------------ */
  const tools = buildRoomTools({ rooms, messages, models, tasks, planning, decisions, artifacts, memberOfSession });
  trace('tools.built', { count: tools.length, names: tools.map((tool) => tool.name) });
  const toolNames = [];
  if (ctx.tools?.register) {
    trace('tools.registry', {
      hasRegister: typeof ctx.tools.register === 'function',
      hasSchemas: typeof ctx.tools.schemas === 'function',
    });
    for (const definition of tools) {
      // One malformed definition must not take the whole plugin down: the failure
      // is recorded, named, and the remaining tools still register. A plugin that
      // cannot load reports nothing at all, which is strictly worse.
      trace('tools.register.begin', { name: definition.name });
      try {
        disposers.push(ctx.tools.register(definition));
        toolNames.push(definition.name);
        trace('tools.register.ok', { name: definition.name });
      } catch (error) {
        traceError(`tools.register.${definition.name}`, error);
        logger.warn?.(`[project-room] tool "${definition.name}" failed to register: ${error?.message ?? error}`);
      }
    }
    trace('tools.registered', { registered: toolNames.length, total: tools.length });
    logger.info?.(`[project-room] registered ${toolNames.length}/${tools.length} room tools`);
  } else {
    logger.warn?.('[project-room] no tool registry on this context; room tools are unavailable in this composition.');
  }

  if (options.httpRoute && ctx.webServer?.register) {
    try {
      disposers.push(
        registerRoomRoute({
          ctx,
          store,
          rooms,
          context,
          messages,
          models,
          tasks,
          planning,
          decisions,
          artifacts,
          adapter,
          delivery,
          observer,
          guard,
          recovery,
          workspace,
          ensureMemberSession,
          memberOfSession,
          capabilities,
          logger,
        }),
      );
      trace('route.registered', { path: ROUTE });
    } catch (error) {
      traceError('route.register', error);
      logger.warn?.(`[project-room] HTTP route unavailable: ${error?.message ?? error}`);
    }
  }

  /* ------------------------------------------------------------------ *
   * 6. Recovery
   * ------------------------------------------------------------------ */
  if (options.autoResume !== false) {
    try {
      const recoveryReport = await recovery.recoverAll();
      trace('recovery.done', recoveryReport.summary);
      if (recoveryReport.rooms.length > 0) {
        logger.info?.(`[project-room] recovery: ${JSON.stringify(recoveryReport.summary)}`);
      }
    } catch (error) {
      traceError('recovery', error);
      logger.warn?.(`[project-room] recovery failed: ${error?.message ?? error}`);
    }
  }

  /* ------------------------------------------------------------------ *
   * 7. Reminders
   * ------------------------------------------------------------------ */
  // Started after recovery: recovery may settle tasks, and firing a reminder for
  // a task that recovery just finished would be exactly the noise §11.4 forbids.
  if (options.reminders !== false) {
    const stopReminders = reminders.start();
    disposers.push(stopReminders);
    trace('reminders.started', { intervalMs: reminders.intervalMs });
    try {
      const pass = await reminders.scan();
      trace('reminders.scan', pass);
      if (pass.fired > 0 || pass.expired > 0) {
        logger.info?.(`[project-room] reminders: fired ${pass.fired}, expired ${pass.expired}`);
      }
    } catch (error) {
      // A failed sweep must not stop the plugin: the next tick retries, and the
      // rooms remain fully usable without reminders.
      traceError('reminders.scan', error);
      logger.warn?.(`[project-room] reminder sweep failed: ${error?.message ?? error}`);
    }
  }

  ctx.effect(() => () => {
    // Reverse order, and never throw out of teardown.
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        const result = dispose();
        if (result && typeof result.then === 'function') result.catch(() => {});
      } catch (error) {
        logger.warn?.(`[project-room] teardown step failed: ${error?.message ?? error}`);
      }
    }
  });

  // One boot record: the exact runtime this activation resolved against, the
  // tools it registered, and the capabilities it probed. Written into the
  // plugin's own data directory so "which version is really running" is answered
  // by evidence instead of by reading a path and assuming. `writeReport` (in
  // ./diagnostics.js) also carries the phase trail, so a later crash can be read
  // back to the step it reached.
  writeReport({
    pluginVersion: pluginVersion(),
    dshVersion: capabilities.dshVersion,
    coreResolvedFrom: capabilities.coreResolvedFrom,
    nodeVersion: capabilities.nodeVersion,
    electronVersion: capabilities.electronVersion,
    capabilities,
    registeredTools: toolNames,
    // Named for what it measures. The old key was `availableTools`, which claimed to
    // describe the host while only ever describing this plugin's own scope.
    pluginScopedTools: pluginScopedToolNames(ctx),
    memberToolRestrictions: [...adapter.toolRestrictions.entries()].map(([memberId, deny]) => ({ memberId, deny })),
    rooms: store.listRooms().length,
    dataRoot: dataRoot(),
  });

  trace('activation.ready');
  logger.info?.(`[project-room] ready · core ${capabilities.dshVersion} (${capabilities.coreResolvedFrom ?? 'unresolved'})`);
}

/** This package's own version, read from its manifest. */
function pluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));
    return manifest.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The tool names registered in THIS plugin's own scope, for the restriction check.
 * Read defensively: a composition without a tool registry simply reports none.
 *
 * Scope matters and was previously mislabelled. `ctx.tools.schemas()` answers for the
 * calling context only, so on the desktop profile it returned the 15 room tools and
 * nothing else — `write`, `edit` and `pwsh` were absent even though the host supplies
 * them. Reported as `availableTools`, that read as "this host has no file tools", and
 * a room member treated it as evidence of its own incapacity. It is a useful number
 * for auditing which room tools mounted; it is not an inventory of the host.
 * @param {object} ctx
 * @returns {string[]}
 */
function pluginScopedToolNames(ctx) {
  try {
    return (ctx.tools?.schemas?.() ?? []).map((schema) => schema.name);
  } catch {
    return [];
  }
}

/**
 * Whether `git` is available for worktree isolation. Reported, never assumed:
 * a non-git project falls back to serialized writes with a visible note
 * (the design notes).
 * @returns {string | null} the version string, or null when unavailable
 */
function probeGit() {
  return gitVersion();
}

/**
 * Adopt the current session as a room's human member.
 *
 * The plugin deliberately does not claim ownership of a user session (design
 * §8.2). What it can do truthfully is record the binding so the UI can offer
 * "open my session", and refuse when the host cannot support it.
 *
 * @param {object} input
 * @param {import('../storage/store.js').RoomStore} input.store
 * @param {import('./adapter/host-adapter.js').HostAdapter} input.adapter
 * @param {string} input.roomId
 * @param {string} input.memberId
 * @param {string} input.sessionId
 * @returns {object}
 */
export function bindHumanSession(input) {
  const member = input.store.getMember(input.memberId);
  if (!member) throw new RoomError('NOT_FOUND', `成员 ${input.memberId} 不存在。`);
  if (member.kind !== 'human') throw new RoomError('INVALID_REQUEST', '只有人类成员可以绑定用户会话。');
  const capabilities = input.adapter.capabilities();
  if (!capabilities.borrowedMainBinding) {
    throw new RoomError(
      'HOST_CAPABILITY_MISSING',
      '当前宿主不支持合法绑定用户主会话；可以改为新建一个主代理成员并关联旧会话摘要。',
      { sessionId: input.sessionId },
    );
  }
  return input.store.updateMember(input.memberId, { sessionId: input.sessionId, sessionOwnership: 'borrowed' });
}

/** Id for one plugin activation, used to make registrations idempotent. */
export const activationId = randomUUID();

export { createRelayMessage, RoomError, trace, traceError, writeReport };
