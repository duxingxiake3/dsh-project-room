/**
 * Project Room — the one send path.
 *
 * Every authored message in the system enters here: the user's three `@` input
 * forms, an agent's `room_send` call, and an agent's automatic final reply. The
 * nine steps below are the protocol in code, and the ordering is the point:
 *
 *   1. establish the author from the authenticated caller (never from the body)
 *   2. validate room membership, room state and recipients
 *   3. merge structured mentions with the text parse
 *   4. decide whether this is chat, a reply, or a structured task operation
 *   5. write message + event + deliveries in ONE transaction
 *   6. publish to subscribers, then schedule delivery
 *   7. build a sourced envelope for each target
 *   8. record the host's acceptance
 *   9. update claimed/replied from real host observations
 *
 * Steps 8 and 9 live in {@link DeliveryCoordinator}; this file owns 1–7 and the
 * idempotency that makes a retried send one message, not two.
 *
 * @module dsh-project-room/src/host/room/message-service
 */

import { randomUUID } from 'node:crypto';

import { RoomError, TASK_STATUS_LABELS, isoTimestamp } from '../../../shared/contracts.js';
import { isCourtesy } from './loop-guard.js';

/** Message purposes, used to keep a question from becoming a code change. */
export const MESSAGE_PURPOSE = Object.freeze({
  chat: 'chat',
  question: 'question',
  taskChange: 'task-change',
  progress: 'progress',
  handoff: 'handoff',
  result: 'result',
  system: 'system',
});

