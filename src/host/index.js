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
import { execFileSync } from 'node:child_process';

import { RoomError, isoTimestamp } from '../shared/contracts.js';
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
import { PlanningService } from './tasks/planning-service.js';
import { TaskService } from './tasks/task-service.js';
import { buildRoomTools } from './tools/room-tools.js';
import { ArtifactService } from './workspace/artifact-service.js';
import { registerRoomRoute } from './api/route.js';
import { RecoveryService } from './recovery/recovery-service.js';
import { WorkspaceCoordinator } from './workspace/coordinator.js';

/** Cordis plugin name. */
export const name = 'project-room';

/**
 * Plugin configuration. Every key is optional: the defaults are the design's
 * proposed configuration, and a profile patch may override any of them.
 * @type {object}
 */
export const Config = {
  /** Where room databases live; defaults to `<DSH_HOME>/storages/project-room`. */
  dataDir: undefined,
  /** Default working directory for member sessions (usually the project workspace). */
  workspaceRoot: undefined,
  /** Tools a detail-only member must not receive. */
  restrictedToolDeny: ['bash', 'pwsh', 'write', 'edit', 'str_replace_editor'],
  /** Automatic wake-ups allowed per causal chain before the guard pauses it. */
  maxAutomaticRounds: 12,
  /** Whether the HTTP route is registered (tests disable it). */
  httpRoute: true,
  /** Whether member sessions are created on room creation. */
  autoCreateSessions: true,
};

/**
 * Cordis `apply`.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;
  const options = { ...Config, ...config };
  const disposers = [];

  /* ------------------------------------------------------------------ *
   * 1. Storage
   * ------------------------------------------------------------------ */
  const store = new RoomStore({ logger, ...(options.dataDir ? { file: `${options.dataDir}/rooms.sqlite` } : {}) });
  store.open();
  disposers.push(() => store.close());

  /* ------------------------------------------------------------------ *
   * 2. Host adapter
   * ------------------------------------------------------------------ */
  const adapter = new HostAdapter({ ctx, logger });
  const capabilities = adapter.capabilities();
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
  if (ctx.tools?.register) {
    for (const definition of tools) {
      disposers.push(ctx.tools.register(definition));
    }
    logger.info?.(`[project-room] registered ${tools.length} room tools`);
  } else {
    logger.warn?.('[project-room] no tool registry on this context; room tools are unavailable in this composition.');
  }

  if (options.httpRoute && ctx.webServer?.register) {
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
  }

  /* ------------------------------------------------------------------ *
   * 6. Recovery
   * ------------------------------------------------------------------ */
  if (options.autoResume !== false) {
    try {
      const report = await recovery.recoverAll();
      if (report.rooms.length > 0) logger.info?.(`[project-room] recovery: ${JSON.stringify(report.summary)}`);
    } catch (error) {
      logger.warn?.(`[project-room] recovery failed: ${error?.message ?? error}`);
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

  logger.info?.('[project-room] ready');
}

/**
 * Detail-only roles get coordination tools but no code-writing tools, so "this
 * member does not modify the repository" is enforced rather than requested.
 * @param {string} role
 * @returns {boolean}
 */
function shouldRestrictTools(role) {
  return role === 'designer' || role === 'docs';
}

/**
 * Whether `git` is available for worktree isolation. Reported, never assumed:
 * a non-git project falls back to serialized writes with a visible note
 * (the design notes).
 * @returns {string | null} the version string, or null when unavailable
 */
function probeGit() {
  try {
    return String(execFileSync('git', ['--version'], { encoding: 'utf8' })).trim();
  } catch {
    return null;
  }
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

/** Timestamp helper used by the route for cache-busting versions. */
export const pluginStartedAt = isoTimestamp();

/** Id for one plugin activation, used to make registrations idempotent. */
export const activationId = randomUUID();

export { createRelayMessage, RoomError };
