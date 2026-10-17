/**
 * Project Room — context builder.
 *
 * Turns "this member should answer this message" into the exact block the model
 * sees. The rule is that visibility is not the same as
 * per-turn input: a member may read the whole room, but one call receives only
 * what the current work needs.
 *
 * Every section that summarises state cites its source (message seq, decision
 * revision, task revision) so a member can go and read the original instead of
 * trusting a paraphrase, and so a compressed summary can never quietly merge two
 * conflicting positions into a fake consensus.
 *
 * @module dsh-project-room/src/host/room/context-builder
 */

import { DELIVERY_LABELS, TASK_STATUS_LABELS, isoTimestamp } from '../../../shared/contracts.js';

const RECENT_MESSAGE_LIMIT = 25;

export class ContextBuilder {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   */
  constructor(input) {
    this.store = input.store;
  }

  /**
   * Compose the envelope handed to one recipient.
   *
   * @param {object} input
   * @param {object} input.message The saved room message.
   * @param {object} input.author Author member row.
   * @param {object} input.recipient Recipient member row.
   * @param {object} input.room
   * @param {boolean} [input.isReply]        Whether this message answers something the recipient sent.
   * @returns {string}
   */
  composeEnvelope(input) {
    const { message, author, recipient, room } = input;
    const sections = [];

    sections.push(
      [
        `【群消息 · ${room.title}】`,
        `发送者：${author.displayName}（${author.kind === 'human' ? '用户' : `@${author.handle}，${author.role}`}）`,
        `接收者：你（${recipient.displayName}）`,
        `消息序号：#${message.seq}`,
      ].join('\n'),
    );

    if (message.replyTo) {
      const original = this.store.getMessage(message.replyTo);
      if (original) {
        const originalAuthor = this.store.getMember(original.authorId);
        sections.push(
          [
            '【这条消息回复的是】',
            `#${original.seq} ${originalAuthor?.displayName ?? original.authorId}：${truncate(original.body, 400)}`,
          ].join('\n'),
        );
      }
    }

    sections.push(['【正文】', message.body || '（只有点名，没有正文）'].join('\n'));

    const task = message.taskId ? this.store.getTask(message.taskId) : recipient.currentTaskId ? this.store.getTask(recipient.currentTaskId) : null;
    if (task) sections.push(this.#taskSection(task));

    const decisions = this.store
      .listDecisions(room.id, { statuses: ['accepted'] })
      .filter((decision) => decision.revision > recipient.lastAppliedDecisionRevision || (task && decision.affectedTaskIds.includes(task.id)));
    if (decisions.length > 0) {
      sections.push(
        [
          '【对你仍生效的决定】',
          ...decisions
            .slice(-5)
            .map((decision) => `r${decision.revision}（来源消息 #${this.#seqOf(decision.sourceMessageId) ?? '?'}）${decision.statement}`),
        ].join('\n'),
      );
    }

    const recent = this.store
      .listRecentMessages(room.id, { limit: RECENT_MESSAGE_LIMIT })
      .filter((entry) => entry.seq !== message.seq);
    if (recent.length > 0) {
      const members = new Map(this.store.listMembers(room.id, { includeRetired: true }).map((member) => [member.id, member]));
      sections.push(
        [
          `【群内最近 ${recent.length} 条（按时间正序，供你判断上下文，不需要逐条回应）】`,
          ...recent.map((entry) => {
            const name = members.get(entry.authorId)?.displayName ?? entry.authorId;
            return `#${entry.seq} ${name}：${truncate(entry.body, 220)}`;
          }),
        ].join('\n'),
      );
    }

    const blocked = this.store
      .listTasks(room.id, { statuses: ['blocked'] })
      .filter((entry) => entry.ownerId === recipient.id);
    if (blocked.length > 0) {
      sections.push(
        [
          '【你名下仍有受阻的任务】',
          ...blocked.map((entry) => `- ${entry.objective}（r${entry.revision}）`),
        ].join('\n'),
      );
    }

    sections.push(
      [
        '【怎么回应】',
        '- 直接在回复里说话即可，你的最终回答会自动回到项目群，不需要手写 JSON。',
        '- 需要别人配合时，直接在正文里 @ 对方（例如 @backend、@前端），这条消息会送到对方。',
        '- 需要补充材料时用 room_read 读取群记录，用 room_members 查当前成员与 @ 名称。',
        '- 任务状态、成果与验收请用对应工具落盘，群里说一句“完成了”不会改变任务状态。',
        '- 只回答真正被问到的事；没有做过的事情不要声称做过。',
      ].join('\n'),
    );

    return sections.join('\n\n');
  }

  /**
   * Compose a short background notice for a member that was mentioned only in
   * passing, or for a task event that woke them without a message body.
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.recipientId
   * @param {string} input.summary
   * @param {object} [input.task]
   * @returns {string}
   */
  composeNotice(input) {
    const recipient = this.store.getMember(input.recipientId);
    const room = this.store.getRoom(input.roomId);
    const lines = [`【项目群通知 · ${room?.title ?? input.roomId}】`, input.summary];
    if (input.task) lines.push(this.#taskSection(input.task));
    lines.push('如果这与你的工作有关，请在群里说明你的下一步；无关时可以简短说明不需要处理。');
    return lines.join('\n');
  }

  /**
   * A member's own status line: current task, unread count, and which version
   * they have actually applied. Read by the UI so "read the message" is never
   * confused with "applied the decision".
   * @param {object} member
   * @returns {object}
   */
  memberView(member) {
    const room = this.store.getRoom(member.roomId);
    const task = member.currentTaskId ? this.store.getTask(member.currentTaskId) : null;
    const open = this.store.listOpenDeliveries(member.roomId, member.id);
    const latestDecision = this.store.listDecisions(member.roomId, { statuses: ['accepted'] }).pop() ?? null;
    return {
      ...member,
      currentTask: task
        ? { id: task.id, objective: task.objective, status: task.status, statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status, revision: task.revision }
        : null,
      unreadCount: Math.max(0, (room?.lastSeq ?? 0) - member.lastSeenSeq),
      awaitingReplyCount: open.length,
      decisionLag: latestDecision ? Math.max(0, latestDecision.revision - member.lastAppliedDecisionRevision) : 0,
      openDeliveries: open.map((delivery) => ({
        messageId: delivery.messageId,
        status: delivery.status,
        statusLabel: DELIVERY_LABELS[delivery.status] ?? delivery.status,
      })),
      syncedAt: isoTimestamp(),
    };
  }

  #taskSection(task) {
    const owner = task.ownerId ? this.store.getMember(task.ownerId) : null;
    const dependencies = task.dependencies
      .map((dependencyId) => this.store.getTask(dependencyId))
      .filter(Boolean)
      .map((dependency) => `#${dependency.id}（${TASK_STATUS_LABELS[dependency.status] ?? dependency.status}）`);
    return [
      `【任务 r${task.revision}】${task.objective}`,
      `状态：${TASK_STATUS_LABELS[task.status] ?? task.status}｜负责人：${owner?.displayName ?? '未指定'}`,
      task.deliverables.length > 0 ? `交付物：${task.deliverables.join('；')}` : null,
      task.acceptance.length > 0 ? `验收条件：${task.acceptance.join('；')}` : null,
      dependencies.length > 0 ? `依赖：${dependencies.join('、')}` : null,
      task.needsSync ? '注意：这项任务的需求版本已变更，需要先同步新版本再提交验收。' : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  #seqOf(messageId) {
    const message = this.store.getMessage(messageId);
    return message?.seq ?? null;
  }
}

/**
 * Clip long text for a summary line. Deliberately marked with an ellipsis so a
 * reader can tell a quote from a full message.
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function truncate(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
