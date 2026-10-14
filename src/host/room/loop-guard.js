/**
 * Project Room — abnormal-loop guard.
 *
 * the design notes is explicit about two opposite failures, and this module exists to
 * avoid both:
 *
 *   - **Too strict.** A fixed "each pair may exchange two messages" rule, or
 *     truncating a discussion because the words look similar, would break the
 *     real collaboration the product exists for. A repeated user requirement, a
 *     re-quoted interface field and a genuine multi-round design argument are all
 *     normal.
 *   - **Too loose.** "收到→谢谢→不客气" chains and a member waking itself can burn
 *     unlimited tokens without producing anything.
 *
 * So the guard is narrow, evidence-based, and applies only to AUTOMATIC wake-ups:
 * it looks at one causal chain, and only pauses when a wake adds no new question,
 * no new evidence and no work progress. A user's own message always goes through.
 *
 * @module dsh-project-room/src/host/room/loop-guard
 */

/** Social closers that ask for nothing. */
const COURTESY_PATTERNS = [
  /^\s*(好的?|行|嗯+|收到|了解|明白|谢谢?|多谢|感谢|辛苦了?|不客气|客气|没事|没问题|OK|ok|👌|👍|🙏)[\s!！。.~～]*$/,
  /^\s*(谢谢|多谢|感谢)[^\n]{0,12}(辛苦|帮忙|支持)[\s!！。.~～]*$/,
  /^\s*(收到|了解|明白)[\s,，]*(谢谢|多谢|感谢)[\s!！。.~～]*$/,
];

/**
 * Whether a body is purely a social closer — no question, no request, no result.
 *
 * Deliberately conservative: anything carrying a question mark, a mention with
 * content after it, a code fence, or a task word returns `false`, so a real
 * message can never be silently swallowed as politeness.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function isCourtesy(body) {
  const text = String(body ?? '').trim();
  if (!text) return true;
  if (text.length > 30) return false;
  if (/[?？]/.test(text)) return false;
  if (/```|`/.test(text)) return false;
  if (/@/.test(text)) return false;
  if (/(请|麻烦|帮我|改成|实现|修复|测试|提交|发现问题|不对|报错|失败|阻塞|进度)/.test(text)) return false;
  return COURTESY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether a body carries something answerable: a question, a request, a result,
 * or evidence.
 * @param {string} body
 * @returns {boolean}
 */
export function asksSomething(body) {
  const text = String(body ?? '').trim();
  if (text.length > 30) return true;
  if (/[?？]/.test(text)) return true;
  if (/(请|麻烦|帮我|应该|是不是|有没有|为什么|怎么|如何|是否|需要|改成|实现|修复|测试|确认|对齐|同步|提交|回一下|看一下|发我)/.test(text)) {
    return true;
  }
  if (/(完成|通过|失败|报错|错误|记录|结果|evidence|日志|退出码|commit|diff)/i.test(text)) return true;
  return false;
}

/**
 * A cheap, stable fingerprint of a message's substance. Used only to spot a
 * literal repeat inside one causal chain — never to judge whether a discussion
 * is worthwhile.
 * @param {string} body
 * @returns {string}
 */
