/**
 * Project Room — delivery coordinator.
 *
 * Delivery is a ledger, not a second queue (the design notes): the room database
 * says "this group message was saved", the host inbox says "this input was
 * admitted", and a `Delivery` row records what actually happened between them.
 *
 * The states are the product's honesty mechanism (§10.5). In particular:
 *
 *   - `accepted` means the host took the input. It does NOT mean the member read
 *     it, so the UI says "已送达，尚未确认取用".
 *   - `claimed` is written only from a real host observation — the agent-scoped
 *     `agent/inbox/claimed` event carrying that exact message identity.
 *   - `uncertain` is for the crash window where the host may have accepted an
 *     input the plugin never recorded. It stops automatic resending and offers a
 *     reconciliation entry instead of guessing.
 *
 * @module dsh-project-room/src/host/delivery/coordinator
 */

import { DELIVERY_LABELS, RoomError, isoTimestamp } from '../../../shared/contracts.js';
import { createRelayMessage } from '../adapter/host-adapter.js';

/** The mapping from a host reconciliation answer to a delivery state. */
export const RECONCILE_STATES = Object.freeze({
  pending: 'accepted',
  absent: 'failed',
  unknown: 'uncertain',
});

export class DeliveryCoordinator {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../adapter/host-adapter.js').HostAdapter} input.adapter
   * @param {import('../room/room-service.js').RoomService} input.rooms
   * @param {import('../room/context-builder.js').ContextBuilder} input.context
   * @param {import('../room/loop-guard.js').LoopGuard} input.guard
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.adapter = input.adapter;
    this.rooms = input.rooms;
    this.context = input.context;
    this.guard = input.guard;
    this.logger = input.logger ?? null;
    /** @type {Map<string, { queue: string[], active: number }>} per-member serialization */
    this.lanes = new Map();
    /** @type {Map<string, number>} automatic wakes spent per causal chain */
    this.rounds = new Map();
    /** @type {Set<string>} deliveries currently being admitted, to stop double admission */
    this.inFlight = new Set();
  }

  /* ---------------------------------------------------------------- *
   * Scheduling
   * ---------------------------------------------------------------- */

  /**
   * Hand one message's deliveries to their recipients.
   *
   * @param {object} input
   * @param {object} input.message
   * @param {object} input.author
   * @param {'queue' | 'steer'} input.mode
   * @param {string} [input.purpose]
   * @returns {Promise<Array<{ recipientId: string, recipientName: string, status: string, label: string, detail: string | null }>>}
   */
  async schedule(input) {
    const message = this.store.getMessage(input.message.id) ?? input.message;
    const room = this.rooms.requireRoom(message.roomId);
    const results = [];

    for (const delivery of message.deliveries) {
      const recipient = this.store.getMember(delivery.recipientId);
      if (!recipient) {
        this.store.upsertDelivery({
          ...delivery,
          status: 'discarded',
          detail: '接收人已不在成员表中。',
          updatedAt: isoTimestamp(),
        });
        results.push(this.#view(delivery.recipientId, delivery.recipientId, 'discarded', '接收人已不在成员表中。'));
        continue;
      }

      if (delivery.status === 'pending' && recipient.kind === 'human') {
        // Human recipients get a notification state, never a model call.
        const updated = this.store.upsertDelivery({
          ...delivery,
          status: 'accepted',
          actualMode: 'queue',
          detail: '用户通知，不产生模型调用。',
          updatedAt: isoTimestamp(),
        });
        this.rooms.publish(room.id, {
          type: 'delivery.updated',
          roomId: room.id,
          messageId: message.id,
          recipientId: recipient.id,
          status: updated.status,
        });
        results.push(this.#view(recipient.id, recipient.displayName, updated.status, null));
        continue;
      }

      if (delivery.status !== 'pending') {
        results.push(this.#view(recipient.id, recipient.displayName, delivery.status, delivery.detail));
        continue;
      }

      if (recipient.status === 'paused') {
        const updated = this.store.upsertDelivery({
          ...delivery,
          status: 'paused',
          detail: '该成员已暂停，消息保留为待处理。',
          updatedAt: isoTimestamp(),
        });
        results.push(this.#view(recipient.id, recipient.displayName, updated.status, updated.detail));
        continue;
      }

      if (room.status === 'paused') {
        const updated = this.store.upsertDelivery({
          ...delivery,
          status: 'paused',
          detail: '项目已暂停，聊天仍可查看并输入，但不会静默恢复执行。',
          updatedAt: isoTimestamp(),
        });
        results.push(this.#view(recipient.id, recipient.displayName, updated.status, updated.detail));
        continue;
      }

      // Automatic-wake guard: applies only to agent-to-agent wake-ups.
      const chainId = message.causalRootId || message.id;
      const gate = this.guard.check({
        roomId: room.id,
        causalRootId: chainId,
        authorId: message.authorId,
        authorKind: message.authorKind,
        recipientIds: [recipient.id],
        body: message.body,
      });
      if (!gate.allowed) {
        const updated = this.store.upsertDelivery({
          ...delivery,
          status: 'discarded',
          detail: gate.reason ?? '自动唤醒被暂停。',
          updatedAt: isoTimestamp(),
        });
        this.store.appendEvent({
          roomId: room.id,
          eventType: 'loop.paused',
          payload: { messageId: message.id, recipientId: recipient.id, reason: gate.reason },
        });
        results.push(this.#view(recipient.id, recipient.displayName, updated.status, updated.detail));
        continue;
      }

      results.push(await this.#admit({ message, room, delivery, recipient, mode: input.mode }));
    }

    return results;
  }

  /**
   * Run one delivery to completion, moving through admitting → accepted/failed.
   * @param {object} input
   * @returns {Promise<object>}
   */
  async #admit(input) {
    const { message, room, delivery, recipient, mode } = input;
    const key = `${message.id}|${recipient.id}`;
    if (this.inFlight.has(key)) {
      return this.#view(recipient.id, recipient.displayName, 'admitting', '正在交给目标会话。');
    }
    this.inFlight.add(key);
    const attempt = delivery.deliveryAttempt + 1;
    this.store.upsertDelivery({
      ...delivery,
      status: 'admitting',
      deliveryAttempt: attempt,
      updatedAt: isoTimestamp(),
    });

    try {
      const author = this.store.getMember(message.authorId);
      const envelope = this.context.composeEnvelope({ message, author, recipient, room });
      const hostMessage = createRelayMessage({
        text: envelope,
        roomId: room.id,
        messageId: message.id,
        authorId: message.authorId,
        authorName: author?.displayName ?? message.authorId,
        recipientId: recipient.id,
        stableDeliveryKey: `${room.id}|${message.id}|${recipient.id}|${attempt}`,
        form: 'relay',
      });

      // Preferred mode is `steer` only when the member is mid-turn AND the host
      // supports step boundaries; otherwise this is an ordinary next turn, and
      // the recorded actualMode says which one really happened.
      const requested = this.#modeFor(mode, recipient);
      const delivered = this.adapter.deliver({
        memberId: recipient.id,
        message: hostMessage,
        mode: requested,
      });

      const updated = this.store.upsertDelivery({
        ...delivery,
        status: 'accepted',
        requestedMode: requested,
        actualMode: delivered.actualMode,
        hostMessageId: delivered.hostMessageId,
        deliveryAttempt: attempt,
        detail:
          delivered.actualMode === 'steer'
            ? '已在运行中的步骤边界送达。'
            : requested === 'steer'
              ? '宿主未支持在运行中插入，已按下一轮投递。'
              : null,
        updatedAt: isoTimestamp(),
      });
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'delivery.accepted',
        payload: {
          messageId: message.id,
          recipientId: recipient.id,
          actualMode: delivered.actualMode,
          hostMessageId: delivered.hostMessageId,
        },
      });
      this.rooms.publish(room.id, {
        type: 'delivery.updated',
        roomId: room.id,
        messageId: message.id,
        recipientId: recipient.id,
        status: updated.status,
      });
      if (message.authorKind === 'agent') {
        this.guard.record({
          roomId: room.id,
          causalRootId: message.causalRootId || message.id,
          authorId: message.authorId,
          body: message.body,
        });
      }
      return this.#view(recipient.id, recipient.displayName, updated.status, updated.detail);
    } catch (error) {
      const code = error instanceof RoomError ? error.code : 'INTERNAL';
      const status = code === 'MEMBER_UNAVAILABLE' ? 'paused' : 'failed';
      const detail = String(error?.message ?? error);
      const updated = this.store.upsertDelivery({
        ...delivery,
        status,
        requestedMode: mode,
        deliveryAttempt: attempt,
        errorCode: code,
        detail,
        updatedAt: isoTimestamp(),
      });
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'delivery.failed',
        payload: { messageId: message.id, recipientId: recipient.id, code, detail },
      });
      this.rooms.publish(room.id, {
        type: 'delivery.updated',
        roomId: room.id,
        messageId: message.id,
        recipientId: recipient.id,
        status: updated.status,
      });
      return this.#view(recipient.id, recipient.displayName, updated.status, detail);
    } finally {
      this.inFlight.delete(key);
    }
  }

  #modeFor(mode, recipient) {
    if (mode === 'steer') return 'steer';
    const capabilities = this.adapter.capabilities();
    const status = this.adapter.statusOf(recipient.id);
    // A running member is the only case where a step boundary is meaningful.
    if (capabilities.steer && status === 'running') return 'steer';
    return 'queue';
  }

  #view(recipientId, recipientName, status, detail) {
    return {
      recipientId,
      recipientName,
      status,
      label: DELIVERY_LABELS[status] ?? status,
      detail: detail ?? null,
    };
  }

  /* ---------------------------------------------------------------- *
   * Host observations
   * ---------------------------------------------------------------- */

  /**
   * Observe that a host turn consumed a specific relay message, and move that
   * delivery to `claimed`.
   *
   * Called from an agent-scoped `agent/inbox/claimed` listener. The identity
   * matched is the host message id this coordinator created, so a wrong claim
   * cannot be recorded.
   *
   * @param {object} input
   * @param {string} input.memberId
   * @param {string} input.hostMessageId
   * @returns {object | null}
   */
  observeClaimed(input) {
    const parsed = parseRelayId(input.hostMessageId);
    if (!parsed) return null;
    const delivery = this.store.getDelivery(parsed.messageId, input.memberId);
    if (!delivery) return null;
    if (delivery.status === 'claimed' || delivery.status === 'replied') return delivery;
    const updated = this.store.upsertDelivery({
      ...delivery,
      status: 'claimed',
      updatedAt: isoTimestamp(),
    });
    const message = this.store.getMessage(parsed.messageId);
    if (message) {
      this.rooms.publish(message.roomId, {
        type: 'delivery.updated',
        roomId: message.roomId,
        messageId: message.id,
        recipientId: input.memberId,
        status: updated.status,
      });
    }
    return updated;
  }

  /**
   * Record that a member produced an answer to the input it consumed, so the
   * delivery reaches `replied` — which is evidence of a reply, never of
   * completion (the design notes).
   * @param {string} messageId
   * @param {string} memberId
   */
  observeReplied(messageId, memberId) {
    const delivery = this.store.getDelivery(messageId, memberId);
    if (!delivery) return;
    this.store.upsertDelivery({ ...delivery, status: 'replied', updatedAt: isoTimestamp() });
    const message = this.store.getMessage(messageId);
    if (message) {
      this.rooms.publish(message.roomId, {
        type: 'delivery.updated',
        roomId: message.roomId,
        messageId,
        recipientId: memberId,
        status: 'replied',
      });
    }
  }

  /**
   * Reconcile uncertain deliveries after a restart.
   *
   * The order matters (the design notes): ask the host, use the same identity to
   * restore admission when it is still queued, retry only when absence is proven,
   * and otherwise stay `uncertain` and stop auto-resending.
   *
   * @param {string} roomId
   * @returns {Promise<Array<{ messageId: string, recipientId: string, outcome: string, detail: string }>>}
   */
  async reconcileRoom(roomId) {
    const pending = this.store.listPendingDeliveries(roomId, ['uncertain', 'admitting', 'pending']);
    const outcomes = [];
    for (const delivery of pending) {
      const message = this.store.getMessage(delivery.messageId);
      if (!message) continue;
      const recipient = this.store.getMember(delivery.recipientId);

      if (!delivery.hostMessageId) {
        // The host never confirmed anything, so this is safe to (re)send.
        if (recipient && recipient.kind === 'agent') {
          const result = await this.#admit({ message, room: this.rooms.requireRoom(roomId), delivery, recipient, mode: 'queue' });
          outcomes.push({ messageId: delivery.messageId, recipientId: delivery.recipientId, outcome: result.status, detail: '未送达过，已重新投递。' });
        }
        continue;
      }

      const truth = this.adapter.reconcile({ memberId: delivery.recipientId, hostMessageId: delivery.hostMessageId });
      const status = RECONCILE_STATES[truth] ?? 'uncertain';
      if (status === 'failed') {
        this.store.upsertDelivery({ ...delivery, status: 'failed', detail: '核对确认宿主未收到该输入。', updatedAt: isoTimestamp() });
        outcomes.push({ messageId: delivery.messageId, recipientId: delivery.recipientId, outcome: 'failed', detail: '宿主未收到，可手动重投。' });
      } else if (status === 'accepted') {
        this.store.upsertDelivery({ ...delivery, status: 'accepted', detail: '重启核对：仍在目标会话待处理。', updatedAt: isoTimestamp() });
        outcomes.push({ messageId: delivery.messageId, recipientId: delivery.recipientId, outcome: 'accepted', detail: '仍在待处理队列。' });
      } else {
        this.store.upsertDelivery({
          ...delivery,
          status: 'uncertain',
          detail: '无法确认宿主是否已接受，已停止自动重发。',
          updatedAt: isoTimestamp(),
        });
        outcomes.push({ messageId: delivery.messageId, recipientId: delivery.recipientId, outcome: 'uncertain', detail: '需要人工核对。' });
      }
    }
    if (outcomes.length > 0) {
      this.store.appendEvent({ roomId, eventType: 'delivery.reconciled', payload: { outcomes } });
    }
    return outcomes;
  }

  /**
   * Mark every in-flight delivery as uncertain, for the shutdown path. Called
   * before the database closes so a crash between host acceptance and receipt
   * recording is recoverable rather than invisible.
   */
  markInFlightUncertain() {
    for (const key of this.inFlight) {
      const [messageId, recipientId] = key.split('|');
      const delivery = this.store.getDelivery(messageId, recipientId);
      if (!delivery) continue;
      this.store.upsertDelivery({
        ...delivery,
        status: 'uncertain',
        detail: '插件在投递过程中退出，需要核对宿主是否已接受。',
        updatedAt: isoTimestamp(),
      });
    }
  }

  /**
   * Deliveries the UI should show as "needs attention".
   * @param {string} roomId
   * @returns {object[]}
   */
  problems(roomId) {
    return this.store
      .listPendingDeliveries(roomId, ['failed', 'uncertain', 'paused'])
      .map((delivery) => ({
        ...delivery,
        label: DELIVERY_LABELS[delivery.status] ?? delivery.status,
        message: this.store.getMessage(delivery.messageId),
      }));
  }
}

/**
 * Recover the room message id and recipient from the host message identity this
 * coordinator created in {@link createRelayMessage}. Returns `null` for any
 * other message, so a foreign claim can never be mis-recorded.
 * @param {string} hostMessageId
 * @returns {{ roomId: string, messageId: string, recipientId: string } | null}
 */
export function parseRelayId(hostMessageId) {
  const parts = String(hostMessageId ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== 'project-room') return null;
  return { roomId: parts[1], messageId: parts[2], recipientId: parts[3] };
}
