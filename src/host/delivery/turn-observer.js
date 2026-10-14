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

      if (event.type === 'user/message') {
        const parsed = parseRelayId(event.id);
        if (parsed && parsed.recipientId === member.id) {
          if (!state.consumed.includes(parsed.messageId)) state.consumed.push(parsed.messageId);
          this.delivery.observeClaimed({ memberId: member.id, hostMessageId: event.id });
          this.#markSeen(member.id, parsed.messageId);
        }
        return;
      }

      if (event.type === 'assistant/message') {
        // Keep only the newest assistant text of this turn; the durable event id
        // makes the publication idempotent across a reload.
        state.lastAssistant = { text: extractText(event.content), eventId: event.id };
        return;
      }

      if (event.type === 'turn/end') {
        state.turn = event.turn ?? state.turn;
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

    if (consumed.length === 0 || !assistant?.text?.trim()) return null;

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
