/**
 * Project Room — turn observer.
 *
 * Connects a member's real execution to the room, in both directions that the
 * design requires:
 *
 *   - **Receipts.** An agent-scoped `agent/inbox/claimed` event proves that a
 *     specific relay message entered a turn, so its delivery may move from
 *     "已送达" to "对方本轮已取用". Nothing here infers "read" from a status.
 *   - **Final replies (`publishFinalReplies`).** A turn that was driven by a room
 *     message publishes its final assistant text back into the room, so the user
 *     can never be in the position of "the agent answered but the group never
 *     saw it" (the design notes).
 *
 * Two deliberate restrictions keep the automatic path from being noisy:
 *
 *   1. A turn must have consumed a room message to be eligible. An unrelated
 *      turn in a borrowed user session is never published (AT29).
 *   2. Only the LAST assistant message of the turn is published, and only after
 *      the turn closes — a draft is not a statement, and a streamed half-name
 *      must not wake anyone (§4.2).
 *
 * @module dsh-project-room/src/host/delivery/turn-observer
 */

import { isoTimestamp } from '../../../shared/contracts.js';
import { parseRelayId } from './coordinator.js';

export class TurnObserver {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../adapter/host-adapter.js').HostAdapter} input.adapter
   * @param {import('../room/message-service.js').MessageService} input.messages
   * @param {import('./coordinator.js').DeliveryCoordinator} input.delivery
   * @param {() => boolean} [input.enabled]
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.adapter = input.adapter;
    this.messages = input.messages;
    this.delivery = input.delivery;
    this.enabled = input.enabled ?? (() => true);
    this.logger = input.logger ?? null;
    /**
     * Per-member turn state.
     * @type {Map<string, { consumed: string[], lastAssistant: string | null, turn: number | null, publishing: boolean }>}
     */
    this.turns = new Map();
    /** @type {Array<() => void>} */
    this.disposers = [];
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  /**
   * Attach to one member's agent.
   *
   * Everything is registered through `agent.ctx`, so disposal of that agent
   * removes these listeners with it — reloading the plugin twice cannot produce
   * double replies (the design notes).
   *
   * @param {object} input
   * @param {string} input.memberId
   * @param {string} input.roomId
   * @param {object} input.agent
   */
  attachMember(input) {
    const { memberId, agent } = input;
    const state = this.#state(memberId);

    // Receipt: this exact relay message entered a turn.
    const onClaimed = (payload) => {
      const hostMessageId = payload?.message?.id;
      const parsed = parseRelayId(hostMessageId);
      if (!parsed) return;
      if (!state.consumed.includes(parsed.messageId)) state.consumed.push(parsed.messageId);
      state.turn = payload?.turn ?? state.turn;
      this.delivery.observeClaimed({ memberId, hostMessageId });
      this.#markSeen(memberId, parsed.messageId);
    };
    agent.ctx.on('agent/inbox/claimed', onClaimed);

    // A claim already happened before we attached (resume path): read the
    // pending identity list from the live inbox so a restored session still
    // reports accurately.
    try {
      for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
        const parsed = parseRelayId(message.id);
        if (parsed) this.delivery.observeClaimed({ memberId, hostMessageId: message.id });
      }
    } catch (error) {
      this.logger?.warn?.(`[project-room] inbox probe failed for ${memberId}: ${error?.message ?? error}`);
    }

    // Turn closure: publish the final answer, once.
    const onStatus = (payload) => {
      if (payload?.status === 'idle') void this.flush(memberId).catch((error) => {
        this.logger?.warn?.(`[project-room] final reply publish failed for ${memberId}: ${error?.message ?? error}`);
      });
    };
    agent.ctx.on('agent/status', onStatus);

