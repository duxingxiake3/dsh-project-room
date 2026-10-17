/**
 * Project Room — the HTTP route the client half talks to.
 *
 * One exact route on the authenticated `/api` channel, registered through the
 * host's web-server service. It is a plain request/response JSON endpoint, not a
 * bespoke socket: the group timeline is a durable, sequenced record, so a
 * reconnecting page refills from storage by cursor rather than trusting a push it
 * may have missed.
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
 * The authenticated human a lifecycle mutation is attributed to. The route is
 * already on the authenticated channel; this resolver refuses when the project
 * has no active human or when it cannot tell which active human acted. An agent
 * has no route-level caller identity, so it can never satisfy this.
 * @param {import('../storage/store.js').RoomStore} store
 * @param {string} roomId
 * @returns {string}
 */
export function resolveLifecycleActor(store, roomId) {
  const humans = store.listMembers(roomId).filter((member) => member.kind === 'human');
  if (humans.length === 0) {
    throw new RoomError('FORBIDDEN', '当前项目没有活跃的可识别人类成员，生命周期操作仅限真实用户。');
  }
  if (humans.length > 1) {
    throw new RoomError('FORBIDDEN', '当前项目有多个活跃人类成员，无法验证具体操作人；生命周期操作已停用。', {
      humans: humans.map((member) => member.id),
    });
  }
  return humans[0].id;
}

/**
 * Register the route on the host web server.
 * @param {object} services
 * @returns {() => void} disposer
 */
