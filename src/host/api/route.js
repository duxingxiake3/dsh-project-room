/**
 * Project Room — the HTTP route the client half talks to.
 *
 * One exact route on the authenticated `/api` channel, registered through the
 * host's web-server service. It is a plain request/response JSON endpoint, not a
 * bespoke socket: the group timeline is a durable, sequenced record, so a
 * reconnecting page refills from storage by cursor rather than trusting a push it
 * may have missed (the design notes).
 *
 * Two boundaries are enforced here and nowhere else:
 *
 *   - **Identity.** The author of a message is never taken from the request body.
 *     The route resolves which member the browser is acting as, and rejects a
 *     claimed author that does not match. A forged `authorId` cannot write.
 *   - **Error shape.** Every failure leaves as `{ ok: false, error: { code,
 *     message } }` with a natural-Chinese message, so the UI never renders an
 *     internal stack or a raw English host error.
 *
 * @module dsh-project-room/src/host/api/route
 */

import { ROUTE } from '../../../shared/contracts.js';
import { RoomError, fail, ok } from '../../../shared/contracts.js';
import { ContextBuilder } from '../room/context-builder.js';
import { DEFAULT_ROOM_CONFIG } from '../room/room-service.js';

/** Requests larger than this are refused rather than buffered. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Register the route on the host web server.
 * @param {object} services
 * @returns {() => void} disposer
 */