    this.disposers.push(() => {
      try {
        agent.ctx.off('agent/inbox/claimed', onClaimed);
        agent.ctx.off('agent/status', onStatus);
      } catch {
        /* the agent scope may already be unwound */
      }
    });
  }

  /**
   * Attach to the plugin context to observe durable session events.
   *
   * `session/event` is the only place a specific input can be proven to have
   * entered a turn, and the only place the assistant's final text can be read
   * without depending on a live stream.
   *
   * @param {object} ctx   Plugin context.
   */
  attachHost(ctx) {
    const members = () => new Map(this.store.listRooms().flatMap((room) => this.store.listMembers(room.id, { includeRetired: true })).map((member) => [member.sessionId, member]));

    const listener = (session, event) => {
      const member = members().get(session?.id);
      if (!member || member.kind !== 'agent') return;
      const state = this.#state(member.id);
      // The listener receives the log envelope `{ type, seq, time, data }`; every
      // field below lives in `data`. Reading the top level silently produced nothing.
      const payload = unwrapSessionEvent(event);

      if (event.type === 'user/message') {
        const hostMessageId = payload.id ?? event.id;
        const parsed = parseRelayId(hostMessageId);
        if (parsed && parsed.recipientId === member.id) {
          if (!state.consumed.includes(parsed.messageId)) state.consumed.push(parsed.messageId);
          this.delivery.observeClaimed({ memberId: member.id, hostMessageId });
          this.#markSeen(member.id, parsed.messageId);
        }
        return;
      }

      if (event.type === 'assistant/message') {
        // Keep only the newest assistant text of this turn; the durable event id
        // makes the publication idempotent across a reload. When no block list can be
        // found at all, the raw shape is recorded instead of an empty reply: "the
        // agent said nothing" and "we failed to read what it said" must never be the
        // same observation.
        const envelope = readAssistantEnvelope(event);
        state.lastAssistant = {
          text: extractText(envelope.content),
          eventId: envelope.id,
          blockTypes: [...new Set(envelope.content.map((block) => block?.type ?? '(none)'))],
          shape: envelope.content.length === 0 ? describeEventShape(event) : null,
        };
        return;
      }

      if (event.type === 'turn/end') {
        state.turn = payload.turn ?? state.turn;
        // A room-driven turn that closes badly must leave a durable mark. Otherwise
        // "the agent never answered" and "the plugin lost the answer" are
        // indistinguishable from the group, which is the failure mode this whole
        // observer exists to prevent.
        const reason = payload.reason?.kind ?? 'unknown';
        if (reason !== 'completed' && state.consumed.length > 0) {
          this.store.appendEvent({
            roomId: member.roomId,
            eventType: 'member.turn.ended',
            payload: {
              memberId: member.id,
              turn: payload.turn ?? null,
              reason,
              failure: payload.reason?.failure?.message ?? null,
              consumed: [...state.consumed],
            },
          });
        }
        void this.flush(member.id).catch((error) => {
          this.logger?.warn?.(`[project-room] final reply publish failed for ${member.id}: ${error?.message ?? error}`);
        });
      }
    };

    ctx.on('session/event', listener);
    this.disposers.push(() => {
      try {
        ctx.off('session/event', listener);
      } catch {
        /* the plugin fiber may already be unwound */
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Publication
   * ---------------------------------------------------------------- */

  /**
   * Publish the turn's final answer back into the room, if the turn was driven
   * by room messages.
   * @param {string} memberId
   * @returns {Promise<object | null>}
   */
  async flush(memberId) {
    const state = this.#state(memberId);
    if (state.publishing) return null;
    const member = this.store.getMember(memberId);
    if (!member || !this.enabled()) return null;

    const consumed = [...state.consumed];
    const assistant = state.lastAssistant;
    state.consumed = [];
    state.lastAssistant = null;

    if (consumed.length === 0 || !assistant?.text?.trim()) {
      // Record WHY nothing was published, on the occasions where something was
      // expected. Without this the plugin is indistinguishable from broken: a turn
      // that ran and produced only tool calls looks exactly like a turn whose reply
      // was lost, and neither leaves a trace. The two reasons are different facts and
      // are named differently (the design notes, §10.3).
      if (consumed.length > 0) {
        this.store.appendEvent({
          roomId: member.roomId,
          eventType: 'member.final-reply.skipped',
          payload: {
            memberId,
            consumed,
            reason: assistant?.text?.trim() ? 'no-assistant-message' : 'assistant-message-had-no-text',
            // The block kinds the model actually produced. Without them, "the agent
            // said nothing" cannot be told apart from "the plugin failed to read what
            // it said" — and that ambiguity already cost hours once.
            blockTypes: assistant?.blockTypes ?? [],
            // Present only when the block list came back empty: the raw event shape,
            // so a version difference in the durable format is visible instead of
            // looking like an agent that chose to say nothing.
            eventShape: assistant?.shape ?? null,
            note: assistant
              ? `这一轮的助手消息只有这些块：${(assistant.blockTypes ?? []).join(', ') || '(空)'}；没有可直接发布的正文。`
              : '这一轮没有产生任何助手消息（可能只做了工具调用，或请求失败）。',
          },
        });
      }
      return null;
    }

    state.publishing = true;
    try {
      const result = await this.messages.publishFinalReply({
        roomId: member.roomId,
        memberId,
        body: assistant.text,
        inputMessageIds: consumed,
        turnBindingId: `${memberId}:${assistant.eventId}`,
      });
      for (const messageId of consumed) this.delivery.observeReplied(messageId, memberId);
      if (result) {
        this.store.appendEvent({
          roomId: member.roomId,
          eventType: 'member.final-reply.published',
          payload: { memberId, messageId: result.message.id, consumed, sourceEvent: assistant.eventId },
        });
      }
      return result;
    } finally {
      state.publishing = false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  #state(memberId) {
    let state = this.turns.get(memberId);
    if (!state) {
      state = { consumed: [], lastAssistant: null, turn: null, publishing: false };
      this.turns.set(memberId, state);
    }
    return state;
  }

  #markSeen(memberId, messageId) {
    const message = this.store.getMessage(messageId);
    if (!message) return;
    const member = this.store.getMember(memberId);
    if (!member || message.seq <= member.lastSeenSeq) return;
    this.store.updateMember(memberId, { lastSeenSeq: message.seq });
  }

  /**
   * Why the room-driven turns of this room produced nothing visible, newest first.
   *
   * Read by the panel so "the agent is silent" always has a stated reason attached
   * rather than being left for the user to guess at.
   *
   * @param {string} roomId
   * @param {number} [limit]
   * @returns {Array<{ seq: number, eventType: string, payload: object, createdAt: string }>}
   */
  diagnostics(roomId, limit = 20) {
    const wanted = new Set(['member.final-reply.skipped', 'member.turn.ended', 'member.final-reply.published', 'delivery.failed', 'delivery.reconciled', 'loop.paused']);
    try {
      return this.store.listRoomEvents
        ? this.store.listRoomEvents(roomId, { limit, eventTypes: [...wanted] }).reverse()
        : [];
    } catch (error) {
      this.logger?.warn?.(`[project-room] diagnostics unavailable for ${roomId}: ${error?.message ?? error}`);
      return [];
    }
  }

  /**
   * Release every listener this observer registered. Called on plugin unload so
   * no callback outlives the fiber that owns it (the design notes).
   */
  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* best-effort */
      }
    }
    this.turns.clear();
  }
}

