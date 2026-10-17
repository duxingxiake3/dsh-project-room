/**
 * Project Room — reminder expiry.
 *
 * Reminders are *bound* to a task and a deadline, stored
 * durably, deduplicated, and — this is the part that is easy to skip — **invalidated
 * when the reason for them has gone away**. A reminder that fires after the task
 * was finished, cancelled, or handed to a member who has since exited is not a
 * nudge; it is noise that teaches everyone to ignore the room.
 *
 * So a scan is a two-outcome pass, not a mail merge:
 *
 *   - the reminder still matters → post it once, and record that it fired;
 *   - the reminder's premise is gone → retire it silently, recording *why*.
 *
 * Four rules make the pass safe to run on a timer:
 *
 *   1. `store.settleReminder` transitions only a `pending` row, and the state is
 *      claimed **before** the message is composed. Two ticks, or two processes
 *      over the same file, cannot both fire one reminder.
 *   2. The message carries a deterministic `clientMessageId` derived from the
 *      reminder id, so even a crash between "settled" and "sent" cannot produce a
 *      second copy on retry — it produces a duplicate *send*, which the message
 *      service collapses.
 *   3. A reminder never mentions anyone, so it can never wake an agent and start a
 *      new causal chain. "提醒消息本身不自动触发提醒的提醒" falls out of
 *      that rather than needing a special case.
 *   4. A failure to send leaves the reminder settled, not pending. Re-firing on
 *      every tick forever is worse than one lost nudge, and the failure is
 *      reported where an operator can see it.
 *
 * @module dsh-project-room/src/host/reminders/reminder-service
 */

import { TASK_STATUS_LABELS } from '../../../shared/contracts.js';

/**
 * Task states that make a reminder pointless: the work is closed one way or
 * another, so there is nothing left to chase. `blocked` is deliberately absent —
 * a blocked task is exactly the case a reminder exists for.
 */
const SETTLED_TASK_STATES = new Set(['accepted', 'superseded', 'cancelled', 'failed']);

/** How often a scan runs. A blocked task's deadline is 30 minutes out, so this is ample. */
export const DEFAULT_SCAN_INTERVAL_MS = 60_000;