export class MessageService {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('./room-service.js').RoomService} input.rooms
   * @param {import('./context-builder.js').ContextBuilder} input.context
   * @param {import('../adapter/host-adapter.js').HostAdapter} input.adapter
   * @param {import('../delivery/coordinator.js').DeliveryCoordinator} [input.delivery]
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.rooms = input.rooms;
    this.context = input.context;
    this.adapter = input.adapter;
    this.delivery = input.delivery ?? null;
    this.logger = input.logger ?? null;
  }

  /**
   * Send one authored message.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.authorId Server-derived author; never trusted from the body.
   * @param {string} [input.clientMessageId] Idempotency key; generated when absent.
   * @param {string} input.body
   * @param {import('../../../shared/contracts.js').Mention[]} [input.mentions]
   * @param {string | null} [input.replyTo]
   * @param {string | null} [input.threadId]
   * @param {string | null} [input.taskId]
   * @param {string | null} [input.causalRootId]
   * @param {string | null} [input.purpose]
   * @param {boolean} [input.asTaskChange]   User explicitly changing requirements.
   * @param {'queue' | 'steer'} [input.mode]
   * @param {number} [input.membershipRevision]
   * @param {boolean} [input.schedule]       Whether to hand deliveries to the coordinator now.
   * @returns {Promise<{ message: object, duplicate: boolean, targets: object[], warnings: string[] }>}
   */
  async send(input) {
    const room = this.rooms.requireRoom(input.roomId);
    const author = this.rooms.requireMember(input.authorId);
    if (author.roomId !== room.id) {
      throw new RoomError('NOT_A_ROOM_MEMBER', '作者与项目群不匹配，已拒绝写入。');
    }
    if (room.status === 'trashed') {
      throw new RoomError('ROOM_TRASHED', '项目在回收站中，聊天只读；恢复后才能发送新消息。');
    }
    if (room.status === 'quiescing' || room.status === 'purging') {
      throw new RoomError(room.status === 'purging' ? 'ROOM_PURGING' : 'ROOM_QUIESCING', '项目正在停止执行或永久删除，新的会话输入已被阻断。');
    }
    if (room.status === 'archived' && author.kind === 'agent') {
      throw new RoomError('ROOM_PAUSED', '项目已归档，代理不再接受新的自动执行。');
    }

    const clientMessageId = input.clientMessageId || randomUUID();
    const body = String(input.body ?? '');
    const existing = this.store.findMessageByClientKey(room.id, author.id, clientMessageId);
    if (existing) {
      const expected = hashOf({
        body,
        mentions: input.mentions ?? [],
        replyTo: input.replyTo ?? null,
        threadId: input.threadId ?? null,
        taskId: input.taskId ?? null,
      });
      // Same key, different payload: a conflict the caller must resolve rather
      // than a silent overwrite.
      if (!this.#samePayload(existing, expected)) {
        throw new RoomError('REVISION_CONFLICT', '同一个发送请求标识被用于不同内容，已拒绝重复写入。', {
          clientMessageId,
          messageId: existing.id,
        });
      }
      return { message: existing, duplicate: true, targets: existing.deliveries, warnings: [] };
    }

    // 3. Mentions: structured chips plus the deterministic text parse. Both the
    //    preview and this call use the same resolver, so what the user saw is
    //    what gets delivered ( rule 11).
    const merged = this.rooms.resolveMentions({
      roomId: room.id,
      body,
      mentions: input.mentions ?? [],
      membershipRevision: input.membershipRevision,
    });
    if (merged.ambiguous.length > 0) {
      throw new RoomError('MENTION_AMBIGUOUS', merged.ambiguous[0].reason, { ambiguous: merged.ambiguous });
    }

    const warnings = [];
    if (merged.unknownText.length > 0) {
      // Unresolved names are reported, never redirected to the coordinator.
      warnings.push(`以下点名无法识别，已作为普通文本保留：${merged.unknownText.join('、')}`);
    }

    const targets = this.#resolveRecipients({
      room,
      author,
      replyTo: input.replyTo ?? null,
      resolved: merged.targets,
      purpose: input.purpose ?? null,
      body,
    });

    const purpose = input.asTaskChange
      ? MESSAGE_PURPOSE.taskChange
      : input.purpose ?? classifyPurpose(body, targets);
    if (input.asTaskChange && !input.taskId) {
      throw new RoomError('INVALID_REQUEST', '把这条发言登记为需求变更时需要指明关联任务。');
    }

    const createdAt = isoTimestamp();
    const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const causalRootId = input.causalRootId || messageId;
    const payloadHash = hashOf({ body, mentions: input.mentions ?? [], replyTo: input.replyTo ?? null, threadId: input.threadId ?? null, taskId: input.taskId ?? null });

    // 5. One transaction: message, its seq-sharing event, and every delivery.
    const committed = this.store.transaction(() => {
      const { seq } = this.store.appendEvent({
        roomId: room.id,
        eventType: 'message.created',
        payload: { messageId, authorId: author.id, recipientIds: targets.map((target) => target.memberId) },
      });
      const message = this.store.insertMessage({
        id: messageId,
        roomId: room.id,
        seq,
        authorId: author.id,
        authorKind: author.kind,
        body,
        mentions: merged.targets,
        replyTo: input.replyTo ?? null,
        threadId: input.threadId ?? null,
        taskId: input.taskId ?? null,
        causalRootId,
        clientMessageId,
        payloadHash,
        createdAt,
      });
      /** @type {object[]} */
      const deliveries = [];
      for (const target of targets) {
        deliveries.push(
          this.store.upsertDelivery({
            messageId,
            recipientId: target.memberId,
            status: target.deliverable ? 'pending' : target.retained ?? 'discarded',
            requestedMode: target.mode,
            deliveryAttempt: 0,
            detail: target.deliverable ? null : target.reason,
          }),
        );
      }
      if (purpose === MESSAGE_PURPOSE.taskChange) {
        this.store.appendEvent({
          roomId: room.id,
          eventType: 'task.change.requested',
          payload: { messageId, taskId: input.taskId, authorId: author.id, body },
        });
      }
      return { message, deliveries };
    });

    // 6. Visible to the UI first; delivery is a separate, retryable step. A
    //    message that cannot be delivered is still a message.
    this.rooms.publish(room.id, {
      type: 'message.created',
      roomId: room.id,
      messageId,
      seq: committed.message.seq,
      authorId: author.id,
    });

    if (input.schedule !== false && this.delivery) {
      // The project's preferred delivery mode is `steer`: a member
      // that is mid-turn should receive the message at its nearest step boundary.
      // The coordinator still decides from the member's REAL state and the host's
      // real capabilities, and records which mode actually happened — a preference
      // must never be reported as a fact.
      const preferred = room.config?.delivery?.preferredMode === 'steer' ? 'steer' : 'queue';
      const scheduled = await this.delivery.schedule({
        message: this.store.getMessage(messageId),
        author,
        mode: input.mode ?? preferred,
        purpose,
      });
      for (const entry of scheduled) {
        if (entry.status === 'failed') warnings.push(`${entry.recipientName}：${entry.detail}`);
      }
    }

    return {
      message: this.store.getMessage(messageId),
      duplicate: false,
      targets: this.store.getMessage(messageId).deliveries,
      warnings,
    };
  }

  /**
   * Publish a member's final answer back into the room.
   *
   * This is what makes "the agent answered but the room never saw it" impossible.
   * It is deliberately the same path as an authored message, so
   * a final reply's own `@` mentions reach their targets too.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.memberId
   * @param {string} input.body
   * @param {string | null} [input.replyTo]
   * @param {string[]} [input.inputMessageIds]  Messages consumed by that turn.
   * @param {string | null} [input.turnBindingId] Stable id for de-duplication.
   * @param {string | null} [input.taskId]
   * @returns {Promise<object | null>}  `null` when the turn had nothing to publish.
   */
  async publishFinalReply(input) {
    const body = String(input.body ?? '').trim();
    if (!body) return null;
    const member = this.rooms.requireMember(input.memberId);
    const room = this.rooms.requireRoom(input.roomId);

    // Exactly one consumed message becomes this reply's `replyTo`; a multi-input
    // turn publishes as a public message so it cannot broadcast to every author
    // by accident.
    const consumed = (input.inputMessageIds ?? []).filter(Boolean);
    const replyTo = input.replyTo ?? (consumed.length === 1 ? consumed[0] : null);

    return this.send({
      roomId: room.id,
      authorId: member.id,
      clientMessageId: input.turnBindingId ? `turn:${input.turnBindingId}` : `final:${randomUUID()}`,
      body,
      mentions: [],
      replyTo,
      taskId: input.taskId ?? null,
      causalRootId: replyTo ?? `final:${member.id}`,
      purpose: MESSAGE_PURPOSE.progress,
      mode: 'queue',
    });
  }

  /**
   * 4. Decide who this actually reaches.
   *
   * Explicit mentions win. A reply to a message wakes its author (converted to a
   * concrete recipient) unless the reply already names someone. An unmentioned
   * user message defaults to the coordinator. An unmentioned agent message is a
   * public statement that wakes nobody — which is what stops "two agents say
   * thanks forever" from becoming an infinite loop.
   *
   * @param {object} input
   * @returns {Array<{ memberId: string, deliverable: boolean, reason: string | null, mode: 'queue' | 'steer' }>}
   */
  #resolveRecipients(input) {
    const { room, author, resolved, replyTo, body, purpose } = input;
    const members = new Map(this.store.listMembers(room.id, { includeRetired: true }).map((member) => [member.id, member]));
    /** @type {Map<string, { memberId: string, deliverable: boolean, reason: string | null, mode: 'queue' | 'steer' }>} */
    const out = new Map();

    const add = (memberId, reason, deliverable, retained = null) => {
      if (memberId === author.id) return; // @自己 is a note, never a self-wake
      const member = members.get(memberId);
      if (!member) return;
      const existing = out.get(memberId);
      if (existing) {
        existing.deliverable = existing.deliverable || deliverable;
        return;
      }
      out.set(memberId, { memberId, deliverable, reason, mode: 'queue', retained });
    };

    for (const mention of resolved) {
      const target = members.get(mention.targetMemberId);
      if (!target) {
        out.set(mention.targetMemberId, {
          memberId: mention.targetMemberId,
          deliverable: false,
          reason: '该成员已不在本群，消息保留为不可投递。',
          mode: 'queue',
          retained: 'discarded',
        });
        continue;
      }
      if (target.kind === 'human') {
        // A human recipient is a notification, never a model invocation. The
        // row starts as `pending` so the coordinator records the notification
        // state instead of claiming the host discarded it.
        add(target.id, '人类成员：仅通知，不产生模型调用。', false, 'pending');
        continue;
      }
      if (target.status === 'paused') {
        // `paused` is a state of its own: the message is kept, not cancelled,
        // and an explicit resume is what wakes the member again.
        add(target.id, '该成员已暂停，消息保留为待处理。', false, 'paused');
        continue;
      }
      if (target.status === 'offline') {
        out.set(target.id, { memberId: target.id, deliverable: false, reason: '该成员已退出或会话不可用。', mode: 'queue' });
        continue;
      }
      // A courtesy note ("谢谢") reaches the human it names but does not burn an
      // agent turn on a message that asks nothing.
      const pureCourtesy = isCourtesy(body) && (purpose === MESSAGE_PURPOSE.chat || purpose === null);
      add(target.id, pureCourtesy ? '社交消息：仅通知，不唤醒模型。' : null, !pureCourtesy);
    }

    if (out.size === 0 && replyTo) {
      const original = this.store.getMessage(replyTo);
      if (original && original.authorId !== author.id) {
        const originalAuthor = members.get(original.authorId);
        if (originalAuthor?.kind === 'agent' && originalAuthor.status === 'idle') {
          add(originalAuthor.id, '回复该消息的作者。', true);
        } else if (originalAuthor?.kind === 'human') {
          add(originalAuthor.id, '人类成员：仅通知。', false);
        }
      }
    }

    if (out.size === 0 && author.kind === 'human') {
      const coordinator = this.store
        .listMembers(room.id)
        .find((member) => member.role === 'coordinator' && member.status !== 'offline');
      if (coordinator) add(coordinator.id, '用户未点名，默认由主代理接收。', true);
    }

    if (out.size === 0 && purpose === MESSAGE_PURPOSE.taskChange && input.taskId) {
      const task = this.store.getTask(input.taskId);
      if (task?.ownerId) add(task.ownerId, '需求变更通知任务负责人。', true);
    }

    return [...out.values()].map((entry) => ({
      ...entry,
      mode: room.status === 'paused' ? 'queue' : entry.mode,
    }));
  }

  #samePayload(stored, expectedHash) {
    // `payload_hash` was written from the request itself (body, structured
    // mentions, replyTo, threadId, taskId), so a retry of the same request
    // compares equal — while `mentions` in the row holds the RESOLVED targets
    // and could not be compared with a raw request.
    return stored.payloadHash === expectedHash;
  }
}

