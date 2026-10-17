/**
 * Project Room — client half.
 *
 * Served to the browser as a CLASSIC script (no ESM, no JSX transform, no
 * bundler), so this file self-registers through the client module loader and
 * builds elements with `react/jsx-runtime`. Only `react` and `react/jsx-runtime`
 * are required explicitly; the shared rules arrive as package-local chunks
 * (`client.vocabulary.js`, `client.mention-resolver.js`) generated from the same
 * source the host runs, which is what makes the `@` preview and the server
 * resolution identical rather than merely similar.
 *
 * Registers two surfaces:
 *   - `sidebar.panellist` id `project-room` → the sidebar button
 *   - `main`              key `project-room` → the whole room workspace
 *
 * The panel is three columns: projects and members on the
 * left, the group timeline in the middle, tasks/decisions/artifacts on the right.
 * Narrow layouts collapse the outer columns into drawers.
 */

window.__ModuleLoader__.load({
  id: 'dsh-project-room',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

/* >>> GENERATED: shared rules (scripts/build-client.mjs) >>> */
// Inlined from shared/ so the browser half is ONE classic script. The client module
// table is closed, so a package-local chunk cannot be fetched at runtime.
// ---- shared/vocabulary.js ----
/**
 * Project Room — shared vocabulary.
 *
 * The small, dependency-free half of the contracts: enumerations, their natural
 * Chinese labels, the legal task transitions, role templates, and the wire error
 * codes. Both halves load this module — the host as ESM, the browser through the
 * generated `client.vocabulary.js` chunk — so a status can never be labelled two
 * different ways on the two sides of the wire.
 *
 * Nothing here imports anything, which is exactly what makes it loadable in a
 * classic browser script.
 *
 * @module dsh-project-room/shared/vocabulary
 */

/** ASCII `@` and its full-width twin. */
const AT_SIGN = '@';
const AT_SIGN_FULL_WIDTH = '\uFF20';

/** Route served by the plugin's host half on the authenticated `/api` channel. */
const ROUTE = '/api/dsh-project-room';

/** Wire protocol marker for the message envelope handed to a member session. */
const ENVELOPE_PROTOCOL = 'project-room.v1';

/** Authored time is always stored as UTC ISO 8601. */
const TIME_FORMAT = 'utc-iso8601';

/** Everything a client may send as an action name starts with this. */
const ACTION_PREFIX = 'room.';

/**
 * Delivery states. "Delivered" is not "read": `claimed` requires a real host
 * observation.
 * @type {Readonly<Record<string, string>>}
 */
const DELIVERY_LABELS = Object.freeze({
  pending: '等待发送',
  paused: '已暂停，消息保留',
  admitting: '正在交给目标成员',
  accepted: '已送达，尚未确认取用',
  claimed: '对方本轮已取用',
  replied: '已回复',
  discarded: '已被宿主取消',
  failed: '投递失败',
  uncertain: '无法确认是否送达，正在核对',
});

/**
 * Task states.
 * @type {Readonly<Record<string, string>>}
 */
const TASK_STATUS_LABELS = Object.freeze({
  proposed: '提议中',
  ready: '就绪',
  in_progress: '执行中',
  blocked: '受阻',
  submitted: '已提交',
  verifying: '验收中',
  accepted: '已验收',
  rework: '待返工',
  superseded: '已被新版替代',
  failed: '已失败',
  cancelled: '已取消',
});

/**
 * Legal task transitions. Anything absent is rejected rather than accepted.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const TASK_TRANSITIONS = Object.freeze({
  proposed: ['ready', 'cancelled', 'superseded', 'blocked'],
  ready: ['in_progress', 'blocked', 'cancelled', 'superseded'],
  in_progress: ['submitted', 'blocked', 'failed', 'cancelled', 'rework'],
  blocked: ['ready', 'in_progress', 'cancelled', 'superseded'],
  submitted: ['verifying', 'rework', 'accepted'],
  verifying: ['accepted', 'rework', 'failed'],
  accepted: ['superseded', 'rework'],
  rework: ['in_progress', 'submitted', 'cancelled'],
  superseded: [],
  failed: ['in_progress', 'cancelled'],
  cancelled: [],
});

/**
 * Member states. Deliberately separate from delivery and task state: `working`
 * comes from a real agent status, never from a pending message.
 * @type {Readonly<Record<string, string>>}
 */
const MEMBER_STATUS_LABELS = Object.freeze({
  idle: '空闲',
  working: '执行中',
  awaiting_reply: '等待回复',
  needs_user: '需要用户处理',
  paused: '暂停',
  offline: '离线 / 故障',
});

/**
 * Role templates. A template supplies duties and a default handle; it never
 * pins a model brand.
 * @type {ReadonlyArray<{ role: string, handle: string, title: string, aliases: string[], duties: string, defaultObjectives: string[] }>}
 */
const ROLE_TEMPLATES = Object.freeze([
  {
    role: 'coordinator',
    handle: 'coordinator',
    title: '主代理',
    aliases: ['主代理', '队长', '协调'],
    duties: '理解目标、检查现状、拆分工作、安排成员、协调依赖、组织验收。',
    defaultObjectives: ['拆分项目目标并安排成员', '汇总变更与组织验收'],
  },
  {
    role: 'frontend',
    handle: 'frontend',
    title: '前端',
    aliases: ['前端'],
    duties: '界面、交互、前端数据接入与前端自检。',
    defaultObjectives: ['实现前端交付物', '与后端对齐接口后联调'],
  },
  {
    role: 'backend',
    handle: 'backend',
    title: '后端',
    aliases: ['后端'],
    duties: '接口、数据、服务端逻辑、错误语义与边界处理。',
    defaultObjectives: ['实现服务端接口与错误语义', '公布接口约定供前端与测试使用'],
  },
  {
    role: 'tester',
    handle: 'tester',
    title: '测试',
    aliases: ['测试', '质量'],
    duties: '用例设计、真实执行记录、缺陷复现与验收证据。',
    defaultObjectives: ['编写并运行用例', '在集成结果上验证并记录证据'],
  },
  {
    role: 'devops',
    handle: 'devops',
    title: '运维',
    aliases: ['运维', '部署'],
    duties: '构建、本地运行说明、依赖与环境可复现性。',
    defaultObjectives: ['整理构建与启动说明', '在可运行版本上复跑并记录'],
  },
  {
    role: 'designer',
    handle: 'designer',
    title: '设计',
    aliases: ['设计', '交互'],
    duties: '交互与视觉约定、状态与错误呈现规范。',
    defaultObjectives: ['给出交互与状态约定'],
  },
  {
    role: 'docs',
    handle: 'docs',
    title: '文档',
    aliases: ['文档', '说明'],
    duties: '说明文档、使用步骤与变更记录。',
    defaultObjectives: ['补齐使用与变更文档'],
  },
]);

/**
 * Look one role template up.
 * @param {string} role
 * @returns {(typeof ROLE_TEMPLATES)[number] | undefined}
 */
function roleTemplate(role) {
  return ROLE_TEMPLATES.find((template) => template.role === role);
}

/**
 * Whether a task transition is legal.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TASK_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Research run states (deep research). Kept here so the host and the panel cannot label
 * "approved" as "running".
 * @type {Readonly<Record<string, string>>}
 */
const RESEARCH_STATUS_LABELS = Object.freeze({
  AWAITING_APPROVAL: '待用户批准',
  APPROVED: '已批准，待启动',
  REJECTED: '未获批准',
  RUNNING: '研究中',
  PAUSED: '已暂停',
  PAUSED_RECONCILE: '重启后待核对',
  STOPPED: '已停止',
  CANCELLED: '已取消',
  COMPLETED: '已完成',
  FAILED: '已失败',
  EXPIRED: '批准已过期',
});

/** Natural Chinese for a research conclusion. */
const RESEARCH_CONCLUSION_LABELS = Object.freeze({
  improved: '有可验证提升',
  no_change: '保持不变更合适',
  inconclusive: '证据不足，无法结论',
  rejected_candidate: '候选被否决',
});

/**
 * Project lifecycle states (project lifecycle). The room `status` is the admission gate;
 * this is the observable state, so "stopping" is never displayed as "stopped".
 * @type {Readonly<Record<string, string>>}
 */
const PROJECT_LIFECYCLE_LABELS = Object.freeze({
  ACTIVE: '进行中',
  PAUSING: '正在暂停',
  PAUSED: '已暂停',
  QUIESCING: '正在停止执行',
  ARCHIVED: '已归档',
  BLOCKED: '停止未确认',
  TRASHED: '回收站',
  PURGING: '正在永久删除',
  PURGE_BLOCKED: '清理受阻，待处理',
  PURGED: '已永久删除',
});

/** Natural Chinese for the persisted research phase. */
const RESEARCH_PHASE_LABELS = Object.freeze({
  proposal: '提议',
  approved: '待启动',
  independent: '独立提案',
  review: '交叉评审',
  experiment: '实验验证',
  converge: '收敛',
  completed: '已完成',
  stopped: '已停止',
});

/**
 * Natural Chinese for a wire error code, so the UI never shows a stack.
 * @type {Readonly<Record<string, string>>}
 */
const ERROR_LABELS = Object.freeze({
  MENTION_AMBIGUOUS: '点名有歧义，请先选择要联系的人',
  MEMBER_UNAVAILABLE: '该成员当前不可用',
  REVISION_CONFLICT: '版本冲突，请刷新后重试',
  HOST_CAPABILITY_MISSING: '当前宿主缺少所需能力',
  DELIVERY_UNCERTAIN: '投递状态不确定，正在核对',
  ROOM_PAUSED: '项目已暂停',
  ROOM_TRASHED: '项目已在回收站，仅可查看或恢复',
  ROOM_ARCHIVED: '项目已归档，仅可查看或恢复',
  ROOM_QUIESCING: '项目正在停止执行，禁止新的任务、消息与唤醒',
  ROOM_PURGING: '项目正在永久删除，禁止任何新工作',
  PROJECT_BUSY: '项目仍有正在执行的工作，请先停止并核对',
  PROJECT_SNAPSHOT_MISSING: '回收站快照缺失，无法恢复',
  PROJECT_SNAPSHOT_MISMATCH: '回收站快照与当前项目结构不一致',
  PROJECT_STOP_PENDING: '停止尚未确认，项目已进入阻塞状态',
  PROJECT_PURGE_BLOCKED: '部分独占资源未能释放，清理已阻塞并保留可恢复数据',
  RESEARCH_DISABLED: '深度研究功能未启用',
  RESEARCH_NOT_FOUND: '没有找到这次研究',
  RESEARCH_NOT_AUTHORIZED: '这项研究还没有获得真实用户批准',
  RESEARCH_INVALID_STATE: '研究当前状态不允许这个操作',
  RESEARCH_SCOPE_CHANGED: '研究范围或预算已经变化，必须重新审批',
  RESEARCH_OUT_OF_SCOPE: '研究请求越出已批准的项目范围',
  RESEARCH_BUDGET_EXCEEDED: '研究预算已经用尽，已暂停',
  RESEARCH_BUDGET_MISSING: '研究预算账本缺失',
  RESEARCH_PROJECT_VERSION_CHANGED: '项目版本已经变化，研究需要重新核对范围',
  NOT_A_ROOM_MEMBER: '你不是这个项目群的成员',
  ARTIFACT_NOT_VERIFIED: '成果未经过核验',
  NOT_FOUND: '没有找到对应内容',
  INVALID_REQUEST: '请求不完整或格式不对',
  FORBIDDEN: '当前身份不能执行这个操作',
  INTERNAL: '插件内部错误',
});

/**
 * ISO 8601 UTC timestamp for "now".
 * @param {number} [epochMs]
 * @returns {string}
 */
function isoTimestamp(epochMs = Date.now()) {
  return new Date(epochMs).toISOString();
}

/**
 * Human label for a delivery state.
 * @param {string} status
 * @returns {string}
 */
function deliveryLabel(status) {
  return DELIVERY_LABELS[status] ?? status;
}

/**
 * Human label for a task state.
 * @param {string} status
 * @returns {string}
 */
function taskLabel(status) {
  return TASK_STATUS_LABELS[status] ?? status;
}

/**
 * Human label for a member state.
 * @param {string} status
 * @returns {string}
 */
function memberLabel(status) {
  return MEMBER_STATUS_LABELS[status] ?? status;
}

// ---- shared/mention-resolver.js ----
/**
 * Project Room — deterministic @ mention resolver.
 *
 * This module implements the protocol. It is the single source of truth for all
 * three legal input paths (avatar menu, picker, plain text), and it is loaded by
 * BOTH halves: the host imports it as ESM, the browser loads the same file
 * through the client module table. Preview and server therefore cannot drift —
 * a `@后端` that previews as one member resolves to that member on submit.
 *
 * Rules enforced here, in this order:
 *   1. Mask body structure (fenced code, inline code, quote lines, link
 *      targets, email local parts) before looking for `@`.
 *   2. An `@` must start at text start, whitespace, or an allowed punctuation
 *      boundary. `dev@example.com` and `npm@scope/pkg` never trigger.
 *   3. Read one complete name run, or a bracketed name `@「前端 小林」`.
 *   4. Exact unique handle first (ASCII case-insensitive), then alias, then
 *      display name — all under NFC normalization. No LLM guessing, ever.
 *   5. One member named twice yields exactly one target.
 *   6. Text with no name boundary (`@前端你先看看`) is never split: it is
 *      reported as a hint, not silently mis-delivered.
 *   7. Names that match nothing, or match several members, are reported so the
 *      UI can ask — never quietly redirected to the coordinator.
 *
 * @module dsh-project-room/shared/mention-resolver
 */



/* ------------------------------------------------------------------ *
 * Character classes — kept explicit so the rules are auditable
 * ------------------------------------------------------------------ */

/** Full-width and half-width space characters. */
const SPACE = /[\s\u00A0\u3000]/;

/**
 * Punctuation allowed immediately BEFORE an `@`. Word characters and
 * `-`/`_`/`.`/`+` are deliberately absent, so email and package specifiers
 * cannot trigger a mention.
 */
const BOUNDARY_BEFORE = new Set([
  '(', '[', '{', '<', '"', "'", '「', '『', '【', '《', '（', '［', '｛', '〈', '“', '‘',
  ',', '.', ';', ':', '!', '?', '，', '。', '；', '：', '！', '？', '、', '…', '~', '·',
  '-', '—', '－', '/', '\\', '|', '*', '>', '=', '+', '％', '%', '&', '^', '$', '#', '@',
]);

/**
 * Punctuation that ends a name run. Anything here stops the run, which is what
 * makes `@后端，接口好了吗` resolve to `后端`.
 */
const TERMINATOR = new Set([
  ' ', '\t', '\n', '\r', '\u00A0', '\u3000',
  ',', '.', ';', ':', '!', '?', '"', "'", '(', ')', '[', ']', '{', '}', '<', '>',
  '，', '。', '；', '：', '！', '？', '、', '…', '“', '”', '‘', '’', '（', '）',
  '【', '】', '《', '》', '「', '」', '『', '』', '〈', '〉', '·', '—', '～', '~',
  '/', '\\', '|', '*', '=', '+', '%', '&', '#', '$', '^', '`',
]);

/** Bracket pairs accepted for a name that contains spaces. */
const BRACKETS = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['《', '》'],
  ['"', '"'],
  ["'", "'"],
];

/** The literal `@all` style keywords that expand to the active member snapshot. */
const EVERYONE_KEYWORDS = Object.freeze(['所有人', '全员', 'all', 'everyone', 'all-members']);

/** The literal keywords that address the human user rather than an agent. */
const HUMAN_KEYWORDS = Object.freeze(['用户', '老板', 'user', 'owner', 'human']);

/* ------------------------------------------------------------------ *
 * Normalization helpers
 * ------------------------------------------------------------------ */

/**
 * Normalize a name for comparison. NFC first; ASCII lowercasing is applied
 * separately by {@link foldAscii} so a Chinese alias is never case-folded into
 * a different string.
 * @param {string} value
 * @returns {string}
 */
function normalizeName(value) {
  return String(value ?? '').normalize('NFC').trim();
}

/**
 * Case-insensitive fold for ASCII handles only.
 * @param {string} value
 * @returns {string}
 */
function foldAscii(value) {
  return normalizeName(value).replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/**
 * Whether two names are the same member alias under the project's rules:
 * exact match after NFC, or ASCII-case-insensitive match when both sides are
 * pure ASCII.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameName(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (left === right) return true;
  if (/^[\x20-\x7E]*$/.test(left) && /^[\x20-\x7E]*$/.test(right)) {
    return foldAscii(left) === foldAscii(right);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Body structure masking
 * ------------------------------------------------------------------ */

/**
 * Mark every UTF-16 position of `body` that is inside a construct where an `@`
 * must NOT trigger a mention: fenced code, inline code, blockquote lines, HTML
 * tags, and the local part plus domain of an email address.
 *
 * Kept exported because both the UI preview and the tests assert on the exact
 * masked set — "which characters were ignored" is a product-visible rule here.
 *
 * @param {string} body
 * @returns {Uint8Array} 1 = masked (inert), 0 = live text.
 */
function maskBody(body) {
  const text = String(body ?? '');
  const masked = new Uint8Array(text.length);
  const mask = (start, end) => {
    for (let i = Math.max(0, start); i < Math.min(text.length, end); i += 1) masked[i] = 1;
  };

  // 1. Fenced code blocks. An unclosed fence masks to the end, matching what a
  //    reader sees as "still code".
  let fenceStart = -1;
  let cursor = 0;
  while (cursor < text.length) {
    const lineEnd = nextLineEnd(text, cursor);
    const line = text.slice(cursor, lineEnd);
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceStart < 0) {
        fenceStart = cursor;
      } else {
        mask(fenceStart, lineEnd);
        fenceStart = -1;
      }
    } else if (fenceStart >= 0) {
      // Inside a fence: nothing on these lines is live text.
      mask(cursor, lineEnd);
    }
    cursor = lineEnd + 1;
  }
  if (fenceStart >= 0) mask(fenceStart, text.length);

  // 2. Inline code. Paired backticks of equal length, per CommonMark's simple
  //    reading; an unmatched single backtick stays literal text.
  const inline = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
  let inlineMatch;
  while ((inlineMatch = inline.exec(text)) !== null) {
    mask(inlineMatch.index, inlineMatch.index + inlineMatch[0].length);
  }

  // 3. Blockquote lines: `>` prefixed lines quote someone else's words.
  cursor = 0;
  while (cursor < text.length) {
    const lineEnd = nextLineEnd(text, cursor);
    if (/^\s{0,3}>/.test(text.slice(cursor, lineEnd))) mask(cursor, lineEnd);
    cursor = lineEnd + 1;
  }

  // 4. HTML tags and autolinks `<...>`.
  const tag = /<[^>\n]{0,400}>/g;
  let tagMatch;
  while ((tagMatch = tag.exec(text)) !== null) mask(tagMatch.index, tagMatch.index + tagMatch[0].length);

  // 5. Link targets `](...)`, bare URLs, `mailto:` addresses, and the whole of
  //    any email address (`local@domain`).
  const email = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  let emailMatch;
  while ((emailMatch = email.exec(text)) !== null) {
    mask(emailMatch.index, emailMatch.index + emailMatch[0].length);
  }
  const linkTarget = /\]\(([^)\n]*)\)/g;
  let linkMatch;
  while ((linkMatch = linkTarget.exec(text)) !== null) {
    mask(linkMatch.index, linkMatch.index + linkMatch[0].length);
  }
  const url = /\b(?:https?|mailto|file):\/?\/?[^\s<>()]+/gi;
  let urlMatch;
  while ((urlMatch = url.exec(text)) !== null) mask(urlMatch.index, urlMatch.index + urlMatch[0].length);

  return masked;
}

/**
 * End offset (exclusive) of the line starting at `start`, excluding the
 * newline itself.
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function nextLineEnd(text, start) {
  const found = text.indexOf('\n', start);
  return found < 0 ? text.length : found;
}

/* ------------------------------------------------------------------ *
 * Token extraction
 * ------------------------------------------------------------------ */

/**
 * Find candidate `@name` tokens in free text, applying the structural and
 * boundary rules. Resolution against a member list happens separately.
 *
 * @param {string} body
 * @returns {ParsedAtToken[]}
 */
function extractAtTokens(body) {
  const text = String(body ?? '');
  if (!text.includes(AT_SIGN) && !text.includes(AT_SIGN_FULL_WIDTH)) return [];
  const masked = maskBody(text);
  /** @type {ParsedAtToken[]} */
  const tokens = [];

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== AT_SIGN && char !== AT_SIGN_FULL_WIDTH) continue;
    if (masked[i] === 1) continue;

    // Rule 2: the `@` must begin a mention, not sit inside a word.
    if (i > 0 && masked[i - 1] === 0 && !SPACE.test(text[i - 1]) && !BOUNDARY_BEFORE.has(text[i - 1])) continue;

    // The `@` itself may be followed by whitespace when the user typed a chip
    // separator; a name must still follow immediately after that whitespace.
    let start = i + 1;
    while (start < text.length && SPACE.test(text[start])) start += 1;
    if (start >= text.length) continue;
    if (masked[start] === 1) continue;

    const bracketed = readBracketedName(text, start);
    let end;
    let name;
    if (bracketed) {
      end = bracketed.end;
      name = bracketed.name;
    } else {
      end = start;
      while (end < text.length && masked[end] === 0 && !TERMINATOR.has(text[end]) && !SPACE.test(text[end])) end += 1;
      if (end === start) continue;
      name = text.slice(start, end);
    }
    if (!name) continue;

    tokens.push({
      start: i,
      end,
      raw: text.slice(i, end),
      name: normalizeName(name),
      // Internal-only aids for {@link resolveMentions}; stripped from the wire.
      nameStart: start,
    });
    i = end - 1;
  }

  return tokens;
}

/**
 * Read `「...」`-style bracketed names, which are the only way to mention a
 * member whose alias contains a space.
 * @param {string} text
 * @param {number} start
 * @returns {{ name: string, end: number } | null}
 */
function readBracketedName(text, start) {
  for (const [open, close] of BRACKETS) {
    if (text[start] !== open) continue;
    const closeAt = text.indexOf(close, start + 1);
    if (closeAt < 0) return null;
    const name = text.slice(start + 1, closeAt);
    if (!name.trim()) return null;
    return { name, end: closeAt + 1 };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Member index and resolution
 * ------------------------------------------------------------------ */

/**
 * A resolved mention target set for one member table revision.
 *
 * Construct one per `(room, membershipRevision)`. The resolver refuses to mix
 * revisions: `resolve()` takes the revision the caller believes is current and
 * returns `stale: true` instead of guessing when they differ, which is what
 * makes "renamed member keeps their old bound mentions" true in practice.
 */
class MentionResolver {
  /**
   * @param {object} input
   * @param {RoomMember[]} input.members Active members (human and agent).
   * @param {number} [input.membershipRevision]
   * @param {string[]} [input.tombstones]  Retired aliases that must not be reused.
   * @param {string[]} [input.everyoneKeywords]
   * @param {string[]} [input.humanKeywords]
   */
  constructor(input) {
    const members = Array.isArray(input?.members) ? input.members : [];
    /** @type {number} */
    this.membershipRevision = Number.isFinite(input?.membershipRevision) ? input.membershipRevision : 0;
    /** @type {string[]} */
    this.tombstones = (input?.tombstones ?? []).map(normalizeName).filter(Boolean);
    /** @type {Set<string>} */
    this.everyoneKeywords = new Set((input?.everyoneKeywords ?? EVERYONE_KEYWORDS).map(foldAscii));
    /** @type {Set<string>} */
    this.humanKeywords = new Set((input?.humanKeywords ?? HUMAN_KEYWORDS).map(foldAscii));

    /** @type {Map<string, RoomMember[]>} exact (NFC) key → members */
    const exact = new Map();
    /** @type {Map<string, RoomMember[]>} ASCII-folded key → members */
    const folded = new Map();
    const push = (map, key, member) => {
      if (!key) return;
      const list = map.get(key);
      if (list) list.push(member);
      else map.set(key, [member]);
    };

    for (const member of members) {
      if (!member) continue;
      const keys = [member.handle, member.displayName, ...(member.aliases ?? [])];
      for (const key of keys) {
        push(exact, normalizeName(key), member);
        if (/^[\x20-\x7E]*$/.test(normalizeName(key))) push(folded, foldAscii(key), member);
      }
    }
    /** @type {Map<string, RoomMember[]>} */
    this.exact = exact;
    /** @type {Map<string, RoomMember[]>} */
    this.folded = folded;
    /** @type {RoomMember[]} */
    this.members = members;
  }

  /**
   * All active agent members — the snapshot `@所有人` expands to.
   * @returns {RoomMember[]}
   */
  activeAgents() {
    return this.members.filter((member) => member.kind === 'agent' && member.status !== 'offline');
  }

  /**
   * The human member the room speaks to, when one exists.
   * @returns {RoomMember | undefined}
   */
  human() {
    return this.members.find((member) => member.kind === 'human');
  }

  /**
   * Resolve one token.
   * @param {ParsedAtToken} token
   * @returns {MentionResolution}
   */
  resolveToken(token) {
    const name = normalizeName(token.name);
    const folded = foldAscii(name);

    if (this.everyoneKeywords.has(folded)) {
      return {
        token,
        kind: 'everyone',
        memberId: null,
        candidates: this.activeAgents().map((member) => member.id),
        reason: `所有人（${this.activeAgents().length} 位 AI 成员）`,
      };
    }

    const exactHits = this.exact.get(name) ?? [];
    const hits = exactHits.length > 0 ? exactHits : this.folded.get(folded) ?? [];
    const unique = dedupeMembers(hits);

    // rule 12: a retired alias stays a tombstone. Resolving it to a
    // *different* member would silently mis-deliver text the user wrote for
    // someone who left, so a tombstoned name is inert by construction —
    // reusing it is refused when an alias is registered, not un-tombstoned here.
    if (this.tombstones.some((retired) => sameName(retired, name))) {
      return {
        token,
        kind: 'unknown',
        memberId: null,
        candidates: [],
        reason: `“${token.name}”是已退出成员的旧名，本条不会改投别人；请从成员列表选择新成员。`,
      };
    }

    if (unique.length === 1) {
      return { token, kind: 'member', memberId: unique[0].id, candidates: [], reason: '' };
    }
    if (unique.length > 1) {
      return {
        token,
        kind: 'ambiguous',
        memberId: null,
        candidates: unique.map((member) => member.id),
        reason: `“${token.name}”在本群对应 ${unique.length} 位成员，请选择要联系的人。`,
      };
    }

    if (this.humanKeywords.has(folded) && this.human()) {
      return { token, kind: 'member', memberId: this.human().id, candidates: [], reason: '' };
    }

    // Rule 8: a run that swallowed following text is reported as a hint rather
    // than guessed at. `@前端你先看看` lands here.
    const hint = this.boundaryHint(token);
    return {
      token,
      kind: 'unknown',
      memberId: null,
      candidates: [],
      reason: hint
        ? `无法识别“${token.raw}”。如果要点名，请在名字后加空格或标点（例如 ${hint}）。`
        : `无法识别“${token.raw}”，可以从成员列表选择，或按普通文本发送。`,
    };
  }

  /**
   * Suggest a resolvable prefix when a name run clearly starts with a real
   * alias but continues into more text.
   * @param {ParsedAtToken} token
   * @returns {string | null}
   */
  boundaryHint(token) {
    const name = normalizeName(token.name);
    let best = null;
    for (const [key, members] of this.exact) {
      if (!key || key.length >= name.length) continue;
      if (!name.startsWith(key)) continue;
      if (dedupeMembers(members).length !== 1) continue;
      if (best === null || key.length > best.length) best = key;
    }
    if (best === null) {
      const folded = foldAscii(name);
      for (const [key, members] of this.folded) {
        if (!key || key.length >= folded.length) continue;
        if (!folded.startsWith(key)) continue;
        if (dedupeMembers(members).length !== 1) continue;
        if (best === null || key.length > best.length) best = key;
      }
    }
    return best === null ? null : `${AT_SIGN}${best}`;
  }

  /**
   * Resolve a whole body into an ordered, duplicate-free resolution list.
   * @param {string} body
   * @param {{ membershipRevision?: number }} [options]
   * @returns {{ resolutions: MentionResolution[], stale: boolean, unknownText: string[] }}
   */
  resolve(body, options) {
    const stale =
      Number.isFinite(options?.membershipRevision) && options.membershipRevision !== this.membershipRevision;
    const tokens = extractAtTokens(body);
    const resolutions = tokens.map((token) => this.resolveToken(token));
    return {
      resolutions,
      stale,
      unknownText: resolutions.filter((entry) => entry.kind === 'unknown').map((entry) => entry.token.raw),
    };
  }
}

/**
 * Deduplicate members by identity — the same member reachable by handle,
 * alias and display name is still one member.
 * @param {RoomMember[]} members
 * @returns {RoomMember[]}
 */
function dedupeMembers(members) {
  const seen = new Set();
  const out = [];
  for (const member of members) {
    if (!member || seen.has(member.id)) continue;
    seen.add(member.id);
    out.push(member);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Merging structured chips with typed text
 * ------------------------------------------------------------------ */

/**
 * Merge structured mentions (avatar menu / picker chips) with the text-parsed
 * ones, then produce the final target set.
 *
 * Rules:
 *   - Structured chips always win: they carry a `memberId` already validated
 *     against this room, and a renamed member keeps receiving them.
 *   - Text mentions are resolved; unknown/ambiguous ones are reported, never
 *     silently dropped and never redirected.
 *   - `@所有人` expands to the active-agent snapshot at send time.
 *   - A member named twice (chip + text, or two spellings) yields ONE record.
 *
 * @param {object} input
 * @param {string} input.body
 * @param {Mention[]} [input.mentions]  Structured chips from the client.
 * @param {MentionResolver} input.resolver
 * @param {number} [input.membershipRevision]
 * @returns {{
 *   targets: Mention[],
 *   unknownText: string[],
 *   ambiguous: Array<{ raw: string, candidates: MemberId[], reason: string }>,
 *   stale: boolean,
 *   hints: string[],
 * }}
 */
function mergeMentions(input) {
  const body = String(input?.body ?? '');
  const resolver = input.resolver;
  const structured = Array.isArray(input?.mentions) ? input.mentions : [];
  /** @type {Mention[]} */
  const targets = [];
  const seen = new Set();
  /** @type {string[]} */
  const unknownText = [];
  /** @type {Array<{ raw: string, candidates: MemberId[], reason: string }>} */
  const ambiguous = [];
  /** @type {string[]} */
  const hints = [];

  const add = (mention) => {
    if (!mention?.targetMemberId || seen.has(mention.targetMemberId)) return;
    seen.add(mention.targetMemberId);
    targets.push(mention);
  };

  // 1. Structured chips first: they are already server-validated identities.
  for (const chip of structured) {
    add({
      targetMemberId: String(chip.targetMemberId),
      origin: chip.origin === 'avatar' || chip.origin === 'picker' ? chip.origin : 'picker',
      displaySnapshot: String(chip.displaySnapshot ?? ''),
      span: chip.span ?? null,
    });
  }

  // 2. Typed text.
  const { resolutions, stale } = resolver.resolve(body, {
    membershipRevision: input?.membershipRevision,
  });
  for (const resolution of resolutions) {
    if (resolution.kind === 'member' && resolution.memberId) {
      // A member already present as a structured chip stays once.
      if (seen.has(resolution.memberId)) continue;
      add({
        targetMemberId: resolution.memberId,
        origin: 'typed',
        displaySnapshot: resolution.token.name,
        span: { start: resolution.token.start, end: resolution.token.end },
      });
      continue;
    }
    if (resolution.kind === 'everyone') {
      for (const memberId of resolution.candidates) {
        add({ targetMemberId: memberId, origin: 'typed', displaySnapshot: '所有人', span: null });
      }
      continue;
    }
    if (resolution.kind === 'ambiguous') {
      ambiguous.push({
        raw: resolution.token.raw,
        candidates: resolution.candidates,
        reason: resolution.reason,
      });
      continue;
    }
    unknownText.push(resolution.token.raw);
    if (resolution.reason.includes('加空格')) hints.push(resolution.reason);
  }

  return { targets, unknownText, ambiguous, stale: Boolean(stale), hints };
}

/**
 * Render a body with mention spans for display: returns segments so the UI can
 * highlight exactly the ranges the server resolved, without re-parsing.
 * @param {string} body
 * @param {Mention[]} mentions
 * @returns {Array<{ text: string, mention: Mention | null }>}
 */
function segmentsForDisplay(body, mentions) {
  const text = String(body ?? '');
  const spans = (mentions ?? [])
    .filter((mention) => mention?.span && Number.isFinite(mention.span.start) && Number.isFinite(mention.span.end))
    .map((mention) => ({ ...mention.span, mention }))
    .sort((a, b) => a.start - b.start);
  if (spans.length === 0) return text ? [{ text, mention: null }] : [];
  /** @type {Array<{ text: string, mention: Mention | null }>} */
  const out = [];
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > cursor) out.push({ text: text.slice(cursor, start), mention: null });
    out.push({ text: text.slice(start, end), mention: span.mention });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), mention: null });
  return out;
}