export class ReminderService {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('../room/room-service.js').RoomService} input.rooms
   * @param {import('../room/message-service.js').MessageService} [input.messages]
   * @param {object} [input.logger]
   * @param {number} [input.intervalMs]
   * @param {() => number} [input.now] injectable clock, so tests do not sleep
   */
  constructor(input) {
    this.store = input.store;
    this.rooms = input.rooms;
    this.messages = input.messages ?? null;
    this.logger = input.logger ?? null;
    this.intervalMs = input.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.now = input.now ?? (() => Date.now());
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** Guards against a slow scan overlapping the next tick. */
    this.running = false;
  }

  /**
   * Start the periodic scan.
   *
   * The timer is `unref`ed: a pending reminder must never be the reason a host
   * process refuses to exit.
   * @returns {() => void} stop function
   */
  start() {
    if (this.timer) return () => this.stop();
    this.timer = setInterval(() => {
      void this.scan().catch((error) => {
        this.logger?.warn?.(`[project-room] reminder scan failed: ${error?.message ?? error}`);
      });
    }, this.intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  /** @returns {void} */
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every due reminder.
   *
   * @param {{ now?: number }} [options]
   * @returns {Promise<{ examined: number, fired: number, expired: number, failed: number, details: object[] }>}
   */
  async scan(options = {}) {
    const report = { examined: 0, fired: 0, expired: 0, failed: 0, details: [] };
    if (this.running) return report;
    this.running = true;
    try {
      const at = new Date(options.now ?? this.now()).toISOString();
      for (const reminder of this.store.dueReminders(at)) {
        report.examined += 1;

        // Decide before claiming. `settleReminder` only transitions a `pending`
        // row — that guard is what makes two ticks (or two processes over the same
        // file) unable to both act on one reminder. Using it twice for the same
        // reminder would silently do nothing the second time, so the outcome has to
        // be known up front and written once.
        const verdict = this.#verdict(reminder);
        if (verdict.outcome === 'expired') {
          if (!this.store.settleReminder(reminder.id, 'expired', verdict.reason)) continue;
          report.expired += 1;
          report.details.push({ reminderId: reminder.id, roomId: reminder.roomId, outcome: 'expired', reason: verdict.reason });
          continue;
        }

        // Claim first, then compose: whoever wins this update owns the reminder.
        if (!this.store.settleReminder(reminder.id, 'fired')) continue;
        const outcome = await this.#post(reminder, verdict);
        report.details.push(outcome);
        if (outcome.outcome === 'fired') report.fired += 1;
        else report.failed += 1;
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  /**
   * Whether a due reminder still has a reason to exist, decided without writing
   * anything.
   *
   * Split from the posting step so the state written to the row is the state that
   * was actually reached. "Claim as fired, then discover the task is finished" left
   * the second write with nothing to update, and the row kept a `fired` state for a
   * reminder that was never posted.
   *
   * @param {object} reminder
   * @returns {{ outcome: 'fire', room: object, target: object, task: object | null, authorId: string }
   *   | { outcome: 'expired', reason: string }}
   */
  #verdict(reminder) {
    const room = this.store.getRoom(reminder.roomId);
    if (!room) return { outcome: 'expired', reason: 'room-missing' };
    if (room.status === 'archived') return { outcome: 'expired', reason: 'room-archived' };
    if (room.status === 'trashed') return { outcome: 'expired', reason: 'room-trashed' };
    if (room.status === 'quiescing') return { outcome: 'expired', reason: 'room-quiescing' };
    if (room.status === 'purging') return { outcome: 'expired', reason: 'room-purging' };

    const target = this.store.getMember(reminder.targetId);
    // A retired member is `offline`; their reminder is addressed to nobody.
    if (!target || target.status === 'offline') return { outcome: 'expired', reason: 'recipient-gone' };

    const task = reminder.taskId ? this.store.getTask(reminder.taskId) : null;
    if (reminder.taskId && !task) return { outcome: 'expired', reason: 'task-missing' };
    if (task && SETTLED_TASK_STATES.has(task.status)) {
      return { outcome: 'expired', reason: `task-${task.status}` };
    }

    if (!this.messages) return { outcome: 'expired', reason: 'no-message-service' };

    // The author must be a real member of this room: the message service refuses an
    // author it cannot attribute, and inventing a "system" principal here would put
    // a sender in the timeline that no member table can resolve.
    const authorId = authorFor(this.store, reminder.roomId, target);
    if (!authorId) return { outcome: 'expired', reason: 'no-author' };

    return { outcome: 'fire', room, target, task, authorId };
  }

  /**
   * Post a reminder that survived {@link #verdict}.
   *
   * @param {object} reminder
   * @param {{ room: object, target: object, task: object | null, authorId: string }} verdict
   * @returns {Promise<{ reminderId: string, roomId: string, outcome: 'fired' | 'failed', reason?: string, messageId?: string }>}
   */
  async #post(reminder, verdict) {
    const base = { reminderId: reminder.id, roomId: reminder.roomId };
    const { target, task, authorId } = verdict;
    try {
      const sent = await this.messages.send({
        roomId: reminder.roomId,
        authorId,
        body: composeReminder(task, target, this.#lastBlocker(reminder.roomId, task)),
        mentions: [],
        taskId: reminder.taskId ?? null,
        // Deterministic: a retry after a crash collapses into the first send.
        clientMessageId: `reminder:${reminder.id}`,
        purpose: 'system',
        causalRootId: reminder.taskId ?? null,
      });
      this.store.appendEvent({
        roomId: reminder.roomId,
        eventType: 'reminder.fired',
        payload: { reminderId: reminder.id, taskId: reminder.taskId ?? null, targetId: target.id, messageId: sent.message.id },
      });
      this.rooms.publish(reminder.roomId, { type: 'reminder.fired', roomId: reminder.roomId, reminderId: reminder.id });
      return { ...base, outcome: 'fired', messageId: sent.message.id };
    } catch (error) {
      const reason = String(error?.message ?? error);
      this.logger?.warn?.(`[project-room] reminder ${reminder.id} could not be posted: ${reason}`);
      // The row stays `fired`: re-firing on every tick forever is worse than one
      // lost nudge, and the failure is visible in the log and the return value.
      this.store.settleReminder(reminder.id, 'expired', `send-failed: ${reason}`);
      return { ...base, outcome: 'failed', reason };
    }
  }

  /**
   * The most recent blocker note for a room, which is where the missing piece of a
   * blocked task is actually recorded.
   *
   * `task-service` writes the reason into `admin_note` (kind `blocker`) and does not
   * keep it on the task row, so reading it from the task object would have produced
   * a reminder that silently omitted the one fact the reader needs.
   *
   * @param {string} roomId
   * @param {object | null} task
   * @returns {string | null}
   */
  #lastBlocker(roomId, task) {
    if (!task) return null;
    try {
      // `listAdminNotes` orders by `created_at desc`, so the newest blocker is the
      // first element. Reading the last one would attach the oldest recorded
      // blocker to a task that has since been blocked for a different reason.
      const latest = this.store.listAdminNotes(roomId, 50).find((note) => note.kind === 'blocker');
      return latest ? latest.body : null;
    } catch {
      // The reminder must survive an unreadable note table: it is a nudge, not a report.
      return null;
    }
  }
}

/**
 * Pick who the reminder appears to come from.
 *
 * Preference order is deliberate: the member who was *supposed* to answer (so the
 * nudge reads as the room noticing), else the coordinator (its job is to chase),
 * else anyone active. Every candidate is verified against the member table.
 *
 * @param {import('../storage/store.js').RoomStore} store
 * @param {string} roomId
 * @param {object} target
 * @returns {string | null}
 */
function authorFor(store, roomId, target) {
  const members = store.listMembers(roomId);
  if (members.some((member) => member.id === target.id)) return target.id;
  return members.find((member) => member.role === 'coordinator')?.id ?? members[0]?.id ?? null;
}

/**
 * The reminder text.
 *
 * It carries the task, the state it is stuck in and what is missing, because a
 * reminder that only says "any progress?" cannot be acted on without re-reading
 * the whole room. Nothing time-dependent is
 * included, so the text is stable for a given task revision — which is what makes
 * the deterministic `clientMessageId` a true idempotency key rather than a label.
 *
 * @param {object | null} task
 * @param {object} target
 * @param {string | null} blocker
 * @returns {string}
 */
function composeReminder(task, target, blocker) {
  if (!task) return `【提醒】${target.displayName}：有一条到期的待办需要跟进。`;
  const label = TASK_STATUS_LABELS[task.status] ?? task.status;
  return [
    `【提醒】@${target.handle} 这项任务已到跟进时间，目前仍是「${label}」（r${task.revision}）。`,
    // The id is included because a reminder that names only the objective cannot be
    // traced back to a task row without re-reading the whole room.
    `任务：${task.objective}（${task.id}）`,
    blocker ? `记录缺少：${blocker}` : null,
    '如果已经不需要跟进，请把任务状态更新掉；这里的提醒会随任务结束一起失效。',
  ]
    .filter(Boolean)
    .join('\n');
}
