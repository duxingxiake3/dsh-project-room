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
 * A bare acknowledgement with a short trailing clause, and nothing actionable in it.
 *
 * This case was missing, and the live AT39 trial showed what that costs: two members
 * exchanged roughly 180 messages of the form "收到，无补充。" / "确认，#461 与我的自述一致。"
 * over about two minutes, each one individually harmless, and the guard never saw a
 * courtesy chain because the old patterns required the acknowledgement to be the WHOLE
 * message. the design notes names exactly this pair — "反复『收到/谢谢』" — as the case that
 * must stop, so the rule has to survive a polite tail.
 *
 * The tail is bounded twice over, because a guard that swallows a message carrying work
 * is worse than one that misses politeness. It may not run past 32 characters and may
 * not contain a digit or any work verb that means something concrete is happening or is
 * being asked for. Digits are the strongest signal available: seq numbers, revisions,
 * exit codes and counts are how this plugin's members say "here is a fact". A bare `#`
 * therefore stays inside the rule (it is only a cross-reference on its own), while
 * "#461" and "r16" and "退出码 0" do not.
 */
const ACK_WITH_TAIL =
  /^(收到|了解|明白|确认|同意|认可|无补充|无待办|无异议|一致|照此|OK)[\s,，:：、]*(?:(?:#\d{1,4})|(?:(?!\d)(?!(?:写|脚本|跑|实现|修复|测试|提交|改|发现|报错|失败|阻塞|进度|请))[^\n])){0,32}$/;

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
  return COURTESY_PATTERNS.some((pattern) => pattern.test(text)) || ACK_WITH_TAIL.test(text);
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
   * @param {number} [options.maxAutomaticWakesPerMinute] Room-level backstop: automatic
   *   wake-ups allowed in one room inside a rolling minute with no user message.
   * @param {() => number} [options.now] Clock, injectable for tests.
   */
  constructor(options = {}) {
    this.maxAutomaticRounds = Number.isFinite(options.maxAutomaticRounds) ? options.maxAutomaticRounds : 12;
    this.repeatTolerance = Number.isFinite(options.repeatTolerance) ? options.repeatTolerance : 1;
    /**
     * The per-chain counter cannot catch a courtesy ping-pong by itself: each reply
     * quotes the message it answers, so every message carries its target's id as
     * `causalRootId` and every chain holds ONE round. Measured on the 2026-10-17 AT39
     * trial: 274 messages, **241 distinct roots**, two members trading "无动作。"
     * while `maxAutomaticRounds` never advanced.
     *
     * This counter is per ROOM and time-based instead, so forking roots cannot hide
     * a runaway exchange. A productive discussion still passes: a user message
     * resets it, and that trial's working phase stayed far below the limit.
     */
    this.maxAutomaticWakesPerMinute = Number.isFinite(options.maxAutomaticWakesPerMinute)
      ? options.maxAutomaticWakesPerMinute
      : 12;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    /** @type {Map<string, number[]>} */
    this.roomWindows = new Map();
    /** @type {Set<string>} */
    this.roomBlocked = new Set();
    /** @type {Map<string, { rounds: number, wakes: string[], fingerprints: string[], lastAuthor: string | null }>} */
    this.chains = new Map();
    /** @type {Set<string>} */
    this.paused = new Set();
    /** @type {Array<{ roomId: string, causalRootId: string, reason: string, at: string }>} */
    this.incidents = [];
  }

  /** Prune and return the room's automatic wake-ups from the last minute. */
  #recentRoomWakes(roomId) {
    const cutoff = this.now() - 60_000;
    const list = (this.roomWindows.get(roomId) ?? []).filter((at) => at > cutoff);
    this.roomWindows.set(roomId, list);
    // The block is a rate limit, not a sentence: once the window is empty the room
    // runs again without waiting for a human. Only a human message resets it sooner.
    if (list.length === 0) this.roomBlocked.delete(roomId);
    return list;
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
      this.roomWindows.set(input.roomId, []);
      this.roomBlocked.delete(input.roomId);
      return { allowed: true, reason: null, automatic: false };
    }

    // Room-level backstop, checked before anything chain-shaped: a quiet courtesy
    // ping-pong never accumulates rounds on ONE chain (each reply forks a new root),
    // so the room's automatic traffic itself has to be bounded. The window is
    // evaluated on every check — that is also what lets it expire — and a user
    // message clears it outright.
    const recent = this.#recentRoomWakes(input.roomId);
    if (recent.length >= this.maxAutomaticWakesPerMinute) {
      if (!this.roomBlocked.has(input.roomId)) {
        this.roomBlocked.add(input.roomId);
        this.incidents.push({
          roomId: input.roomId,
          causalRootId: input.causalRootId,
          reason: `本项目 60 秒内已自动唤醒 ${recent.length} 次且期间没有用户发言，已暂停自动推进。`,
          at: new Date(this.now()).toISOString(),
        });
      }
      return {
        allowed: false,
        reason: `本项目 60 秒内已自动唤醒 ${recent.length} 次且没有用户发言，已暂停自动推进以免空转；等这一分钟窗口过去或你发言后恢复。`,
        automatic: true,
      };
    }
    if (this.roomBlocked.has(input.roomId)) {
      return {
        allowed: false,
        reason: '本项目因 60 秒内自动唤醒过多被暂停推进；等窗口过去或你发言后恢复。',
        automatic: true,
      };
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
    // A round that carries new substance is not spending ANY budget — neither the
    // chain's nor the room's. That is what keeps a 15-round exchange that asks a new
    // question every time from being cut: the design notes forbids a fixed round cap, and
    // an earlier version of this counter charged every wake and did exactly that.
    const substantive = addsNewSubstance(chain, input.body);
    if (!substantive) chain.rounds += 1;
    chain.lastAuthor = input.authorId;
    if (chain.fingerprints.length < 40) chain.fingerprints.push(fingerprint(input.body));
    this.chains.set(chainKey, chain);
    if (!substantive) {
      // `record` runs once per admitted delivery, so this counts turns that actually
      // started. Only wakes that brought nothing are charged against the room
      // backstop, because it exists to stop courtesy ping-pong, not work.
      const recent = this.#recentRoomWakes(input.roomId);
      recent.push(this.now());
      this.roomWindows.set(input.roomId, recent);
    }
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