/**
 * Stable hash of the fields that define a send request's identity.
 * @param {object} input
 * @returns {string}
 */
export function hashOf(input) {
  return JSON.stringify({
    body: input.body ?? '',
    mentions: (input.mentions ?? []).map((mention) => mention.targetMemberId ?? mention).sort(),
    replyTo: input.replyTo ?? null,
    threadId: input.threadId ?? null,
    taskId: input.taskId ?? null,
  });
}

/**
 * Classify an authored message. This is a deliberately small, explicit
 * classifier: the rules forbid turning a question into a code change, and the
 * only safe way to do that without a model is to require explicit structure for
 * the change case.
 * @param {string} body
 * @param {object[]} targets
 * @returns {string}
 */
export function classifyPurpose(body, targets) {
  const text = String(body ?? '');
  if (isCourtesy(text)) return MESSAGE_PURPOSE.chat;
  if (/(请|麻烦|帮我|把它|改成|改为|实现|新增|修复|补齐|更新)/.test(text)) return MESSAGE_PURPOSE.taskChange;
  if (/(为什么|怎么|如何|是否|吗？|\?|？)/.test(text)) return MESSAGE_PURPOSE.question;
  if (/(进度|怎么样了|还没|阻塞|卡在)/.test(text)) return MESSAGE_PURPOSE.progress;
  return targets.length > 0 ? MESSAGE_PURPOSE.chat : MESSAGE_PURPOSE.chat;
}

/**
 * Human label for a task status, re-exported here so callers formatting a
 * message do not need the contracts module.
 * @param {string} status
 * @returns {string}
 */
export function taskStatusLabel(status) {
  return TASK_STATUS_LABELS[status] ?? status;
}