export function registerRoomRoute(services) {
  const { ctx, store, rooms, messages, models, tasks, planning, decisions, artifacts, adapter, delivery, observer, guard, recovery, workspace, ensureMemberSession, memberOfSession, capabilities, logger } = services;
  // The route reads the same member view the timeline does, so the panel and the
  // wire cannot disagree about "unread" or "waiting for you".
  const context = services.context ?? new ContextBuilder({ store });

  const handler = async (request, response) => {
    const started = Date.now();
    let payload = {};
    try {
      payload = await readJson(request);
    } catch (error) {
      writeJson(response, 400, fail('INVALID_REQUEST', `请求体无法解析：${String(error?.message ?? error)}`));
      return;
    }

    const action = String(payload.action ?? '');
    try {
      // The wire carries a flat payload: the action plus its own fields. The
      // client half posts exactly this shape, so neither side translates.
      const result = await dispatch(action, payload);
      writeJson(response, 200, ok({ data: result, tookMs: Date.now() - started, action }));
    } catch (error) {
      const roomError = error instanceof RoomError ? error : null;
      const code = roomError?.code ?? 'INTERNAL';
      const message = roomError?.message ?? `操作失败：${String(error?.message ?? error)}`;
      if (!roomError) logger?.warn?.(`[project-room] ${action} failed: ${error?.stack ?? error}`);
      writeJson(response, code === 'INTERNAL' ? 500 : 400, fail(code, message, roomError?.details));
    }
  };

  /**
   * One switch over the logical operations of the design notes. Kept flat and
   * explicit so the wire surface is auditable in one screen.
   * @param {string} action
   * @param {object} payload
   */
  async function dispatch(action, payload) {
    switch (action) {
      /* ------------------------------------------------------------ *
       * Rooms and members
       * ------------------------------------------------------------ */
      case 'room.create': {
        const goal = typeof payload.goal === 'string' ? payload.goal : '';
        const result = await rooms.createRoom({
          title: payload.title || '未命名项目群',
          workspaceRef: payload.workspaceRef ?? null,
          ownerRef: payload.ownerRef ?? 'local-user',
          goal,
          members: Array.isArray(payload.members) ? payload.members : [{ role: 'coordinator' }],
          config: { ...(payload.config ?? {}), ...(goal ? { goal } : {}) },
          cwd: payload.cwd ?? payload.workspaceRef ?? null,
          createSession: (input) => ensureMemberSession(input),
        });
        // The goal becomes the coordinator's first real instruction, so planning
        // starts from a user requirement rather than from a standing prompt.
        if (goal) {
          const coordinator = result.members.find((member) => member.role === 'coordinator');
          const human = result.members.find((member) => member.kind === 'human');
          if (coordinator && human) {
            const sent = await messages.send({
              roomId: result.room.id,
              authorId: human.id,
              body: goal,
              mentions: [{ targetMemberId: coordinator.id, origin: 'picker', displaySnapshot: coordinator.displayName, span: null }],
              clientMessageId: `room-goal:${result.room.id}`,
              purpose: 'task-change',
            });
            if (!payload.asTaskChange) {
              // Planning mode "先规划" records the goal without dispatching.
              return { room: result.room, members: result.members, warnings: result.warnings, goalMessage: sent.message };
            }
          }
        }
        return { room: result.room, members: result.members, warnings: result.warnings };
      }

      case 'room.list': {
        return { rooms: store.listRooms().map((room) => ({ ...room, members: store.listMembers(room.id, { includeRetired: true }).length })) };
      }

      case 'room.get': {
        const snapshot = await rooms.snapshot({
          roomId: payload.roomId,
          afterSeq: payload.afterSeq ?? 0,
          limit: payload.limit ?? 200,
          threadId: payload.threadId ?? null,
          taskId: payload.taskId ?? null,
        });
        // Resolve each member's EFFECTIVE model through the precedence chain rather
        // than reading `modelProfileRef` directly. A member created without a pinned
        // model stores `null` there while really running on the role/project/host
        // default, so the raw column reports "未配置" for a member that is in fact
        // fully routed — exactly the kind of claim this plugin must not make.
        const resolved = await Promise.all(
          snapshot.members.map(async (member) => {
            if (member.kind !== 'agent') return { member, effective: null };
            const effective = await models.effectiveFor(member);
            return {
              member,
              effective: {
                ...effective,
                profile: effective.profile ?? (effective.profileRef ? store.getModelProfile(effective.profileRef) : null),
              },
            };
          }),
        );
        return {
          ...snapshot,
          members: resolved.map(({ member, effective }) => ({
            ...context.memberView(member),
            // What is actually in effect, and who chose it. `pinnedProfileRef` stays
            // the raw column so the panel can tell "you pinned this" from "inherited".
            pinnedProfileRef: member.modelProfileRef,
            effectiveModel: effective?.profile ?? null,
            selectionSource: effective ? effective.source : member.selectionSource,
          })),
          board: rooms.board(payload.roomId),
          models: (await models.listProfiles()).map((profile) => ({
            profileRef: profile.id,
            providerRoute: profile.providerRoute,
            modelId: profile.modelId,
            label: profile.label,
            capabilityStatus: profile.capabilityStatus,
            capabilities: profile.capabilities,
            note: profile.note,
          })),
          modelSettings: {
            ...models.settingsOf(payload.roomId),
            // The fallback tier the user has NOT chosen. Sent separately so the panel
            // can say "not set — currently using this Harness's default" instead of
            // presenting someone else's decision as the project's own.
            hostDefault: models.hostDefault(),
          },
          routes: models.observedRoutes(),
          capabilities,
          recovery: recovery.inspect(payload.roomId),
          loopIncidents: guard.listIncidents().filter((incident) => incident.roomId === payload.roomId),
          // Why a room-driven turn produced no visible reply. Without this the group
          // cannot tell "the model returned nothing" from "the plugin lost the
          // answer", and both look like silence.
          diagnostics: observer.diagnostics(payload.roomId),
          workspace: {
            isolation: workspace.isolationFor(payload.roomId),
            snapshot: workspace.snapshotPlan(payload.roomId),
          },
        };
      }

      case 'room.update': {
        return {
          room: store.updateRoom(payload.roomId, {
            ...(payload.title === undefined ? {} : { title: payload.title }),
            ...(payload.status === undefined ? {} : { status: payload.status }),
            ...(payload.workspaceRef === undefined ? {} : { workspaceRef: payload.workspaceRef }),
            ...(payload.config === undefined ? {} : { config: { ...rooms.requireRoom(payload.roomId).config, ...payload.config } }),
          }),
        };
      }

      case 'room.member.add': {
        const result = await rooms.ensureMember({
          roomId: payload.roomId,
          role: payload.role ?? 'custom',
          displayName: payload.displayName ?? null,
          handle: payload.handle ?? null,
          aliases: payload.aliases ?? [],
          modelProfileRef: payload.modelProfileRef ?? null,
          requestKey: payload.requestKey ?? null,
          cwd: payload.cwd ?? null,
          createSession: (input) => ensureMemberSession(input),
        });
        return result;
      }

      case 'room.member.update': {
        return { member: rooms.updateMember({ memberId: payload.memberId, patch: payload.patch ?? {}, expectedRevision: payload.expectedRevision }) };
      }

      case 'room.member.control': {
        const action_ = payload.control ?? payload.controlAction;
        if (action_ === 'pause') return { member: rooms.pauseMember(payload.memberId), state: 'paused' };
        if (action_ === 'resume') {
          const resumed = rooms.resumeMember(payload.memberId);
          await ensureMemberSession({ memberId: payload.memberId }).catch((error) => {
            logger?.warn?.(`[project-room] resume session failed: ${error?.message ?? error}`);
          });
          return { member: resumed, state: 'resumed' };
        }
        if (action_ === 'stop') {
          const requested = adapter.requestStop(payload.memberId);
          if (requested) return { member: store.getMember(payload.memberId), state: 'stopping' };
          return { member: rooms.pauseMember(payload.memberId), state: 'paused' };
        }
        if (action_ === 'retire') {
          const result = rooms.retireMember(payload.memberId);
          return { member: result.member, openTasks: result.openTasks, state: 'retired' };
        }
        throw new RoomError('INVALID_REQUEST', `未知的成员操作：${String(action_)}`);
      }

      case 'room.member.model.set': {
        const result = await models.setMemberModel({
          memberId: payload.memberId,
          profileRef: payload.profileRef,
          source: payload.source === 'allowed-pool' ? 'allowed-pool' : 'member-fixed',
          expectedConfigRevision: payload.expectedConfigRevision,
          reason: payload.reason ?? '用户在成员详情中选择',
        });
        store.appendEvent({
          roomId: result.member.roomId,
          eventType: 'member.model.changed',
          payload: {
            memberId: result.member.id,
            profileRef: payload.profileRef,
            state: result.state,
            configRevision: result.configRevision,
          },
        });
        rooms.publish(result.member.roomId, { type: 'member.updated', roomId: result.member.roomId, memberId: result.member.id });
        return result;
      }

      /* ------------------------------------------------------------ *
       * Messages and mentions
       * ------------------------------------------------------------ */
      case 'room.message.send': {
        const member = requireActor(payload);
        const result = await messages.send({
          roomId: payload.roomId,
          authorId: member.id,
          clientMessageId: payload.clientMessageId,
          body: payload.body ?? '',
          mentions: payload.mentions ?? [],
          replyTo: payload.replyTo ?? null,
          threadId: payload.threadId ?? null,
          taskId: payload.taskId ?? null,
          causalRootId: payload.causalRootId ?? null,
          purpose: payload.purpose ?? null,
          mode: payload.mode === 'steer' ? 'steer' : 'queue',
          membershipRevision: payload.membershipRevision,
        });

        // A user's explicit requirement change follows the full §13.3 path
        // instead of being only a chat line.
        let decision = null;
        if (payload.asTaskChange && payload.taskId) {
          decision = await decisions.recordHumanChange({
            roomId: payload.roomId,
            sourceMessageId: result.message.id,
            statement: payload.body,
            scope: payload.scope ?? '',
            affectedTaskIds: [payload.taskId],
            actorId: member.id,
          });
        }
        return { message: result.message, duplicate: result.duplicate, targets: result.targets, warnings: result.warnings, decision };
      }

      case 'room.mention.resolve': {
        return rooms.resolveMentions({
          roomId: payload.roomId,
          body: payload.body ?? '',
          mentions: payload.mentions ?? [],
          membershipRevision: payload.membershipRevision,
        });
      }

      case 'room.events.subscribe': {
        // Cursor-based refill: the caller passes the last seq it rendered.
        const snapshot = await rooms.snapshot({ roomId: payload.roomId, afterSeq: payload.afterSeq ?? 0, limit: payload.limit ?? 200 });
        return { messages: snapshot.messages, nextSeq: snapshot.nextSeq, lastSeq: snapshot.room.lastSeq };
      }

      /* ------------------------------------------------------------ *
       * Models
       * ------------------------------------------------------------ */
      case 'room.model.list': {
        const profiles = await models.listProfiles({ refresh: payload.refresh === true });
        return {
          profiles: profiles.map((profile) => ({
            profileRef: profile.id,
            providerRoute: profile.providerRoute,
            modelId: profile.modelId,
            label: profile.label,
            capabilityStatus: profile.capabilityStatus,
            capabilities: profile.capabilities,
            contextWindow: profile.contextWindow,
            note: profile.note,
          })),
          settings: payload.roomId ? models.settingsOf(payload.roomId) : null,
          roles: payload.roomId
            ? store.listMembers(payload.roomId).map((member) => ({ memberId: member.id, role: member.role, modelProfileRef: member.modelProfileRef, modelConfigRevision: member.modelConfigRevision, selectionSource: member.selectionSource, modelLocked: member.modelLocked }))
            : [],
          observedRoutes: models.observedRoutes(),
          revisions: payload.memberId ? store.listModelRevisions(payload.memberId) : [],
        };
      }

      case 'room.model.settings.set': {
        const room = rooms.requireRoom(payload.roomId);
        const next = { ...(room.config?.models ?? DEFAULT_ROOM_CONFIG.models), ...(payload.patch ?? {}) };
        if (next.selectionMode === 'allowed-pool' && (!Array.isArray(next.allowedProfileRefs) || next.allowedProfileRefs.length === 0)) {
          throw new RoomError('INVALID_REQUEST', '启用允许池自动选型必须设置非空允许池。');
        }
        for (const profileRef of next.allowedProfileRefs ?? []) {
          if (profileRef) await models.requireProfile(profileRef);
        }
        return { room: store.updateRoom(payload.roomId, { config: { ...room.config, models: next } }), settings: next };
      }

      /* ------------------------------------------------------------ *
       * Plans, tasks, decisions, artifacts
       * ------------------------------------------------------------ */
      case 'room.plan.propose': {
        const member = requireActor(payload);
        return planning.propose({
          roomId: payload.roomId,
          authorId: member.id,
          sourceMessageId: payload.sourceMessageId ?? null,
          scope: payload.scope ?? '',
          assumptions: payload.assumptions ?? [],
          tasks: payload.tasks ?? [],
        });
      }

      case 'room.plan.commit': {
        const member = requireActor(payload);
        return planning.commit({
          roomId: payload.roomId,
          planId: payload.planId,
          expectedPlanRevision: payload.expectedPlanRevision,
          clientRequestId: payload.clientRequestId,
          actorId: member.id,
          cwd: payload.cwd ?? null,
        });
      }

      case 'room.task.assign': {
        const member = requireActor(payload);
        return { task: tasks.assign({ roomId: payload.roomId, taskId: payload.taskId, memberId: payload.memberId, expectedRevision: payload.expectedRevision, assignmentRevision: payload.assignmentRevision, actorId: member.id, reason: payload.reason ?? null }) };
      }

      case 'room.task.update': {
        const member = requireActor(payload);
        return {
          task: tasks.update({
            roomId: payload.roomId,
            actorId: member.id,
            taskId: payload.taskId,
            expectedRevision: payload.expectedRevision,
            status: payload.status ?? null,
            note: payload.note ?? null,
            evidenceRefs: payload.evidenceRefs ?? [],
            blockers: payload.blockers ?? null,
            attemptId: payload.attemptId ?? null,
          }),
        };
      }

      case 'room.task.verify': {
        const member = requireActor(payload);
        return {
          task: await tasks.verify({
            roomId: payload.roomId,
            actorId: member.id,
            taskId: payload.taskId,
            attemptId: payload.attemptId ?? null,
            passed: payload.passed === true,
            evidenceRefs: payload.evidenceRefs ?? [],
            failures: payload.failures ?? [],
            note: payload.note ?? null,
          }),
        };
      }

      case 'room.task.propose': {
        const member = requireActor(payload);
        return { task: tasks.propose({ roomId: payload.roomId, actorId: member.id, objective: payload.objective, suggestedOwnerId: payload.suggestedOwnerId ?? null, requiredRole: payload.requiredRole ?? null, dependencies: payload.dependencies ?? [], acceptance: payload.acceptance ?? [], deliverables: payload.deliverables ?? [], sourceMessageId: payload.sourceMessageId ?? null }) };
      }

      case 'room.decision.accept': {
        const member = requireActor(payload);
        const decision = await decisions.propose({
          roomId: payload.roomId,
          actorId: member.id,
          sourceMessageId: payload.sourceMessageId ?? null,
          scope: payload.scope ?? '',
          statement: payload.statement,
          affectedTaskIds: payload.affectedTaskIds ?? [],
          accept: true,
          supersedes: payload.supersedes ?? null,
        });
        return { decision, board: decisions.board(payload.roomId) };
      }

      case 'room.decision.ack': {
        const member = requireActor(payload);
        return { ack: decisions.ack({ roomId: payload.roomId, actorId: member.id, decisionId: payload.decisionId, state: payload.state, appliedTaskRevision: payload.appliedTaskRevision ?? null, detail: payload.detail ?? null }) };
      }

      case 'room.artifact.publish': {
        const member = requireActor(payload);
        return {
          artifact: artifacts.publish({
            roomId: payload.roomId,
            actorId: member.id,
            taskId: payload.taskId ?? null,
            attemptId: payload.attemptId ?? null,
            kind: payload.kind,
            location: payload.location,
            contentHash: payload.contentHash ?? null,
            evidenceRef: payload.evidenceRef ?? null,
            summary: payload.summary ?? null,
          }),
        };
      }

      case 'room.artifact.reverify': {
        return { results: artifacts.reverify(payload.roomId) };
      }

      case 'room.result.card': {
        return { card: artifacts.resultCard(payload.taskId, payload.attemptId ?? null) };
      }

      /* ------------------------------------------------------------ *
       * Execution and recovery
       * ------------------------------------------------------------ */
      case 'room.workspace.prepare': {
        return workspace.prepareWorktree({ roomId: payload.roomId, taskId: payload.taskId, attemptId: payload.attemptId, actorId: payload.actorId });
      }

      case 'room.workspace.integration': {
        return workspace.integrationPlan({ roomId: payload.roomId, taskId: payload.taskId, attemptId: payload.attemptId });
      }

      case 'room.recovery.inspect': {
        return recovery.inspect(payload.roomId);
      }

      case 'room.recovery.run': {
        return recovery.recoverRoom(payload.roomId);
      }

      case 'room.delivery.retry': {
        const message = store.getMessage(payload.messageId);
        if (!message) throw new RoomError('NOT_FOUND', `消息 ${payload.messageId} 不存在。`);
        const author = store.getMember(message.authorId);
        const board = await delivery.schedule({ message, author, mode: 'queue' });
        return { results: board };
      }

      case 'room.discussion.list': {
        return { discussions: store.listDiscussions(payload.roomId) };
      }

      case 'room.loop.resume': {
        guard.resume(payload.roomId, payload.causalRootId);
        return { resumed: true };
      }

      /* ------------------------------------------------------------ *
       * Diagnostics
       * ------------------------------------------------------------ */
      case 'room.capabilities': {
        return { capabilities, route: ROUTE, rooms: store.listRooms().length };
      }

      case 'room.event.read': {
        return { events: readEvents(store, payload) };
      }

      case 'room.self': {
        const member = memberOfSession(payload.sessionId);
        return { member, isRoomMember: Boolean(member) };
      }

      default:
        throw new RoomError('INVALID_REQUEST', `未知操作：${action || '(空)'}`);
    }
  }

  /**
   * Resolve the acting member for a write operation.
   *
   * The client sends the member it believes it is acting as; the server checks
   * that the claim matches a real member of the room. A mismatch is refused
   * rather than silently rewritten, because "silently rewritten" is how a
   * forged author would succeed (the design notes).
   * @param {object} payload
   * @returns {object}
   */
  function requireActor(payload) {
    const claimed = payload.actorId ?? payload.authorId;
    if (!claimed) {
      throw new RoomError('INVALID_REQUEST', '缺少操作身份；请在客户端选择你在这个项目群中的身份。');
    }
    const member = store.getMember(claimed);
    if (!member) throw new RoomError('NOT_A_ROOM_MEMBER', '该身份不是任何项目群的成员。');
    if (payload.roomId && member.roomId !== payload.roomId) {
      throw new RoomError('NOT_A_ROOM_MEMBER', '该身份不属于这个项目群，已拒绝写入。');
    }
    if (member.kind === 'agent' && payload.assertHuman) {
      throw new RoomError('FORBIDDEN', '代理身份不能执行仅限用户的操作。');
    }
    return member;
  }

  /** Room events for the detailed work view. */
  function readEvents(store_, payload) {
    const events = [];
    const room = rooms.requireRoom(payload.roomId);
    const from = Math.max(1, Number(payload.afterSeq ?? 1));
    const to = Math.min(room.lastSeq, Number(payload.beforeSeq ?? room.lastSeq));
    for (const message of store.listMessages(payload.roomId, { afterSeq: from - 1, limit: Math.max(1, to - from + 1) })) {
      events.push({ seq: message.seq, eventType: 'message.created', createdAt: message.createdAt, payload: { messageId: message.id, authorId: message.authorId } });
    }
    return events;
  }

  return ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler,
  });
}

/**
 * Read and parse a JSON request body with a hard size limit.
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<object>}
 */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {object} body
 */
function writeJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(text);
}