/**
 * Unwrap a durable session event.
 *
 * A `session/event` listener receives the LOG ENVELOPE, not the bare payload:
 *
 *   { type, seq, time, data: { …payload… }, surfaceOp? }
 *
 * so `assistant/message` puts the message at `event.data.message`, and `turn/end`
 * puts `turn`/`reason` at `event.data.turn` / `event.data.reason`. Reading the
 * top level yields `undefined` for every field — which is exactly how every member's
 * answer was discarded while the plugin reported nothing wrong. Recorded from a real
 * activation (`eventShape` on `member.final-reply.skipped`).
 *
 * The bare payload is accepted too, so one shape change cannot bring the failure back.
 *
 * @param {object} event
 * @returns {object} the payload
 */
export function unwrapSessionEvent(event) {
  if (event && typeof event === 'object' && event.data && typeof event.data === 'object' && typeof event.type === 'string') {
    return event.data;
  }
  return event ?? {};
}

/**
 * Describe an event's shape for diagnosis: the top-level keys, and the key names of
 * anything that looks like it might hold the message.
 *
 * Bounded and free of content: this lands in the room's own event log, and a
 * diagnostic must never leak a prompt or an answer.
 *
 * @param {object} event
 * @returns {object}
 */
function describeEventShape(event) {
  const keys = Object.keys(event ?? {}).slice(0, 20);
  const shape = { keys };
  for (const key of ['data', 'message', 'payload']) {
    const value = event?.[key];
    if (value && typeof value === 'object') {
      shape[key] = { keys: Object.keys(value).slice(0, 20), contentType: Array.isArray(value.content) ? 'array' : typeof value.content };
    }
  }
  return shape;
}

/**
 * Read the assistant message out of a durable `assistant/message` event.
 *
 * Accepts the envelope (`event.data.message`), a bare payload (`event.message`), or
 * a message-shaped event (`event.content`). Tolerating all three costs two property
 * checks and removes an entire class of "the reply vanished" bug.
 *
 * @param {object} event
 * @returns {{ id: string | undefined, content: Array<{ type: string, text?: string }> }}
 */
export function readAssistantEnvelope(event) {
  const payload = unwrapSessionEvent(event);
  const message = payload.message ?? payload;
  return {
    id: message?.id ?? payload.id ?? event?.id,
    content: Array.isArray(message?.content) ? message.content : [],
  };
}

/**
 * Extract plain text from a durable content-block array.
 *
 * Reasoning blocks and tool calls are deliberately excluded: they are internal
 * work, not a statement to the group (§4.2: tool activity and natural speech are
 * presented separately).
 *
 * @param {Array<{ type: string, text?: string }>} content
 * @returns {string}
 */
export function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * A turn binding record, kept for the detailed work view. Not persisted by
 * default; the durable `member.final-reply.published` event carries the same
 * correlation.
 * @param {object} input
 * @returns {object}
 */
export function turnBinding(input) {
  return {
    memberId: input.memberId,
    sessionId: input.sessionId,
    consumed: input.consumed ?? [],
    publishedMessageId: input.publishedMessageId ?? null,
    at: isoTimestamp(),
  };
}