/**
 * Strip the mention syntax from a body for a compact display label, e.g. the
 * sidebar preview line.
 * @param {string} body
 * @returns {string}
 */
function stripMentionSyntax(body) {
  const text = String(body ?? '');
  const tokens = extractAtTokens(text);
  if (tokens.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const token of tokens) {
    out += text.slice(cursor, token.start);
    cursor = token.end;
  }
  out += text.slice(cursor);
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * @typedef {import('./contracts.js').RoomMember} RoomMember
 * @typedef {import('./contracts.js').MemberId} MemberId
 * @typedef {import('./contracts.js').Mention} Mention
 * @typedef {import('./contracts.js').ParsedAtToken} ParsedAtToken
 * @typedef {import('./contracts.js').MentionResolution} MentionResolution
 */

const V = { ROUTE, ROLE_TEMPLATES, DELIVERY_LABELS, TASK_STATUS_LABELS, MEMBER_STATUS_LABELS, ERROR_LABELS, PROJECT_LIFECYCLE_LABELS, roleTemplate, deliveryLabel, taskLabel, memberLabel };
const M = { MentionResolver, mergeMentions, segmentsForDisplay, stripMentionSyntax, extractAtTokens, maskBody };
/* <<< GENERATED: shared rules <<< */

    // The generated section declares the shared rule names directly in this
    // factory's scope (ROUTE, ROLE_TEMPLATES, roleTemplate, MentionResolver, …), so
    // there is nothing to unpack — re-declaring them here would be a SyntaxError.
    // `V` and `M` are thin views for the code below that reads them namespaced.

    /** Class-name prefix, unique to this plugin. */
    const P = 'dpr_';

    /* ------------------------------------------------------------------ *
     * Styles
     *
     * Theme tokens only, plus the Harness radius / elevation / timing tokens
     * the shipped UI already uses. The surface is a layered "liquid glass":
     * a tinted ambient wash behind three translucent panes, each with a
     * gradient rim instead of a flat border. Light and dark are separate
     * token maps so the panel keeps its depth in both themes.
     * ------------------------------------------------------------------ */
    const CSS_TEMPLATE = `
.${P}root{
  --dpr-blue:var(--dsw-alias-button-info-fill,#4176e6);
  --dpr-surface:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));
  --dpr-glass-a:color-mix(in srgb,var(--dpr-surface) 70%,transparent);
  --dpr-glass-b:color-mix(in srgb,var(--dpr-surface) 44%,transparent);
  --dpr-glass-strong:color-mix(in srgb,var(--dpr-surface) 90%,transparent);
  --dpr-pop-a:color-mix(in srgb,var(--dpr-surface) 97%,transparent);
  --dpr-pop-b:color-mix(in srgb,var(--dpr-surface) 92%,transparent);
  --dpr-blue-soft:color-mix(in srgb,var(--dpr-blue) 11%,transparent);
  --dpr-blue-rim:color-mix(in srgb,var(--dpr-blue) 26%,transparent);
  --dpr-rim-hi:rgba(255,255,255,.72);
  --dpr-rim-lo:rgba(255,255,255,.14);
  --dpr-hairline:color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);
  --dpr-hover:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);
  --dpr-hover-strong:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);
  --dpr-text-2:var(--dsw-alias-label-secondary);
  --dpr-text-3:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));
  --dpr-inset:inset 0 1px 0 rgba(255,255,255,.62);
  --dpr-shadow:0 30px 70px -40px rgba(15,23,42,.55),0 6px 18px -12px rgba(15,23,42,.18);
  --dpr-shadow-soft:0 16px 40px -30px rgba(15,23,42,.45),0 3px 10px -8px rgba(15,23,42,.14);
  --dpr-radius:22px;
  --dpr-fs:1.06;
  --dpr-fs-add:0.5px;
  position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;gap:10px;padding:12px;overflow:hidden;
  color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
  -webkit-font-smoothing:antialiased;
  background:
    radial-gradient(1100px 640px at 2% -12%,color-mix(in srgb,#4d93f8 24%,transparent),transparent 62%),
    radial-gradient(900px 560px at 105% -6%,color-mix(in srgb,#a78bfa 19%,transparent),transparent 58%),
    radial-gradient(820px 620px at 48% 122%,color-mix(in srgb,#38bdf8 15%,transparent),transparent 64%),
    var(--dsw-alias-bg-base);
  container-type:inline-size;container-name:dpr_room;
}
.${P}root[data-text=large]{--dpr-fs:1.14;--dpr-fs-add:0.75px}
.${P}root[data-text=xlarge]{--dpr-fs:1.22;--dpr-fs-add:1px}
body[data-ds-dark-theme] .${P}root{
  --dpr-glass-a:color-mix(in srgb,var(--dpr-surface) 76%,transparent);
  --dpr-glass-b:color-mix(in srgb,var(--dpr-surface) 50%,transparent);
  --dpr-glass-strong:color-mix(in srgb,var(--dpr-surface) 90%,transparent);
  --dpr-rim-hi:rgba(255,255,255,.1);
  --dpr-rim-lo:rgba(255,255,255,.02);
  --dpr-hover:rgba(255,255,255,.07);
  --dpr-hover-strong:rgba(255,255,255,.11);
  --dpr-inset:inset 0 1px 0 rgba(255,255,255,.07);
  --dpr-shadow:0 30px 70px -42px #000,0 6px 22px -14px #000;
  --dpr-shadow-soft:0 16px 40px -30px #000,0 2px 10px -8px #000;
  background:
    radial-gradient(1050px 620px at 2% -12%,color-mix(in srgb,#4d93f8 26%,transparent),transparent 62%),
    radial-gradient(900px 560px at 105% -6%,color-mix(in srgb,#a78bfa 21%,transparent),transparent 58%),
    radial-gradient(820px 620px at 48% 122%,color-mix(in srgb,#38bdf8 15%,transparent),transparent 64%),
    var(--dsw-alias-bg-base);
}
.${P}root,.${P}root *{box-sizing:border-box}
.${P}root :focus-visible{outline:2px solid color-mix(in srgb,var(--dpr-blue) 62%,transparent);outline-offset:2px}
.${P}root ::-webkit-scrollbar{width:8px;height:8px}
.${P}root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 26%,transparent);border:2px solid transparent;border-radius:99px;background-clip:content-box}
.${P}root ::-webkit-scrollbar-thumb:hover{background-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 42%,transparent);background-clip:content-box}
.${P}root ::-webkit-scrollbar-track{background:0 0}
.${P}spacer{flex:1 1 auto}

/* ---------- header ---------- */
.${P}head{
  position:relative;z-index:3;flex:none;display:flex;align-items:center;gap:12px;padding:10px 12px 10px 14px;border-radius:20px;border:1px solid transparent;
  background:linear-gradient(160deg,var(--dpr-glass-a),var(--dpr-glass-b)) padding-box,linear-gradient(160deg,var(--dpr-rim-hi),rgba(255,255,255,0) 36%,rgba(255,255,255,0) 68%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);box-shadow:var(--dpr-inset),var(--dpr-shadow-soft);
}
.${P}brand{display:flex;align-items:center;gap:11px;min-width:0;flex:1 1 auto}
.${P}mark{position:relative;width:38px;height:38px;flex:none;border-radius:13px;display:grid;place-items:center;color:#fff;overflow:hidden;
  background:linear-gradient(145deg,#5b9bff,#4176e6 52%,#6d5efc);
  box-shadow:0 10px 22px -12px #4176e6,inset 0 1px 0 rgba(255,255,255,.5),inset 0 -10px 18px -12px rgba(15,23,42,.55);}
.${P}mark:after{content:"";position:absolute;inset:0;background:linear-gradient(160deg,rgba(255,255,255,.5),transparent 42%);mix-blend-mode:soft-light;pointer-events:none}
.${P}mark svg{width:19px;height:19px;position:relative;z-index:1}
.${P}mark:before{content:"";position:absolute;top:-45%;bottom:-45%;left:-70%;width:60%;background:linear-gradient(100deg,rgba(255,255,255,0),rgba(255,255,255,.5),rgba(255,255,255,0));transform:rotate(10deg);animation:${P}sheen 5.6s var(--ds-ease-in-out) infinite;pointer-events:none;z-index:2}
.${P}markLg{width:46px;height:46px;border-radius:15px}
.${P}markLg svg{width:23px;height:23px}
.${P}brandText{display:flex;flex-direction:column;gap:1px;min-width:0}
.${P}titleRow{display:flex;align-items:center;gap:8px;min-width:0}
.${P}title{margin:0;font-size:16px;font-weight:650;line-height:22px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${P}sub{font-size:11.5px;line-height:16px;color:var(--dpr-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${P}live{display:inline-flex;align-items:center;gap:5px;min-height:19px;padding:0 8px 0 6px;border-radius:999px;font-size:10.5px;font-weight:600;line-height:19px;color:var(--dpr-text-2);background:var(--dpr-hover);border:1px solid var(--dpr-hairline);flex:none}
.${P}liveDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent)}
.${P}liveDot[data-state=paused]{background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent)}
.${P}liveDot[data-state=archived]{background:var(--dpr-text-3);box-shadow:none}
.${P}liveDot[data-state=trashed]{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.${P}headActions{display:flex;align-items:center;gap:7px;flex:none;margin-left:auto;min-width:0}
.${P}textSize{position:relative;display:inline-flex;flex:none}
.${P}textSizeGlyph{font-size:12.5px;font-weight:700;letter-spacing:-.03em;line-height:1}
.${P}textSizeMenu{position:absolute;right:0;top:calc(100% + 7px);z-index:96;width:176px;padding:5px;border-radius:14px;border:1px solid transparent;
  background:linear-gradient(165deg,var(--dpr-pop-a),var(--dpr-pop-b)) padding-box,linear-gradient(165deg,var(--dpr-rim-hi),rgba(255,255,255,0) 40%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(40px) saturate(170%);-webkit-backdrop-filter:blur(40px) saturate(170%);box-shadow:0 26px 60px -28px rgba(15,23,42,.55);animation:${P}pop .14s ease-out}
.${P}textSizeTitle{padding:4px 8px 5px;font-size:9px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--dpr-text-3)}
.${P}textSizeItem{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;line-height:16px;text-align:left;cursor:pointer}
.${P}textSizeItem:hover{background:var(--dpr-hover)}
.${P}textSizeItemOn{background:var(--dpr-blue-soft)}
.${P}textSizeSample{flex:none;width:30px;font-weight:700;line-height:1;color:var(--dpr-text-2);text-align:center}
.${P}textSizeSample[data-size=large]{font-size:14px}
.${P}textSizeSample[data-size=xlarge]{font-size:16px}
.${P}textSizeLabel{flex:1}
.${P}textSizeItem svg{color:var(--dpr-blue)}
.${P}projectActions{position:relative;display:inline-flex;flex:none}
.${P}projectMenu{left:auto;right:0;top:calc(100% + 7px);width:216px}
.${P}projectMenuHead{display:flex;align-items:center;gap:6px;padding:7px 8px 8px;font-size:10.5px;color:var(--dpr-text-2)}
.${P}projectMenuStatus{font-weight:600;color:var(--dsw-alias-label-primary);flex:none}
.${P}projectMenuHead .${P}hint{margin-left:auto;flex:none}

/* ---------- buttons / selects ---------- */
.${P}btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 12px;border-radius:11px;border:1px solid var(--dpr-hairline);background:var(--dpr-glass-strong);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:550;line-height:18px;cursor:pointer;white-space:nowrap;box-shadow:inset 0 1px 0 rgba(255,255,255,.26);transition:background .16s var(--ds-ease-in-out),transform .16s var(--ds-ease-in-out),box-shadow .16s,color .16s,filter .16s}
.${P}btn:hover:not(:disabled){background:var(--dpr-hover-strong);transform:translateY(-1px);box-shadow:0 6px 16px -12px rgba(15,23,42,.6),inset 0 1px 0 rgba(255,255,255,.3)}
.${P}btn:active:not(:disabled){transform:none}
.${P}btn:disabled{opacity:.42;cursor:default;box-shadow:none}
.${P}btn svg{flex:none}
.${P}btnPrimary{border-color:transparent;color:#fff;background:linear-gradient(135deg,#5b9bff,#4176e6 52%,#7c6cf8);box-shadow:0 10px 22px -14px #4176e6,inset 0 1px 0 rgba(255,255,255,.4)}
.${P}btnPrimary:hover:not(:disabled){background:linear-gradient(135deg,#68a5ff,#4176e6 52%,#8a7bff);filter:saturate(1.05);box-shadow:0 14px 26px -14px #4176e6,inset 0 1px 0 rgba(255,255,255,.45)}
.${P}btnGhost{border-color:transparent;background:0 0;box-shadow:none;color:var(--dpr-text-2)}
.${P}btnGhost:hover:not(:disabled){background:var(--dpr-hover);color:var(--dsw-alias-label-primary);transform:none;box-shadow:none}
.${P}btnDanger{color:var(--dsw-alias-state-error-primary)}
.${P}btnDangerSolid{border-color:transparent;color:#fff;background:linear-gradient(135deg,#ef6a6a,#d93a3a 55%,#b91c1c);box-shadow:0 10px 22px -14px #d93a3a,inset 0 1px 0 rgba(255,255,255,.35)}
.${P}btnDangerSolid:hover:not(:disabled){filter:brightness(1.05);box-shadow:0 14px 26px -14px #d93a3a,inset 0 1px 0 rgba(255,255,255,.4)}
.${P}btnDanger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.${P}btnTiny{height:26px;padding:0 9px;border-radius:8px;font-size:11.5px;gap:5px}
.${P}iconBtn{width:34px;height:34px;padding:0;border-radius:11px;display:grid;place-items:center;border:1px solid var(--dpr-hairline);background:var(--dpr-glass-strong);color:var(--dpr-text-2);cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.26);transition:background .16s,color .16s,transform .16s}
.${P}iconBtn:hover{background:var(--dpr-hover-strong);color:var(--dsw-alias-label-primary);transform:translateY(-1px)}
.${P}iconBtn:disabled{opacity:.45;cursor:default;transform:none}
.${P}spin{animation:${P}spin .9s linear infinite}
.${P}selectWrap{position:relative;display:inline-flex;align-items:center;flex:none;min-width:0}
.${P}selectWrap:after{content:"";position:absolute;right:11px;top:50%;width:6px;height:6px;border-right:1.5px solid var(--dpr-text-3);border-bottom:1.5px solid var(--dpr-text-3);border-radius:1px;transform:translateY(-70%) rotate(45deg);pointer-events:none}
.${P}select{appearance:none;-webkit-appearance:none;height:34px;width:100%;max-width:220px;padding:0 30px 0 11px;border-radius:11px;border:1px solid var(--dpr-hairline);background:var(--dpr-glass-strong);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer;outline:none;text-overflow:ellipsis;transition:background .16s,border-color .16s,box-shadow .16s}
.${P}select:hover{background:var(--dpr-hover-strong)}
.${P}select:focus{border-color:var(--dpr-blue-rim);box-shadow:0 0 0 3px var(--dpr-blue-soft)}
.${P}selectBlock{max-width:none}
.${P}roomSelect{flex:1 1 170px;min-width:130px;max-width:260px}
.${P}statusSelect{max-width:118px}
.${P}btnLabel{display:inline}

/* ---------- banners ---------- */
.${P}banners{display:flex;flex-direction:column;gap:6px;flex:none;z-index:2}
.${P}banner{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:12px;border:1px solid var(--dpr-hairline);background:var(--dpr-glass-strong);font-size:11.5px;line-height:17px;color:var(--dpr-text-2);animation:${P}rise .2s var(--ds-ease-in-out) both}
.${P}banner svg{margin-top:1px;flex:none}
.${P}bannerText{flex:1;min-width:0;white-space:pre-wrap}
.${P}bannerAction{flex:none;align-self:center}
.${P}bannerWarn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,var(--dpr-glass-strong));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.${P}bannerErr{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dpr-glass-strong));color:var(--dsw-alias-state-error-primary)}
.${P}bannerOk{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 28%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,var(--dpr-glass-strong));color:var(--dsw-alias-state-success-primary)}
.${P}bannerClose{flex:none;align-self:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:0 0;color:currentColor;cursor:pointer;display:grid;place-items:center;opacity:.75}
.${P}bannerClose:hover{opacity:1;background:var(--dpr-hover)}

/* ---------- columns / panes ---------- */
.${P}cols{position:relative;z-index:1;flex:1;min-height:0;display:grid;grid-template-columns:248px minmax(0,1fr) 312px;gap:10px}
.${P}pane{position:relative;isolation:isolate;display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid transparent;border-radius:var(--dpr-radius);overflow:hidden;
  background:linear-gradient(168deg,var(--dpr-glass-a),var(--dpr-glass-b)) padding-box,linear-gradient(156deg,var(--dpr-rim-hi),rgba(255,255,255,0) 30%,rgba(255,255,255,0) 72%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(34px) saturate(160%);-webkit-backdrop-filter:blur(34px) saturate(160%);box-shadow:var(--dpr-inset),var(--dpr-shadow-soft);}
.${P}pane:before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;pointer-events:none;background:
  radial-gradient(120% 90% at 0% 0%,color-mix(in srgb,var(--dpr-blue) 8%,transparent),transparent 58%),
  radial-gradient(90% 80% at 100% 100%,color-mix(in srgb,#a78bfa 7%,transparent),transparent 62%);}
.${P}paneHead{display:flex;align-items:center;gap:7px;padding:2px 2px 4px;flex:none;min-width:0}
.${P}paneTitle{display:flex;align-items:center;gap:5px;font-size:10px;font-weight:650;letter-spacing:.09em;text-transform:uppercase;color:var(--dpr-text-3);min-width:0}
.${P}count{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 5px;border-radius:999px;background:var(--dpr-hover);color:var(--dpr-text-2);font-size:9.5px;font-weight:600;line-height:1;flex:none}
.${P}paneScroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px;display:flex;flex-direction:column;gap:7px}
.${P}divider{height:1px;flex:none;margin:3px 2px;background:linear-gradient(90deg,transparent,var(--dpr-hairline),transparent)}
.${P}filterTabs{display:flex;gap:2px;padding:2px;border-radius:10px;background:var(--dpr-hover);border:1px solid var(--dpr-hairline);flex:none;margin:0 2px 3px}
.${P}filterTab{flex:1;min-width:0;height:24px;border:1px solid transparent;border-radius:8px;background:0 0;color:var(--dpr-text-3);font:inherit;font-size:9.5px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;padding:0 3px}
.${P}filterTab:hover{color:var(--dsw-alias-label-primary)}
.${P}filterTabOn{background:var(--dpr-glass-strong);color:var(--dsw-alias-label-primary);border-color:var(--dpr-hairline);box-shadow:0 4px 12px -8px rgba(15,23,42,.5),inset 0 1px 0 rgba(255,255,255,.3)}
.${P}filterTab .${P}count{min-width:14px;height:14px;font-size:8px;line-height:14px;padding:0 3px}
.${P}filterLabel{overflow:hidden;text-overflow:ellipsis}
.${P}emptyList{padding:9px 6px;font-size:10.5px;line-height:16px;color:var(--dpr-text-3)}
.${P}roomList{display:flex;flex-direction:column;gap:2px;min-width:0;max-height:min(300px,36vh);overflow-y:auto;padding-right:2px}
.${P}roomRow{position:relative;display:flex;align-items:center;gap:9px;width:100%;padding:8px 9px;border-radius:13px;border:1px solid transparent;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background .15s,border-color .15s}
.${P}roomRow:hover{background:var(--dpr-hover)}
.${P}roomRowOn{background:linear-gradient(100deg,color-mix(in srgb,var(--dpr-blue) 15%,transparent),color-mix(in srgb,var(--dpr-blue) 4%,transparent));border-color:color-mix(in srgb,var(--dpr-blue) 20%,transparent)}
.${P}roomRowOn:before{content:"";position:absolute;left:-1px;top:8px;bottom:8px;width:3px;border-radius:99px;background:var(--dpr-blue);box-shadow:0 0 10px color-mix(in srgb,var(--dpr-blue) 60%,transparent)}
.${P}roomDot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary);margin:0 2px 0 1px}
.${P}roomDot[data-status=active]{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.${P}roomDot[data-status=paused]{background:var(--dsw-alias-state-warn-primary)}
.${P}roomDot[data-status=archived]{background:var(--dpr-text-3)}
.${P}roomDot[data-status=trashed]{background:var(--dsw-alias-state-error-primary)}
.${P}roomDot[data-status=quiescing]{background:var(--dsw-alias-state-warn-primary);animation:${P}pulse 1.2s ease-in-out infinite}
.${P}roomDot[data-status=purging]{background:var(--dsw-alias-state-error-primary);animation:${P}pulse 1.2s ease-in-out infinite}
.${P}roomRow[data-status=trashed] .${P}roomName{color:var(--dpr-text-2)}
.${P}roomRow[data-status=trashed] .${P}roomMeta{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 72%,var(--dpr-text-3))}
.${P}roomText{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.${P}roomName{font-size:12.5px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}roomMeta{font-size:10px;line-height:15px;color:var(--dpr-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------- members ---------- */
.${P}memberList{display:flex;flex-direction:column;gap:1px;min-width:0}
.${P}memberRow{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:14px;border:1px solid transparent;cursor:pointer;transition:background .15s,border-color .15s}
.${P}memberRow:hover{background:var(--dpr-hover)}
.${P}memberRowOn{background:var(--dpr-hover);border-color:var(--dpr-hairline)}
.${P}memberText{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.${P}memberNameRow{display:flex;align-items:center;gap:5px;min-width:0}
.${P}memberName{font-size:12.5px;font-weight:600;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.${P}memberMeta{font-size:10px;line-height:15px;color:var(--dpr-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}memberModel{font-size:9.5px;line-height:14px;color:var(--dpr-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;opacity:.92}
.${P}memberTask{display:flex;align-items:center;gap:4px;font-size:9.5px;line-height:14px;color:var(--dpr-text-3);overflow:hidden;white-space:nowrap}
.${P}memberTask svg{flex:none;opacity:.75}
.${P}memberBadge{margin-left:auto;flex:none;font-size:9px;line-height:15px;min-height:16px;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 24%,transparent);font-weight:600}
.${P}avatar{position:relative;flex:none;width:30px;height:30px;padding:0;border:0;border-radius:50%;display:grid;place-items:center;font:inherit;font-size:11.5px;font-weight:650;color:#fff;line-height:1;cursor:context-menu;user-select:none;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 5px 12px -7px rgba(15,23,42,.6);transition:transform .15s,box-shadow .15s}
.${P}avatar:hover{transform:translateY(-1px) scale(1.04);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 8px 16px -8px rgba(15,23,42,.6)}
.${P}avatar:after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(160deg,rgba(255,255,255,.28),transparent 55%);pointer-events:none}
.${P}avatarLg{width:34px;height:34px;font-size:13px}
.${P}avatarSm{width:24px;height:24px;font-size:10px}
.${P}avatarDot{position:absolute;right:-1px;bottom:-1px;width:9px;height:9px;border-radius:50%;border:2px solid var(--dsw-alias-bg-base);z-index:2}
.${P}avatarDot[data-tone=working]{background:var(--dsw-alias-state-success-primary)}
.${P}avatarDot[data-tone=waiting]{background:var(--dsw-alias-state-warn-primary)}
.${P}avatarDot[data-tone=user]{background:var(--dsw-alias-state-error-primary)}
.${P}avatarDot[data-tone=paused]{background:var(--dpr-text-3)}
.${P}avatarDot[data-tone=idle]{background:var(--dsw-alias-state-idle-primary)}
.${P}aiTag{flex:none;display:inline-flex;align-items:center;min-height:14px;padding:0 4px;border-radius:5px;font-size:8.5px;font-weight:650;letter-spacing:.04em;color:var(--dpr-blue);background:var(--dpr-blue-soft);border:1px solid var(--dpr-blue-rim)}
.${P}roleDot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dpr-role,var(--dpr-blue))}

/* ---------- member detail ---------- */
.${P}detail{border:1px solid var(--dpr-hairline);border-radius:16px;background:var(--dpr-glass-strong);padding:11px;display:flex;flex-direction:column;gap:8px;box-shadow:inset 0 1px 0 rgba(255,255,255,.22);animation:${P}pop .18s ease-out;margin-top:2px}
.${P}detailHead{display:flex;align-items:center;gap:8px;min-width:0}
.${P}detailName{font-size:13px;font-weight:650;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}detailRole{font-size:10px;color:var(--dpr-text-3)}
.${P}kv{display:flex;gap:8px;font-size:10.5px;line-height:16px;color:var(--dpr-text-2)}
.${P}kvKey{flex:none;width:52px;color:var(--dpr-text-3)}
.${P}kvVal{min-width:0;word-break:break-all}
.${P}mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:9.5px;letter-spacing:-.01em}
.${P}field{display:flex;flex-direction:column;gap:4px;min-width:0}
.${P}label{font-size:10px;font-weight:600;color:var(--dpr-text-3);letter-spacing:.02em;line-height:15px}
.${P}input{width:100%;box-sizing:border-box;height:34px;padding:0 10px;border-radius:10px;border:1px solid var(--dpr-hairline);background:var(--dpr-glass-strong);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none;transition:border-color .16s,box-shadow .16s,background .16s}
.${P}input:hover{background:var(--dpr-hover-strong)}
.${P}input:focus{border-color:var(--dpr-blue-rim);box-shadow:0 0 0 3px var(--dpr-blue-soft)}
.${P}input::placeholder{color:var(--dpr-text-3)}
textarea.${P}input{height:auto;min-height:64px;padding:8px 10px;line-height:19px;resize:vertical}
.${P}hint{font-size:9.5px;line-height:14px;color:var(--dpr-text-3)}
.${P}detailActions{display:flex;flex-wrap:wrap;gap:5px}

/* ---------- timeline ---------- */
.${P}timeline{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:8px 16px 6px;display:flex;flex-direction:column;gap:2px}
.${P}day{display:flex;align-items:center;gap:10px;padding:8px 0 6px;flex:none;color:var(--dpr-text-3);font-size:9.5px;font-weight:600;letter-spacing:.05em}
.${P}day:before,.${P}day:after{content:"";flex:1;height:1px;background:linear-gradient(90deg,transparent,var(--dpr-hairline),transparent)}
.${P}msg{position:relative;display:flex;align-items:flex-start;gap:10px;padding:5px 6px;border-radius:14px;transition:background .15s}
.${P}msg:hover{background:var(--dpr-hover)}
.${P}msgSelf{flex-direction:row-reverse}
.${P}msgBody{display:flex;flex-direction:column;gap:2px;min-width:0;max-width:min(84%,660px)}
.${P}msgSelf .${P}msgBody{align-items:flex-end}
.${P}msgHead{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.${P}msgSelf .${P}msgHead{justify-content:flex-end}
.${P}author{font-size:12px;font-weight:650;line-height:17px;color:var(--dsw-alias-label-primary)}
.${P}roleTag{font-size:9.5px;line-height:15px;color:var(--dpr-text-3)}
.${P}timeTag{font-size:9px;line-height:14px;color:var(--dpr-text-3);font-variant-numeric:tabular-nums;opacity:.85}
.${P}msgActions{margin-left:auto;display:flex;align-items:center;gap:2px;opacity:0;transition:opacity .12s}
.${P}msg:hover .${P}msgActions{opacity:1}
.${P}msgSelf .${P}msgActions{margin-left:0;margin-right:auto}
.${P}actionBtn{height:22px;padding:0 6px;border:0;border-radius:6px;background:0 0;color:var(--dpr-text-3);font:inherit;font-size:9.5px;cursor:pointer;display:inline-flex;align-items:center;gap:3px}
.${P}actionBtn:hover{background:var(--dpr-hover-strong);color:var(--dsw-alias-label-primary)}
.${P}text{font-size:13px;line-height:21px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);min-width:0}
.${P}msgSelf .${P}text{padding:8px 12px;border-radius:16px 16px 5px 16px;background:linear-gradient(150deg,color-mix(in srgb,var(--dpr-blue) 15%,var(--dpr-surface)),color-mix(in srgb,var(--dpr-blue) 8%,var(--dpr-surface)));border:1px solid color-mix(in srgb,var(--dpr-blue) 18%,transparent);box-shadow:0 8px 22px -20px rgba(15,23,42,.6)}
.${P}prose{white-space:pre-wrap;overflow-wrap:anywhere}
.${P}prose+.${P}prose{margin-top:6px}
.${P}inlineCode{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;padding:1px 4px;border-radius:5px;background:var(--dpr-hover);border:1px solid var(--dpr-hairline)}
.${P}bold{font-weight:650}
.${P}codeBlock{margin:6px 0;border:1px solid var(--dpr-hairline);border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-bg-base) 64%,transparent)}
.${P}codeHead{display:flex;align-items:center;gap:6px;padding:4px 9px;border-bottom:1px solid var(--dpr-hairline);background:var(--dpr-hover);font-size:9px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--dpr-text-3)}
.${P}pre{margin:0;padding:9px 11px;overflow-x:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre;tab-size:2}
.${P}mention{color:var(--dpr-blue);background:var(--dpr-blue-soft);border-radius:5px;padding:0 3px;font-weight:600;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.${P}replyRef{display:flex;align-items:center;gap:6px;max-width:100%;padding:4px 8px;border-radius:8px;background:var(--dpr-hover);border-left:2px solid var(--dpr-blue-rim);font-size:10px;line-height:15px;color:var(--dpr-text-2);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.${P}replyRef b{font-weight:600;color:var(--dpr-text-2)}
.${P}chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
.${P}chip{display:inline-flex;align-items:center;gap:4px;min-height:18px;padding:0 7px;border-radius:999px;border:1px solid var(--dpr-hairline);background:var(--dpr-glass-strong);color:var(--dpr-text-2);font-size:9px;line-height:16px;white-space:nowrap;font-weight:500}
.${P}chipOk{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.${P}chipWarn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.${P}chipErr{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary)}
.${P}chipBlue{border-color:var(--dpr-blue-rim);background:var(--dpr-blue-soft);color:var(--dpr-blue)}
.${P}sys{align-self:center;max-width:88%;margin:4px 0;padding:4px 11px;border-radius:999px;background:var(--dpr-hover);border:1px solid var(--dpr-hairline);font-size:10px;line-height:16px;color:var(--dpr-text-3);text-align:center;white-space:pre-wrap}
.${P}streamEmpty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:36px 20px;text-align:center;color:var(--dpr-text-3)}
.${P}streamEmptyTitle{font-size:14px;font-weight:600;color:var(--dpr-text-2)}
.${P}streamEmptyText{font-size:11px;line-height:18px;max-width:320px}

/* ---------- composer ---------- */
.${P}composerWrap{flex:none;position:relative;padding:0 12px 12px}
.${P}composer{position:relative;display:flex;flex-direction:column;gap:4px;padding:9px 11px 9px;border-radius:18px;border:1px solid transparent;
  background:linear-gradient(160deg,var(--dpr-glass-strong),var(--dpr-glass-a)) padding-box,linear-gradient(160deg,var(--dpr-rim-hi),rgba(255,255,255,0) 38%,rgba(255,255,255,0) 74%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(32px) saturate(160%);-webkit-backdrop-filter:blur(32px) saturate(160%);box-shadow:var(--dpr-inset),var(--dpr-shadow-soft);transition:box-shadow .2s}
.${P}composer:focus-within{box-shadow:0 0 0 3px color-mix(in srgb,var(--dpr-blue) 14%,transparent),0 18px 40px -30px rgba(15,23,42,.5)}
.${P}replyBar{display:flex;align-items:center;gap:7px;padding:4px 7px;border-radius:8px;background:var(--dpr-blue-soft);border:1px solid var(--dpr-blue-rim);font-size:10px;line-height:15px;color:var(--dpr-text-2);min-width:0}
.${P}replyBarText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}readonlyBar{display:flex;align-items:center;gap:8px;padding:5px 7px;font-size:11.5px;line-height:17px;color:var(--dpr-text-2)}
.${P}readonlyBar svg{flex:none;color:var(--dpr-text-3)}
.${P}editorRow{display:flex;align-items:flex-end;gap:8px;min-width:0}
.${P}textarea{flex:1;min-width:0;border:0;background:0 0;outline:0;resize:none;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);min-height:40px;max-height:168px;padding:3px 2px;overflow-y:auto}
.${P}textarea::placeholder{color:var(--dpr-text-3)}
.${P}send{flex:none;width:34px;height:34px;border:0;border-radius:50%;display:grid;place-items:center;color:#fff;cursor:pointer;background:linear-gradient(145deg,#64a1ff,#4176e6 55%,#7c6cf8);box-shadow:0 9px 20px -10px #4176e6,inset 0 1px 0 rgba(255,255,255,.42);transition:transform .15s,filter .15s,opacity .15s}
.${P}send:hover:not(:disabled){transform:translateY(-1px) scale(1.04);filter:brightness(1.05)}
.${P}send:active:not(:disabled){transform:none}
.${P}send:disabled{opacity:.38;cursor:default;box-shadow:none}
.${P}composerFoot{display:flex;align-items:center;gap:8px;min-width:0;padding:0 1px}
.${P}footInfo{display:flex;align-items:center;gap:5px;min-width:0;font-size:9.5px;line-height:14px;color:var(--dpr-text-3);overflow:hidden}
.${P}footInfo span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}footHint{flex:none;font-size:9px;color:var(--dpr-text-3);opacity:.85}
.${P}mChip{display:inline-flex;align-items:center;gap:4px;min-height:22px;padding:0 4px 0 8px;border-radius:999px;background:var(--dpr-blue-soft);border:1px solid var(--dpr-blue-rim);font-size:10px;line-height:20px;color:var(--dsw-alias-label-primary)}
.${P}mChipX{width:18px;height:18px;border:0;border-radius:50%;background:0 0;color:var(--dpr-text-2);font:inherit;font-size:12px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0}
.${P}mChipX:hover{background:var(--dpr-hover-strong);color:var(--dsw-alias-label-primary)}
.${P}chipsRow{display:flex;flex-wrap:wrap;gap:5px;padding-bottom:2px}
.${P}picker{position:absolute;left:12px;right:12px;bottom:calc(100% + 8px);z-index:45;max-height:300px;overflow-y:auto;padding:5px;border-radius:16px;border:1px solid transparent;
  background:linear-gradient(165deg,var(--dpr-pop-a),var(--dpr-pop-b)) padding-box,linear-gradient(165deg,var(--dpr-rim-hi),rgba(255,255,255,0) 40%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(40px) saturate(170%);-webkit-backdrop-filter:blur(40px) saturate(170%);box-shadow:0 30px 70px -30px rgba(15,23,42,.55);animation:${P}pop .16s ease-out}
.${P}pickerItem{display:flex;align-items:center;gap:9px;width:100%;padding:6px 8px;border:1px solid transparent;border-radius:10px;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.${P}pickerItem:hover,.${P}pickerItemOn{background:var(--dpr-blue-soft);border-color:var(--dpr-blue-rim)}
.${P}pickerText{display:flex;flex-direction:column;gap:0;min-width:0}
.${P}pickerName{font-size:12px;font-weight:600;line-height:17px}
.${P}pickerMeta{font-size:9.5px;line-height:14px;color:var(--dpr-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}pickerHint{padding:5px 8px 2px;margin-top:3px;border-top:1px solid var(--dpr-hairline);font-size:9px;line-height:14px;color:var(--dpr-text-3)}
.${P}spinner{display:inline-block;vertical-align:middle;width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 24%,transparent);border-top-color:currentColor;animation:${P}spin .8s linear infinite}

/* ---------- context menu ---------- */
.${P}menu{position:absolute;z-index:90;width:214px;padding:5px;border-radius:15px;border:1px solid transparent;
  background:linear-gradient(165deg,var(--dpr-pop-a),var(--dpr-pop-b)) padding-box,linear-gradient(165deg,var(--dpr-rim-hi),rgba(255,255,255,0) 40%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(40px) saturate(170%);-webkit-backdrop-filter:blur(40px) saturate(170%);box-shadow:0 26px 60px -28px rgba(15,23,42,.55);animation:${P}pop .14s ease-out}
.${P}menuHead{display:flex;align-items:center;gap:8px;padding:6px 7px 7px}
.${P}menuHeadText{display:flex;flex-direction:column;min-width:0}
.${P}menuName{font-size:12px;font-weight:650;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}menuHandle{font-size:9px;line-height:13px;color:var(--dpr-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}menuItem{display:flex;align-items:center;gap:7px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;line-height:16px;text-align:left;cursor:pointer}
.${P}menuItem svg{color:var(--dpr-text-3);flex:none}
.${P}menuItem:hover{background:var(--dpr-blue-soft)}
.${P}menuItem:hover svg{color:var(--dpr-blue)}
.${P}menuItemDanger{color:var(--dsw-alias-state-error-primary)}
.${P}menuItemDanger svg{color:currentColor}
.${P}menuItemDanger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.${P}menuSep{height:1px;margin:3px 6px;background:var(--dpr-hairline)}

/* ---------- right rail ---------- */
.${P}rail{display:flex;flex-direction:column;min-height:0;flex:1;padding:10px;gap:8px;overflow:hidden}
.${P}tabs{display:flex;gap:3px;padding:3px;border-radius:12px;background:var(--dpr-hover);border:1px solid var(--dpr-hairline);flex:none}
.${P}tab{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:29px;border:1px solid transparent;border-radius:9px;background:0 0;color:var(--dpr-text-2);font:inherit;font-size:11.5px;font-weight:550;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.${P}tab:hover{color:var(--dsw-alias-label-primary)}
.${P}tabOn{background:var(--dpr-glass-strong);color:var(--dsw-alias-label-primary);border-color:var(--dpr-hairline);box-shadow:0 4px 12px -8px rgba(15,23,42,.5),inset 0 1px 0 rgba(255,255,255,.3)}
.${P}tabCount{min-width:15px;min-height:15px;padding:0 4px;border-radius:999px;background:var(--dpr-hover-strong);font-size:8.5px;font-weight:600;line-height:15px;color:var(--dpr-text-2)}
.${P}railScroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:2px 2px 6px}
.${P}section{display:flex;flex-direction:column;gap:7px;min-width:0}
.${P}sectionTitle{margin:0;font-size:9.5px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--dpr-text-3);display:flex;align-items:center;gap:5px}
.${P}progressCard{position:relative;border:1px solid var(--dpr-hairline);border-radius:15px;padding:11px 12px;background:linear-gradient(150deg,color-mix(in srgb,var(--dpr-blue) 9%,var(--dpr-glass-strong)),var(--dpr-glass-strong));overflow:hidden}
.${P}progressTop{display:flex;align-items:flex-end;justify-content:space-between;gap:8px}
.${P}pct{font-size:26px;font-weight:650;line-height:26px;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.${P}pct small{font-size:11px;font-weight:600;color:var(--dpr-text-3);margin-left:1px}
.${P}progressMeta{font-size:9.5px;line-height:15px;color:var(--dpr-text-3);text-align:right}
.${P}bar{height:5px;border-radius:999px;background:var(--dpr-hover);overflow:hidden;margin-top:9px}
.${P}barFill{height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--dpr-blue),#8b5cf6);transition:width .5s var(--ds-ease-in-out);box-shadow:0 0 8px color-mix(in srgb,var(--dpr-blue) 40%,transparent)}
.${P}task{border:1px solid var(--dpr-hairline);border-radius:13px;padding:8px 9px;background:var(--dpr-glass-strong);display:flex;flex-direction:column;gap:4px;transition:border-color .15s,transform .15s}
.${P}task:hover{border-color:color-mix(in srgb,var(--dpr-blue) 26%,transparent);transform:translateY(-1px)}
.${P}taskTop{display:flex;align-items:flex-start;gap:6px;min-width:0}
.${P}taskObj{flex:1;min-width:0;font-size:11px;font-weight:550;line-height:16px;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.${P}taskMeta{display:flex;flex-wrap:wrap;gap:2px 7px;font-size:9px;line-height:14px;color:var(--dpr-text-3)}
.${P}taskMeta b{font-weight:600;color:var(--dpr-text-2)}
.${P}taskAccept{font-size:9px;line-height:14px;color:var(--dpr-text-3);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.${P}status{display:inline-flex;align-items:center;gap:4px;min-height:17px;padding:0 6px;border-radius:999px;font-size:8.5px;font-weight:600;line-height:17px;white-space:nowrap;flex:none;border:1px solid var(--dpr-hairline);background:var(--dpr-hover);color:var(--dpr-text-2)}
.${P}status:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.9}
.${P}statusOk{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.${P}statusWarn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.${P}statusErr{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary)}
.${P}statusBlue{border-color:var(--dpr-blue-rim);background:var(--dpr-blue-soft);color:var(--dpr-blue)}
.${P}decision{border:1px solid var(--dpr-hairline);border-radius:13px;padding:9px 10px;background:var(--dpr-glass-strong);display:flex;flex-direction:column;gap:4px}
.${P}decisionTop{display:flex;align-items:center;gap:5px;font-size:9px;color:var(--dpr-text-3)}
.${P}decisionText{font-size:11px;line-height:17px;color:var(--dsw-alias-label-primary);white-space:pre-wrap}
.${P}details{border:1px solid var(--dpr-hairline);border-radius:13px;background:var(--dpr-glass-strong);overflow:hidden}
.${P}details>summary{list-style:none;display:flex;align-items:center;gap:6px;padding:8px 10px;font-size:10px;font-weight:600;color:var(--dpr-text-2);cursor:pointer}
.${P}details>summary::-webkit-details-marker{display:none}
.${P}details[open]>summary{border-bottom:1px solid var(--dpr-hairline)}
.${P}detailsBody{padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.${P}form{display:flex;flex-direction:column;gap:10px}
.${P}choiceRow{display:flex;flex-direction:column;gap:5px}
.${P}choice{display:flex;align-items:flex-start;gap:7px;padding:7px 9px;border:1px solid var(--dpr-hairline);border-radius:11px;background:var(--dpr-glass-strong);cursor:pointer;font-size:10px;line-height:15px;color:var(--dpr-text-2)}
.${P}choice:has(input:checked){border-color:var(--dpr-blue-rim);background:var(--dpr-blue-soft);color:var(--dsw-alias-label-primary)}
.${P}choice input{margin:2px 0 0;accent-color:var(--dpr-blue);flex:none}
.${P}choice b{display:block;font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:1px}
.${P}pool{border:1px solid var(--dpr-hairline);border-radius:11px;background:var(--dpr-glass-strong);max-height:150px;overflow-y:auto;padding:4px}
.${P}poolRow{display:flex;align-items:flex-start;gap:6px;padding:4px 5px;border-radius:7px;font-size:9.5px;line-height:14px;color:var(--dpr-text-2);cursor:pointer}
.${P}poolRow:hover{background:var(--dpr-hover)}
.${P}poolRow input{margin-top:1px;accent-color:var(--dpr-blue);flex:none}
.${P}note{font-size:9.5px;line-height:15px;color:var(--dpr-text-3);padding:6px 8px;border-radius:8px;background:var(--dpr-hover)}
.${P}noteOk{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent);color:var(--dsw-alias-state-success-primary)}
.${P}noteErr{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary)}
.${P}modelRow{display:flex;align-items:center;gap:7px;min-width:0;padding:1px 0}
.${P}modelRole{flex:none;width:52px;font-size:10px;color:var(--dpr-text-2);display:flex;align-items:center;gap:5px;overflow:hidden;white-space:nowrap}

/* ---------- create room ---------- */
.${P}createWrap{position:relative;z-index:1;flex:1;min-height:0;overflow-y:auto;display:flex;align-items:flex-start;justify-content:center;padding:18px}
.${P}createCard{width:100%;max-width:640px;border:1px solid transparent;border-radius:26px;padding:24px;display:flex;flex-direction:column;gap:16px;
  background:linear-gradient(165deg,var(--dpr-glass-a),var(--dpr-glass-b)) padding-box,linear-gradient(155deg,var(--dpr-rim-hi),rgba(255,255,255,0) 30%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(34px) saturate(150%);-webkit-backdrop-filter:blur(34px) saturate(150%);box-shadow:var(--dpr-inset),var(--dpr-shadow);animation:${P}rise .3s var(--ds-ease-in-out) both}
.${P}createHead{display:flex;align-items:center;gap:12px}
.${P}createTitle{margin:0;font-size:21px;font-weight:650;line-height:28px;letter-spacing:-.02em}
.${P}createSub{font-size:11.5px;line-height:17px;color:var(--dpr-text-2)}
.${P}formGrid{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.${P}fieldFull{grid-column:1/-1}
.${P}roleGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(136px,1fr));gap:6px}
.${P}roleCard{position:relative;display:flex;align-items:flex-start;gap:7px;padding:8px 9px;border-radius:11px;border:1px solid var(--dpr-hairline);background:var(--dpr-glass-strong);cursor:pointer;user-select:none;transition:background .15s,border-color .15s,box-shadow .15s}
.${P}roleCard:hover{background:var(--dpr-hover)}
.${P}roleCard:has(input:checked){border-color:var(--dpr-blue-rim);background:var(--dpr-blue-soft);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dpr-blue) 12%,transparent)}
.${P}roleCard input{position:absolute;opacity:0;pointer-events:none}
.${P}roleCheck{width:15px;height:15px;flex:none;border-radius:5px;border:1px solid var(--dpr-hairline);display:grid;place-items:center;margin-top:1px;color:#fff;background:var(--dpr-glass-strong);transition:background .15s,border-color .15s}
.${P}roleCard:has(input:checked) .${P}roleCheck{background:var(--dpr-blue);border-color:transparent}
.${P}roleCheck svg{opacity:0;width:10px;height:10px}
.${P}roleCard:has(input:checked) .${P}roleCheck svg{opacity:1}
.${P}roleText{display:flex;flex-direction:column;gap:0;min-width:0}
.${P}roleTitle{font-size:11.5px;font-weight:600;line-height:16px;color:var(--dsw-alias-label-primary)}
.${P}roleDuty{font-size:9px;line-height:13px;color:var(--dpr-text-3);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.${P}createFoot{display:flex;align-items:center;gap:8px;padding-top:4px;border-top:1px solid var(--dpr-hairline);flex-wrap:wrap}

/* ---------- empty / loading ---------- */
.${P}emptyPane{position:relative;z-index:1;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:20px}
.${P}emptyCard{width:100%;max-width:520px;text-align:center;padding:36px 30px;border:1px solid transparent;border-radius:26px;display:flex;flex-direction:column;align-items:center;gap:11px;
  background:linear-gradient(165deg,var(--dpr-glass-a),var(--dpr-glass-b)) padding-box,linear-gradient(155deg,var(--dpr-rim-hi),rgba(255,255,255,0) 32%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(34px) saturate(150%);-webkit-backdrop-filter:blur(34px) saturate(150%);box-shadow:var(--dpr-inset),var(--dpr-shadow)}
.${P}emptyArt{width:74px;height:74px;border-radius:24px;display:grid;place-items:center;color:#fff;background:linear-gradient(145deg,#5b9bff,#4176e6 52%,#7c6cf8);box-shadow:0 20px 40px -22px #4176e6,inset 0 1px 0 rgba(255,255,255,.45)}
.${P}emptyArt svg{width:34px;height:34px}
.${P}emptyTitle{font-size:18px;font-weight:650;line-height:24px}
.${P}emptyText{font-size:11.5px;line-height:18px;color:var(--dpr-text-2);max-width:380px}
.${P}loadingSpinner{color:var(--dpr-blue)}

/* ---------- drawer ---------- */
.${P}scrim{position:absolute;inset:0;z-index:50;background:color-mix(in srgb,var(--dsw-alias-bg-base) 30%,rgba(15,23,42,.4));backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:${P}fade .18s ease-out}
.${P}drawer{position:absolute;z-index:51;top:12px;right:12px;bottom:12px;width:min(420px,calc(100% - 24px));display:flex;flex-direction:column;border:1px solid transparent;border-radius:22px;overflow:hidden;
  background:linear-gradient(165deg,var(--dpr-glass-strong),var(--dpr-glass-a)) padding-box,linear-gradient(155deg,var(--dpr-rim-hi),rgba(255,255,255,0) 32%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(40px) saturate(160%);-webkit-backdrop-filter:blur(40px) saturate(160%);box-shadow:var(--dpr-inset),var(--dpr-shadow);animation:${P}slideIn .22s var(--ds-ease-in-out) both}
.${P}drawerHead{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dpr-hairline);flex:none}
.${P}drawerTitle{font-size:13px;font-weight:650;line-height:18px;flex:1;min-width:0}
.${P}drawerBody{flex:1;min-height:0;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.${P}showMembers,.${P}showBoard{display:none}

/* ---------- deep research (deep research) ---------- */
.${P}researchCard{flex:none;margin:8px 10px 0;border:1px solid transparent;border-radius:16px;overflow:hidden;max-height:46%;display:flex;flex-direction:column;
  background:linear-gradient(165deg,var(--dpr-pop-a),var(--dpr-pop-b)) padding-box,linear-gradient(150deg,var(--dpr-rim-hi),rgba(255,255,255,0) 34%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(26px) saturate(155%);-webkit-backdrop-filter:blur(26px) saturate(155%);box-shadow:var(--dpr-inset),0 14px 32px -28px rgba(15,23,42,.75)}
.${P}researchPending{border-color:color-mix(in srgb,var(--dpr-blue) 36%,transparent);box-shadow:var(--dpr-inset),0 0 0 1px color-mix(in srgb,var(--dpr-blue) 18%,transparent),0 16px 34px -26px color-mix(in srgb,var(--dpr-blue) 55%,transparent)}
.${P}researchHead{display:flex;align-items:flex-start;gap:9px;padding:10px 12px;flex:none;border-bottom:1px solid var(--dpr-hairline)}
.${P}researchIcon{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;flex:none;color:var(--dpr-blue);background:var(--dpr-blue-soft);border:1px solid var(--dpr-blue-rim)}
.${P}researchHeadText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.${P}researchTitleRow{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.${P}researchBadge{flex:none;font-size:8.5px;line-height:13px;padding:1px 6px;border-radius:99px;color:var(--dpr-blue);background:var(--dpr-blue-soft);border:1px solid var(--dpr-blue-rim);font-weight:650}
.${P}researchPending .${P}researchBadge{color:#a16207;background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.3)}
.${P}researchTitle{font-size:12.5px;font-weight:650;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.${P}researchStatus{flex:none;font-size:9px;line-height:14px;padding:1px 5px;border-radius:99px;color:var(--dpr-text-3);background:var(--dpr-hover);border:1px solid var(--dpr-hairline)}
.${P}researchStatus[data-status=RUNNING]{color:#15803d;background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.25)}
.${P}researchStatus[data-status=APPROVED]{color:var(--dpr-blue);background:var(--dpr-blue-soft);border-color:var(--dpr-blue-rim)}
.${P}researchStatus[data-status=PAUSED]{color:#a16207;background:rgba(251,191,36,.1);border-color:rgba(251,191,36,.25)}
.${P}researchMeta{font-size:9.5px;line-height:14px;color:var(--dpr-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}researchToggle{flex:none;height:22px;padding:0 6px;border:1px solid var(--dpr-hairline);border-radius:7px;background:var(--dpr-hover);color:var(--dpr-text-2);font:inherit;font-size:9px;cursor:pointer}
.${P}researchToggle:hover{background:var(--dpr-hover-strong);color:var(--dsw-alias-label-primary)}
.${P}researchBody{padding:9px 12px;display:flex;flex-direction:column;gap:7px;overflow-y:auto;min-height:0}
.${P}researchObjective{font-size:11px;line-height:17px;color:var(--dsw-alias-label-primary);white-space:pre-wrap}
.${P}researchWhy{font-size:10px;line-height:16px;color:var(--dpr-text-2);white-space:pre-wrap}
.${P}researchFacts{display:flex;flex-wrap:wrap;gap:4px 8px}
.${P}researchFact{display:inline-flex;align-items:center;gap:3px;font-size:9px;line-height:14px;color:var(--dpr-text-3);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}researchFact svg{flex:none;opacity:.8}
.${P}researchWarning{font-size:9.5px;line-height:15px;padding:6px 8px;border-radius:8px;color:#a16207;background:rgba(251,191,36,.09);border:1px solid rgba(251,191,36,.24)}
.${P}researchOutcome{font-size:10px;line-height:16px;padding:6px 8px;border-radius:8px;color:var(--dpr-text-2);background:var(--dpr-hover);border:1px solid var(--dpr-hairline)}
.${P}researchError{font-size:10px;line-height:15px;color:var(--dsw-alias-state-error-primary);padding:5px 7px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent)}
.${P}researchDetails{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dpr-hairline);padding-top:8px}
.${P}researchDetailSection{display:flex;flex-direction:column;gap:3px;min-width:0}
.${P}researchList{margin:0;padding-left:15px;font-size:9.5px;line-height:15px;color:var(--dpr-text-2);word-break:break-word}
.${P}researchList li+li{margin-top:2px}
.${P}researchActions{flex:none;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 12px;border-top:1px solid var(--dpr-hairline);background:color-mix(in srgb,var(--dpr-glass-strong) 55%,transparent)}
.${P}researchActions .${P}btn{height:28px}
.${P}researchFieldGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:7px}
.${P}researchField{display:flex;flex-direction:column;gap:4px;min-width:0}
.${P}researchField .${P}input,.${P}researchField textarea{width:100%;box-sizing:border-box}
.${P}researchField textarea{min-height:66px;resize:vertical;font:inherit}

/* ---------- lifecycle dialogs ---------- */
.${P}modalScrim{position:absolute;inset:0;z-index:100;background:color-mix(in srgb,var(--dsw-alias-bg-base) 28%,rgba(15,23,42,.52));backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);animation:${P}fade .16s ease-out}
.${P}modal{position:absolute;z-index:101;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,calc(100% - 28px));max-height:calc(100% - 28px);display:flex;flex-direction:column;border:1px solid transparent;border-radius:22px;overflow:hidden;
  background:linear-gradient(165deg,var(--dpr-pop-a),var(--dpr-pop-b)) padding-box,linear-gradient(155deg,var(--dpr-rim-hi),rgba(255,255,255,0) 32%,var(--dpr-rim-lo)) border-box;
  backdrop-filter:blur(40px) saturate(160%);-webkit-backdrop-filter:blur(40px) saturate(160%);box-shadow:var(--dpr-inset),var(--dpr-shadow);animation:${P}pop .18s var(--ds-ease-in-out)}
.${P}modalDanger{top:calc(50% - 50px);max-height:calc(100% - 110px);box-shadow:var(--dpr-inset),0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent),var(--dpr-shadow)}
.${P}modalHead{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--dpr-hairline);flex:none}
.${P}modalIcon{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;flex:none;color:var(--dpr-blue);background:var(--dpr-blue-soft);border:1px solid var(--dpr-blue-rim)}
.${P}modalDanger .${P}modalIcon{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent)}
.${P}modalTitle{flex:1;min-width:0;font-size:14px;font-weight:650;line-height:20px}
.${P}modalBody{padding:13px 14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;min-height:0}
.${P}modalText{font-size:11.5px;line-height:19px;color:var(--dpr-text-2);white-space:pre-wrap}
.${P}modalWarning{display:flex;align-items:flex-start;gap:7px;padding:8px 10px;border-radius:11px;font-size:11px;line-height:17px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent)}
.${P}modalWarning svg{flex:none;margin-top:1px}
.${P}modalStats{display:grid;grid-template-columns:repeat(auto-fit,minmax(64px,1fr));gap:5px}
.${P}stat{display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 4px;border-radius:9px;background:var(--dpr-hover);border:1px solid var(--dpr-hairline);min-width:0}
.${P}statValue{font-size:15px;font-weight:650;line-height:19px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.${P}statLabel{font-size:9px;line-height:13px;color:var(--dpr-text-3);white-space:nowrap}
.${P}modalSection{display:flex;flex-direction:column;gap:4px;min-width:0}
.${P}modalList{margin:0;padding-left:16px;font-size:10.5px;line-height:17px;color:var(--dpr-text-2);word-break:break-word}
.${P}modalList li+li{margin-top:2px}
.${P}modalField{display:flex;flex-direction:column;gap:5px}
.${P}modalCheck{display:flex;align-items:flex-start;gap:7px;font-size:10.5px;line-height:17px;color:var(--dpr-text-2);cursor:pointer}
.${P}modalCheck input{margin-top:2px;accent-color:var(--dpr-blue);flex:none}
.${P}modalFoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 14px;border-top:1px solid var(--dpr-hairline);flex:none}
.${P}modalFoot .${P}hint{flex:1 1 180px;min-width:0}
.${P}modalFoot .${P}btn{flex:none}

/* ---------- responsive (container, not viewport) ---------- */
@container dpr_room (max-width:1260px){
  .${P}cols{grid-template-columns:240px minmax(0,1fr)}
  .${P}right{display:none}
  .${P}showBoard{display:inline-flex}
}
@container dpr_room (max-width:920px){
  .${P}cols{grid-template-columns:minmax(0,1fr)}
  .${P}left{display:none}
  .${P}showMembers{display:inline-flex}
  .${P}headSub{display:none}
}
@container dpr_room (max-width:720px){
  .${P}head{flex-wrap:wrap;gap:8px;padding:9px 10px}
  .${P}brand{flex:1 1 100%}
  .${P}headActions{flex:1 1 100%;justify-content:flex-end;flex-wrap:wrap;margin-left:0}
  .${P}select{max-width:none}
  .${P}btnNew .${P}btnLabel{display:none}
  .${P}btnNew{width:34px;padding:0}
  .${P}live{display:none}
  .${P}roomSelect{flex:1 1 140px}
}
@container dpr_room (max-width:560px){
  .${P}root{padding:8px;gap:8px}
  .${P}timeline{padding:6px 8px 4px}
  .${P}composerWrap{padding:0 6px 8px}
  .${P}footHint{display:none}
  .${P}msgBody{max-width:88%}
  .${P}formGrid{grid-template-columns:1fr}
  .${P}createCard{padding:16px}
  .${P}mark{display:none}
  .${P}statusSelect{max-width:104px}
}

@keyframes ${P}pop{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
@keyframes ${P}fade{from{opacity:0}to{opacity:1}}
@keyframes ${P}slideIn{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
@keyframes ${P}rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes ${P}spin{to{transform:rotate(360deg)}}
@keyframes ${P}pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes ${P}sheen{0%,18%{transform:translateX(-160%) rotate(10deg)}55%,100%{transform:translateX(360%) rotate(10deg)}}

@media (prefers-reduced-motion:reduce){
  .${P}root *{animation:none !important;transition:none !important}
}
@media (prefers-reduced-transparency:reduce){
  .${P}head,.${P}pane,.${P}composer,.${P}menu,.${P}picker,.${P}drawer,.${P}createCard,.${P}emptyCard{backdrop-filter:none;-webkit-backdrop-filter:none}
  .${P}head,.${P}pane,.${P}composer,.${P}drawer,.${P}createCard,.${P}emptyCard{background:var(--dsw-alias-bg-layer-1)}
}
`;

    /**
     * Scale every authored type size through two custom properties instead of
     * hard-coding a second type scale. `--dpr-fs` is the multiplier and
     * `--dpr-fs-add` lifts the smallest labels (9–10px) that a multiplier alone
     * would leave unreadable. Layout dimensions stay fixed; the pills that would
     * otherwise clip switch to min-height below.
     */
    const CSS = CSS_TEMPLATE.replace(
      /(font-size|line-height):([0-9]+(?:\.[0-9]+)?)px/g,
      (_match, property, value) => `${property}:calc(${value}px * var(--dpr-fs,1) + var(--dpr-fs-add,0px))`,
    );

    /* ------------------------------------------------------------------ *
     * Utilities
     * ------------------------------------------------------------------ */

    /** POST one action to the host half and unwrap its envelope. */
    async function post(action, payload) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(payload ?? {}) }),
        credentials: 'same-origin',
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        throw new Error(`宿主通道返回了非 JSON 响应（HTTP ${response.status}）`);
      }
      if (body && body.ok) return body.data;
      const error = body?.error ?? {};
      const prefix = error.code ? `${V.ERROR_LABELS?.[error.code] ?? error.code}：` : '';
      const failure = new Error(`${prefix}${error.message ?? `请求失败（HTTP ${response.status}）`}`);
      failure.code = error.code ?? 'INTERNAL';
      failure.details = error.details;
      throw failure;
    }

    /** Deterministic avatar colour and initial for one member. */
    function avatarFor(member) {
      const label = member?.displayName ?? member?.memberId ?? '?';
      let hash = 0;
      for (let index = 0; index < label.length; index += 1) hash = (hash * 31 + label.charCodeAt(index)) % 360;
      return { initial: label.slice(0, 1), hue: hash };
    }

    /** Local wall-clock time for a stored UTC timestamp. */
    function timeOf(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    /** A stable local day key for a stored UTC timestamp. */
    function dayKeyOf(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    }

    /** A human label for the day a message belongs to. */
    function dayLabelOf(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const now = new Date();
      const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
      if (sameDay(date, now)) return '今天';
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      if (sameDay(date, yesterday)) return '昨天';
      return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
    }

    /** A delivery state's chip tone. */
    function toneOf(status) {
      if (status === 'replied' || status === 'claimed') return `${P}chip ${P}chipOk`;
      if (status === 'failed' || status === 'discarded') return `${P}chip ${P}chipErr`;
      if (status === 'paused' || status === 'uncertain') return `${P}chip ${P}chipWarn`;
      return `${P}chip`;
    }

    /** A member status' colour tone, used by the avatar status dot. */
    function memberTone(status) {
      if (status === 'working') return 'working';
      if (status === 'awaiting_reply') return 'waiting';
      if (status === 'needs_user') return 'user';
      if (status === 'paused' || status === 'offline') return 'paused';
      return 'idle';
    }

    /** Kept for the verification surface's previous contract. */
    function dotOf(status) {
      return memberTone(status);
    }

    /** A task state's pill tone. */
    function taskTone(status) {
      if (status === 'accepted') return `${P}status ${P}statusOk`;
      if (status === 'blocked' || status === 'failed' || status === 'cancelled') return `${P}status ${P}statusErr`;
      if (status === 'rework') return `${P}status ${P}statusWarn`;
      if (status === 'submitted' || status === 'verifying' || status === 'in_progress' || status === 'ready') return `${P}status ${P}statusBlue`;
      return `${P}status`;
    }

    /** Room lifecycle label. */
    function roomStatusLabel(status) {
      if (status === 'paused') return '已暂停';
      if (status === 'archived') return '已归档';
      if (status === 'trashed') return '回收站';
      if (status === 'quiescing') return '正在停止执行';
      if (status === 'purging') return '正在永久删除';
      return '进行中';
    }

    /** The fine state wins when it is more specific than the admission status. */
    function lifecycleLabelOf(room) {
      const state = room?.lifecycleState;
      if (state) return V.PROJECT_LIFECYCLE_LABELS?.[state] ?? roomStatusLabel(room?.status);
      return roomStatusLabel(room?.status);
    }

    /** The left-pane group a status belongs to. */
    function roomFilterOf(status) {
      if (status === 'archived') return 'archived';
      if (status === 'trashed' || status === 'purging') return 'trash';
      return 'active';
    }

    /** A member's human-facing role. Humans have no role template. */
    function roleLabelOf(member) {
      if (member?.kind === 'human') return '人类成员';
      return roleTemplate(member?.role)?.title ?? member?.role ?? '';
    }

    /** Extra aliases worth showing next to a role, without repeating it. */
    function aliasHintOf(member) {
      const roleTitle = roleLabelOf(member);
      const aliases = (member?.aliases ?? []).filter((alias) => alias && alias !== roleTitle && alias !== member.displayName && alias !== member.handle);
      return aliases.length > 0 ? ` · ${aliases.join('/')}` : '';
    }

    /** Role accent, so role dots stay recognisable across the panel. */
    function roleHue(role) {
      const hues = { coordinator: 217, frontend: 190, backend: 262, tester: 38, devops: 170, designer: 330, docs: 214 };
      return hues[role] ?? 217;
    }

    /**
     * Where a member's model came from, as a parenthesised suffix.
     *
     * `host-default` says the Harness's own default is in use because nobody chose
     * one — it must not read as "the project default", which would imply a decision
     * the user never made.
     */
    function selectionSourceLabel(source) {
      if (source === 'member-fixed') return '（成员固定）';
      if (source === 'role-default') return '（角色默认）';
      if (source === 'allowed-pool') return '（允许池自动选择）';
      if (source === 'host-default') return '（本 Harness 默认，未指定）';
      return '（项目默认）';
    }

    /** A one-line quote preview: no markdown markers, no mention syntax. */
    function previewText(body) {
      return M.stripMentionSyntax(String(body ?? ''))
        .replace(/```[\s\S]*?```/g, '［代码］')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/^[#>\-\s]+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    /** Join class names, dropping falsy entries. */
    function cx(...values) {
      return values.filter(Boolean).join(' ');
    }

    /** Clamp a number into a range. */
    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    /** The three reading sizes offered by the header's "Aa" control. */
    const TEXT_SIZE_OPTIONS = [
      { id: 'standard', label: '标准', sample: 'Aa' },
      { id: 'large', label: '大', sample: 'Aa' },
      { id: 'xlarge', label: '特大', sample: 'Aa' },
    ];

    /** Read the saved reading size; an unknown or unavailable store is "standard". */
    function readTextSize() {
      try {
        const stored = window.localStorage?.getItem('dpr-text-size');
        return TEXT_SIZE_OPTIONS.some((option) => option.id === stored) ? stored : 'standard';
      } catch {
        return 'standard';
      }
    }

    /* ------------------------------------------------------------------ *
     * Icons — inline, so the panel never loads an asset it cannot fetch.
     * ------------------------------------------------------------------ */

    const ICONS = {
      users: [
        ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }],
        ['circle', { cx: 9, cy: 7, r: 4 }],
        ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }],
        ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }],
      ],
      tasks: [
        ['rect', { x: 3, y: 3, width: 7, height: 7, rx: 2 }],
        ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 2 }],
        ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 2 }],
        ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 2 }],
      ],
      plus: [['path', { d: 'M12 5v14' }], ['path', { d: 'M5 12h14' }]],
      refresh: [['path', { d: 'M20 11a8 8 0 1 0-2.34 5.66' }], ['path', { d: 'M20 4v7h-7' }]],
      arrowUp: [['path', { d: 'M12 19V5' }], ['path', { d: 'M5 12l7-7 7 7' }]],
      at: [
        ['circle', { cx: 12, cy: 12, r: 4 }],
        ['path', { d: 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94' }],
      ],
      x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
      check: [['path', { d: 'M20 6 9 17l-5-5' }]],
      chevronDown: [['path', { d: 'm6 9 6 6 6-6' }]],
      settings: [
        ['path', { d: 'M4 21v-7' }],
        ['path', { d: 'M4 10V3' }],
        ['path', { d: 'M12 21v-9' }],
        ['path', { d: 'M12 8V3' }],
        ['path', { d: 'M20 21v-5' }],
        ['path', { d: 'M20 12V3' }],
        ['circle', { cx: 4, cy: 12, r: 2 }],
        ['circle', { cx: 12, cy: 10, r: 2 }],
        ['circle', { cx: 20, cy: 14, r: 2 }],
      ],
      alert: [
        ['path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z' }],
        ['path', { d: 'M12 9v4' }],
        ['path', { d: 'M12 17h.01' }],
      ],
      message: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]],
      pause: [['path', { d: 'M9 4v16' }], ['path', { d: 'M15 4v16' }]],
      play: [['path', { d: 'M8 5v14l11-7z', fill: 'currentColor', stroke: 'none' }]],
      archive: [
        ['rect', { x: 3, y: 4, width: 18, height: 4, rx: 1 }],
        ['path', { d: 'M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8' }],
        ['path', { d: 'M10 12h4' }],
      ],
      trash: [
        ['path', { d: 'M3 6h18' }],
        ['path', { d: 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2' }],
        ['path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }],
        ['path', { d: 'M10 11v6M14 11v6' }],
      ],
      more: [['path', { d: 'M5 12h.01M12 12h.01M19 12h.01', strokeWidth: 2.4 }]],
      restore: [
        ['path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }],
        ['path', { d: 'M21 3v5h-5' }],
      ],
      spark: [['path', { d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z' }]],
      clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
      folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
      model: [
        ['rect', { x: 5, y: 5, width: 14, height: 14, rx: 3 }],
        ['rect', { x: 9, y: 9, width: 6, height: 6, rx: 1 }],
        ['path', { d: 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3' }],
      ],
      arrowLeft: [['path', { d: 'M19 12H5' }], ['path', { d: 'M12 19l-7-7 7-7' }]],
      dot: [['circle', { cx: 12, cy: 12, r: 3, fill: 'currentColor', stroke: 'none' }]],
    };

    /**
     * One line icon. Shapes are plain SVG descriptors, so the set is small and
     * the panel stays a single classic script with no runtime asset request.
     */
    function Icon(props) {
      const { name, size = 16, strokeWidth = 1.8, className } = props;
      const shapes = ICONS[name] ?? ICONS.dot;
      return jsx('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        className,
        children: shapes.map(([tag, attrs], index) => jsx(tag, { key: index, ...attrs })),
      });
    }

    /** The panel's brand glyph: two overlapping project-room bubbles. */
    function BrandMark() {
      return jsx('svg', {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          jsx('path', {
            key: 'a',
            d: 'M3.8 7.2a2 2 0 0 1 2-2h7.4a2 2 0 0 1 2 2v3.2a2 2 0 0 1-2 2H8.6L5.4 15v-2.7H5.8a2 2 0 0 1-2-2z',
          }),
          jsx('path', {
            key: 'b',
            d: 'M11.8 3.2h6.4a2 2 0 0 1 2 2v3.1a2 2 0 0 1-2 2h-.9v2.5l-2.8-2.5',
          }),
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Mention-aware rich text
     * ------------------------------------------------------------------ */

    /**
     * Render one paragraph/inline chunk. Backticked code and **bold** are the
     * two conventions room members actually use in reports; nothing is parsed
     * as HTML, so a message can never inject markup.
     */
    function renderInline(text, keyBase) {
      const nodes = [];
      const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
      let cursor = 0;
      let index = 0;
      for (const match of text.matchAll(pattern)) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        if (match[1] !== undefined) {
          nodes.push(jsx('code', { key: `${keyBase}-c${index}`, className: `${P}inlineCode`, children: match[1] }));
        } else {
          // A bold run may contain inline code; parse it rather than showing
          // its backticks literally. Bold content cannot contain `*`, so this
          // recursion terminates.
          nodes.push(jsx('strong', { key: `${keyBase}-b${index}`, className: `${P}bold`, children: renderInline(match[2], `${keyBase}-b${index}`) }));
        }
        cursor = match.index + match[0].length;
        index += 1;
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    /** Render a plain-text block, preserving the server-resolved mention spans. */
    function renderProse(text, mentions, base, key) {
      const local = (mentions ?? [])
        .filter(
          (mention) =>
            mention?.span &&
            Number.isFinite(mention.span.start) &&
            Number.isFinite(mention.span.end) &&
            mention.span.start >= base &&
            mention.span.end <= base + text.length,
        )
        .map((mention) => ({ ...mention, span: { start: mention.span.start - base, end: mention.span.end - base } }));
      let segments;
      try {
        segments = M.segmentsForDisplay(text, local);
      } catch {
        segments = [{ text, mention: null }];
      }
      const children = [];
      segments.forEach((segment, index) => {
        if (segment.mention) {
          children.push(
            jsx('span', {
              key: `${key}-m${index}`,
              className: `${P}mention`,
              title: `已投递给 ${segment.mention.displaySnapshot || segment.mention.targetMemberId}`,
              children: segment.text,
            }),
          );
        } else {
          children.push(...renderInline(segment.text, `${key}-s${index}`));
        }
      });
      return jsx('div', { key, className: `${P}prose`, children });
    }

    /**
     * A message body: fenced code blocks become real code panels, everything
     * else keeps its whitespace and mention highlights.
     */
    function RichMessageText(props) {
      const { body, mentions } = props;
      const value = String(body ?? '');
      const blocks = [];
      const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
      let cursor = 0;
      let index = 0;
      for (const match of value.matchAll(fence)) {
        if (match.index > cursor) blocks.push({ type: 'prose', text: value.slice(cursor, match.index), start: cursor });
        blocks.push({ type: 'code', lang: match[1].trim(), code: match[2].replace(/\n$/, ''), key: `c${index}` });
        cursor = match.index + match[0].length;
        index += 1;
      }
      if (cursor < value.length) blocks.push({ type: 'prose', text: value.slice(cursor), start: cursor });
      if (blocks.length === 0) blocks.push({ type: 'prose', text: value, start: 0 });
      return jsx('div', {
        className: `${P}text`,
        children: blocks.map((block, blockIndex) => {
          if (block.type === 'code') {
            return jsxs(
              'div',
              {
                key: `code-${blockIndex}`,
                className: `${P}codeBlock`,
                children: [
                  jsx('div', { className: `${P}codeHead`, children: block.lang || '代码' }),
                  jsx('pre', { className: `${P}pre`, children: jsx('code', { children: block.code }) }),
                ],
              },
            );
          }
          return renderProse(block.text, mentions, block.start, `prose-${blockIndex}`);
        }),
      });
    }

    /** The simple mention renderer, kept for callers that do not want blocks. */
    function MentionText(props) {
      const { body, mentions } = props;
      const segments = useMemo(() => {
        try {
          return M.segmentsForDisplay(body ?? '', mentions ?? []);
        } catch {
          return [{ text: body ?? '', mention: null }];
        }
      }, [body, mentions]);
      return jsx('div', {
        className: `${P}text`,
        children: segments.map((segment, index) =>
          segment.mention
            ? jsx('span', {
                key: index,
                className: `${P}mention`,
                title: `已投递给 ${segment.mention.displaySnapshot || segment.mention.targetMemberId}`,
                children: segment.text,
              })
            : jsx('span', { key: index, children: segment.text }),
        ),
      });
    }

    /* ------------------------------------------------------------------ *
     * Avatar + context menu
     * ------------------------------------------------------------------ */

    function Avatar(props) {
      const { member, small, large, showStatus, onMenu } = props;
      const { initial, hue } = avatarFor(member);
      const style = { background: `linear-gradient(145deg, hsl(${hue} 72% 56%), hsl(${(hue + 28) % 360} 66% 44%))` };
      const classes = cx(`${P}avatar`, small && `${P}avatarSm`, large && `${P}avatarLg`);
      return jsx('button', {
        type: 'button',
        className: classes,
        style,
        title: `${member?.displayName ?? '成员'}（右键或长按：@ 他）`,
        'aria-label': `${member?.displayName ?? '成员'} 的头像，打开成员菜单`,
        onClick: (event) => onMenu?.(event, member),
        onContextMenu: (event) => {
          event.preventDefault();
          onMenu?.(event, member, 'mention');
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onMenu?.(event, member);
          }
        },
        children: [
          jsx('span', { key: 'initial', children: initial }),
          showStatus
            ? jsx('span', {
                key: 'status',
                className: `${P}avatarDot`,
                'data-tone': memberTone(member?.status),
                title: member?.status ? memberLabel(member.status) : '',
              })
            : null,
        ],
      });
    }

    function MemberMenu(props) {
      const { state, onClose, onPick, members, canReply } = props;
      useEffect(() => {
        // Attach only while open, and defer the outside-click listener by one
        // task: the click that opened the menu is still bubbling when this effect
        // runs, and would otherwise close it in the same gesture.
        if (!state?.open) return undefined;
        const close = () => onClose();
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        const timer = setTimeout(() => {
          window.addEventListener('click', close);
          window.addEventListener('keydown', onKey);
        }, 0);
        return () => {
          clearTimeout(timer);
          window.removeEventListener('click', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [state?.open, onClose]);
      // `state` is owned by the panel and may not be materialised yet on a first
      // render; treat a missing state as "no menu" rather than throwing.
      if (!state || !state.open) return null;
      const member = (members ?? []).find((entry) => entry.id === state.memberId);
      if (!member) return null;
      const self = member.id === state.selfId;
      const item = (label, action, icon, options) =>
        jsx('button', {
          type: 'button',
          className: cx(`${P}menuItem`, options?.danger && `${P}menuItemDanger`),
          onClick: (event) => {
            event.stopPropagation();
            onPick(action, member);
          },
          children: [jsx(Icon, { key: 'icon', name: icon, size: 14 }), jsx('span', { key: 'label', children: label })],
        });
      return jsxs('div', {
        className: `${P}menu`,
        style: { left: state.x, top: state.y },
        onClick: (event) => event.stopPropagation(),
        role: 'menu',
        children: [
          jsxs('div', {
            className: `${P}menuHead`,
            children: [
              jsx(Avatar, { member, small: true, key: 'avatar' }),
              jsxs('div', {
                className: `${P}menuHeadText`,
                children: [
                  jsx('span', { className: `${P}menuName`, children: member.displayName }),
                  jsx('span', { className: `${P}menuHandle`, children: `@${member.handle} · ${roleLabelOf(member)}` }),
                ],
              }),
            ],
          }),
          jsx('div', { className: `${P}menuSep` }),
          item(self ? '@ 自己（留注记，不触发模型）' : `@ 他（${member.displayName}）`, 'mention', 'at'),
          canReply && state.messageId ? item('回复这条消息', 'reply', 'message') : null,
          jsx('div', { className: `${P}menuSep`, key: 'sep1' }),
          item('查看成员', 'detail', 'users'),
          item('选择或更换模型', 'model', 'model'),
          item('查看当前任务', 'task', 'tasks'),
          jsx('div', { className: `${P}menuSep`, key: 'sep2' }),
          member.status === 'paused' ? item('恢复该成员', 'resume', 'play') : item('暂停该成员', 'pause', 'pause'),
          member.status === 'offline' ? null : item('让该成员退出本群', 'retire', 'archive', { danger: true }),
        ].filter(Boolean),
      });
    }

    /* ------------------------------------------------------------------ *
     * Composer
     * ------------------------------------------------------------------ */

    function Composer(props) {
      const { room, members, selfId, onSend, onError, busy, pendingMention, onMentionHandled, replyTo, onCancelReply, readOnly, readOnlyReason } = props;
      const [body, setBody] = useState('');
      const [chips, setChips] = useState([]);
      const [picker, setPicker] = useState({ open: false, query: '', index: 0, start: -1 });
      const [toast, setToast] = useState(null);
      const areaRef = useRef(null);
      const composing = useRef(false);

      const resolver = useMemo(
        () =>
          new M.MentionResolver({
            members,
            membershipRevision: room?.membershipRevision ?? 0,
          }),
        [members, room?.membershipRevision],
      );

      /** Insert a member chip at the caret without disturbing the draft. */
      const insertChip = useCallback(
        (member) => {
          setChips((current) => (current.some((chip) => chip.targetMemberId === member.id) ? current : [...current, { targetMemberId: member.id, origin: 'picker', displaySnapshot: member.displayName, span: null }]));
          setPicker({ open: false, query: '', index: 0, start: -1 });
          const area = areaRef.current;
          if (area) {
            const caret = area.selectionStart ?? body.length;
            const before = body.slice(0, caret);
            const after = area.value.slice(area.selectionEnd ?? caret);
            // Trailing space so a typed name after the chip is never glued to it.
            const next = `${before.replace(/@[^\s@]*$/, '')}${after.startsWith(' ') ? '' : ' '}${after}`;
            setBody(next);
            requestAnimationFrame(() => {
              const position = before.replace(/@[^\s@]*$/, '').length;
              area.focus();
              area.setSelectionRange(position, position);
            });
          }
          areaRef.current?.focus();
        },
        [body],
      );

      // An avatar-menu "@ him" request lands here: insert the chip at the caret of
      // the existing draft and keep focus, WITHOUT sending.
      useEffect(() => {
        if (!pendingMention?.memberId) return;
        const member = members.find((entry) => entry.id === pendingMention.memberId);
        if (!member) {
          onMentionHandled?.();
          return;
        }
        insertChip(member);
        onMentionHandled?.();
      }, [pendingMention, members, insertChip, onMentionHandled]);

      // Keep the textarea exactly as tall as its draft, up to a bound.
      useEffect(() => {
        const area = areaRef.current;
        if (!area) return;
        area.style.height = 'auto';
        area.style.height = `${Math.min(area.scrollHeight, 168)}px`;
      }, [body]);

      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(null), 3200);
        return () => clearTimeout(timer);
      }, [toast]);

      /** Recompute the local preview on every keystroke — same rules as the server. */
      const preview = useMemo(() => {
        try {
          const merged = M.mergeMentions({
            body,
            mentions: chips,
            resolver,
            membershipRevision: room?.membershipRevision,
          });
          const nameOf = (memberId) => members.find((member) => member.id === memberId)?.displayName ?? memberId;
          return {
            targets: merged.targets.map((target) => ({ ...target, displayName: nameOf(target.targetMemberId) })),
            unknown: merged.unknownText,
            ambiguous: merged.ambiguous,
            hints: merged.hints,
            stale: merged.stale,
          };
        } catch (error) {
          return { targets: [], unknown: [], ambiguous: [], hints: [String(error?.message ?? error)], stale: false };
        }
      }, [body, chips, resolver, members, room?.membershipRevision]);

      const aiTargetCount = preview.targets.filter((target) => {
        const member = members.find((entry) => entry.id === target.targetMemberId);
        return member?.kind === 'agent';
      }).length;

      /** Detect an `@` right before the caret and open the picker. */
      const syncPicker = useCallback(
        (value, caret) => {
          const before = value.slice(0, caret);
          const match = /(?:^|[\s([{"'「『（【,，。；;:：!！?？])([@＠][^\s@＠]*)$/.exec(before);
          if (!match) {
            setPicker((current) => (current.open ? { ...current, open: false } : current));
            return;
          }
          const query = match[2].slice(1);
          setPicker({ open: true, query, index: 0, start: caret - match[2].length });
        },
        [],
      );

      const candidates = useMemo(() => {
        if (!picker.open) return [];
        const query = picker.query.toLowerCase();
        const inactive = members.filter((member) => member.status !== 'offline' && member.id !== selfId);
        const matched = inactive.filter((member) => {
          if (!query) return true;
          const haystack = [member.displayName, member.handle, member.role, ...(member.aliases ?? [])].join(' ').toLowerCase();
          return haystack.includes(query);
        });
        const everyone = { id: '__everyone__', displayName: '所有人', handle: 'all', role: 'broadcast', kind: 'agent', aliases: [] };
        const allowsEveryone = !query || '所有人'.includes(query) || 'all'.startsWith(query) || 'everyone'.startsWith(query);
        return (allowsEveryone ? [everyone, ...matched] : matched).slice(0, 12);
      }, [picker.open, picker.query, members, selfId]);

      const chooseEveryone = useCallback(() => {
        setChips((current) => [
          ...current,
          ...members
            .filter((member) => member.kind === 'agent' && member.status !== 'offline' && member.id !== selfId)
            .map((member) => ({ targetMemberId: member.id, origin: 'picker', displaySnapshot: member.displayName, span: null })),
        ]);
        setBody((current) => current.replace(/[@＠][^\s@＠]*$/, ''));
        setPicker({ open: false, query: '', index: 0, start: -1 });
      }, [members, selfId]);

      const onKeyDown = (event) => {
        // Never steal Enter/Tab from an in-progress IME composition: a Chinese
        // candidate must be committed by the IME first.
        if (composing.current || event.isComposing || event.keyCode === 229) return;
        if (picker.open) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setPicker((current) => ({ ...current, index: Math.min(current.index + 1, candidates.length - 1) }));
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setPicker((current) => ({ ...current, index: Math.max(current.index - 1, 0) }));
            return;
          }
          if ((event.key === 'Enter' || event.key === 'Tab') && candidates.length > 0) {
            event.preventDefault();
            const chosen = candidates[picker.index] ?? candidates[0];
            if (chosen.id === '__everyone__') {
              chooseEveryone();
            } else {
              insertChip(chosen);
            }
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setPicker({ open: false, query: '', index: 0, start: -1 });
            return;
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void submit();
        }
      };

      const submit = async () => {
        const text = body.trim();
        if (!text && chips.length === 0) return;
        if (preview.ambiguous.length > 0) {
          onError?.(preview.ambiguous[0].reason);
          return;
        }
        try {
          const result = await onSend({
            body: text,
            mentions: chips,
            membershipRevision: room?.membershipRevision,
          });
          setBody('');
          setChips([]);
          setToast({ kind: result?.duplicate ? 'warn' : 'ok', text: result?.duplicate ? '这条消息之前已经发送过，没有重复投递。' : '已发送。' });
          if (result?.warnings?.length) onError?.(result.warnings.join('；'));
        } catch (error) {
          onError?.(String(error?.message ?? error));
        }
      };

      const hints = [];
      if (preview.hints.length > 0) hints.push(jsx('div', { key: 'hint', className: cx(`${P}banner`, `${P}bannerWarn`), children: [jsx(Icon, { name: 'alert', size: 13 }), jsx('span', { className: `${P}bannerText`, children: preview.hints.join('\n') })] }));
      if (preview.ambiguous.length > 0) {
        hints.push(
          jsx('div', {
            key: 'ambiguous',
            className: cx(`${P}banner`, `${P}bannerErr`),
            children: [
              jsx(Icon, { name: 'alert', size: 13 }),
              jsx('span', { className: `${P}bannerText`, children: `${preview.ambiguous[0].reason}（候选：${preview.ambiguous[0].candidates.map((candidate) => candidate.displayName).join('、')}）` }),
            ],
          }),
        );
      }
      if (preview.unknown.length > 0) {
        hints.push(jsx('div', { key: 'unknown', className: cx(`${P}banner`, `${P}bannerWarn`), children: [jsx(Icon, { name: 'alert', size: 13 }), jsx('span', { className: `${P}bannerText`, children: `无法识别的点名会被当作普通文本：${preview.unknown.join('、')}` })] }));
      }
      if (toast) hints.push(jsx('div', { key: 'toast', className: cx(`${P}banner`, toast.kind === 'warn' ? `${P}bannerWarn` : `${P}bannerOk`), children: [jsx(Icon, { name: 'check', size: 13 }), jsx('span', { className: `${P}bannerText`, children: toast.text })] }));

      if (readOnly) {
        return jsx('div', {
          className: `${P}composerWrap`,
          children: jsxs('div', {
            className: `${P}composer`,
            children: [
              jsxs('div', {
                className: `${P}readonlyBar`,
                children: [
                  jsx(Icon, { name: readOnlyReason === 'trashed' ? 'trash' : readOnlyReason === 'blocked' ? 'alert' : readOnlyReason === 'quiescing' || readOnlyReason === 'purging' ? 'pause' : 'archive', size: 15 }),
                  jsx('span', {
                    children:
                      readOnlyReason === 'trashed'
                        ? '项目在回收站，聊天只读；恢复项目后才能继续发送。'
                        : readOnlyReason === 'blocked'
                          ? '项目有停止请求尚未确认，新的会话输入已被阻断；请先核对或取消该请求。'
                          : readOnlyReason === 'quiescing' || readOnlyReason === 'purging'
                            ? '项目正在停止执行或永久删除，新的会话输入已被阻断。'
                            : '项目已归档，聊天只读；恢复为暂停态后才能继续发送。',
                  }),
                ],
              }),
            ],
          }),
        });
      }

      return jsxs('div', {
        className: `${P}composerWrap`,
        children: [
          picker.open && candidates.length > 0
            ? jsxs('div', {
                className: `${P}picker`,
                role: 'listbox',
                children: [
                  ...candidates.map((member, index) =>
                    jsxs(
                      'button',
                      {
                        type: 'button',
                        className: index === picker.index ? `${P}pickerItem ${P}pickerItemOn` : `${P}pickerItem`,
                        onMouseDown: (event) => {
                          event.preventDefault();
                          if (member.id === '__everyone__') chooseEveryone();
                          else insertChip(member);
                        },
                        role: 'option',
                        'aria-selected': index === picker.index,
                        children: [
                          jsx(Avatar, { member, small: true, key: 'avatar' }),
                          jsxs('span', {
                            key: 'text',
                            className: `${P}pickerText`,
                            children: [
                              jsx('span', { className: `${P}pickerName`, children: member.id === '__everyone__' ? '所有人' : member.displayName }),
                              jsx('span', {
                                className: `${P}pickerMeta`,
                                children:
                                  member.id === '__everyone__'
                                    ? `会触达 ${members.filter((entry) => entry.kind === 'agent' && entry.status !== 'offline' && entry.id !== selfId).length} 位 AI 成员`
                                    : `@${member.handle} · ${roleLabelOf(member)}${aliasHintOf(member)}`,
                              }),
                            ],
                          }),
                        ],
                      },
                      member.id,
                    ),
                  ),
                  jsx('div', { className: `${P}pickerHint`, children: '↑↓ 选择 · Enter/Tab 确认 · Esc 关闭' }),
                ],
              })
            : null,
          jsxs('div', {
            className: `${P}composer`,
            children: [
              replyTo
                ? jsxs('div', {
                    className: `${P}replyBar`,
                    children: [
                      jsx(Icon, { name: 'message', size: 12, key: 'icon' }),
                      jsx('span', { className: `${P}replyBarText`, children: `正在回复 ${replyTo.authorName ?? ''}：#${replyTo.seq} ${previewText(replyTo.body).slice(0, 80)}` }),
                      jsx('button', { type: 'button', className: `${P}mChipX`, title: '取消引用', onClick: () => onCancelReply?.(), children: '×' }),
                    ],
                  })
                : null,
              chips.length > 0
                ? jsx('div', {
                    className: `${P}chipsRow`,
                    children: chips.map((chip) =>
                      jsxs(
                        'span',
                        {
                          className: `${P}mChip`,
                          children: [
                            jsx('span', { key: 'name', children: `@${chip.displaySnapshot || chip.targetMemberId}` }),
                            jsx('button', {
                              key: 'remove',
                              type: 'button',
                              className: `${P}mChipX`,
                              title: '移除这个接收人',
                              onClick: () => setChips((current) => current.filter((entry) => entry.targetMemberId !== chip.targetMemberId)),
                              children: '×',
                            }),
                          ],
                        },
                        chip.targetMemberId,
                      ),
                    ),
                  })
                : null,
              jsxs('div', {
                className: `${P}editorRow`,
                children: [
                  jsx('textarea', {
                    ref: areaRef,
                    className: `${P}textarea`,
                    placeholder: '说点什么，或输入 @ 选人（例如：@前端 为什么这样设计？）',
                    value: body,
                    rows: 2,
                    onChange: (event) => {
                      const value = event.target.value;
                      setBody(value);
                      syncPicker(value, event.target.selectionStart ?? value.length);
                      setToast(null);
                    },
                    onCompositionStart: () => {
                      composing.current = true;
                    },
                    onCompositionEnd: (event) => {
                      composing.current = false;
                      const value = event.target.value;
                      syncPicker(value, event.target.selectionStart ?? value.length);
                    },
                    onKeyDown,
                    onClick: (event) => syncPicker(body, event.currentTarget.selectionStart ?? body.length),
                    'aria-label': '群消息输入框',
                  }),
                  jsx('button', {
                    type: 'button',
                    className: `${P}send`,
                    disabled: busy || (!body.trim() && chips.length === 0),
                    title: '发送（Enter）',
                    'aria-label': '发送消息',
                    onClick: () => void submit(),
                    children: busy ? jsx('span', { className: `${P}spinner` }) : jsx(Icon, { name: 'arrowUp', size: 17, strokeWidth: 2 }),
                  }),
                ],
              }),
              jsxs('div', {
                className: `${P}composerFoot`,
                children: [
                  jsx('button', {
                    type: 'button',
                    className: cx(`${P}btn`, `${P}btnGhost`, `${P}btnTiny`),
                    onClick: () => {
                      setPicker({ open: true, query: '', index: 0, start: -1 });
                      areaRef.current?.focus();
                    },
                    children: [jsx(Icon, { name: 'at', size: 13, key: 'icon' }), jsx('span', { key: 'label', children: '成员' })],
                  }),
                  jsxs('div', {
                    className: `${P}footInfo`,
                    children: [
                      jsx(Icon, { name: 'users', size: 12, key: 'icon' }),
                      jsx('span', {
                        key: 'text',
                        children:
                          aiTargetCount > 0
                            ? `将触达 ${aiTargetCount} 位 AI 成员${preview.targets.length - aiTargetCount > 0 ? ` + ${preview.targets.length - aiTargetCount} 位人类成员` : ''}`
                            : '未点名：默认由主代理接收',
                      }),
                    ],
                  }),
                  jsx('span', { className: `${P}spacer` }),
                  jsx('span', { className: `${P}footHint`, children: 'Enter 发送 · Shift+Enter 换行' }),
                ],
              }),
            ],
          }),
          hints.length > 0 ? jsx('div', { className: `${P}banners`, style: { marginTop: 6 }, children: hints }) : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Model settings
     * ------------------------------------------------------------------ */

    /**
     * Project-level model configuration.
     *
     * Without this surface the four-level precedence is only half
     * usable: a member's own dropdown exists, but there is nowhere to state the
     * project default or the per-role defaults those fall back to. The allowed pool
     * lives here too, because enabling it without a non-empty pool is refused by the
     * service — the UI must not offer a switch that cannot work.
     */
    function ModelSettings(props) {
      const { room, models, settings, onSave, hostDefault } = props;
      const [defaultRef, setDefaultRef] = useState(settings?.projectDefaultProfileRef ?? '');
      const [roleDrafts, setRoleDrafts] = useState(settings?.roleDefaults ?? {});
      const [mode, setMode] = useState(settings?.selectionMode ?? 'fixed');
      const [pool, setPool] = useState(settings?.allowedProfileRefs ?? []);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);
      // Two instances can coexist (the wide right rail and the narrow drawer),
      // so the radio group name must not be shared across the document.
      const groupName = useMemo(() => `dpr-mode-${Math.random().toString(36).slice(2, 8)}`, []);

      // Keep the form in step with the server after a save or a room switch.
      useEffect(() => {
        setDefaultRef(settings?.projectDefaultProfileRef ?? '');
        setRoleDrafts(settings?.roleDefaults ?? {});
        setMode(settings?.selectionMode ?? 'fixed');
        setPool(settings?.allowedProfileRefs ?? []);
      }, [settings, room?.id]);

      const available = (models ?? []).filter((profile) => profile.capabilityStatus !== 'unavailable');
      const roles = ['coordinator', 'frontend', 'backend', 'tester', 'devops', 'designer', 'docs'];
      const configuredRoles = roles.filter((role) => (room?.members ?? []).some((member) => member.role === role) || roleDrafts[role]);

      const togglePool = (ref) =>
        setPool((current) => (current.includes(ref) ? current.filter((entry) => entry !== ref) : [...current, ref]));

      const save = async () => {
        setBusy(true);
        setNote(null);
        try {
          const result = await onSave({
            projectDefaultProfileRef: defaultRef || null,
            roleDefaults: Object.fromEntries(Object.entries(roleDrafts).filter(([, value]) => value)),
            selectionMode: mode,
            allowedProfileRefs: mode === 'allowed-pool' ? pool : [],
          });
          setNote({ kind: 'ok', text: `已保存。${result?.settings?.selectionMode === 'allowed-pool' ? '自动选型只在允许池内挑选，且不覆盖已锁定的成员。' : '成员默认使用固定选型，不会暗中换模型。'}` });
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      };

      return jsxs('div', {
        className: `${P}form`,
        children: [
          jsx('div', {
            className: `${P}note`,
            children: '三层优先级：成员固定 > 角色默认 > 项目默认。没选的层不会偷偷换模型。',
          }),

          jsxs('div', {
            className: `${P}field`,
            children: [
              jsx('span', { className: `${P}label`, children: '项目默认（没有单独配置的成员使用）' }),
              jsxs('span', {
                className: `${P}selectWrap`,
                children: jsx('select', {
                  className: cx(`${P}select`, `${P}selectBlock`),
                  value: defaultRef,
                  onChange: (event) => setDefaultRef(event.target.value),
                  children: [
                    jsx('option', {
                      value: '',
                      children: hostDefault ? `未设置（暂用本 Harness 默认：${hostDefault.modelId}）` : '未设置（本 Harness 也没有可用默认模型）',
                    }),
                    ...available.map((profile) => jsx('option', { value: profile.profileRef, children: `${profile.label} — ${profile.providerRoute}/${profile.modelId}` })),
                  ],
                }),
              }),
            ],
          }),

          configuredRoles.length > 0
            ? jsxs('div', {
                className: `${P}field`,
                children: [
                  jsx('span', { className: `${P}label`, children: '角色默认（覆盖项目默认）' }),
                  ...configuredRoles.map((role) =>
                    jsxs(
                      'div',
                      {
                        className: `${P}modelRow`,
                        children: [
                          jsxs('span', { className: `${P}modelRole`, children: [jsx('span', { className: `${P}roleDot`, style: { background: `hsl(${roleHue(role)} 68% 54%)` } }), roleTemplate(role)?.title ?? role] }),
                          jsxs('span', {
                            className: `${P}selectWrap`,
                            style: { flex: 1 },
                            children: jsx('select', {
                              className: cx(`${P}select`, `${P}selectBlock`),
                              value: roleDrafts[role] ?? '',
                              onChange: (event) => setRoleDrafts((current) => ({ ...current, [role]: event.target.value })),
                              children: [
                                jsx('option', { value: '', children: '跟随项目默认' }),
                                ...available.map((profile) => jsx('option', { value: profile.profileRef, children: `${profile.label} — ${profile.providerRoute}/${profile.modelId}` })),
                              ],
                            }),
                          }),
                        ],
                      },
                      role,
                    ),
                  ),
                ],
              })
            : null,

          jsxs('div', {
            className: `${P}field`,
            children: [
              jsx('span', { className: `${P}label`, children: '选型模式' }),
              jsxs('div', {
                className: `${P}choiceRow`,
                children: [
                  jsxs('label', {
                    className: `${P}choice`,
                    children: [
                      jsx('input', { type: 'radio', name: groupName, checked: mode === 'fixed', onChange: () => setMode('fixed') }),
                      jsxs('span', {
                        children: [
                          jsx('b', { children: '固定选型（默认）' }),
                          '由我固定每位成员的模型；系统不会自作主张换模型。',
                        ],
                      }),
                    ],
                  }),
                  jsxs('label', {
                    className: `${P}choice`,
                    children: [
                      jsx('input', { type: 'radio', name: groupName, checked: mode === 'allowed-pool', onChange: () => setMode('allowed-pool') }),
                      jsxs('span', {
                        children: [
                          jsx('b', { children: '允许池自动选型' }),
                          '主代理只在下述允许池内为新成员/新任务选型并公开理由，不覆盖已锁定成员。',
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),

          mode === 'allowed-pool'
            ? jsxs('div', {
                className: `${P}field`,
                children: [
                  jsx('span', { className: `${P}label`, children: `允许池（必须非空；已选 ${pool.length}）` }),
                  jsx('div', {
                    className: `${P}pool`,
                    children: available.map((profile) =>
                      jsxs(
                        'label',
                        {
                          className: `${P}poolRow`,
                          children: [
                            jsx('input', { type: 'checkbox', checked: pool.includes(profile.profileRef), onChange: () => togglePool(profile.profileRef) }),
                            jsx('span', { children: `${profile.label}（${profile.providerRoute}/${profile.modelId}）` }),
                          ],
                        },
                        profile.profileRef,
                      ),
                    ),
                  }),
                  jsx('div', { className: `${P}hint`, children: '自动选型不会覆盖被锁定的成员，也不会越出这个池子。' }),
                ],
              })
            : null,

          note ? jsx('div', { className: cx(`${P}note`, note.kind === 'error' ? `${P}noteErr` : `${P}noteOk`), children: note.text }) : null,
          jsx('button', {
            type: 'button',
            className: cx(`${P}btn`, `${P}btnPrimary`),
            style: { width: '100%' },
            disabled: busy,
            onClick: () => void save(),
            children: busy ? [jsx('span', { className: `${P}spinner`, key: 's' }), '保存中…'] : '保存模型配置',
          }),
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Right rail: tasks, decisions, recovery, models
     * ------------------------------------------------------------------ */

    function Board(props) {
      const { room, board, recovery, onAction, error } = props;
      if (!board) return jsx('div', { className: `${P}note`, children: '正在读取任务板…' });
      const tasks = board.tasks ?? [];
      const accepted = tasks.filter((task) => task.status === 'accepted').length;
      const running = tasks.filter((task) => task.status === 'in_progress' || task.status === 'submitted' || task.status === 'verifying').length;
      const ratio = tasks.length === 0 ? 0 : Math.round((accepted / tasks.length) * 100);
      return jsxs('div', {
        className: `${P}section`,
        children: [
          jsxs('div', {
            className: `${P}progressCard`,
            children: [
              jsxs('div', {
                className: `${P}progressTop`,
                children: [
                  jsxs('div', {
                    className: `${P}pct`,
                    children: [String(ratio), jsx('small', { children: '%' })],
                  }),
                  jsxs('div', {
                    className: `${P}progressMeta`,
                    children: [`${accepted}/${tasks.length} 已验收`, jsx('br', { key: 'break' }), `${running} 项在流转`],
                  }),
                ],
              }),
              jsx('div', { className: `${P}bar`, children: jsx('div', { className: `${P}barFill`, style: { width: `${ratio}%` } }) }),
            ],
          }),
          jsxs('div', {
            className: `${P}section`,
            children: [
              jsxs('h4', {
                className: `${P}sectionTitle`,
                children: [jsx(Icon, { name: 'tasks', size: 12 }), '任务', jsx('span', { className: `${P}count`, children: tasks.length })],
              }),
              tasks.length === 0
                ? jsx('div', { className: `${P}note`, children: '还没有任务。把整体目标交给主代理，它会拆分并派发。' })
                : tasks.map((task) =>
                    jsxs(
                      'div',
                      {
                        className: `${P}task`,
                        children: [
                          jsxs('div', {
                            className: `${P}taskTop`,
                            children: [
                              jsx('span', { className: taskTone(task.status), children: taskLabel(task.status) }),
                              jsx('span', { className: `${P}taskObj`, children: task.objective }),
                            ],
                          }),
                          jsxs('div', {
                            className: `${P}taskMeta`,
                            children: [
                              jsx('span', { key: 'r', children: `r${task.revision}` }),
                              jsx('span', { key: 'o', children: task.ownerName ?? '未指派' }),
                              task.needsSync ? jsx('span', { key: 's', className: `${P}chip ${P}chipWarn`, children: '需同步新版本' }) : null,
                              task.blockedBy?.length ? jsx('span', { key: 'b', children: `等待 ${task.blockedBy.length} 项依赖` }) : null,
                            ],
                          }),
                          task.acceptance?.length ? jsx('div', { className: `${P}taskAccept`, children: `验收：${task.acceptance.join('；')}` }) : null,
                          task.artifacts?.length
                            ? jsx('div', {
                                className: `${P}chips`,
                                children: task.artifacts.slice(0, 5).map((artifact) =>
                                  jsx('span', { className: artifact.verified ? `${P}chip ${P}chipOk` : `${P}chip ${P}chipWarn`, children: `${artifact.kind}：${artifact.location}${artifact.verified ? '' : '（未核验）'}` }, artifact.id),
                                ),
                              })
                            : null,
                        ],
                      },
                      task.id,
                    ),
                  ),
            ],
          }),
          jsxs('div', {
            className: `${P}section`,
            children: [
              jsxs('h4', {
                className: `${P}sectionTitle`,
                children: [jsx(Icon, { name: 'check', size: 12 }), '项目决定', jsx('span', { className: `${P}count`, children: (board.decisions ?? []).length })],
              }),
              (board.decisions ?? []).length === 0
                ? jsx('div', { className: `${P}note`, children: '还没有采纳的决定。' })
                : board.decisions.map((decision) =>
                    jsxs(
                      'div',
                      {
                        className: `${P}decision`,
                        children: [
                          jsxs('div', {
                            className: `${P}decisionTop`,
                            children: [jsx(Icon, { name: 'spark', size: 11 }), `r${decision.revision} · ${decision.status === 'accepted' ? '已采纳' : decision.status === 'proposed' ? '提议中' : decision.status}`],
                          }),
                          jsx('div', { className: `${P}decisionText`, children: decision.statement }),
                          decision.acks?.length
                            ? jsx('div', {
                                className: `${P}chips`,
                                children: decision.acks.map((ack) => {
                                  const member = (board.members ?? []).find((entry) => entry.id === ack.memberId);
                                  return jsx(
                                    'span',
                                    {
                                      className:
                                        ack.state === 'synced' || ack.state === 'unaffected'
                                          ? `${P}chip ${P}chipOk`
                                          : ack.state === 'rework' || ack.state === 'needs_clarification'
                                            ? `${P}chip ${P}chipWarn`
                                            : `${P}chip`,
                                      children: `${member?.displayName ?? ack.memberId}：${ack.state}`,
                                    },
                                    ack.memberId,
                                  );
                                }),
                              })
                            : null,
                        ],
                      },
                      decision.id,
                    ),
                  ),
            ],
          }),
          recovery
            ? jsxs('details', {
                className: `${P}details`,
                children: [
                  jsxs('summary', {
                    children: [jsx(Icon, { name: 'clock', size: 12 }), '投递与恢复', jsx('span', { className: `${P}spacer` }), jsx('span', { className: `${P}hint`, children: recovery.singleWriter ? '本进程唯一写入' : '写入者未知' })],
                  }),
                  jsxs('div', {
                    className: `${P}detailsBody`,
                    children: [
                      jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '上次恢复' }), jsx('span', { className: `${P}kvVal`, children: recovery.lastRecoveryAt ?? '本次会话内尚未恢复' })] }),
                      (recovery.deliveries ?? []).length === 0
                        ? jsx('div', { className: `${P}hint`, children: '没有失败或不确定的投递。' })
                        : recovery.deliveries.map((delivery) =>
                            jsxs(
                              'div',
                              {
                                className: `${P}task`,
                                children: [
                                  jsxs('div', { className: `${P}taskTop`, children: [jsx('span', { className: `${P}status ${P}statusWarn`, children: delivery.label }), jsx('span', { className: `${P}taskObj`, children: `#${delivery.seq ?? '?'}` })] }),
                                  jsx('div', { className: `${P}taskMeta`, children: delivery.detail ?? '' }),
                                  jsx('div', {
                                    className: `${P}chips`,
                                    children: jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnTiny`), onClick: () => onAction('retry', delivery), children: '核对后重投' }),
                                  }),
                                ],
                              },
                              `${delivery.messageId}:${delivery.recipientId}`,
                            ),
                          ),
                      recovery.note ? jsx('div', { className: `${P}hint`, children: recovery.note }) : null,
                    ],
                  }),
                ],
              })
            : null,
          error ? jsx('div', { className: cx(`${P}banner`, `${P}bannerErr`), children: error }) : null,
        ],
      });
    }

    function RightRail(props) {
      const { room, board, recovery, models, settings, hostDefault, onSave, onAction } = props;
      const [tab, setTab] = useState('tasks');
      const taskCount = board?.tasks?.length ?? 0;
      return jsxs('div', {
        className: `${P}rail`,
        children: [
          jsxs('div', {
            className: `${P}tabs`,
            role: 'tablist',
            children: [
              jsxs('button', {
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'tasks',
                className: tab === 'tasks' ? `${P}tab ${P}tabOn` : `${P}tab`,
                onClick: () => setTab('tasks'),
                children: [jsx(Icon, { name: 'tasks', size: 13, key: 'icon' }), jsx('span', { key: 'label', children: '任务' }), taskCount > 0 ? jsx('span', { key: 'count', className: `${P}tabCount`, children: taskCount }) : null],
              }),
              jsxs('button', {
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'models',
                className: tab === 'models' ? `${P}tab ${P}tabOn` : `${P}tab`,
                onClick: () => setTab('models'),
                children: [jsx(Icon, { name: 'model', size: 13, key: 'icon' }), jsx('span', { key: 'label', children: '模型' })],
              }),
            ],
          }),
          jsx('div', {
            className: `${P}railScroll`,
            children:
              tab === 'tasks'
                ? jsx(Board, {
                    room,
                    board,
                    recovery,
                    models,
                    settings,
                    hostDefault,
                    onSave,
                    onAction,
                  })
                : jsxs(Fragment, {
                    children: [
                      jsxs('div', {
                        className: `${P}section`,
                        children: [
                          jsxs('h4', {
                            className: `${P}sectionTitle`,
                            children: [jsx(Icon, { name: 'model', size: 12 }), '模型与选型'],
                          }),
                          jsx('div', { className: `${P}hint`, children: `当前模式：${settings?.selectionMode === 'allowed-pool' ? '允许池自动选型' : '固定选型'}` }),
                        ],
                      }),
                      jsx(ModelSettings, {
                        room,
                        models,
                        settings,
                        hostDefault,
                        onSave,
                      }),
                    ],
                  }),
          }),
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Timeline
     * ------------------------------------------------------------------ */

    function Timeline(props) {
      const { messages, members, selfId, onAvatarMenu, onReply } = props;
      const scroller = useRef(null);
      const pinned = useRef(true);

      useEffect(() => {
        const element = scroller.current;
        if (!element) return undefined;
        const onScroll = () => {
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
        };
        element.addEventListener('scroll', onScroll);
        return () => element.removeEventListener('scroll', onScroll);
      }, []);

      useEffect(() => {
        const element = scroller.current;
        if (element && pinned.current) element.scrollTop = element.scrollHeight;
      }, [messages]);

      const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
      const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

      if (messages.length === 0) {
        return jsxs('div', {
          className: `${P}timeline`,
          ref: scroller,
          children: [
            jsxs('div', {
              className: `${P}streamEmpty`,
              children: [
                jsx('div', { className: `${P}emptyArt`, style: { width: 58, height: 58, borderRadius: 18 }, children: jsx(Icon, { name: 'message', size: 26 }) }),
                jsx('div', { className: `${P}streamEmptyTitle`, children: '群聊已经准备好了' }),
                jsx('div', { className: `${P}streamEmptyText`, children: '说一句话，或输入 @ 点名成员。没有点名时，默认由主代理接收。' }),
              ],
            }),
          ],
        });
      }

      const rendered = [];
      let lastDay = null;
      for (const message of messages) {
        const day = dayKeyOf(message.createdAt);
        if (day && day !== lastDay) {
          rendered.push(jsx('div', { className: `${P}day`, children: dayLabelOf(message.createdAt) }, `day-${day}`));
          lastDay = day;
        }
        const author = memberById.get(message.authorId) ?? { id: message.authorId, displayName: message.authorId, role: '', kind: 'agent' };
        if (author.kind === 'human' && /^【/.test(message.body)) {
          rendered.push(jsx('div', { className: `${P}sys`, children: message.body }, message.id));
          continue;
        }
        const self = message.authorId === selfId;
        const replySource = message.replyTo ? byId.get(message.replyTo) : null;
        const replyAuthor = replySource ? memberById.get(replySource.authorId) : null;
        rendered.push(
          jsxs(
            'div',
            {
              className: self ? `${P}msg ${P}msgSelf` : `${P}msg`,
              children: [
                jsx(Avatar, { member: author, onMenu: (event, member) => onAvatarMenu(event, member, undefined, message) }, 'avatar'),
                jsxs(
                  'div',
                  {
                    className: `${P}msgBody`,
                    children: [
                      jsxs(
                        'div',
                        {
                          className: `${P}msgHead`,
                          children: [
                            jsx('span', { className: `${P}author`, children: self ? '我' : author.displayName }),
                            author.kind === 'agent' ? jsx('span', { className: `${P}aiTag`, children: 'AI' }) : null,
                            !self && roleLabelOf(author) && !String(author.displayName).includes(roleLabelOf(author))
                              ? jsx('span', { className: `${P}roleTag`, children: roleLabelOf(author) })
                              : null,
                            jsx('span', { className: `${P}timeTag`, title: `#${message.seq}`, children: timeOf(message.createdAt) }),
                            message.taskId ? jsx('span', { className: `${P}chip ${P}chipBlue`, children: `任务 ${message.taskId}` }) : null,
                            jsx('span', { className: `${P}spacer` }),
                            jsx('div', {
                              className: `${P}msgActions`,
                              children: [
                                jsx('button', {
                                  type: 'button',
                                  className: `${P}actionBtn`,
                                  onClick: () => onReply(message, author),
                                  children: [jsx(Icon, { name: 'message', size: 11, key: 'icon' }), jsx('span', { key: 'label', children: '回复' })],
                                }),
                                jsx('button', {
                                  type: 'button',
                                  className: `${P}actionBtn`,
                                  title: '在输入框里 @ 他',
                                  onClick: (event) => onAvatarMenu(event, author, 'mention', message),
                                  children: [jsx(Icon, { name: 'at', size: 11, key: 'icon' }), jsx('span', { key: 'label', children: '@' })],
                                }),
                              ],
                            }),
                          ],
                        },
                      ),
                      replySource
                        ? jsx('div', {
                            className: `${P}replyRef`,
                            children: [
                              jsx(Icon, { name: 'message', size: 10, key: 'icon' }),
                              jsxs('span', {
                                key: 'text',
                                children: [jsx('b', { key: 'author', children: `${replyAuthor?.displayName ?? replySource.authorId} ` }), `#${replySource.seq} ${previewText(replySource.body).slice(0, 100)}`],
                              }),
                            ],
                          })
                        : null,
                      jsx(RichMessageText, { body: message.body, mentions: message.mentions }),
                      message.deliveries?.length > 0
                        ? jsx('div', {
                            className: `${P}chips`,
                            children: message.deliveries.map((delivery) => {
                              const target = memberById.get(delivery.recipientId);
                              const targetName = target?.displayName ?? (delivery.recipientId && delivery.recipientId !== 'undefined' ? delivery.recipientId : '未知接收人');
                              return jsx(
                                'span',
                                {
                                  className: toneOf(delivery.status),
                                  title: delivery.detail ?? '',
                                  children: `${targetName}：${deliveryLabel(delivery.status)}`,
                                },
                                delivery.recipientId ?? delivery.messageId,
                              );
                            }),
                          })
                        : null,
                    ],
                  },
                  'body',
                ),
              ],
            },
            message.id,
          ),
        );
      }
      return jsx('div', { className: `${P}timeline`, ref: scroller, children: rendered });
    }

    /* ------------------------------------------------------------------ *
     * Member list and detail
     * ------------------------------------------------------------------ */

    function MemberList(props) {
      const { members, selfId, onAvatarMenu, selectedId, onSelect } = props;
      return jsx('div', {
        className: `${P}memberList`,
        children: members.map((member) => {
          const model = member.effectiveModel;
          return jsxs(
            'div',
            {
              className: selectedId === member.id ? `${P}memberRow ${P}memberRowOn` : `${P}memberRow`,
              onClick: () => onSelect(member),
              role: 'button',
              tabIndex: 0,
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(member);
                }
              },
              children: [
                jsx(Avatar, {
                  member,
                  showStatus: true,
                  onMenu: (event, entry) => onAvatarMenu(event, entry),
                  key: 'avatar',
                }),
                jsxs('div', {
                  key: 'text',
                  className: `${P}memberText`,
                  children: [
                    jsxs('div', {
                      className: `${P}memberNameRow`,
                      children: [
                        jsx('span', { className: `${P}memberName`, children: member.displayName }),
                        member.kind === 'agent' ? jsx('span', { className: `${P}aiTag`, children: 'AI' }) : null,
                        member.awaitingReplyCount > 0
                          ? jsx('span', { className: `${P}memberBadge`, title: `${member.awaitingReplyCount} 条投递尚未处理`, children: `${member.awaitingReplyCount} 待处理` })
                          : null,
                      ],
                    }),
                    jsx('div', {
                      className: `${P}memberMeta`,
                      children: `@${member.handle} · ${roleLabelOf(member)} · ${memberLabel(member.status)}${member.id === selfId ? ' · 你' : ''}`,
                    }),
                    model
                      ? jsx('div', {
                          className: `${P}memberModel`,
                          title: `${model.providerRoute}/${model.modelId}${selectionSourceLabel(member.selectionSource)}`,
                          children: model.modelId,
                        })
                      : jsx('div', { className: `${P}memberModel`, children: '未配置模型' }),
                    member.currentTask
                      ? jsxs('div', {
                          className: `${P}memberTask`,
                          title: `${member.currentTask.objective}（${taskLabel(member.currentTask.status)} r${member.currentTask.revision}）`,
                          children: [jsx(Icon, { name: 'spark', size: 10 }), jsx('span', { children: member.currentTask.objective })],
                        })
                      : null,
                  ],
                }),
              ],
            },
            member.id,
          );
        }),
      });
    }

    function MemberDetail(props) {
      const { member, models, settings, onModelChange, onControl, onClose, routes } = props;
      const [pending, setPending] = useState(null);
      const [busy, setBusy] = useState(false);
      // A selected member can leave the room (retired, or dropped by a refresh)
      // between the click and the render. Rendering nothing is better than a panel
      // that throws: the whole workspace shares this React tree.
      if (!member || !member.id) return null;
      const observed = (routes ?? []).find((route) => route.memberId === member.id);
      const options = (models ?? []).filter((profile) => profile.capabilityStatus !== 'unavailable');
      return jsxs('div', {
        className: `${P}detail`,
        children: [
          jsxs('div', {
            className: `${P}detailHead`,
            children: [
              jsx(Avatar, { member, large: true, key: 'avatar' }),
              jsxs('div', {
                key: 'text',
                style: { minWidth: 0, flex: 1 },
                children: [
                  jsx('div', { className: `${P}detailName`, children: member.displayName }),
                  jsx('div', { className: `${P}detailRole`, children: `@${member.handle} · ${roleLabelOf(member)}` }),
                ],
              }),
              jsx('button', {
                type: 'button',
                className: `${P}iconBtn`,
                style: { width: 26, height: 26, borderRadius: 8 },
                title: '关闭成员详情',
                onClick: onClose,
                children: jsx(Icon, { name: 'x', size: 13 }),
              }),
            ],
          }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '身份' }), jsx('span', { className: `${P}kvVal`, children: `@${member.handle}${member.aliases?.length ? ` · ${member.aliases.join('、')}` : ''}` })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '状态' }), jsx('span', { className: `${P}kvVal`, children: memberLabel(member.status) })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '会话' }), jsx('span', { className: `${P}kvVal ${P}mono`, title: member.sessionId ?? '', children: member.sessionId ?? '未创建' })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '归属' }), jsx('span', { className: `${P}kvVal`, children: member.sessionOwnership === 'borrowed' ? '借用的用户会话（不会销毁）' : member.sessionOwnership === 'owned' ? '插件拥有' : '未知' })] }),
          observed
            ? jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '实际路由' }), jsx('span', { className: `${P}kvVal`, children: `${observed.providerRoute}/${observed.modelId}（第 ${observed.turn ?? '?'} 轮观测）` })] })
            : jsx('div', { className: `${P}hint`, children: '还没有观测到真实请求；改模型后请等它真正执行一次。' }),
          jsxs('div', {
            className: `${P}field`,
            style: { marginTop: 2 },
            children: [
              jsx('span', { className: `${P}label`, children: '模型（真实已接入的提供方/模型 ID）' }),
              jsxs('span', {
                className: `${P}selectWrap`,
                children: jsx('select', {
                  className: cx(`${P}select`, `${P}selectBlock`),
                  value: pending ?? member.pinnedProfileRef ?? '',
                  onChange: (event) => setPending(event.target.value),
                  children: [
                    // An unpinned member is NOT unconfigured: it inherits the role, project
                    // or host default. Naming the inherited model here is the difference
                    // between "we don't know what this runs on" and the truth.
                    jsx('option', {
                      value: '',
                      children: member.pinnedProfileRef
                        ? '取消固定（回到角色/项目默认）'
                        : member.effectiveModel
                          ? `未固定 — 当前继承：${member.effectiveModel.modelId}`
                          : '未配置（使用角色/项目默认）',
                    }),
                    ...options.map((profile) => jsx('option', { value: profile.profileRef, children: `${profile.label} — ${profile.providerRoute}/${profile.modelId}${profile.capabilityStatus === 'unverified' ? '（能力待验证）' : ''}` })),
                  ],
                }),
              }),
              jsxs('div', {
                className: `${P}detailActions`,
                children: [
                  jsx('button', {
                    type: 'button',
                    className: cx(`${P}btn`, `${P}btnPrimary`, `${P}btnTiny`),
                    disabled: busy || !pending || pending === member.modelProfileRef,
                    onClick: async () => {
                      setBusy(true);
                      try {
                        await onModelChange(member, pending);
                        setPending(null);
                      } finally {
                        setBusy(false);
                      }
                    },
                    children: busy ? '切换中…' : '应用模型',
                  }),
                  jsx('span', { className: `${P}hint`, children: `配置 r${member.modelConfigRevision} · ${member.modelLocked ? '已锁定' : '未锁定'}` }),
                ],
              }),
              jsx('div', { className: `${P}hint`, children: `切换在安全边界生效：当前请求沿用旧路由，下一次请求使用新模型；身份、@ 名称与任务归属不变。项目选型模式：${settings?.selectionMode ?? 'fixed'}` }),
            ],
          }),
          jsxs('div', {
            className: `${P}detailActions`,
            children: [
              jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnTiny`), onClick: () => onControl(member, member.status === 'paused' ? 'resume' : 'pause'), children: member.status === 'paused' ? '恢复' : '暂停' }),
              jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnTiny`), onClick: () => onControl(member, 'stop'), children: '停止当前工作' }),
              jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnTiny`, `${P}btnDanger`), onClick: () => onControl(member, 'retire'), children: '退出本群' }),
            ],
          }),
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Room creation
     * ------------------------------------------------------------------ */

    function CreateRoom(props) {
      const { models, onCreated, onCancel } = props;
      const [title, setTitle] = useState('');
      const [workspace, setWorkspace] = useState('');
      const [goal, setGoal] = useState('');
      const [roles, setRoles] = useState(['coordinator', 'frontend', 'backend', 'tester']);
      const [modelsByRole, setModelsByRole] = useState({});
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const available = (models ?? []).filter((profile) => profile.capabilityStatus !== 'unavailable');

      const toggle = (role) =>
        setRoles((current) => (current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role]));

      const submit = async () => {
        setBusy(true);
        setError(null);
        try {
          const result = await post('room.create', {
            title: title.trim() || '未命名项目群',
            workspaceRef: workspace.trim() || null,
            cwd: workspace.trim() || null,
            goal: goal.trim(),
            members: roles.map((role) => ({
              role,
              modelProfileRef: modelsByRole[role] || null,
            })),
          });
          onCreated(result);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      };

      return jsx('div', {
        className: `${P}createWrap`,
        children: jsxs('div', {
          className: `${P}createCard`,
          children: [
            jsxs('div', {
              className: `${P}createHead`,
              children: [
                jsx('div', { className: `${P}mark ${P}markLg`, children: jsx(BrandMark, {}) }),
                jsxs('div', {
                  style: { minWidth: 0, flex: 1 },
                  children: [
                    jsx('h2', { className: `${P}createTitle`, children: '新建项目群' }),
                    jsx('div', { className: `${P}createSub`, children: '一个项目一个群：主代理拆分与验收，成员各自使用你选择的真实模型。' }),
                  ],
                }),
                jsx('button', {
                  type: 'button',
                  className: `${P}iconBtn`,
                  title: '取消并返回',
                  onClick: onCancel,
                  children: jsx(Icon, { name: 'x', size: 15 }),
                }),
              ],
            }),
            jsxs('div', {
              className: `${P}formGrid`,
              children: [
                jsxs('label', {
                  className: `${P}field`,
                  children: [
                    jsx('span', { className: `${P}label`, children: '群名称' }),
                    jsx('input', { className: `${P}input`, value: title, placeholder: '例如：验证码登录功能', onChange: (event) => setTitle(event.target.value) }),
                  ],
                }),
                jsxs('label', {
                  className: `${P}field`,
                  children: [
                    jsx('span', { className: `${P}label`, children: '工作区目录（成员的真实执行目录）' }),
                    jsx('input', { className: `${P}input`, value: workspace, placeholder: '~/my-project', onChange: (event) => setWorkspace(event.target.value) }),
                  ],
                }),
                jsxs('label', {
                  className: `${P}field ${P}fieldFull`,
                  children: [
                    jsx('span', { className: `${P}label`, children: '整体目标（提交后主代理会拆分工作）' }),
                    jsx('textarea', {
                      className: `${P}input`,
                      style: { minHeight: 74 },
                      value: goal,
                      placeholder: '例如：做个验证码登录功能，顺便把运行说明补齐。',
                      onChange: (event) => setGoal(event.target.value),
                    }),
                  ],
                }),
              ],
            }),
            jsxs('div', {
              className: `${P}field`,
              children: [
                jsxs('span', {
                  className: `${P}label`,
                  children: ['初始成员', jsx('span', { style: { fontWeight: 400, marginLeft: 6, opacity: 0.8 }, children: '主代理负责拆分与验收，其余角色按需选择' })],
                }),
                jsx('div', {
                  className: `${P}roleGrid`,
                  children: ROLE_TEMPLATES.map((template) =>
                    jsxs(
                      'label',
                      {
                        className: `${P}roleCard`,
                        children: [
                          jsx('input', { type: 'checkbox', checked: roles.includes(template.role), onChange: () => toggle(template.role) }),
                          jsx('span', { className: `${P}roleCheck`, children: jsx(Icon, { name: 'check', size: 10 }) }),
                          jsxs('span', {
                            className: `${P}roleText`,
                            children: [
                              jsxs('span', {
                                className: `${P}roleTitle`,
                                children: [jsx('span', { className: `${P}roleDot`, style: { background: `hsl(${roleHue(template.role)} 68% 54%)`, display: 'inline-block', marginRight: 5, verticalAlign: 'middle' } }), template.title],
                              }),
                              jsx('span', { className: `${P}roleDuty`, children: template.duties }),
                            ],
                          }),
                        ],
                      },
                      template.role,
                    ),
                  ),
                }),
              ],
            }),
            roles.length > 0
              ? jsxs('div', {
                  className: `${P}field`,
                  children: [
                    jsx('span', { className: `${P}label`, children: '每位成员的模型（可留空，之后在成员详情里改）' }),
                    roles.map((role) =>
                      jsxs(
                        'div',
                        {
                          className: `${P}modelRow`,
                          children: [
                            jsxs('span', {
                              className: `${P}modelRole`,
                              children: [jsx('span', { className: `${P}roleDot`, style: { background: `hsl(${roleHue(role)} 68% 54%)` } }), roleTemplate(role)?.title ?? role],
                            }),
                            jsxs('span', {
                              className: `${P}selectWrap`,
                              style: { flex: 1 },
                              children: jsx('select', {
                                className: cx(`${P}select`, `${P}selectBlock`),
                                value: modelsByRole[role] ?? '',
                                onChange: (event) => setModelsByRole((current) => ({ ...current, [role]: event.target.value })),
                                children: [
                                  jsx('option', { value: '', children: '使用项目/角色默认' }),
                                  ...available.map((profile) => jsx('option', { value: profile.profileRef, children: `${profile.label} — ${profile.providerRoute}/${profile.modelId}` })),
                                ],
                              }),
                            }),
                          ],
                        },
                        role,
                      ),
                    ),
                  ],
                })
              : null,
            error ? jsx('div', { className: cx(`${P}banner`, `${P}bannerErr`), children: [jsx(Icon, { name: 'alert', size: 13 }), jsx('span', { className: `${P}bannerText`, children: error })] }) : null,
            jsxs('div', {
              className: `${P}createFoot`,
              children: [
                jsx('span', { className: `${P}hint`, children: '建群会在一个事务里写完群、成员与创建事件，然后创建成员会话。' }),
                jsx('span', { className: `${P}spacer` }),
                jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnGhost`), onClick: onCancel, children: '取消' }),
                jsx('button', {
                  type: 'button',
                  className: cx(`${P}btn`, `${P}btnPrimary`),
                  disabled: busy || !roles.length,
                  onClick: () => void submit(),
                  children: busy ? [jsx('span', { className: `${P}spinner`, key: 'spinner' }), '正在建群…'] : [jsx(Icon, { name: 'spark', size: 14, key: 'icon' }), '创建项目群'],
                }),
              ],
            }),
          ],
        }),
      });
    }

    /* ------------------------------------------------------------------ *
     * Drawer (narrow layouts)
     * ------------------------------------------------------------------ */

    function Drawer(props) {
      const { title, onClose, children } = props;
      return jsxs(Fragment, {
        children: [
          jsx('div', { className: `${P}scrim`, onClick: onClose }),
          jsxs('div', {
            className: `${P}drawer`,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
            children: [
              jsxs('div', {
                className: `${P}drawerHead`,
                children: [
                  jsx(Icon, { name: title === '成员' ? 'users' : 'tasks', size: 15 }),
                  jsx('span', { className: `${P}drawerTitle`, children: title }),
                  jsx('button', { type: 'button', className: `${P}iconBtn`, title: '关闭', onClick: onClose, children: jsx(Icon, { name: 'x', size: 14 }) }),
                ],
              }),
              jsx('div', { className: `${P}drawerBody`, children }),
            ],
          }),
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Project lifecycle dialog
     * ------------------------------------------------------------------ */

    function LifecycleDialog(props) {
      const { dialog, busy, error, onClose, onConfirm } = props;
      const [confirmTitle, setConfirmTitle] = useState('');
      const [ack, setAck] = useState(false);
      if (!dialog) return null;
      const { kind, room, preview } = dialog;
      const purge = kind === 'purge';
      const canConfirm = !purge || (confirmTitle.trim() === room.title && ack);
      const title = kind === 'purge' ? '永久删除项目' : kind === 'trash' ? '移入回收站' : kind === 'archive' ? '归档项目' : '清理预览';
      const icon = kind === 'purge' ? 'alert' : kind === 'trash' ? 'trash' : kind === 'archive' ? 'archive' : 'tasks';
      const close = () => {
        if (!busy) onClose();
      };
      const stats = preview?.counts ?? null;
      const statEntries = stats
        ? [
            ['消息', stats.messages],
            ['任务', stats.tasks],
            ['决定', stats.decisions],
            ['成果', stats.artifacts],
            ['成员', stats.members],
          ]
        : [];
      return jsxs(Fragment, {
        children: [
          jsx('div', { className: `${P}modalScrim`, onClick: close }),
          jsxs('div', {
            className: cx(`${P}modal`, purge && `${P}modalDanger`),
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
            children: [
              jsxs('div', {
                className: `${P}modalHead`,
                children: [
                  jsx('span', { className: `${P}modalIcon`, children: jsx(Icon, { name: icon, size: 16 }) }),
                  jsx('span', { className: `${P}modalTitle`, children: title }),
                  jsx('button', { type: 'button', className: `${P}iconBtn`, title: '关闭', disabled: busy, onClick: close, children: jsx(Icon, { name: 'x', size: 14 }) }),
                ],
              }),
              jsxs('div', {
                className: `${P}modalBody`,
                children: [
                  kind === 'archive'
                    ? jsx('div', {
                        className: `${P}modalText`,
                        children: '归档会停用自动执行，群记录、任务、决定与源代码都会保留。恢复时回到暂停态，不会自动唤醒成员。',
                      })
                    : null,
                  kind === 'trash'
                    ? jsxs(Fragment, {
                        children: [
                          jsx('div', {
                            className: `${P}modalText`,
                            children: '移入回收站会立即阻断新执行和投递。插件数据保留以便恢复；源代码、借用会话和 worktree 默认不删除。',
                          }),
                          jsx('div', {
                            className: `${P}modalText`,
                            children: '如果仍有成员在运行，这次操作只会发出停止请求；不会把“请求已发出”说成“已经安全停止”。',
                          }),
                        ],
                      })
                    : null,
                  kind === 'preview'
                    ? !preview
                      ? jsxs('div', { className: `${P}modalText`, children: [jsx('span', { className: `${P}spinner`, style: { marginRight: 8 } }), '正在读取清理范围…'] })
                      : jsxs(Fragment, {
                          children: [
                            jsxs('div', {
                              className: `${P}modalText`,
                              children: [
                                '项目：',
                                jsx('b', { children: preview.title }),
                                ` · ${roomStatusLabel(preview.status)} · 生命周期 r${preview.lifecycleRevision}`,
                              ],
                            }),
                            jsx('div', {
                              className: `${P}modalStats`,
                              children: statEntries.map(([label, value]) => jsxs('div', { className: `${P}stat`, children: [jsx('span', { className: `${P}statValue`, children: String(value ?? 0) }), jsx('span', { className: `${P}statLabel`, children: label })] }, label)),
                            }),
                            jsxs('div', {
                              className: `${P}modalSection`,
                              children: [
                                jsx('div', { className: `${P}sectionTitle`, children: '会删除的插件私有数据' }),
                                jsx('ul', { className: `${P}modalList`, children: (preview.pluginManagedData ?? []).map((line, index) => jsx('li', { children: line }, index)) }),
                              ],
                            }),
                            jsxs('div', {
                              className: `${P}modalSection`,
                              children: [
                                jsx('div', { className: `${P}sectionTitle`, children: '会释放的独占会话' }),
                                (preview.deletableOwnedResources ?? []).length === 0
                                  ? jsx('div', { className: `${P}hint`, children: '没有插件拥有的活动会话。' })
                                  : jsx('ul', {
                                      className: `${P}modalList`,
                                      children: preview.deletableOwnedResources.map((resource) =>
                                        jsx('li', { children: `${resource.displayName ?? resource.id} · ${resource.kind === 'session' ? '插件会话' : resource.kind}` }, resource.id),
                                      ),
                                    }),
                              ],
                            }),
                            jsxs('div', {
                              className: `${P}modalSection`,
                              children: [
                                jsx('div', { className: `${P}sectionTitle`, children: '默认保留，不会删除' }),
                                jsx('ul', {
                                  className: `${P}modalList`,
                                  children: (preview.protectedResources ?? []).map((resource) =>
                                    jsx('li', { children: `${resource.reason}${resource.path ? `（${resource.path}）` : ''}` }, resource.id),
                                  ),
                                }),
                              ],
                            }),
                            jsx('div', {
                              className: `${P}modalText`,
                              children: '永久删除只清理插件私有数据，并留下最小审计墓碑；源代码与借用会话默认保留。',
                            }),
                          ],
                        })
                    : null,
                  purge
                    ? !preview
                      ? jsxs('div', { className: `${P}modalText`, children: [jsx('span', { className: `${P}spinner`, style: { marginRight: 8 } }), '正在读取清理范围…'] })
                      : jsxs(Fragment, {
                          children: [
                            jsxs('div', {
                              className: `${P}modalText`,
                              children: [
                                '项目：',
                                jsx('b', { children: preview.title }),
                                ` · ${roomStatusLabel(preview.status)} · 生命周期 r${preview.lifecycleRevision}`,
                              ],
                            }),
                            jsx('div', {
                              className: `${P}modalStats`,
                              children: statEntries.map(([label, value]) => jsxs('div', { className: `${P}stat`, children: [jsx('span', { className: `${P}statValue`, children: String(value ?? 0) }), jsx('span', { className: `${P}statLabel`, children: label })] }, label)),
                            }),
                            jsx('div', {
                              className: `${P}modalText`,
                              children: `将删除：群消息 ${stats?.messages ?? 0} 条、投递 ${stats?.deliveries ?? 0} 条、任务 ${stats?.tasks ?? 0} 个、决定 ${stats?.decisions ?? 0} 个。将释放 ${(preview.deletableOwnedResources ?? []).length} 个插件拥有的会话；完整清单见“清理预览”。`,
                            }),
                            jsx('div', {
                              className: `${P}modalText`,
                              children: '源代码、借用会话、worktree 与宿主日志默认保留，插件不会声称清理了这些外部副本。',
                            }),
                          ],
                        })
                    : null,
                  purge
                    ? jsxs(Fragment, {
                        children: [
                          jsx('div', {
                            className: `${P}modalWarning`,
                            children: [
                              jsx(Icon, { name: 'alert', size: 14, key: 'icon' }),
                              jsx('span', { key: 'text', children: '不可恢复：这会永久删除该项目的插件数据。源代码、借用会话与宿主日志仍会保留；插件无法保证清除这些外部副本。' }),
                            ],
                          }),
                          jsxs('label', {
                            className: `${P}modalField`,
                            children: [
                              jsx('span', { className: `${P}label`, children: `输入项目名称「${room.title}」以确认` }),
                              jsx('input', {
                                className: `${P}input`,
                                value: confirmTitle,
                                placeholder: room.title,
                                disabled: busy,
                                onChange: (event) => setConfirmTitle(event.target.value),
                              }),
                            ],
                          }),
                          jsxs('label', {
                            className: `${P}modalCheck`,
                            children: [
                              jsx('input', { type: 'checkbox', checked: ack, disabled: busy, onChange: (event) => setAck(event.target.checked) }),
                              jsx('span', { children: '我明白插件数据不可恢复；源代码与借用会话默认保留，不会被这次操作删除。' }),
                            ],
                          }),
                        ],
                      })
                    : null,
                  error ? jsx('div', { className: cx(`${P}banner`, `${P}bannerErr`), children: [jsx(Icon, { name: 'alert', size: 13 }), jsx('span', { className: `${P}bannerText`, children: error })] }) : null,
                ],
              }),
              jsxs('div', {
                className: `${P}modalFoot`,
                children: [
                  jsx('span', { className: `${P}hint`, children: purge ? '永久删除需要精确名称与明确确认。' : '所有操作都可回退，除非明确标注“永久删除”。' }),
                  jsx('span', { className: `${P}spacer` }),
                  jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnGhost`), disabled: busy, onClick: close, children: '取消' }),
                  kind === 'preview'
                    ? jsx('button', {
                        type: 'button',
                        className: cx(`${P}btn`, `${P}btnPrimary`),
                        disabled: busy || !preview,
                        onClick: () => onConfirm('purge'),
                        children: [jsx(Icon, { name: 'trash', size: 14, key: 'icon' }), '永久删除…'],
                      })
                    : jsx('button', {
                        type: 'button',
                        className: cx(`${P}btn`, purge ? `${P}btnDangerSolid` : `${P}btnPrimary`),
                        disabled: busy || !canConfirm || (purge && !preview),
                        onClick: () => onConfirm(kind, purge ? { confirmTitle: confirmTitle.trim(), acknowledgeIrreversible: ack } : {}),
                        children: busy
                          ? [jsx('span', { className: `${P}spinner`, key: 'spinner' }), '处理中…']
                          : purge
                            ? '永久删除'
                            : kind === 'trash'
                              ? '移入回收站'
                              : '归档项目',
                      }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Deep research (deep research)
     * ------------------------------------------------------------------ */

    function researchMemberName(members, memberId) {
      return members?.find((member) => member.id === memberId)?.displayName ?? memberId;
    }

    function researchBudgetText(budget) {
      if (!budget) return '预算未读取';
      const maxCalls = budget.maxCalls ?? budget.maxModelCalls ?? 0;
      const usedCalls = budget.usedCalls ?? 0;
      const maxTokens = budget.maxTokens ?? budget.maxTotalTokens ?? 0;
      const usedTokens = budget.usedTokens ?? 0;
      const maxExperiments = budget.maxExperiments ?? budget.maxExperimentRuns ?? 0;
      const usedExperiments = budget.experimentsUsed ?? 0;
      return `${usedCalls}/${maxCalls} 次调用 · ${usedTokens}/${maxTokens} tokens · ${usedExperiments}/${maxExperiments} 次实验`;
    }

    /**
     * The approval/status card rendered above the timeline. It is intentionally
     * not dismissible while a proposal is pending: closing a card is not approval,
     * and the server has no way to turn a dismissed card into a grant.
     */
    function ResearchCard(props) {
      const { research, members, busy, error, onAction, onAdjust } = props;
      const [expanded, setExpanded] = useState(false);
      if (!research?.enabled) return null;
      const pending = research.pending;
      const run = research.run;
      const proposal = pending ?? research.proposal;
      const status = pending ? 'AWAITING_APPROVAL' : run?.status;
      if (!proposal || !status) return null;
      if (!['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'PAUSED_RECONCILE', 'COMPLETED'].includes(status)) return null;

      const budget = research.budget ?? proposal.budget;
      const approval = research.approval;
      const participants = (proposal.participantPlan ?? []).map((entry) => entry.displayName ?? researchMemberName(members, entry.memberId));
      const allowedPaths = proposal.scope?.allowedPaths ?? [];
      const findings = research.findings ?? [];
      const experience = research.experience ?? [];
      const sessions = research.sessions ?? [];
      const experiments = research.experiments ?? [];
      const hypotheses = research.hypotheses ?? [];
      const outcome = research.outcome;
      const statusLabel = RESEARCH_STATUS_LABELS[status] ?? status;
      const pendingApproval = status === 'AWAITING_APPROVAL';
      const canStart = status === 'APPROVED' || status === 'PAUSED';

      return jsxs('div', {
        className: cx(`${P}researchCard`, pendingApproval && `${P}researchPending`),
        'data-status': status,
        children: [
          jsxs('div', {
            className: `${P}researchHead`,
            children: [
              jsx('span', { className: `${P}researchIcon`, children: jsx(Icon, { name: 'spark', size: 16 }) }),
              jsxs('div', {
                className: `${P}researchHeadText`,
                children: [
                  jsxs('div', {
                    className: `${P}researchTitleRow`,
                    children: [
                      jsx('span', { className: `${P}researchBadge`, children: pendingApproval ? '需要你决定' : '深度研究' }),
                      jsx('span', { className: `${P}researchTitle`, children: proposal.topic }),
                      jsx('span', { className: `${P}researchStatus`, 'data-status': status, children: statusLabel }),
                    ],
                  }),
                  jsx('div', {
                    className: `${P}researchMeta`,
                    children: `${participants.join('、')} · 范围 ${allowedPaths.length} 个路径 · ${budget ? `预算 ${budget.maxCalls ?? budget.maxModelCalls ?? 0} 次调用 / ${budget.maxTokens ?? budget.maxTotalTokens ?? 0} tokens` : '预算待确认'}`,
                  }),
                ],
              }),
              jsx('button', {
                type: 'button',
                className: `${P}researchToggle`,
                onClick: () => setExpanded((current) => !current),
                children: expanded ? '收起' : '详情',
              }),
            ],
          }),
          jsxs('div', {
            className: `${P}researchBody`,
            children: [
              jsx('div', { className: `${P}researchObjective`, children: proposal.objective }),
              pendingApproval
                ? jsx('div', { className: `${P}researchWhy`, children: `为什么需要研究：${proposal.justification}` })
                : null,
              jsxs('div', {
                className: `${P}researchFacts`,
                children: [
                  jsxs('span', { className: `${P}researchFact`, children: [jsx(Icon, { name: 'folder', size: 12 }), allowedPaths[0] ?? '未设置范围'] }),
                  jsxs('span', { className: `${P}researchFact`, children: [jsx(Icon, { name: 'clock', size: 12 }), `${Math.round((budget?.maxWallClockMs ?? 0) / 60000)} 分钟上限`] }),
                  run
                    ? jsxs('span', { className: `${P}researchFact`, children: [jsx(Icon, { name: 'spark', size: 12 }), `阶段 ${RESEARCH_PHASE_LABELS[run.currentPhase] ?? run.currentPhase}`] })
                    : null,
                  run
                    ? jsxs('span', { className: `${P}researchFact`, children: [jsx(Icon, { name: 'model', size: 12 }), researchBudgetText(budget)] })
                    : jsxs('span', { className: `${P}researchFact`, children: [jsx(Icon, { name: 'model', size: 12 }), `${proposal.budget?.maxModelCalls ?? 0} 次调用上限`] }),
                  approval ? jsx('span', { className: `${P}researchFact`, children: `已批准 · ${approval.approvedBy ? researchMemberName(members, approval.approvedBy) : '真实用户'}` }) : null,
                ],
              }),
              pendingApproval
                ? jsx('div', {
                    className: `${P}researchWarning`,
                    children: '只有你点击下面的批准按钮，研究才会进入下一步；关闭卡片、群里说“同意”或代理自称已批准都不算。',
                  })
                : null,
              status === 'COMPLETED' && outcome
                ? jsxs('div', {
                    className: `${P}researchOutcome`,
                    children: [
                      jsx('b', { children: `结论：${RESEARCH_CONCLUSION_LABELS[outcome.decision] ?? outcome.decision}` }),
                      outcome.remainingRisks?.length ? jsx('span', { children: ` · 剩余风险 ${outcome.remainingRisks.length} 项` }) : null,
                      research.flowback ? jsx('span', { children: ' · 已回流到项目决定/任务' }) : null,
                    ],
                  })
                : null,
              error ? jsx('div', { className: `${P}researchError`, children: error }) : null,
              expanded
                ? jsxs('div', {
                    className: `${P}researchDetails`,
                    children: [
                      jsxs('div', {
                        className: `${P}researchDetailSection`,
                        children: [
                          jsx('div', { className: `${P}sectionTitle`, children: `假设 ${hypotheses.length}` }),
                          hypotheses.length === 0
                            ? jsx('div', { className: `${P}hint`, children: '还没有成员提交独立假设。' })
                            : jsx('ul', { className: `${P}researchList`, children: hypotheses.slice(0, 6).map((entry) => jsx('li', { children: entry.claim }, entry.id)) }),
                        ],
                      }),
                      jsxs('div', {
                        className: `${P}researchDetailSection`,
                        children: [
                          jsx('div', { className: `${P}sectionTitle`, children: `实验 ${experiments.length}` }),
                          experiments.length === 0
                            ? jsx('div', { className: `${P}hint`, children: '还没有登记真实实验。' })
                            : jsx('ul', {
                                className: `${P}researchList`,
                                children: experiments.slice(0, 5).map((entry) =>
                                  jsx('li', { children: `${entry.commandRefs?.[0] ?? '未记录命令'} · ${entry.state}` }, entry.id),
                                ),
                              }),
                        ],
                      }),
                      jsxs('div', {
                        className: `${P}researchDetailSection`,
                        children: [
                          jsx('div', { className: `${P}sectionTitle`, children: `发现 ${findings.length}` }),
                          findings.length === 0
                            ? jsx('div', { className: `${P}hint`, children: '还没有带证据级别的发现。' })
                            : jsx('ul', {
                                className: `${P}researchList`,
                                children: findings.slice(0, 6).map((entry) => jsx('li', { children: `[${entry.evidenceLevel}] ${entry.issue}` }, entry.id)),
                              }),
                        ],
                      }),
                      jsxs('div', {
                        className: `${P}researchDetailSection`,
                        children: [
                          jsx('div', { className: `${P}sectionTitle`, children: `本项目经验 ${experience.length}` }),
                          experience.length === 0
                            ? jsx('div', { className: `${P}hint`, children: '还没有已保存的研究经验。' })
                            : jsx('ul', {
                                className: `${P}researchList`,
                                children: experience.slice(0, 5).map((entry) => jsx('li', { children: entry.reusableLesson }, entry.id)),
                              }),
                        ],
                      }),
                      jsxs('div', {
                        className: `${P}researchDetailSection`,
                        children: [
                          jsx('div', { className: `${P}sectionTitle`, children: `研究专用会话 ${sessions.length}` }),
                          sessions.length === 0
                            ? jsx('div', { className: `${P}hint`, children: '还没有研究专用会话记录。' })
                            : jsx('ul', {
                                className: `${P}researchList`,
                                children: sessions.slice(0, 6).map((entry) => jsx('li', { children: `${entry.status} · ${entry.sessionId.slice(-12)}` }, entry.sessionId)),
                              }),
                        ],
                      }),
                      jsxs('div', {
                        className: `${P}researchDetailSection`,
                        children: [
                          jsx('div', { className: `${P}sectionTitle`, children: '范围与审计' }),
                          jsx('ul', {
                            className: `${P}researchList`,
                            children: allowedPaths.map((path) => jsx('li', { children: path }, path)),
                          }),
                          jsx('div', { className: `${P}hint`, children: `scopeDigest ${proposal.scopeDigest?.slice(0, 16) ?? '未记录'}… · 计划版本 r${run?.basePlanRevision ?? 0}` }),
                        ],
                      }),
                    ],
                  })
                : null,
            ],
          }),
          jsxs('div', {
            className: `${P}researchActions`,
            children: [
              pendingApproval
                ? jsxs(Fragment, {
                    children: [
                      jsx('button', {
                        type: 'button',
                        className: cx(`${P}btn`, `${P}btnPrimary`),
                        disabled: busy,
                        onClick: () =>
                          onAction('approve', {
                            researchId: proposal.researchId,
                            expectedProposalRevision: proposal.proposalRevision,
                            scopeDigest: proposal.scopeDigest,
                          }),
                        children: busy ? [jsx('span', { className: `${P}spinner`, key: 'spinner' }), '处理中…'] : [jsx(Icon, { name: 'check', size: 14, key: 'icon' }), '批准本次研究'],
                      }),
                      jsx('button', {
                        type: 'button',
                        className: cx(`${P}btn`, `${P}btnGhost`),
                        disabled: busy,
                        onClick: () =>
                          onAction('reject', {
                            researchId: proposal.researchId,
                            expectedProposalRevision: proposal.proposalRevision,
                            scopeDigest: proposal.scopeDigest,
                          }),
                        children: '不批准，继续常规开发',
                      }),
                      jsx('button', {
                        type: 'button',
                        className: cx(`${P}btn`, `${P}btnGhost`),
                        disabled: busy,
                        onClick: () => onAction('cancel', { researchId: proposal.researchId, reason: '用户取消提议' }),
                        children: '取消这次提议',
                      }),
                      jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnGhost`), disabled: busy, onClick: () => onAdjust(proposal), children: '调整范围 / 预算' }),
                    ],
                  })
                : null,
              canStart
                ? jsxs(Fragment, {
                    children: [
                      jsx('button', {
                        type: 'button',
                        className: cx(`${P}btn`, `${P}btnPrimary`),
                        disabled: busy,
                        onClick: () => onAction('start', { researchId: run.id }),
                        children: [jsx(Icon, { name: 'play', size: 14, key: 'icon' }), status === 'PAUSED' ? '恢复研究' : '开始研究'],
                      }),
                      jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnGhost`), disabled: busy, onClick: () => onAdjust(proposal), children: '调整范围 / 预算' }),
                      jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnGhost`, `${P}btnDanger`), disabled: busy, onClick: () => onAction('stop', { researchId: run.id, reason: '用户停止' }), children: '停止' }),
                    ],
                  })
                : null,
              status === 'PAUSED_RECONCILE'
                ? jsxs(Fragment, {
                    children: [
                      jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnPrimary`), disabled: busy, onClick: () => onAction('reconcile', { researchId: run.id }), children: '核对后恢复' }),
                      jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnGhost`, `${P}btnDanger`), disabled: busy, onClick: () => onAction('stop', { researchId: run.id, reason: '用户停止' }), children: '停止研究' }),
                    ],
                  })
                : null,
              status === 'RUNNING'
                ? jsxs(Fragment, {
                    children: [
                      jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnGhost`), disabled: busy, onClick: () => onAction('pause', { researchId: run.id, reason: '用户暂停' }), children: '暂停研究' }),
                      jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnGhost`, `${P}btnDanger`), disabled: busy, onClick: () => onAction('stop', { researchId: run.id, reason: '用户停止' }), children: '停止研究' }),
                    ],
                  })
                : null,
            ],
          }),
        ],
      });
    }

    /** Budget/scope adjustment. Saving creates a new proposal revision. */
    function ResearchAdjustDialog(props) {
      const { proposal, busy, error, onClose, onSubmit } = props;
      const [budget, setBudget] = useState({
        maxModelCalls: proposal.budget?.maxModelCalls ?? 32,
        maxTotalTokens: proposal.budget?.maxTotalTokens ?? 120000,
        maxWallClockMs: proposal.budget?.maxWallClockMs ?? 3600000,
        maxExperimentRuns: proposal.budget?.maxExperimentRuns ?? 10,
        maxParallelAgents: proposal.budget?.maxParallelAgents ?? 3,
      });
      const [paths, setPaths] = useState((proposal.scope?.allowedPaths ?? []).join('\n'));
      const [excluded, setExcluded] = useState((proposal.scope?.excludedPaths ?? []).join('\n'));
      const numberField = (key, label, suffix) =>
        jsxs('label', {
          className: `${P}researchField`,
          children: [
            jsx('span', { className: `${P}label`, children: label }),
            jsx('input', {
              type: 'number',
              min: 1,
              className: `${P}input`,
              value: budget[key],
              disabled: busy,
              onChange: (event) => setBudget((current) => ({ ...current, [key]: Number(event.target.value) })),
            }),
            suffix ? jsx('span', { className: `${P}hint`, children: suffix }) : null,
          ],
        });
      return jsxs('div', {
        className: `${P}modalScrim`,
        onClick: (event) => {
          if (event.target === event.currentTarget && !busy) onClose();
        },
        children: [
          jsxs('div', {
            className: `${P}modal`,
            role: 'dialog',
            'aria-modal': 'true',
            children: [
              jsxs('div', {
                className: `${P}modalHead`,
                children: [
                  jsx('span', { className: `${P}modalIcon`, children: jsx(Icon, { name: 'spark', size: 16 }) }),
                  jsx('div', { className: `${P}modalTitle`, children: '调整研究范围 / 预算' }),
                  jsx('button', { type: 'button', className: `${P}iconBtn`, disabled: busy, onClick: onClose, children: jsx(Icon, { name: 'x', size: 15 }) }),
                ],
              }),
              jsxs('div', {
                className: `${P}modalBody`,
                children: [
                  jsx('div', { className: `${P}modalText`, children: '保存后会生成新的提议版本，旧批准立即失效，必须再次明确批准。不能借“调整”把旧批准延伸到新的范围或预算。' }),
                  jsxs('div', {
                    className: `${P}researchFieldGrid`,
                    children: [
                      numberField('maxModelCalls', '模型调用上限', '正整数'),
                      numberField('maxTotalTokens', 'Token 上限', '正整数'),
                      numberField('maxWallClockMs', '最长时长（毫秒）', '正整数'),
                      numberField('maxExperimentRuns', '实验次数上限', '正整数'),
                      numberField('maxParallelAgents', '最大并行成员', '正整数'),
                    ],
                  }),
                  jsxs('label', {
                    className: `${P}researchField`,
                    children: [
                      jsx('span', { className: `${P}label`, children: '允许路径（每行一个，必须在项目工作区内）' }),
                      jsx('textarea', { className: `${P}textarea`, rows: 4, value: paths, disabled: busy, onChange: (event) => setPaths(event.target.value) }),
                    ],
                  }),
                  jsxs('label', {
                    className: `${P}researchField`,
                    children: [
                      jsx('span', { className: `${P}label`, children: '排除路径（每行一个）' }),
                      jsx('textarea', { className: `${P}textarea`, rows: 3, value: excluded, disabled: busy, onChange: (event) => setExcluded(event.target.value) }),
                    ],
                  }),
                  error ? jsx('div', { className: cx(`${P}banner`, `${P}bannerErr`), children: error }) : null,
                ],
              }),
              jsxs('div', {
                className: `${P}modalFoot`,
                children: [
                  jsx('span', { className: `${P}hint`, children: '保存后不会启动研究；它会回到“待批准”。' }),
                  jsx('span', { className: `${P}spacer` }),
                  jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnGhost`), disabled: busy, onClick: onClose, children: '取消' }),
                  jsx('button', {
                    type: 'button',
                    className: cx(`${P}btn`, `${P}btnPrimary`),
                    disabled: busy || !paths.trim(),
                    onClick: () =>
                      onSubmit({
                        researchId: proposal.researchId,
                        budget,
                        allowedPaths: paths.split('\n').map((line) => line.trim()).filter(Boolean),
                        excludedPaths: excluded.split('\n').map((line) => line.trim()).filter(Boolean),
                      }),
                    children: busy ? [jsx('span', { className: `${P}spinner`, key: 'spinner' }), '保存中…'] : '保存为新版本',
                  }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * The panel
     * ------------------------------------------------------------------ */

    function ProjectRoomPanel() {
      const rootRef = useRef(null);
      const [rooms, setRooms] = useState([]);
      const [roomId, setRoomId] = useState(null);
      const [state, setState] = useState(null);
      const [fallbackModels, setFallbackModels] = useState([]);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [refreshing, setRefreshing] = useState(false);
      const [creating, setCreating] = useState(false);
      const [drawer, setDrawer] = useState(null);
      const [menu, setMenu] = useState({ open: false, x: 0, y: 0, memberId: null, messageId: null, selfId: null });
      const [selectedMember, setSelectedMember] = useState(null);
      const [replyTo, setReplyTo] = useState(null);
      const [notice, setNotice] = useState(null);
      const [textSize, setTextSize] = useState(readTextSize);
      const [textMenu, setTextMenu] = useState(false);
      const [roomFilter, setRoomFilter] = useState('active');
      const [projectMenu, setProjectMenu] = useState(false);
      const [lifecycleDialog, setLifecycleDialog] = useState(null);
      const [lifecycleBusy, setLifecycleBusy] = useState(false);
      const [lifecycleError, setLifecycleError] = useState(null);
      const [researchBusy, setResearchBusy] = useState(false);
      const [researchError, setResearchError] = useState(null);
      const [researchAdjust, setResearchAdjust] = useState(null);
      const initialFilter = useRef(false);
      // A mention requested from an avatar menu travels as state, so the composer
      // can put the chip at the caret of the draft the user already typed. A window
      // event would have raced the composer's own state and lost the draft.
      const [pendingMention, setPendingMention] = useState(null);

      const selfId = useMemo(() => state?.members?.find((member) => member.kind === 'human')?.id ?? null, [state]);
      const models = state?.models ?? fallbackModels;
      const currentStatus = state?.room?.status ?? 'active';
      const currentLifecycleState = state?.room?.lifecycleState ?? null;
      const readOnly =
        currentStatus === 'trashed' ||
        currentStatus === 'archived' ||
        currentStatus === 'quiescing' ||
        currentStatus === 'purging' ||
        currentLifecycleState === 'BLOCKED' ||
        currentLifecycleState === 'PURGE_BLOCKED';
      const roomCounts = useMemo(
        () => ({
          active: rooms.filter((room) => room.status === 'active' || room.status === 'paused' || room.status === 'quiescing').length,
          archived: rooms.filter((room) => room.status === 'archived').length,
          trash: rooms.filter((room) => room.status === 'trashed' || room.status === 'purging').length,
        }),
        [rooms],
      );
      const visibleRooms = useMemo(() => rooms.filter((room) => roomFilterOf(room.status) === roomFilter), [rooms, roomFilter]);

      const loadRooms = useCallback(async () => {
        try {
          const result = await post('room.list', {});
          const list = result.rooms ?? [];
          setRooms(list);
          return list;
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          return [];
        }
      }, []);

      const loadModels = useCallback(async () => {
        try {
          const result = await post('room.model.list', {});
          setFallbackModels(result.profiles ?? []);
        } catch {
          // A room snapshot carries the same list; this fallback only makes the
          // create form usable before the first room exists.
        }
      }, []);

      const loadRoom = useCallback(
        async (id, options) => {
          if (!id) return;
          try {
            const result = await post('room.get', {
              roomId: id,
              afterSeq: options?.afterSeq ?? 0,
              limit: 200,
            });
            setState((current) => {
              if (!current || current.room.id !== id || !options?.afterSeq) return result;
              const seen = new Set(current.messages.map((message) => message.id));
              return { ...result, messages: [...current.messages, ...result.messages.filter((message) => !seen.has(message.id))] };
            });
            setError(null);
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          }
        },
        [],
      );

      useEffect(() => {
        void (async () => {
          const list = await loadRooms();
          if (list.length === 0) return;
          const preferred = list.find((room) => room.status === 'active' || room.status === 'paused') ?? list.find((room) => room.status === 'archived') ?? list[0];
          setRoomId((current) => current ?? preferred.id);
          if (!initialFilter.current) {
            initialFilter.current = true;
            setRoomFilter(roomFilterOf(preferred.status));
          }
        })();
        void loadModels();
      }, [loadRooms, loadModels]);

      useEffect(() => {
        if (roomId) void loadRoom(roomId);
      }, [roomId, loadRoom]);

      useEffect(() => {
        setSelectedMember(null);
        setReplyTo(null);
      }, [roomId]);

      // Cursor-based refresh: the timeline is a durable record, so a reconnect
      // refills from storage rather than trusting a push it might have missed.
      useEffect(() => {
        if (!roomId) return undefined;
        const timer = setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          const lastSeq = state?.nextSeq ?? 0;
          void loadRoom(roomId, { afterSeq: lastSeq });
        }, 4000);
        return () => clearInterval(timer);
      }, [roomId, state?.nextSeq, loadRoom]);

      useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), 5200);
        return () => clearTimeout(timer);
      }, [notice]);

      // Persist the reading size across reloads; a blocked store is harmless.
      useEffect(() => {
        try {
          window.localStorage?.setItem('dpr-text-size', textSize);
        } catch {
          /* private mode or a missing store */
        }
      }, [textSize]);

      // The "Aa" popover closes on an outside click or Escape. Deferring the
      // listener keeps the click that opened it from closing it immediately.
      useEffect(() => {
        if (!textMenu) return undefined;
        const close = (event) => {
          const target = event.target;
          if (target?.closest?.(`.${P}textSize`)) return;
          setTextMenu(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setTextMenu(false);
        };
        const timer = setTimeout(() => {
          window.addEventListener('click', close);
          window.addEventListener('keydown', onKey);
        }, 0);
        return () => {
          clearTimeout(timer);
          window.removeEventListener('click', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [textMenu]);

      // The project-actions menu has the same outside-click/Escape contract.
      useEffect(() => {
        if (!projectMenu) return undefined;
        const close = (event) => {
          if (event.target?.closest?.(`.${P}projectActions`)) return;
          setProjectMenu(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setProjectMenu(false);
        };
        const timer = setTimeout(() => {
          window.addEventListener('click', close);
          window.addEventListener('keydown', onKey);
        }, 0);
        return () => {
          clearTimeout(timer);
          window.removeEventListener('click', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [projectMenu]);

      useEffect(() => {
        if (!lifecycleDialog) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape' && !lifecycleBusy) {
            setLifecycleDialog(null);
            setLifecycleError(null);
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [lifecycleDialog, lifecycleBusy]);

      useEffect(() => {
        if (!drawer) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setDrawer(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [drawer]);

      const send = useCallback(
        async (input) => {
          if (!state || !selfId) throw new Error('还没有可用的群身份。');
          setBusy(true);
          try {
            const result = await post('room.message.send', {
              roomId: state.room.id,
              actorId: selfId,
              body: input.body,
              mentions: input.mentions,
              replyTo: replyTo?.id ?? null,
              membershipRevision: input.membershipRevision,
              clientMessageId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            });
            setReplyTo(null);
            await loadRoom(state.room.id, { afterSeq: state.nextSeq });
            return result;
          } finally {
            setBusy(false);
          }
        },
        [state, selfId, replyTo, loadRoom],
      );

      const control = useCallback(
        async (member, command) => {
          try {
            if (command === 'retire' && !window.confirm(`让 ${member.displayName} 退出本群？未完成的任务会转为待交接。`)) return;
            await post('room.member.control', { roomId: state.room.id, memberId: member.id, control: command });
            await loadRoom(state.room.id);
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          }
        },
        [state, loadRoom],
      );

      const closeMenu = useCallback(() => {
        setMenu({ open: false, x: 0, y: 0, memberId: null, messageId: null, selfId });
      }, [selfId]);

      const handleMenuPick = useCallback(
        async (action, member) => {
          closeMenu();
          if (action === 'mention') {
            // The menu's whole purpose is to put a chip in the composer WITHOUT
            // sending. The chip travels as state, not as a
            // window event, so the composer can insert it at the caret of the
            // draft the user already typed.
            setPendingMention({ memberId: member.id, displayName: member.displayName, at: Date.now() });
            setNotice({
              kind: 'ok',
              text:
                member.id === selfId
                  ? '已把你自己插入输入框（只作留注记，不会触发模型）。'
                  : `已把 ${member.displayName} 插入输入框，按需要继续补充内容再发送。`,
            });
            return;
          }
          if (action === 'reply') {
            const message = state?.messages?.find((entry) => entry.id === menu.messageId);
            if (message) {
              const author = state.members.find((entry) => entry.id === message.authorId);
              setReplyTo({ ...message, authorName: author?.displayName ?? message.authorId });
            }
            return;
          }
          if (action === 'detail' || action === 'model' || action === 'task') {
            setSelectedMember(member);
            // The left pane and its member detail are hidden below the same
            // container width the stylesheet uses, so surface the drawer there.
            if ((rootRef.current?.clientWidth ?? Number.POSITIVE_INFINITY) <= 920) setDrawer('members');
            return;
          }
          if (action === 'pause' || action === 'resume' || action === 'retire') {
            await control(member, action);
          }
        },
        [state, menu.messageId, selfId, control, closeMenu],
      );

      const selectRoom = useCallback(
        (id) => {
          const room = rooms.find((entry) => entry.id === id);
          setRoomId(id);
          if (room) setRoomFilter(roomFilterOf(room.status));
          setProjectMenu(false);
        },
        [rooms],
      );

      const selectFilter = useCallback(
        (id) => {
          setRoomFilter(id);
          const currentGroup = state?.room ? roomFilterOf(state.room.status) : null;
          if (currentGroup === id) return;
          const first = rooms.find((room) => roomFilterOf(room.status) === id);
          if (first) setRoomId(first.id);
        },
        [rooms, state],
      );

      /** Notice copy for one lifecycle transition, including an unconfirmed stop. */
      const lifecycleNotice = (action, result) => {
        if (result?.blocked) {
          if (result.reason === 'PURGE_BLOCKED') {
            return '永久删除仍有残留：项目留在回收站，插件数据未删除；请审计后重试清理，或恢复项目。';
          }
          const names = (result?.stop?.stillRunning ?? []).map((entry) => entry.displayName).filter(Boolean);
          return `停止尚未确认${names.length > 0 ? `（${names.join('、')}）` : ''}；项目已阻断新执行，请重试核对或取消请求。`;
        }
        const stop = result?.stop;
        const pendingStop = stop && stop.running > 0 && !stop.confirmed ? ' 宿主尚未确认停止，请留意阻塞状态。' : '';
        if (action === 'pause') return `项目已暂停，新执行被阻断。${pendingStop}`;
        if (action === 'resume') {
          const failed = result?.sessions?.failed?.length ?? 0;
          return failed > 0 ? `项目已恢复运行，但有 ${failed} 位成员的会话恢复失败；请查看成员状态。` : '项目已恢复运行。';
        }
        if (action === 'archive') return `项目已归档；恢复时会回到暂停态，不会自动启动成员。${pendingStop}`;
        if (action === 'trash') {
          const days = result?.daysLeft ?? result?.room?.trashDaysLeft;
          return `已移入回收站${days != null ? `，保留 ${days} 天` : ''}；源代码、借用会话和 worktree 未删除。${pendingStop}`;
        }
        if (action === 'restore') {
          return result?.abandonedCleanup
            ? '项目已恢复为暂停态；之前的清理被放弃，残留资源已重新纳入项目，不会自动继续执行。'
            : '项目已恢复为暂停态；成员不会自动继续执行，需要你再次恢复运行。';
        }
        if (action === 'purge') return '插件的项目数据已永久删除；源代码、借用会话、worktree 与宿主日志保留。';
        if (action === 'reconcile') return '停止已确认，项目状态已推进。';
        if (action === 'cancel') return '已取消待处理的停止请求，项目回到原状态。';
        return '操作完成。';
      };

      const applyLifecycleResult = useCallback(
        async (action, result) => {
          const actedRoomId = state?.room?.id ?? null;
          const list = await loadRooms();
          if (action === 'purge') {
            const remaining = list.filter((room) => room.id !== (result?.projectId ?? actedRoomId));
            const next = remaining.find((room) => room.status === 'active' || room.status === 'paused') ?? remaining.find((room) => room.status === 'archived') ?? remaining[0] ?? null;
            setState(null);
            setRoomId(next?.id ?? null);
            setRoomFilter(next ? roomFilterOf(next.status) : 'trash');
            setSelectedMember(null);
            setReplyTo(null);
          } else {
            if (actedRoomId) await loadRoom(actedRoomId);
            const nextStatus = result?.room?.status ?? result?.to ?? null;
            if (nextStatus) setRoomFilter(roomFilterOf(nextStatus));
          }
          setLifecycleDialog(null);
          setLifecycleError(null);
          setProjectMenu(false);
          setNotice({ kind: result?.blocked ? 'warn' : 'ok', text: lifecycleNotice(action, result) });
        },
        [state, loadRooms, loadRoom],
      );

      const runLifecycle = useCallback(
        async (action, extra = {}) => {
          if (!state?.room) return null;
          setLifecycleBusy(true);
          setLifecycleError(null);
          try {
            const result = await post(`room.project.${action}`, {
              roomId: state.room.id,
              expectedLifecycleRevision: state.room.lifecycleRevision ?? 0,
              idempotencyKey: `ui-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              ...extra,
            });
            await applyLifecycleResult(action, result);
            return result;
          } catch (failure) {
            const message = String(failure?.message ?? failure);
            const failedRefs = failure?.details?.failedRefs ?? [];
            const residue = failedRefs.length > 0
              ? ` 残留：${failedRefs.map((ref) => ref.hostRef ?? ref.resourceId ?? ref.reason ?? '?').join('、')}`
              : '';
            if (failure?.code === 'PROJECT_PURGE_BLOCKED') {
              if (state?.room?.id) await loadRoom(state.room.id);
              setLifecycleDialog(null);
              setNotice({ kind: 'warn', text: `永久删除已阻塞，项目数据保留。${residue}` });
              return null;
            }
            setLifecycleError(`${message}${residue}`);
            if (!lifecycleDialog) setError(`${message}${residue}`);
            return null;
          } finally {
            setLifecycleBusy(false);
          }
        },
        [state, applyLifecycleResult, lifecycleDialog, loadRoom],
      );

      const openLifecycleDialog = useCallback(
        async (kind) => {
          if (!state?.room) return;
          setProjectMenu(false);
          setLifecycleError(null);
          setLifecycleDialog({ kind, room: state.room, preview: null });
          if (kind !== 'preview' && kind !== 'purge') return;
          setLifecycleBusy(true);
          try {
            const preview = await post('room.project.cleanup.preview', { roomId: state.room.id });
            setLifecycleDialog((current) => (current && current.kind === kind ? { ...current, preview } : current));
          } catch (failure) {
            setLifecycleError(String(failure?.message ?? failure));
          } finally {
            setLifecycleBusy(false);
          }
        },
        [state],
      );

      const handleDialogConfirm = useCallback(
        async (action, extra = {}) => {
          if (!lifecycleDialog) return;
          if (action === 'purge' && lifecycleDialog.kind === 'preview') {
            setLifecycleDialog({ ...lifecycleDialog, kind: 'purge' });
            setLifecycleError(null);
            return;
          }
          await runLifecycle(action, extra);
        },
        [lifecycleDialog, runLifecycle],
      );

      const handleProjectAction = useCallback(
        (action) => {
          setProjectMenu(false);
          if (action === 'pause' || action === 'resume' || action === 'restore' || action === 'reconcile' || action === 'cancel') {
            void runLifecycle(action);
            return;
          }
          if (action === 'archive' || action === 'trash' || action === 'preview' || action === 'purge') {
            void openLifecycleDialog(action);
          }
        },
        [runLifecycle, openLifecycleDialog],
      );

      const researchNotice = (action, result) => {
        if (action === 'approve') return '已批准这次研究。研究仍未执行；请点击“开始研究”才会进入 RUNNING。';
        if (action === 'reject') return '已不批准这次研究，项目继续常规开发。';
        if (action === 'revise') return '已生成新的研究提议版本；旧批准已失效，请重新审批。';
        if (action === 'start') return '研究已启动。参与成员会收到一次范围受限的启动说明；预算与范围变化必须重新审批。';
        if (action === 'pause') return '研究已暂停，新准入被阻断；已经发生的副作用不会自动回滚。';
        if (action === 'reconcile') return '已确认重启后的研究状态，研究回到暂停态；需要你再次点击“恢复研究”。';
        if (action === 'stop') return '研究已停止；批准已撤销，恢复项目也不会复用旧批准。';
        if (action === 'cancel') return '已取消这次研究提议；没有批准、没有研究调用，项目继续常规开发。';
        return '研究状态已更新。';
      };

      const researchAction = useCallback(
        async (action, payload = {}) => {
          if (!state?.room) return null;
          setResearchBusy(true);
          setResearchError(null);
          try {
            const result = await post(`room.research.${action}`, {
              roomId: state.room.id,
              ...payload,
              ...(action === 'approve' || action === 'reject'
                ? { idempotencyKey: `ui-research-${action}:${payload.researchId}:${payload.expectedProposalRevision}` }
                : {}),
            });
            await loadRoom(state.room.id);
            setResearchAdjust(null);
            setNotice({ kind: 'ok', text: researchNotice(action, result) });
            return result;
          } catch (failure) {
            const message = String(failure?.message ?? failure);
            setResearchError(message);
            setNotice({ kind: 'warn', text: message });
            return null;
          } finally {
            setResearchBusy(false);
          }
        },
        [state, loadRoom],
      );

      const handleResearchAction = useCallback(
        (action, payload) => {
          void researchAction(action, payload);
        },
        [researchAction],
      );

      const submitResearchAdjust = useCallback(
        (values) => {
          if (!selfId) {
            setResearchError('没有可识别的人类成员，不能修改研究提议。');
            return;
          }
          void researchAction('revise', { ...values, actorId: selfId });
        },
        [researchAction, selfId],
      );

      const changeModel = useCallback(
        async (member, profileRef) => {
          try {
            const result = await post('room.member.model.set', {
              roomId: state.room.id,
              memberId: member.id,
              profileRef,
              expectedConfigRevision: member.modelConfigRevision,
              source: 'member-fixed',
            });
            setNotice({
              kind: result.state === 'applied' ? 'ok' : 'warn',
              text:
                result.state === 'applied'
                  ? `已切换 ${member.displayName} 的模型，下一次请求生效；身份、@ 名称与任务归属不变。`
                  : `模型已记录为待切换（${result.state}）；成员的旧配置仍然有效，直到新路由可用。`,
            });
            await loadRoom(state.room.id);
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          }
        },
        [state, loadRoom],
      );

      /**
       * Save the project's model configuration.
       *
       * The service refuses an allowed-pool mode with an empty pool, so the error is
       * surfaced as-is rather than pre-empted: the user should see the rule, not a
       * disabled button with no explanation.
       */
      const saveModelSettings = useCallback(
        async (patch) => {
          if (!state) throw new Error('还没有选中的项目群。');
          const result = await post('room.model.settings.set', { roomId: state.room.id, patch });
          await loadRoom(state.room.id);
          return result;
        },
        [state, loadRoom],
      );

      /** Manual retry of one delivery the reconciliation marked as failed. */
      const onAction = useCallback(
        async (action, payload) => {
          if (action !== 'retry') return;
          try {
            await post('room.delivery.retry', { roomId: state.room.id, messageId: payload.messageId });
            await loadRoom(state.room.id);
            setNotice({ kind: 'ok', text: '已按核对结果重新投递。' });
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          }
        },
        [state, loadRoom],
      );

      const refresh = useCallback(async () => {
        if (!roomId) return;
        setRefreshing(true);
        try {
          // Refresh must also re-read the room list: a project created in another
          // window (or through the route) would otherwise stay invisible until a
          // full page reload.
          await loadRooms();
          await loadRoom(roomId);
        } finally {
          setRefreshing(false);
        }
      }, [roomId, loadRooms, loadRoom]);

      const openCreate = useCallback(() => {
        setDrawer(null);
        setCreating(true);
        if (fallbackModels.length === 0) void loadModels();
      }, [fallbackModels.length, loadModels]);

      const openMenu = useCallback((event, member, intent, message) => {
        if (!member?.id) return;
        const rect = rootRef.current?.getBoundingClientRect();
        const width = rect?.width ?? 1280;
        const height = rect?.height ?? 800;
        const x = clamp((event?.clientX ?? 0) - (rect?.left ?? 0), 8, Math.max(8, width - 224));
        const y = clamp((event?.clientY ?? 0) - (rect?.top ?? 0), 8, Math.max(8, height - 304));
        setMenu({ open: true, x, y, memberId: member.id, messageId: message?.id ?? null, selfId });
      }, [selfId]);

      if (creating) {
        return jsxs('div', {
          className: `${P}root`,
          ref: rootRef,
          'data-text': textSize,
          children: [
            jsx('style', { children: CSS }),
            jsx(CreateRoom, {
              models,
              onCancel: () => setCreating(false),
              onCreated: async (result) => {
                setCreating(false);
                await loadRooms();
                if (result?.room?.id) setRoomId(result.room.id);
              },
            }),
          ],
        });
      }

      const status = state?.room?.status ?? 'active';
      const lifecycleState = state?.room?.lifecycleState ?? null;
      const blocked = lifecycleState === 'BLOCKED';
      const purgeBlocked = lifecycleState === 'PURGE_BLOCKED';
      const pendingAction = state?.room?.lifecyclePending?.action ?? null;
      const agentCount = state ? state.members.filter((member) => member.kind === 'agent').length : 0;
      const banners = [];
      if (state?.capabilities?.notes?.length) {
        banners.push(
          jsx('div', {
            key: 'capability',
            className: cx(`${P}banner`, `${P}bannerWarn`),
            children: [jsx(Icon, { name: 'alert', size: 13 }), jsx('span', { className: `${P}bannerText`, children: `当前宿主能力缺口：${state.capabilities.notes.join('；')}` })],
          }),
        );
      }
      if (state && (status !== 'active' || currentLifecycleState === 'BLOCKED' || currentLifecycleState === 'PURGE_BLOCKED')) {
        const trashed = status === 'trashed';
        const archived = status === 'archived';
        const quiescing = status === 'quiescing';
        const purging = status === 'purging';
        const blocked = currentLifecycleState === 'BLOCKED';
        const purgeBlocked = currentLifecycleState === 'PURGE_BLOCKED';
        const pendingAction = state.room.lifecyclePending?.action ?? null;
        const stuckNames = (state.room.lifecyclePending?.stop?.stillRunning ?? []).map((entry) => entry.displayName).filter(Boolean);
        const text = purgeBlocked
          ? '清理受阻 · 部分独占资源未能释放；项目仍在回收站，插件数据与源码保留。审计残留后可重试永久删除，或恢复项目。'
          : blocked
            ? `停止未确认 · ${stuckNames.length > 0 ? `${stuckNames.join('、')} 的停止结果未知；` : ''}${pendingAction === 'trash' ? '回收站' : pendingAction === 'archive' ? '归档' : '暂停'}请求尚未得到宿主确认，项目已阻断新执行。请重试核对，或取消这次请求。`
            : quiescing
              ? '正在停止执行 · 新任务、消息、投递与唤醒已阻断；只有确认停止后才会进入目标状态。'
              : purging
                ? '正在永久删除 · 所有新工作已阻断；清理失败会停在“清理受阻”，不会假称完成。'
                : trashed
                  ? '项目在回收站 · 只读，不会执行或投递新工作；插件数据保留以便恢复，源代码、借用会话与 worktree 默认保留。'
                  : archived
                    ? '项目已归档 · 只读；历史、任务、决定与源码保留。恢复后回到暂停态，不会自动启动成员。'
                    : '项目已暂停 · 成员不会继续执行，已排队的投递会保留。恢复运行需要你主动操作。';
        const actions = [];
        if (purgeBlocked) {
          actions.push(
            jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnTiny`, `${P}bannerAction`), disabled: lifecycleBusy, onClick: () => void openLifecycleDialog('purge'), children: '重试永久删除' }, 'retry-purge'),
            jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnTiny`, `${P}bannerAction`), disabled: lifecycleBusy, onClick: () => void runLifecycle('restore'), children: '恢复项目' }, 'restore-purge-blocked'),
          );
        } else if (blocked) {
          actions.push(
            jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnTiny`, `${P}bannerAction`), disabled: lifecycleBusy, onClick: () => void runLifecycle('reconcile'), children: '重试核对' }, 'reconcile'),
            jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnTiny`, `${P}bannerAction`), disabled: lifecycleBusy, onClick: () => void runLifecycle('cancel'), children: '取消请求' }, 'cancel'),
          );
        } else if (quiescing) {
          actions.push(jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnTiny`, `${P}bannerAction`), disabled: lifecycleBusy, onClick: () => void runLifecycle('reconcile'), children: '重试核对' }, 'reconcile'));
        } else if (!purging) {
          actions.push(
            jsx('button', {
              type: 'button',
              className: cx(`${P}btn`, `${P}btnTiny`, `${P}bannerAction`),
              key: 'restore',
              disabled: lifecycleBusy,
              onClick: () => void runLifecycle(trashed || archived ? 'restore' : 'resume'),
              children: trashed ? '恢复项目' : archived ? '恢复为暂停' : '恢复运行',
            }),
          );
        }
        if (trashed) {
          actions.push(
            jsx('button', { type: 'button', className: cx(`${P}btn`, `${P}btnTiny`, `${P}bannerAction`), key: 'preview', disabled: lifecycleBusy, onClick: () => void openLifecycleDialog('preview'), children: '清理预览' }),
          );
        }
        banners.push(
          jsxs('div', {
            key: 'status',
            className: cx(`${P}banner`, trashed || purging || blocked || purgeBlocked ? `${P}bannerErr` : `${P}bannerWarn`),
            children: [
              jsx(Icon, { name: purging || trashed ? 'trash' : archived ? 'archive' : blocked || quiescing ? 'alert' : 'pause', size: 13 }),
              jsx('span', { className: `${P}bannerText`, children: text }),
              ...actions,
            ],
          }),
        );
      }
      if (error) {
        banners.push(
          jsxs('div', {
            key: 'error',
            className: cx(`${P}banner`, `${P}bannerErr`),
            children: [
              jsx(Icon, { name: 'alert', size: 13 }),
              jsx('span', { className: `${P}bannerText`, children: error }),
              jsx('button', { type: 'button', className: `${P}bannerClose`, title: '关闭', onClick: () => setError(null), children: jsx(Icon, { name: 'x', size: 12 }) }),
            ],
          }),
        );
      }
      if (notice) {
        banners.push(
          jsxs('div', {
            key: 'notice',
            className: cx(`${P}banner`, notice.kind === 'warn' ? `${P}bannerWarn` : `${P}bannerOk`),
            children: [
              jsx(Icon, { name: notice.kind === 'warn' ? 'alert' : 'check', size: 13 }),
              jsx('span', { className: `${P}bannerText`, children: notice.text }),
              jsx('button', { type: 'button', className: `${P}bannerClose`, title: '关闭', onClick: () => setNotice(null), children: jsx(Icon, { name: 'x', size: 12 }) }),
            ],
          }),
        );
      }

      const rightRail = jsx(RightRail, {
        room: state ? { ...state.room, members: state.members } : null,
        board: state ? { ...state.board, members: state.members } : null,
        recovery: state?.recovery ?? null,
        models,
        settings: state?.modelSettings ?? null,
        hostDefault: state?.modelSettings?.hostDefault ?? null,
        onSave: saveModelSettings,
        onAction,
      });

      const projectItem = (label, action, icon, danger) =>
        jsx('button', {
          type: 'button',
          role: 'menuitem',
          className: cx(`${P}menuItem`, danger && `${P}menuItemDanger`),
          onClick: () => handleProjectAction(action),
          children: [jsx(Icon, { key: 'icon', name: icon, size: 14 }), jsx('span', { key: 'label', children: label })],
        });

      return jsxs('div', {
        className: `${P}root`,
        ref: rootRef,
        'data-text': textSize,
        children: [
          jsx('style', { children: CSS }),
          jsxs('header', {
            className: `${P}head`,
            children: [
              jsxs('div', {
                className: `${P}brand`,
                children: [
                  jsx('div', { className: `${P}mark`, children: jsx(BrandMark, {}) }),
                  jsxs('div', {
                    className: `${P}brandText`,
                    children: [
                      jsxs('div', {
                        className: `${P}titleRow`,
                        children: [
                          jsx('h2', { className: `${P}title`, children: state?.room?.title ?? '项目群' }),
                          state
                            ? jsxs('span', {
                                className: `${P}live`,
                                children: [jsx('span', { className: `${P}liveDot`, 'data-state': status }), lifecycleLabelOf(state.room)],
                              })
                            : null,
                        ],
                      }),
                      jsx('p', {
                        className: cx(`${P}sub`, `${P}headSub`),
                        children: state
                          ? `${agentCount} 位 AI 成员 · 成员表 r${state.room.membershipRevision} · 计划 r${state.room.planRevision} · ${state.room.lastSeq} 条记录`
                          : '一个项目一个群：主代理拆分工作，成员各自用你选的模型真实执行。',
                      }),
                    ],
                  }),
                ],
              }),
              jsxs('div', {
                className: `${P}headActions`,
                children: [
                  state
                    ? jsx('span', {
                        className: `${P}selectWrap ${P}roomSelect`,
                        children: jsx('select', {
                          className: `${P}select`,
                          value: roomId ?? '',
                          'aria-label': '切换项目群',
                          onChange: (event) => selectRoom(event.target.value),
                          children: rooms.map((room) => jsx('option', { value: room.id, children: `${room.title}（${lifecycleLabelOf(room)}）` })),
                        }),
                      })
                    : null,
                  state
                    ? jsx('button', {
                        type: 'button',
                        className: cx(`${P}btn`, `${P}btnGhost`, `${P}showMembers`),
                        title: '打开成员面板',
                        onClick: () => setDrawer('members'),
                        children: [jsx(Icon, { name: 'users', size: 15, key: 'icon' }), jsx('span', { key: 'label', className: `${P}btnLabel`, children: '成员' })],
                      })
                    : null,
                  state
                    ? jsx('button', {
                        type: 'button',
                        className: cx(`${P}btn`, `${P}btnGhost`, `${P}showBoard`),
                        title: '打开任务与模型面板',
                        onClick: () => setDrawer('board'),
                        children: [jsx(Icon, { name: 'tasks', size: 15, key: 'icon' }), jsx('span', { key: 'label', className: `${P}btnLabel`, children: '任务' })],
                      })
                    : null,
                  state
                    ? jsxs('span', {
                        className: `${P}projectActions`,
                        children: [
                          jsx('button', {
                            type: 'button',
                            className: `${P}iconBtn`,
                            title: '项目操作',
                            'aria-label': '项目操作',
                            'aria-haspopup': 'menu',
                            'aria-expanded': projectMenu,
                            disabled: lifecycleBusy,
                            onClick: () => setProjectMenu((current) => !current),
                            children: jsx(Icon, { name: 'more', size: 16 }),
                          }),
                          projectMenu
                            ? jsxs('div', {
                                className: `${P}menu ${P}projectMenu`,
                                role: 'menu',
                                children: [
                                  jsxs('div', {
                                    className: `${P}projectMenuHead`,
                                    children: [
                                      jsx('span', { className: `${P}liveDot`, 'data-state': status }),
                                      jsx('span', { className: `${P}projectMenuStatus`, children: lifecycleLabelOf(state.room) }),
                                      jsx('span', { className: `${P}hint`, children: `生命周期 r${state.room.lifecycleRevision ?? 0}` }),
                                    ],
                                  }),
                                  jsx('div', { className: `${P}menuSep` }),
                                  blocked ? projectItem('重试核对停止', 'reconcile', 'refresh') : null,
                                  blocked && pendingAction !== 'purge' ? projectItem('取消停止请求', 'cancel', 'x') : null,
                                  purgeBlocked ? projectItem('重试永久删除', 'purge', 'trash', true) : null,
                                  purgeBlocked ? projectItem('恢复项目', 'restore', 'restore') : null,
                                  !blocked && !purgeBlocked && status === 'active' ? projectItem('暂停项目', 'pause', 'pause') : null,
                                  !blocked && !purgeBlocked && status === 'paused' ? projectItem('恢复运行', 'resume', 'play') : null,
                                  !blocked && !purgeBlocked && (status === 'archived' || status === 'trashed') ? projectItem(status === 'trashed' ? '恢复项目' : '恢复为暂停', 'restore', 'restore') : null,
                                  !blocked && !purgeBlocked && (status === 'active' || status === 'paused') ? projectItem('归档项目', 'archive', 'archive') : null,
                                  !blocked && !purgeBlocked && (status === 'archived' || status === 'active' || status === 'paused') ? projectItem('移入回收站', 'trash', 'trash', true) : null,
                                  status === 'trashed' ? projectItem('清理预览', 'preview', 'tasks') : null,
                                  status === 'trashed' && !purgeBlocked ? projectItem('永久删除', 'purge', 'trash', true) : null,
                                  status === 'quiescing' && !blocked ? projectItem('重试核对停止', 'reconcile', 'refresh') : null,
                                ],
                              })
                            : null,
                        ],
                      })
                    : null,
                  jsxs('span', {
                    className: `${P}textSize`,
                    children: [
                      jsx('button', {
                        type: 'button',
                        className: `${P}iconBtn`,
                        title: `字号：${TEXT_SIZE_OPTIONS.find((option) => option.id === textSize)?.label ?? '标准'}`,
                        'aria-label': '调整字号',
                        'aria-haspopup': 'menu',
                        'aria-expanded': textMenu,
                        onClick: () => setTextMenu((current) => !current),
                        children: jsx('span', { className: `${P}textSizeGlyph`, children: 'Aa' }),
                      }),
                      textMenu
                        ? jsxs('div', {
                            className: `${P}textSizeMenu`,
                            role: 'menu',
                            children: [
                              jsx('div', { className: `${P}textSizeTitle`, children: '字号' }),
                              ...TEXT_SIZE_OPTIONS.map((option) =>
                                jsxs(
                                  'button',
                                  {
                                    type: 'button',
                                    role: 'menuitemradio',
                                    'aria-checked': textSize === option.id,
                                    className: cx(`${P}textSizeItem`, textSize === option.id && `${P}textSizeItemOn`),
                                    onClick: () => {
                                      setTextSize(option.id);
                                      setTextMenu(false);
                                    },
                                    children: [
                                      jsx('span', { className: `${P}textSizeSample`, 'data-size': option.id, children: 'Aa' }),
                                      jsx('span', { className: `${P}textSizeLabel`, children: option.label }),
                                      textSize === option.id ? jsx(Icon, { name: 'check', size: 12 }) : null,
                                    ],
                                  },
                                  option.id,
                                ),
                              ),
                            ],
                          })
                        : null,
                    ],
                  }),
                  state
                    ? jsx('button', {
                        type: 'button',
                        className: `${P}iconBtn`,
                        title: '刷新',
                        onClick: () => void refresh(),
                        disabled: refreshing,
                        children: jsx(Icon, { name: 'refresh', size: 15, ...(refreshing ? { className: `${P}spin` } : {}) }),
                      })
                    : null,
                  jsx('button', {
                    type: 'button',
                    className: cx(`${P}btn`, `${P}btnPrimary`, `${P}btnNew`),
                    onClick: openCreate,
                    children: [jsx(Icon, { name: 'plus', size: 15, key: 'icon' }), jsx('span', { key: 'label', className: `${P}btnLabel`, children: '新建项目群' })],
                  }),
                ],
              }),
            ],
          }),
          banners.length > 0 ? jsx('div', { className: `${P}banners`, children: banners }) : null,
          !state
            ? rooms.length === 0
              ? jsx('div', {
                  className: `${P}emptyPane`,
                  children: jsxs('div', {
                    className: `${P}emptyCard`,
                    children: [
                      jsx('div', { className: `${P}emptyArt`, children: jsx(BrandMark, {}) }),
                      jsx('div', { className: `${P}emptyTitle`, children: '还没有项目群' }),
                      jsx('div', {
                        className: `${P}emptyText`,
                        children: '一个项目一个群。把整体目标交给主代理，它会拆分工作、安排成员并组织验收；每位成员用你选择的真实模型执行。',
                      }),
                      jsx('button', {
                        type: 'button',
                        className: cx(`${P}btn`, `${P}btnPrimary`),
                        onClick: openCreate,
                        children: [jsx(Icon, { name: 'plus', size: 15, key: 'icon' }), '新建第一个项目群'],
                      }),
                    ],
                  }),
                })
              : jsx('div', {
                  className: `${P}emptyPane`,
                  children: jsxs('div', {
                    className: `${P}emptyCard`,
                    children: [jsx('span', { className: `${P}spinner ${P}loadingSpinner`, style: { width: 20, height: 20 } }), jsx('div', { className: `${P}emptyText`, children: '正在读取项目群…' })],
                  }),
                })
            : jsxs('div', {
                className: `${P}cols`,
                children: [
                  jsx('aside', {
                    className: `${P}pane ${P}left`,
                    children: jsxs('div', {
                      className: `${P}paneScroll`,
                      children: [
                        jsxs('div', {
                          className: `${P}paneHead`,
                          children: [
                            jsxs('span', { className: `${P}paneTitle`, children: [jsx(Icon, { name: 'message', size: 12, key: 'icon' }), '项目群'] }),
                            jsx('span', { className: `${P}count`, children: visibleRooms.length }),
                            jsx('span', { className: `${P}spacer` }),
                            jsx('button', {
                              type: 'button',
                              className: cx(`${P}btn`, `${P}btnGhost`, `${P}btnTiny`),
                              onClick: openCreate,
                              children: [jsx(Icon, { name: 'plus', size: 12, key: 'icon' }), '新建'],
                            }),
                          ],
                        }),
                        jsx('div', {
                          className: `${P}filterTabs`,
                          role: 'tablist',
                          'aria-label': '项目状态',
                          children: [
                            ['active', '进行中'],
                            ['archived', '已归档'],
                            ['trash', '回收站'],
                          ].map(([id, label]) =>
                            jsxs(
                              'button',
                              {
                                type: 'button',
                                role: 'tab',
                                'aria-selected': roomFilter === id,
                                className: cx(`${P}filterTab`, roomFilter === id && `${P}filterTabOn`),
                                onClick: () => selectFilter(id),
                                children: [jsx('span', { className: `${P}filterLabel`, children: label }), jsx('span', { className: `${P}count`, children: roomCounts[id] })],
                              },
                              id,
                            ),
                          ),
                        }),
                        jsx('div', {
                          className: `${P}roomList`,
                          children:
                            visibleRooms.length === 0
                              ? jsx('div', { className: `${P}emptyList`, children: roomFilter === 'trash' ? '回收站是空的。' : roomFilter === 'archived' ? '还没有归档项目。' : '还没有进行中的项目。' })
                              : visibleRooms.map((room) =>
                                  jsxs(
                                    'button',
                                    {
                                      type: 'button',
                                      'data-status': room.status,
                                      className: room.id === roomId ? `${P}roomRow ${P}roomRowOn` : `${P}roomRow`,
                                      title: `${room.title} · ${lifecycleLabelOf(room)}`,
                                      onClick: () => selectRoom(room.id),
                                      children: [
                                        jsx('span', { className: `${P}roomDot`, 'data-status': room.status }),
                                        jsxs('span', {
                                          className: `${P}roomText`,
                                          children: [
                                            jsx('span', { className: `${P}roomName`, children: room.title }),
                                            jsx('span', {
                                              className: `${P}roomMeta`,
                                              children:
                                                room.status === 'trashed'
                                                  ? `${room.members} 位成员 · ${room.lifecycleState === 'PURGE_BLOCKED' ? '清理受阻' : '回收站'}${room.trashDaysLeft != null ? ` · 还剩 ${room.trashDaysLeft} 天` : ''}`
                                                  : `${room.members} 位成员 · ${lifecycleLabelOf(room)}`,
                                            }),
                                          ],
                                        }),
                                      ],
                                    },
                                    room.id,
                                  ),
                                ),
                        }),
                        jsx('div', { className: `${P}divider` }),
                        jsxs('div', {
                          className: `${P}paneHead`,
                          children: [
                            jsxs('span', { className: `${P}paneTitle`, children: [jsx(Icon, { name: 'users', size: 12, key: 'icon' }), '成员'] }),
                            jsx('span', { className: `${P}count`, children: state.members.length }),
                            jsx('span', { className: `${P}spacer` }),
                            jsx('span', { className: `${P}hint`, children: '右键头像 @ 他' }),
                          ],
                        }),
                        jsx(MemberList, {
                          members: state.members,
                          selfId,
                          selectedId: selectedMember?.id ?? null,
                          onSelect: (member) => setSelectedMember(member),
                          onAvatarMenu: (event, member) => openMenu(event, member),
                        }),
                        selectedMember
                          ? jsx(MemberDetail, {
                              member: state.members.find((entry) => entry.id === selectedMember.id) ?? selectedMember,
                              models: state.models,
                              settings: state.modelSettings,
                              routes: state.routes,
                              onClose: () => setSelectedMember(null),
                              onModelChange: changeModel,
                              onControl: control,
                            })
                          : null,
                      ],
                    }),
                  }),
                  jsxs('section', {
                    className: `${P}pane`,
                    children: [
                      jsx(ResearchCard, {
                        research: state.research,
                        members: state.members,
                        busy: researchBusy,
                        error: researchError,
                        onAction: handleResearchAction,
                        onAdjust: (proposal) => {
                          setResearchError(null);
                          setResearchAdjust(proposal);
                        },
                      }),
                      jsx(Timeline, {
                        messages: state.messages,
                        members: state.members,
                        selfId,
                        onReply: (message, author) => setReplyTo({ ...message, authorName: author?.displayName ?? message.authorId }),
                        onAvatarMenu: (event, member, intent, message) => openMenu(event, member, intent, message),
                      }),
                      jsx(Composer, {
                        room: state.room,
                        members: state.members,
                        selfId,
                        busy,
                        pendingMention,
                        replyTo,
                        readOnly,
                        readOnlyReason:
                          currentLifecycleState === 'BLOCKED' || currentLifecycleState === 'PURGE_BLOCKED' ? 'blocked' : currentStatus,
                        onCancelReply: () => setReplyTo(null),
                        onMentionHandled: () => setPendingMention(null),
                        onSend: send,
                        onError: (message) => setError(message),
                      }),
                    ],
                  }),
                  jsx('aside', { className: `${P}pane ${P}right`, children: rightRail }),
                ],
              }),
          drawer ? jsx(Drawer, {
            title: drawer === 'members' ? '成员' : '任务与模型',
            onClose: () => setDrawer(null),
            children:
              drawer === 'members'
                ? jsxs(Fragment, {
                    children: [
                      jsx(MemberList, {
                        members: state?.members ?? [],
                        selfId,
                        selectedId: selectedMember?.id ?? null,
                        onSelect: (member) => setSelectedMember(member),
                        onAvatarMenu: (event, member) => openMenu(event, member),
                      }),
                      selectedMember && state
                        ? jsx(MemberDetail, {
                            member: state.members.find((entry) => entry.id === selectedMember.id) ?? selectedMember,
                            models: state.models,
                            settings: state.modelSettings,
                            routes: state.routes,
                            onClose: () => setSelectedMember(null),
                            onModelChange: changeModel,
                            onControl: control,
                          })
                        : null,
                    ],
                  })
                : rightRail,
          }) : null,
          jsx(MemberMenu, {
            state: menu,
            members: state?.members ?? [],
            canReply: true,
            onClose: closeMenu,
            onPick: handleMenuPick,
          }),
          lifecycleDialog
            ? jsx(LifecycleDialog, {
                key: `${lifecycleDialog.kind}:${lifecycleDialog.room?.id ?? ''}`,
                dialog: lifecycleDialog,
                busy: lifecycleBusy,
                error: lifecycleError,
                onClose: () => {
                  setLifecycleDialog(null);
                  setLifecycleError(null);
                },
                onConfirm: (action, extra) => void handleDialogConfirm(action, extra),
              })
            : null,
          researchAdjust
            ? jsx(ResearchAdjustDialog, {
                key: `${researchAdjust.id}:${researchAdjust.proposalRevision}`,
                proposal: researchAdjust,
                busy: researchBusy,
                error: researchError,
                onClose: () => {
                  setResearchAdjust(null);
                  setResearchError(null);
                },
                onSubmit: submitResearchAdjust,
              })
            : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Registration
     * ------------------------------------------------------------------ */

    /** Sidebar entry icon: a small room glyph, drawn inline so no asset loads. */
    function RoomIcon() {
      return jsx('svg', {
        width: 18,
        height: 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          jsx('path', { d: 'M4 5.5h12.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9.5L5.5 18v-3.5H4a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 4 5.5Z', key: 'bubble' }),
          jsx('path', { d: 'M18 8.5h1.5A1.5 1.5 0 0 1 21 10v3a1.5 1.5 0 0 1-1.5 1.5H19v2.5l-3-2.5', key: 'tail' }),
          jsx('circle', { cx: 9, cy: 10, r: 1.6, fill: 'currentColor', stroke: 'none', key: 'eye1' }),
          jsx('circle', { cx: 13, cy: 10, r: 1.6, fill: 'currentColor', stroke: 'none', key: 'eye2' }),
        ],
      });
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'project-room',
            order: 21,
            label: () => '项目群',
          },
          RoomIcon,
        ),
      );

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'project-room',
          },
          ProjectRoomPanel,
        ),
      );
    }

    exports.apply = apply;
    /**
     * Client services this half needs before `apply` runs.
     *
     * The client loader gives each entry a Cordis fiber, and an un-injected service
     * is not merely absent — reading it throws, which puts the fiber in `failed`.
     * The web boot audit then reports exactly that, with no reason attached:
     * `web boot: 1 entry did not activate / dsh-project-room: failed`. That is what
     * kept the desktop app from starting until this array was filled in.
     *
     * Only `slots` is required: `apply` registers two slot entries, and a
     * composition without the slot registry has nowhere to put a panel. Everything
     * else the panel uses is read lazily through `ctx.get(...)`.
     */
    exports.inject = ['slots'];
    /** Exposed for verification only; the module loader uses `apply` and `inject`. */
    exports.__internals = {
      ProjectRoomPanel,
      Composer,
      Timeline,
      Board,
      ModelSettings,
      RightRail,
      CreateRoom,
      Drawer,
      LifecycleDialog,
      selectionSourceLabel,
      MemberList,
      MemberDetail,
      MemberMenu,
      Avatar,
      MentionText,
      RichMessageText,
      Icon,
      BrandMark,
      post,
      avatarFor,
      toneOf,
      dotOf,
      CSS,
    };
    return module.exports;
  },
});
