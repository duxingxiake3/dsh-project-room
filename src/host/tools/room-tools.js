/**
 * Project Room — the room tool surface.
 *
 * These are the tools a project-room member (and the coordinator) actually calls
 * while working. Three invariants shape every definition here:
 *
 *   1. **The server binds the caller.** `roomId` is derived from the calling
 *      agent's session, never from an argument, and no tool accepts a sender id.
 *      A model cannot claim to be someone else, and cannot reach another room
 *      (the design notes, §18).
 *   2. **Arguments are plain JSON Schema.** The Host's registry enforces
 *      `parameters` and the declared output schema; the tool body additionally
 *      validates what JSON Schema cannot express (revisions, membership).
 *   3. **No tool lies about state.** Task status moves through the transition
 *      table, acceptance requires real evidence, and a failed write returns an
 *      error rather than a success message.
 *
 * @module dsh-project-room/src/host/tools/room-tools
 */

import { randomUUID } from 'node:crypto';

import { RoomError, TASK_STATUS_LABELS } from '../../../shared/contracts.js';
import { extractText } from '../delivery/turn-observer.js';
import { detectDependencyCycle } from '../room/loop-guard.js';

/**
 * Build every room tool definition.
 *
 * @param {object} services
 * @param {import('../room/room-service.js').RoomService} services.rooms
 * @param {import('../room/message-service.js').MessageService} services.messages
 * @param {import('../models/model-service.js').ModelProfileService} services.models
 * @param {import('../tasks/task-service.js').TaskService} services.tasks
 * @param {import('../tasks/planning-service.js').PlanningService} services.planning
 * @param {import('../decisions/decision-service.js').DecisionService} services.decisions
 * @param {import('../workspace/artifact-service.js').ArtifactService} services.artifacts
 * @param {(sessionId: string) => object | null} services.memberOfSession
 * @returns {object[]}
 */