export function fingerprint(body) {
  return String(body ?? '')
    .replace(/@[\p{L}\p{N}_-]+/gu, '@')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

/**
 * Whether one automatic round brings something the chain has not already seen:
 * a new question, a new request, a new result or new evidence.
 *
 * Only rounds that bring nothing are charged against the automatic-round budget.
 * The design forbids a fixed maximum number of discussion rounds (§17.1) and
 * only treats a chain as an anomaly when it adds no new question, no new
 * evidence and no progress (§17.2), so a discussion that keeps producing new
 * substance must not be cut off — an unproductive chain still stops (AT19).
 *
 * @param {{ fingerprints: string[] }} chain
 * @param {string} body
 * @returns {boolean}
 */
function addsNewSubstance(chain, body) {
  if (!asksSomething(body)) return false;
  const print = fingerprint(body);
  return print !== '' && !chain.fingerprints.includes(print);
}

/**
 * Per-room automatic-wake ledger.
 *
 * It records automatic wakes by causal chain so the guard can answer three
 * questions: how many automatic rounds has this chain already spent, is this a
 * literal repeat, and is a member waking itself.
 */
export class LoopGuard {
  /**
   * @param {object} [options]
   * @param {number} [options.maxAutomaticRounds] Soft cap on automatic wake-ups per chain.
   * @param {number} [options.repeatTolerance] Identical consecutive messages tolerated.
   */
  constructor(options = {}) {
    this.maxAutomaticRounds = Number.isFinite(options.maxAutomaticRounds) ? options.maxAutomaticRounds : 12;
    this.repeatTolerance = Number.isFinite(options.repeatTolerance) ? options.repeatTolerance : 1;
    /** @type {Map<string, { rounds: number, wakes: string[], fingerprints: string[], lastAuthor: string | null }>} */
    this.chains = new Map();
    /** @type {Set<string>} */
    this.paused = new Set();
    /** @type {Array<{ roomId: string, causalRootId: string, reason: string, at: string }>} */
    this.incidents = [];
  }

  /**
   * Decide whether one automatic wake-up may proceed.
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.causalRootId
   * @param {string} input.authorId
   * @param {string[]} input.recipientIds
   * @param {string} input.body
   * @param {'user' | 'agent'} input.authorKind
   * @returns {{ allowed: boolean, reason: string | null, automatic: boolean }}
   */
  check(input) {
    const chainKey = `${input.roomId}|${input.causalRootId}`;

    // A human message always goes through and starts a fresh chain allowance:
    // the user asking again is never "a loop" (the design notes).
    if (input.authorKind === 'human') {
      this.chains.set(chainKey, { rounds: 0, wakes: [], fingerprints: [], lastAuthor: input.authorId });
      this.paused.delete(chainKey);
      return { allowed: true, reason: null, automatic: false };
    }

    if (this.paused.has(chainKey)) {
      return {
        allowed: false,
        reason: '这条自动唤醒链已被判定为无进展循环并暂停；用户发言仍可继续这条讨论。',
        automatic: true,
      };
    }

    const chain = this.chains.get(chainKey) ?? { rounds: 0, wakes: [], fingerprints: [], lastAuthor: null };
    const currentFingerprint = fingerprint(input.body);

    // Self-wake: an agent whose message would wake itself with nothing new.
    if (input.recipientIds.length === 1 && input.recipientIds[0] === input.authorId) {
      return { allowed: false, reason: '成员不能通过自己的发言唤醒自己。', automatic: true };
    }

    // Literal repeat without new substance inside the same chain.
    const repeats = chain.fingerprints.filter((entry) => entry === currentFingerprint).length;
    if (currentFingerprint && repeats > this.repeatTolerance && !asksSomething(input.body)) {
      return {
        allowed: false,
        reason: '同一句话在一条协作链里重复出现且没有新问题或新依据，已合并处理。',
        automatic: true,
      };
    }

    if (chain.rounds >= this.maxAutomaticRounds && !addsNewSubstance(chain, input.body)) {
      this.paused.add(chainKey);
      this.incidents.push({
        roomId: input.roomId,
        causalRootId: input.causalRootId,
        reason: `自动唤醒链达到 ${this.maxAutomaticRounds} 轮且未产生决定或产物变化，已暂停该链。`,
        at: new Date().toISOString(),
      });
      return {
        allowed: false,
        reason: `这条协作链已自动往返 ${this.maxAutomaticRounds} 轮仍未产生新进展，已暂停自动推进；请相关成员明确拆分任务或由用户决定方向。`,
        automatic: true,
      };
    }

    return { allowed: true, reason: null, automatic: true };
  }

  /**
   * Record that an automatic round actually happened.
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.causalRootId
   * @param {string} input.authorId
   * @param {string} input.body
   */
  record(input) {
    const chainKey = `${input.roomId}|${input.causalRootId}`;
    const chain = this.chains.get(chainKey) ?? { rounds: 0, wakes: [], fingerprints: [], lastAuthor: null };
    // A round that carries new substance is not spending the chain's budget.
    if (!addsNewSubstance(chain, input.body)) chain.rounds += 1;
    chain.lastAuthor = input.authorId;
    if (chain.fingerprints.length < 40) chain.fingerprints.push(fingerprint(input.body));
    this.chains.set(chainKey, chain);
  }

  /**
   * Whether something that counts as progress happened in a chain. Progress
   * resets the allowance, because a chain that produced a decision, a task
   * change or an artifact is not a loop (the design notes).
   * @param {string} roomId
   * @param {string} causalRootId
   */
  noteProgress(roomId, causalRootId) {
    const chainKey = `${roomId}|${causalRootId}`;
    this.chains.set(chainKey, { rounds: 0, wakes: [], fingerprints: [], lastAuthor: null });
    this.paused.delete(chainKey);
  }

  /**
   * Let the user un-pause a chain explicitly.
   * @param {string} roomId
   * @param {string} causalRootId
   */
  resume(roomId, causalRootId) {
    this.paused.delete(`${roomId}|${causalRootId}`);
  }

  /**
   * Detect the mutual-wait case: every listed task is blocked on a member that is
   * itself waiting. Reported to the coordinator and the user rather than
   * retried forever (the design notes).
   * @param {object[]} tasks
   * @returns {{ detected: boolean, members: string[], tasks: string[] }}
   */
  detectCircularWait(tasks) {
    const waiting = tasks.filter((task) => task.status === 'blocked' && Array.isArray(task.dependencies) && task.dependencies.length > 0);
    if (waiting.length < 2) return { detected: false, members: [], tasks: [] };
    const blockedIds = new Set(waiting.map((task) => task.id));
    const cycleTasks = waiting.filter((task) => task.dependencies.some((dependency) => blockedIds.has(dependency)));
    if (cycleTasks.length < 2) return { detected: false, members: [], tasks: [] };
    return {
      detected: true,
      members: [...new Set(cycleTasks.map((task) => task.ownerId).filter(Boolean))],
      tasks: cycleTasks.map((task) => task.id),
    };
  }

  /** Incidents for the UI / board, newest first. */
  listIncidents() {
    return [...this.incidents].reverse();
  }
}

/**
 * Detect a dependency cycle before a plan is committed. A cyclic plan must be
 * refused with an explanation, not accepted and then deadlocked (the design notes,
 * AT40).
 *
 * @param {Array<{ id: string, dependencies?: string[] }>} tasks
 * @returns {{ acyclic: boolean, cycle: string[] | null }}
 */
export function detectDependencyCycle(tasks) {
  const graph = new Map(tasks.map((task) => [task.id, (task.dependencies ?? []).filter((id) => tasks.some((other) => other.id === id))]));
  const state = new Map();
  /** @type {string[] | null} */
  let cycle = null;

  const visit = (node, path) => {
    if (cycle) return;
    const status = state.get(node);
    if (status === 'done') return;
    if (status === 'visiting') {
      cycle = [...path.slice(path.indexOf(node)), node];
      return;
    }
    state.set(node, 'visiting');
    for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
    state.set(node, 'done');
  };

  for (const task of tasks) visit(task.id, []);
  return { acyclic: cycle === null, cycle };
}