export function registerRoomRoute(services) {
  const { ctx, store, rooms, messages, models, tasks, planning, decisions, artifacts, adapter, delivery, observer, guard, recovery, workspace, lifecycle, research, ensureMemberSession, memberOfSession, capabilities, logger } = services;
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
   * The authenticated human in this project. The route itself is already on the
   * authenticated `/api` channel; this resolver names the member row the action
   * is attributed to, and refuses when the project has no human identity.
   * @param {string} roomId
   * @returns {string}
   */
  function lifecycleActor(roomId) {
    return resolveLifecycleActor(store, roomId);
  }

  /** Human identity for research approval/stop; agents have no such route. */
  function researchHumanActor(roomId) {
    const humans = store.listMembers(roomId).filter((member) => member.kind === 'human');
    if (humans.length === 0) {
      throw new RoomError('FORBIDDEN', '当前项目没有可识别的人类成员，研究审批仅限真实用户。');
    }
    if (humans.length > 1) {
      throw new RoomError('FORBIDDEN', '当前项目有多个活跃人类成员，无法验证具体审批人；多人类审批已停用。', {
        humans: humans.map((member) => member.id),
      });
    }
    return humans[0].id;
  }

  /** @returns {import('../research/research-service.js').ResearchService} */
  function requireResearch() {
    if (!research) throw new RoomError('RESEARCH_DISABLED', '深度研究服务未装配。');
    return research;
  }

  /**
   * Validate the revision/idempotency envelope every lifecycle mutation needs.
   * A missing revision is refused rather than silently replaced with "latest",
   * because that is exactly how a double click becomes a second transition.
   * @param {string} action
   * @param {object} payload
   */
  function lifecycleInput(action, payload) {
    if (!Number.isInteger(payload.expectedLifecycleRevision) || payload.expectedLifecycleRevision < 0) {
      throw new RoomError('INVALID_REQUEST', `${action} 需要 expectedLifecycleRevision（非负整数）。`);
    }
    if (typeof payload.idempotencyKey !== 'string' || payload.idempotencyKey.trim().length === 0) {
      throw new RoomError('INVALID_REQUEST', `${action} 需要非空的 idempotencyKey，防止重复点击产生两次操作。`);
    }
    return {
      expectedLifecycleRevision: payload.expectedLifecycleRevision,
      idempotencyKey: payload.idempotencyKey,
      requestedBy: lifecycleActor(payload.roomId),
    };
  }

  /**
   * One switch over the logical operations. Kept flat and
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
        return {
          rooms: lifecycle.list().map((room) => ({
            ...room,
            members: store.listMembers(room.id, { includeRetired: true }).length,
          })),
        };
      }

      /* ------------------------------------------------------------ *
       * project lifecycle
       * ------------------------------------------------------------ */
      case 'room.project.list': {
        return { projects: lifecycle.list() };
      }

      case 'room.project.inspect': {
        return lifecycle.inspect(payload.roomId);
      }

      case 'room.project.cleanup.preview': {
        return lifecycle.preview(payload.roomId);
      }

      case 'room.project.pause': {
        return lifecycle.pause(payload.roomId, lifecycleInput('pause', payload));
      }

      case 'room.project.resume': {
        return lifecycle.resume(payload.roomId, lifecycleInput('resume', payload));
      }

      case 'room.project.archive': {
        return lifecycle.archive(payload.roomId, lifecycleInput('archive', payload));
      }

      case 'room.project.restore': {
        return lifecycle.restore(payload.roomId, lifecycleInput('restore', payload));
      }

      case 'room.project.trash': {
        return lifecycle.trash(payload.roomId, lifecycleInput('trash', payload));
      }

      case 'room.project.purge': {
        return lifecycle.purge(payload.roomId, {
          ...lifecycleInput('purge', payload),
          confirmTitle: typeof payload.confirmTitle === 'string' ? payload.confirmTitle : '',
          acknowledgeIrreversible: payload.acknowledgeIrreversible === true,
          operationScopeDigest: typeof payload.operationScopeDigest === 'string' ? payload.operationScopeDigest : null,
        });
      }

      case 'room.project.reconcile': {
        return lifecycle.reconcile(payload.roomId, lifecycleInput('reconcile', payload));
      }

      case 'room.project.cancel': {
        return lifecycle.cancel(payload.roomId, lifecycleInput('cancel', payload));
      }

      /* ------------------------------------------------------------ *
       * deep research deep research
       * ------------------------------------------------------------ */
      case 'room.research.list': {
        return { research: requireResearch().summary(payload.roomId) };
      }

      case 'room.research.get': {
        return { research: requireResearch().summary(payload.roomId) };
      }

      case 'room.research.propose': {
        const member = requireActor(payload);
        return requireResearch().propose({
          roomId: payload.roomId,
          actorId: member.id,
          sourceMessageId: payload.sourceMessageId ?? null,
          topic: payload.topic,
          objective: payload.objective,
          justification: payload.justification,
          hypotheses: payload.hypotheses ?? [],
          expectedArtifacts: payload.expectedArtifacts ?? [],
          participantPlan: payload.participantPlan ?? payload.participantIds ?? [],
          allowedPaths: payload.allowedPaths ?? [],
          excludedPaths: payload.excludedPaths ?? [],
          modelProfileRefs: payload.modelProfileRefs ?? [],
          budget: payload.budget ?? {},
          idempotencyKey: payload.idempotencyKey,
        });
      }

      case 'room.research.approve': {
        const humanId = researchHumanActor(payload.roomId);
        return requireResearch().approve({
          researchId: payload.researchId,
          expectedProposalRevision: payload.expectedProposalRevision,
          scopeDigest: payload.scopeDigest,
          approvedBy: humanId,
          idempotencyKey: payload.idempotencyKey,
          channelRef: 'authenticated-ui',
        });
      }

      case 'room.research.reject': {
        const humanId = researchHumanActor(payload.roomId);
        return requireResearch().reject({
          researchId: payload.researchId,
          expectedProposalRevision: payload.expectedProposalRevision,
          scopeDigest: payload.scopeDigest,
          approvedBy: humanId,
          idempotencyKey: payload.idempotencyKey,
          reason: payload.reason ?? null,
          channelRef: 'authenticated-ui',
        });
      }

      case 'room.research.cancel': {
        const humanId = researchHumanActor(payload.roomId);
        return requireResearch().cancel({
          researchId: payload.researchId,
          actorId: humanId,
          reason: payload.reason ?? null,
        });
      }

      case 'room.research.revise': {
        const member = requireActor(payload);
        return requireResearch().revise({
          researchId: payload.researchId,
          actorId: member.id,
          allowedPaths: payload.allowedPaths,
          excludedPaths: payload.excludedPaths,
          participantPlan: payload.participantPlan,
          modelProfileRefs: payload.modelProfileRefs,
          budget: payload.budget,
        });
      }

      case 'room.research.start': {
        return requireResearch().start({ researchId: payload.researchId });
      }

      case 'room.research.pause': {
        researchHumanActor(payload.roomId);
        return requireResearch().pause({ researchId: payload.researchId, reason: payload.reason ?? '用户暂停', actorId: researchHumanActor(payload.roomId) });
      }

      case 'room.research.resume': {
        researchHumanActor(payload.roomId);
        return requireResearch().resume({ researchId: payload.researchId });
      }

      case 'room.research.stop': {
        researchHumanActor(payload.roomId);
        return requireResearch().stop({ researchId: payload.researchId, reason: payload.reason ?? '用户停止', actorId: researchHumanActor(payload.roomId) });
      }

      case 'room.research.report': {
        return { research: requireResearch().summary(payload.roomId) };
      }

      case 'room.research.experience': {
        return { experience: requireResearch().listExperience(payload.roomId) };
      }

      case 'room.research.sessions': {
        return { sessions: requireResearch().listSessions(payload.roomId) };
      }

      case 'room.research.flowback': {
        const member = requireActor(payload);
        return requireResearch().flowBack({ researchId: payload.researchId, actorId: member.id });
      }

      case 'room.research.reconcile': {
        const humanId = researchHumanActor(payload.roomId);
        return requireResearch().reconcile({ researchId: payload.researchId, actorId: humanId });
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
          research: research ? research.summary(payload.roomId) : { enabled: false },
        };
      }

      case 'room.update': {
        if (payload.status !== undefined) {
          throw new RoomError('INVALID_REQUEST', '项目状态必须使用 room.project.* 生命周期操作；这些操作会记录版本、幂等键与审计日志。');
        }
        rooms.assertWritable(payload.roomId, '修改项目');
        const updated = store.updateRoom(payload.roomId, {
          ...(payload.title === undefined ? {} : { title: payload.title }),
          ...(payload.workspaceRef === undefined ? {} : { workspaceRef: payload.workspaceRef }),
          ...(payload.config === undefined ? {} : { config: { ...rooms.requireRoom(payload.roomId).config, ...payload.config } }),
        });
        return { room: updated };
      }

      case 'room.member.add': {
        rooms.assertWritable(payload.roomId, '添加成员');
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
        const target = store.getMember(payload.memberId);
        if (target) rooms.assertWritable(target.roomId, '修改成员');
        return { member: rooms.updateMember({ memberId: payload.memberId, patch: payload.patch ?? {}, expectedRevision: payload.expectedRevision }) };
      }

      case 'room.member.control': {
        const target = store.getMember(payload.memberId);
        if (target) rooms.assertWritable(target.roomId, '控制成员');
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
        const target = store.getMember(payload.memberId);
        if (target) rooms.assertWritable(target.roomId, '修改成员模型');
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

        // A user's explicit requirement change follows the full path
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
        rooms.assertWritable(payload.roomId, '修改项目模型');
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
        rooms.assertWritable(payload.roomId, '提出决定');
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
        rooms.assertWritable(payload.roomId, '回报决定同步');
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
        rooms.assertActive(payload.roomId, '准备执行工作区');
        return workspace.prepareWorktree({ roomId: payload.roomId, taskId: payload.taskId, attemptId: payload.attemptId, actorId: payload.actorId });
      }

      case 'room.workspace.integration': {
        rooms.assertActive(payload.roomId, '查看集成计划');
        return workspace.integrationPlan({ roomId: payload.roomId, taskId: payload.taskId, attemptId: payload.attemptId });
      }

      case 'room.recovery.inspect': {
        return recovery.inspect(payload.roomId);
      }

      case 'room.recovery.run': {
        rooms.assertWritable(payload.roomId, '运行恢复');
        return recovery.recoverRoom(payload.roomId);
      }

      case 'room.delivery.retry': {
        const message = store.getMessage(payload.messageId);
        if (!message) throw new RoomError('NOT_FOUND', `消息 ${payload.messageId} 不存在。`);
        rooms.assertActive(message.roomId, '重试投递');
        const author = store.getMember(message.authorId);
        const board = await delivery.schedule({ message, author, mode: 'queue' });
        return { results: board };
      }

      case 'room.discussion.list': {
        return { discussions: store.listDiscussions(payload.roomId) };
      }

      case 'room.loop.resume': {
        rooms.assertActive(payload.roomId, '恢复自动唤醒');
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
   * forged author would succeed.
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