export function buildRoomTools(services) {
  const { rooms, messages, models, tasks, planning, decisions, artifacts, memberOfSession } = services;

  /**
   * Resolve the calling member from the tool execution context.
   * @param {object} exec
   * @returns {object} member row
   */
  const callerOf = (exec) => {
    const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id ?? null;
    const member = sessionId ? memberOfSession(sessionId) : null;
    if (!member) {
      throw new RoomError(
        'NOT_A_ROOM_MEMBER',
        '这次调用不是来自项目群成员会话，已拒绝；请通过项目群界面或群内成员发起。',
        { sessionId },
      );
    }
    return member;
  };

  /** Require the caller to be the room's coordinator. */
  const coordinatorOf = (exec) => {
    const member = callerOf(exec);
    if (member.role !== 'coordinator') {
      throw new RoomError('FORBIDDEN', '该操作只有主代理可以执行；其他成员可以提出建议或直接联系负责人。', {
        memberId: member.id,
        role: member.role,
      });
    }
    return member;
  };

  return [
    /* -------------------------------------------------------------- *
     * Reading the room
     * -------------------------------------------------------------- */
    {
      name: 'room_members',
      description:
        '列出当前项目群的成员、角色、@ 名称、状态与当前任务。需要点名联系别人时先用这个工具确认准确写法。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(_args, exec) {
        const member = callerOf(exec);
        const room = rooms.requireRoom(member.roomId);
        const members = rooms.store.listMembers(member.roomId, { includeRetired: true });
        return {
          roomId: room.id,
          title: room.title,
          status: room.status,
          membershipRevision: room.membershipRevision,
          you: { memberId: member.id, handle: member.handle, displayName: member.displayName },
          members: members.map((entry) => ({
            memberId: entry.id,
            displayName: entry.displayName,
            handle: entry.handle,
            aliases: entry.aliases,
            role: entry.role,
            kind: entry.kind,
            status: entry.status,
            currentTask: entry.currentTaskId ? rooms.store.getTask(entry.currentTaskId)?.objective ?? null : null,
          })),
        };
      },
    },

    {
      name: 'room_read',
      description:
        '读取项目群记录。默认读取最近若干条；给出 afterSeq 可以按序号往后翻，给出 threadId 或 taskId 只读某个专题/任务相关消息。返回的来源序号可用于引用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          afterSeq: { type: 'integer', description: '只返回序号大于该值的消息。' },
          beforeSeq: { type: 'integer', description: '只返回序号小于该值的消息（用于往回读）。' },
          limit: { type: 'integer', description: '返回条数上限，默认 30。' },
          threadId: { type: 'string', description: '只读某个专题。' },
          taskId: { type: 'string', description: '只读某个任务相关消息。' },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        const room = rooms.requireRoom(member.roomId);
        const limit = clamp(args.limit ?? 30, 1, 200);
        const list =
          args.afterSeq !== undefined && args.afterSeq !== null
            ? rooms.store.listMessages(room.id, { afterSeq: args.afterSeq, limit, threadId: args.threadId, taskId: args.taskId })
            : rooms.store.listRecentMessages(room.id, { limit, threadId: args.threadId, taskId: args.taskId });
        const filtered =
          args.beforeSeq !== undefined && args.beforeSeq !== null ? list.filter((message) => message.seq < args.beforeSeq) : list;
        const membersById = new Map(rooms.store.listMembers(room.id, { includeRetired: true }).map((entry) => [entry.id, entry]));
        return {
          roomId: room.id,
          lastSeq: room.lastSeq,
          messages: filtered.map((message) => ({
            seq: message.seq,
            messageId: message.id,
            author: membersById.get(message.authorId)?.displayName ?? message.authorId,
            authorKind: message.authorKind,
            body: message.body,
            mentions: message.mentions.map((mention) => membersById.get(mention.targetMemberId)?.displayName ?? mention.targetMemberId),
            replyToSeq: message.replyTo ? rooms.store.getMessage(message.replyTo)?.seq ?? null : null,
            taskId: message.taskId,
            createdAt: message.createdAt,
          })),
        };
      },
    },

    /* -------------------------------------------------------------- *
     * Speaking
     * -------------------------------------------------------------- */
    {
      name: 'room_send',
      description:
        '在项目群发一条消息。可以在工作中主动联系任何成员（正文里写 @handle 即可，例如 @backend、@前端），也可以直接对用户说明情况。不填 recipientIds 时按正文中的 @ 解析。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          body: { type: 'string', description: '消息正文。使用 @handle 点名要联系的成员。' },
          recipientIds: {
            type: 'array',
            description: '结构化接收人（成员 id）。一般不需要填，留空则按正文 @ 解析。',
            items: { type: 'string' },
          },
          replyTo: { type: 'string', description: '要回复的群消息 id。' },
          threadId: { type: 'string', description: '把这条消息归入某个专题。' },
          taskId: { type: 'string', description: '关联的任务 id。' },
          clientMessageId: { type: 'string', description: '幂等键；重试时保持不变可避免重复发送。' },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        const body = String(args.body ?? '').trim();
        if (!body) throw new RoomError('INVALID_REQUEST', '消息正文不能为空。');
        const result = await messages.send({
          roomId: member.roomId,
          authorId: member.id,
          body,
          mentions: (args.recipientIds ?? []).map((memberId) => ({
            targetMemberId: memberId,
            origin: 'picker',
            displaySnapshot: '',
            span: null,
          })),
          replyTo: args.replyTo ?? null,
          threadId: args.threadId ?? null,
          taskId: args.taskId ?? null,
          clientMessageId: args.clientMessageId ?? `tool:${randomUUID()}`,
          purpose: null,
        });
        return {
          messageId: result.message.id,
          seq: result.message.seq,
          duplicate: result.duplicate,
          warnings: result.warnings,
          deliveries: result.targets.map((delivery) => ({
            recipientId: delivery.recipientId,
            status: delivery.status,
          })),
        };
      },
    },

    {
      name: 'room_discussion_open',
      description:
        '就一个问题发起专题协商（例如接口字段对齐），并通知相关成员。专题摘要会显示在群里，完整讨论留在专题内，避免多个问题混在一条时间线里。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string', description: '要解决的问题。' },
          participantIds: { type: 'array', description: '参与成员 id。', items: { type: 'string' } },
          taskId: { type: 'string', description: '相关任务 id。' },
          firstMessage: { type: 'string', description: '发起时的第一条说明。' },
        },
        required: ['topic'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        const discussion = rooms.store.insertDiscussion({
          id: `disc_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
          roomId: member.roomId,
          topic: args.topic,
          participants: [member.id, ...(args.participantIds ?? [])],
          status: 'open',
        });
        const sent = await messages.send({
          roomId: member.roomId,
          authorId: member.id,
          body: args.firstMessage ?? `【专题】${args.topic}`,
          mentions: (args.participantIds ?? []).map((memberId) => ({
            targetMemberId: memberId,
            origin: 'picker',
            displaySnapshot: '',
            span: null,
          })),
          threadId: discussion.id,
          taskId: args.taskId ?? null,
          clientMessageId: `discussion:${discussion.id}`,
          purpose: 'chat',
        });
        rooms.store.appendEvent({
          roomId: member.roomId,
          eventType: 'discussion.opened',
          payload: { discussionId: discussion.id, topic: args.topic, participants: discussion.participants },
        });
        return { discussionId: discussion.id, messageId: sent.message.id, participants: discussion.participants };
      },
    },

    /* -------------------------------------------------------------- *
     * Planning and assignment
     * -------------------------------------------------------------- */
    {
      name: 'room_plan_propose',
      description:
        '主代理提交结构化计划提议：目标、工作项、依赖与验收条件。提议先落盘再展示，任何成员都可以提出修订建议。提交前会校验依赖无环、每项有验收条件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceMessageId: { type: 'string', description: '用户给出目标的群消息 id。' },
          scope: { type: 'string', description: '这次计划的覆盖范围说明。' },
          assumptions: { type: 'array', description: '你认为成立但目前未验证的假设。', items: { type: 'string' } },
          tasks: {
            type: 'array',
            description: '工作项列表。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                localId: { type: 'string', description: '本计划内的临时标识，用于表达依赖。' },
                objective: { type: 'string' },
                requiredRole: { type: 'string', description: '建议角色，例如 frontend/backend/tester/devops。' },
                deliverables: { type: 'array', items: { type: 'string' } },
                acceptance: { type: 'array', description: '验收条件，至少一条。', items: { type: 'string' } },
                dependencies: { type: 'array', description: '依赖的其他工作项 localId。', items: { type: 'string' } },
                ownerId: { type: 'string', description: '指定负责人（可选）。' },
                requiredCapabilities: { type: 'array', items: { type: 'string' } },
              },
              required: ['localId', 'objective'],
            },
          },
        },
        required: ['tasks'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = coordinatorOf(exec);
        return planning.propose({
          roomId: member.roomId,
          authorId: member.id,
          sourceMessageId: args.sourceMessageId ?? null,
          scope: args.scope ?? '',
          assumptions: args.assumptions ?? [],
          tasks: args.tasks ?? [],
        });
      },
    },

    {
      name: 'room_plan_commit',
      description:
        '提交一份已校验的计划：写入任务与依赖，生成待派发记录。会按 expectedPlanRevision 检查版本，并保证同一次派发不会重复执行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          planId: { type: 'string' },
          expectedPlanRevision: { type: 'integer' },
          clientRequestId: { type: 'string', description: '幂等键；重试时保持不变。' },
        },
        required: ['planId'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = coordinatorOf(exec);
        return planning.commit({
          roomId: member.roomId,
          planId: args.planId,
          expectedPlanRevision: args.expectedPlanRevision,
          clientRequestId: args.clientRequestId ?? `commit:${args.planId}`,
          actorId: member.id,
        });
      },
    },

    {
      name: 'room_member_ensure',
      description:
        '按需创建或复用一位成员（例如缺少测试角色时）。同一 requestKey 只会创建一次；会用已配置的角色默认模型或允许池，并在创建后校验真实能力。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          role: { type: 'string', description: '角色：frontend/backend/tester/devops/designer/docs 或自定义。' },
          displayName: { type: 'string' },
          handle: { type: 'string', description: '英文 @ 名称，不填自动生成。' },
          modelProfileRef: { type: 'string', description: '指定模型（提供方/模型ID）。不填按项目与角色默认。' },
          requestKey: { type: 'string', description: '幂等键；同一次组队意图保持不变。' },
          reason: { type: 'string', description: '为什么需要这位成员，会记录到群里。' },
        },
        required: ['role'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = coordinatorOf(exec);
        return planning.ensureMember({
          roomId: member.roomId,
          role: args.role,
          displayName: args.displayName ?? null,
          handle: args.handle ?? null,
          modelProfileRef: args.modelProfileRef ?? null,
          requestKey: args.requestKey ?? `${member.roomId}|${args.role}|${args.displayName ?? ''}`,
          reason: args.reason ?? null,
          actorId: member.id,
        });
      },
    },

    {
      name: 'room_task_assign',
      description:
        '安排或转派任务负责人。先停止旧分配并核对副作用，再建立新的分配版本；旧尝试的结果不能被当成本次验收依据。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          memberId: { type: 'string' },
          expectedRevision: { type: 'integer' },
          assignmentRevision: { type: 'string', description: '分配版本，例如 a2。' },
          reason: { type: 'string' },
        },
        required: ['taskId', 'memberId'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        // A user-specified owner always wins; a non-coordinator may only take
        // work for themselves (the design notes).
        if (member.role !== 'coordinator' && args.memberId !== member.id) {
          throw new RoomError('FORBIDDEN', '只有主代理可以转派别人的任务；你可以直接向对方提出协作请求。');
        }
        return tasks.assign({
          roomId: member.roomId,
          taskId: args.taskId,
          memberId: args.memberId,
          expectedRevision: args.expectedRevision,
          assignmentRevision: args.assignmentRevision,
          actorId: member.id,
          reason: args.reason ?? null,
        });
      },
    },

    {
      name: 'room_task_propose',
      description:
        '提出一个新的工作项或澄清任务。会保存来源、负责人建议、依赖与验收条件；未满足依赖的任务不会进入执行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objective: { type: 'string' },
          suggestedOwnerId: { type: 'string' },
          requiredRole: { type: 'string' },
          dependencies: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'array', items: { type: 'string' } },
          deliverables: { type: 'array', items: { type: 'string' } },
          parentTaskId: { type: 'string' },
          sourceMessageId: { type: 'string' },
        },
        required: ['objective'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        return tasks.propose({
          roomId: member.roomId,
          actorId: member.id,
          objective: args.objective,
          suggestedOwnerId: args.suggestedOwnerId ?? null,
          requiredRole: args.requiredRole ?? null,
          dependencies: args.dependencies ?? [],
          acceptance: args.acceptance ?? [],
          deliverables: args.deliverables ?? [],
          parentTaskId: args.parentTaskId ?? null,
          sourceMessageId: args.sourceMessageId ?? null,
        });
      },
    },

    {
      name: 'room_task_update',
      description:
        '更新你负责的任务状态，或提交成果。状态转换会被校验；把任务转为 submitted 时必须给出真实证据引用（命令、日志、diff 或文件位置），口头说“测试通过”不会被接受。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          expectedRevision: { type: 'integer' },
          status: {
            type: 'string',
            enum: ['proposed', 'ready', 'in_progress', 'blocked', 'submitted', 'verifying', 'accepted', 'rework', 'superseded', 'failed', 'cancelled'],
          },
          note: { type: 'string', description: '这次变更的说明，会写入群记录。' },
          evidenceRefs: {
            type: 'array',
            description: '证据：命令与退出码、日志或文件位置、测试记录、commit/diff。',
            items: { type: 'string' },
          },
          blockers: { type: 'string', description: '受阻时缺少什么、需要谁提供。' },
          attemptId: { type: 'string', description: '本次执行尝试 id（提交成果时填写）。' },
        },
        required: ['taskId'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        return tasks.update({
          roomId: member.roomId,
          actorId: member.id,
          taskId: args.taskId,
          expectedRevision: args.expectedRevision,
          status: args.status ?? null,
          note: args.note ?? null,
          evidenceRefs: args.evidenceRefs ?? [],
          blockers: args.blockers ?? null,
          attemptId: args.attemptId ?? null,
        });
      },
    },

    /* -------------------------------------------------------------- *
     * Models, decisions, artifacts
     * -------------------------------------------------------------- */
    {
      name: 'room_model_list',
      description:
        '读取当前实际可用（或不可用）的模型配置及其能力状态。只能选择这里出现过的提供方/模型ID；口头品牌名不是模型标识。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requiredCapabilities: { type: 'array', description: '例如 ["text"]、["image"]。', items: { type: 'string' } },
          role: { type: 'string', description: '按角色默认配置筛选。' },
          refresh: { type: 'boolean', description: '重新向提供方读取目录。' },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        const profiles = await models.listProfiles({ refresh: args.refresh === true });
        const settings = models.settingsOf(member.roomId);
        return {
          selectionMode: settings.selectionMode,
          projectDefaultProfileRef: settings.projectDefaultProfileRef,
          roleDefaults: settings.roleDefaults,
          allowedProfileRefs: settings.allowedProfileRefs,
          profiles: profiles.map((profile) => ({
            profileRef: profile.id,
            providerRoute: profile.providerRoute,
            modelId: profile.modelId,
            label: profile.label,
            capabilityStatus: profile.capabilityStatus,
            capabilities: profile.capabilities,
            note: profile.note,
          })),
          observedRoutes: models.observedRoutes(),
        };
      },
    },

    {
      name: 'room_decision_propose',
      description:
        '提出一个需要同步的技术/需求决定，并列出受影响任务。人类明确要求可以直接形成已采纳决定；代理只能在已被授权的技术范围内采纳技术决定，不能覆盖人类要求。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceMessageId: { type: 'string', description: '决定来源的群消息 id。' },
          scope: { type: 'string', description: '适用范围，例如 auth、登录页。' },
          statement: { type: 'string', description: '约定内容。' },
          affectedTaskIds: { type: 'array', items: { type: 'string' } },
          accept: { type: 'boolean', description: '是否直接采纳（仅限你被授权的技术范围）。' },
          supersedes: { type: 'string', description: '被本决定取代的旧决定 id。' },
        },
        required: ['statement'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        return decisions.propose({
          roomId: member.roomId,
          actorId: member.id,
          sourceMessageId: args.sourceMessageId ?? null,
          scope: args.scope ?? '',
          statement: args.statement,
          affectedTaskIds: args.affectedTaskIds ?? [],
          accept: args.accept === true,
          supersedes: args.supersedes ?? null,
        });
      },
    },

    {
      name: 'room_artifact_publish',
      description:
        '把已有的真实产物登记到群：diff、文件、测试记录、commit 或说明。ArtifactService 会校验引用属于当前项目；未核验的产物会标记为未核验，不能作为验收依据。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          attemptId: { type: 'string' },
          kind: { type: 'string', enum: ['diff', 'file', 'test-run', 'note', 'commit'] },
          location: { type: 'string', description: '相对项目根的文件路径、commit、或命令记录位置。' },
          contentHash: { type: 'string' },
          evidenceRef: { type: 'string', description: '原始证据引用：命令与退出码、日志片段、外部记录。' },
          summary: { type: 'string', description: '这条产物的说明。' },
        },
        required: ['kind', 'location'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        return artifacts.publish({
          roomId: member.roomId,
          actorId: member.id,
          taskId: args.taskId ?? null,
          attemptId: args.attemptId ?? null,
          kind: args.kind,
          location: args.location,
          contentHash: args.contentHash ?? null,
          evidenceRef: args.evidenceRef ?? null,
          summary: args.summary ?? null,
          workspaceRef: rooms.requireRoom(member.roomId).workspaceRef,
        });
      },
    },

    {
      name: 'room_decision_ack',
      description:
        '回报你对某个决定的同步状态：已同步、需要澄清、已有结果需返工、或不受影响（并说明理由）。说一句“收到”不算已同步。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          decisionId: { type: 'string' },
          state: { type: 'string', enum: ['synced', 'needs_clarification', 'rework', 'unaffected', 'pending'] },
          appliedTaskRevision: { type: 'integer', description: '你完成适配后的任务版本。' },
          detail: { type: 'string' },
        },
        required: ['decisionId', 'state'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        return decisions.ack({
          roomId: member.roomId,
          actorId: member.id,
          decisionId: args.decisionId,
          state: args.state,
          appliedTaskRevision: args.appliedTaskRevision ?? null,
          detail: args.detail ?? null,
        });
      },
    },

    {
      name: 'room_task_verify',
      description:
        '按验收条件检查一个已提交任务。必须给出判定依据；产物版本与当前任务/决定版本不一致时返回“版本过期”，不能直接验收。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          attemptId: { type: 'string' },
          passed: { type: 'boolean' },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          failures: { type: 'array', description: '未通过的验收项。', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['taskId', 'passed'],
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
      },
      async execute(args, exec) {
        const member = callerOf(exec);
        return tasks.verify({
          roomId: member.roomId,
          actorId: member.id,
          taskId: args.taskId,
          attemptId: args.attemptId ?? null,
          passed: args.passed === true,
          evidenceRefs: args.evidenceRefs ?? [],
          failures: args.failures ?? [],
          note: args.note ?? null,
        });
      },
    },
  ];
}

/**
 * Check a proposed plan's dependencies before anything is written. Exported so
 * the planner and its tests share one implementation.
 * @param {Array<{ localId: string, dependencies?: string[] }>} proposed
 * @returns {{ acyclic: boolean, cycle: string[] | null, unknown: string[] }}
 */
export function validatePlanDependencies(proposed) {
  const ids = new Set(proposed.map((task) => task.localId));
  const unknown = [];
  for (const task of proposed) {
    for (const dependency of task.dependencies ?? []) {
      if (!ids.has(dependency)) unknown.push(`${task.localId} → ${dependency}`);
    }
  }
  const { acyclic, cycle } = detectDependencyCycle(
    proposed.map((task) => ({ id: task.localId, dependencies: (task.dependencies ?? []).filter((id) => ids.has(id)) })),
  );
  return { acyclic, cycle, unknown };
}

/**
 * List of task statuses a member may set directly through `room_task_update`.
 * `accepted` is deliberately absent: acceptance belongs to verification.
 */
export const MEMBER_SETTABLE_STATUSES = Object.freeze([
  'ready',
  'in_progress',
  'blocked',
  'submitted',
  'rework',
  'failed',
  'cancelled',
]);

/** Truncate-and-stringify helper shared by every tool renderer. */
function renderJson(value) {
  const text = JSON.stringify(value, null, 2);
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…（已截断）` : text;
}

/** Clamp a number into a range. */
function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

/**
 * Helper for tools that report a task back to the model in one compact block.
 * @param {object} task
 * @returns {string}
 */
export function describeTask(task) {
  return `#${task.id} ${task.objective}（r${task.revision}，${TASK_STATUS_LABELS[task.status] ?? task.status}）`;
}

/**
 * Extract the assistant text from a tool-visible result, used by tests.
 * @param {object} result
 * @returns {string}
 */
export function toolResultText(result) {
  return extractText(result?.content ?? []);
}
