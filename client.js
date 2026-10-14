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
 * The panel is three columns as the design notes asks: projects and members on the
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
 * observation (the design notes).
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
 * Task states (the design notes).
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
 * pins a model brand (design D11).
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
 * This module implements the design notes. It is the single source of truth for all
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
  //    any email address (`local@domain`) — per the design notes rule 2.
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
 * member whose alias contains a space (the design notes rule 7).
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
   * @param {RoomMember[]} input.members   Active members (human and agent).
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

    // §5.3 rule 12: a retired alias stays a tombstone. Resolving it to a
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

const V = { ROUTE, ROLE_TEMPLATES, DELIVERY_LABELS, TASK_STATUS_LABELS, MEMBER_STATUS_LABELS, ERROR_LABELS, roleTemplate, deliveryLabel, taskLabel, memberLabel };
const M = { MentionResolver, mergeMentions, segmentsForDisplay, stripMentionSyntax, extractAtTokens, maskBody };
/* <<< GENERATED: shared rules <<< */

    // The generated section declares the shared rule names directly in this
    // factory's scope (ROUTE, ROLE_TEMPLATES, roleTemplate, MentionResolver, …), so
    // there is nothing to unpack — re-declaring them here would be a SyntaxError.
    // `V` and `M` are thin views for the code below that reads them namespaced.

    /** Class-name prefix, unique to this plugin. */
    const P = 'dpr_';

    /* ------------------------------------------------------------------ *
     * Styles — theme tokens only, so light/dark and any retheme apply.
     * ------------------------------------------------------------------ */
    const CSS = `
.${P}root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.${P}head{display:flex;align-items:center;gap:12px;padding:14px 18px 10px;flex-wrap:wrap}
.${P}title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.${P}sub{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.${P}spacer{flex:1}
.${P}btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;line-height:18px;cursor:pointer;border-radius:999px;padding:6px 13px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);white-space:nowrap}
.${P}btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.${P}btn:disabled{opacity:.45;cursor:default}
.${P}btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.${P}btnPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-label-primary));border-color:transparent;color:var(--dsw-alias-label-primary-inverted,var(--dsw-alias-bg-base))}
.${P}btnGhost{border-color:transparent;background:0 0;color:var(--dsw-alias-label-secondary)}
.${P}btnGhost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.${P}btnTiny{font-size:12px;line-height:16px;padding:3px 9px}
.${P}cols{display:flex;flex:1;min-height:0;gap:0;border-top:.5px solid var(--dsw-alias-border-l1)}
.${P}col{display:flex;flex-direction:column;min-height:0;min-width:0}
.${P}colLeft{width:236px;flex:none;border-right:.5px solid var(--dsw-alias-border-l1);overflow:auto}
.${P}colMid{flex:1;min-width:0}
.${P}colRight{width:300px;flex:none;border-left:.5px solid var(--dsw-alias-border-l1);overflow:auto}
.${P}section{padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.${P}sectionTitle{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.${P}roomRow{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font:inherit;font-size:13px;padding:7px 9px;border-radius:8px;border:0;background:0 0;color:inherit;cursor:pointer}
.${P}roomRow:hover{background:var(--dsw-alias-bg-layer-2)}
.${P}roomRowOn{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.${P}memberRow{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:8px;cursor:pointer}
.${P}memberRow:hover{background:var(--dsw-alias-bg-layer-2)}
.${P}avatar{width:28px;height:28px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary-inverted,var(--dsw-alias-bg-base));background:var(--dsw-alias-brand-primary);user-select:none;cursor:context-menu}
.${P}avatarSm{width:24px;height:24px;font-size:11px}
.${P}dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.${P}dotIdle{background:var(--dsw-alias-state-idle-primary)}
.${P}dotWorking{background:var(--dsw-alias-state-success-primary)}
.${P}dotWaiting{background:var(--dsw-alias-state-warn-primary)}
.${P}dotUser{background:var(--dsw-alias-state-error-primary)}
.${P}dotPaused{background:var(--dsw-alias-label-secondary)}
.${P}name{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}meta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${P}aiTag{font-size:10px;line-height:14px;padding:0 4px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);flex:none}
.${P}timeline{flex:1;min-height:0;overflow:auto;padding:10px 16px 4px;display:flex;flex-direction:column;gap:12px}
.${P}msg{display:flex;gap:9px;align-items:flex-start}
.${P}msgBody{min-width:0;flex:1}
.${P}msgHead{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.${P}author{font-size:13px;font-weight:600}
.${P}role{font-size:11px;color:var(--dsw-alias-label-secondary)}
.${P}time{font-size:11px;color:var(--dsw-alias-label-secondary)}
.${P}text{font-size:13.5px;line-height:21px;white-space:pre-wrap;word-break:break-word;margin-top:2px}
.${P}mention{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 3px;font-weight:500}
.${P}replyRef{font-size:11.5px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding:2px 0 2px 7px;margin:3px 0;white-space:pre-wrap}
.${P}chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.${P}chip{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.${P}chipOk{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.${P}chipWarn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.${P}chipErr{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.${P}sys{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 9px;white-space:pre-wrap}
.${P}composer{border-top:.5px solid var(--dsw-alias-border-l1);padding:10px 14px 12px;position:relative}
.${P}editorWrap{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}
.${P}chipsRow{display:flex;flex-wrap:wrap;gap:6px}
.${P}mChip{display:inline-flex;align-items:center;gap:5px;font-size:12px;line-height:18px;padding:1px 4px 1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2)}
.${P}mChipX{border:0;background:0 0;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;padding:0 2px}
.${P}textarea{width:100%;box-sizing:border-box;border:0;background:0 0;outline:0;resize:none;font:inherit;font-size:13.5px;line-height:21px;color:var(--dsw-alias-label-primary);min-height:44px;max-height:180px}
.${P}tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.${P}select,.${P}input{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px}
.${P}input{min-width:0;flex:1}
.${P}picker{position:absolute;left:14px;right:14px;bottom:calc(100% - 4px);z-index:40;max-height:280px;overflow:auto;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:6px}
.${P}pickerItem{display:flex;align-items:center;gap:9px;width:100%;text-align:left;font:inherit;padding:6px 8px;border:0;border-radius:8px;background:0 0;color:inherit;cursor:pointer}
.${P}pickerItem:hover,.${P}pickerItemOn{background:var(--dsw-alias-bg-layer-2)}
.${P}menu{position:fixed;z-index:60;min-width:186px;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.2);padding:4px}
.${P}menuItem{display:block;width:100%;text-align:left;font:inherit;font-size:13px;padding:6px 10px;border:0;border-radius:7px;background:0 0;color:inherit;cursor:pointer}
.${P}menuItem:hover{background:var(--dsw-alias-bg-layer-2)}
.${P}menuSep{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l1)}
.${P}hint{font-size:12px;line-height:17px;padding:6px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.${P}hintErr{background:0 0;border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.${P}hintWarn{background:0 0;border:.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.${P}empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px;text-align:center;color:var(--dsw-alias-label-secondary)}
.${P}emptyTitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.${P}fieldRow{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.${P}label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.${P}checks{display:flex;flex-wrap:wrap;gap:8px}
.${P}check{display:flex;align-items:center;gap:5px;font-size:12.5px}
.${P}card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}
.${P}cardTitle{font-size:12.5px;font-weight:600;line-height:18px}
.${P}kv{display:flex;gap:6px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.${P}kvKey{flex:none;min-width:52px}
.${P}taskRow{display:flex;flex-direction:column;gap:3px;padding:7px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);margin-bottom:6px}
.${P}taskTop{display:flex;align-items:center;gap:6px}
.${P}bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.${P}barFill{height:100%;background:var(--dsw-alias-brand-primary)}
.${P}scroll{overflow:auto}
.${P}nowrap{white-space:nowrap}
.${P}mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.${P}draft{opacity:.72}
@media (max-width:1100px){.${P}colRight{display:none}.${P}colLeft{width:196px}}
@media (max-width:820px){.${P}colLeft{display:none}}
`;

    /* ------------------------------------------------------------------ *
     * Small utilities
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

    /** A delivery state's chip tone. */
    function toneOf(status) {
      if (status === 'replied' || status === 'claimed') return `${P}chip ${P}chipOk`;
      if (status === 'failed' || status === 'discarded') return `${P}chip ${P}chipErr`;
      if (status === 'paused' || status === 'uncertain') return `${P}chip ${P}chipWarn`;
      return `${P}chip`;
    }

    /** A member status dot's class. */
    function dotOf(status) {
      if (status === 'working') return `${P}dot ${P}dotWorking`;
      if (status === 'awaiting_reply') return `${P}dot ${P}dotWaiting`;
      if (status === 'needs_user') return `${P}dot ${P}dotUser`;
      if (status === 'paused' || status === 'offline') return `${P}dot ${P}dotPaused`;
      return `${P}dot ${P}dotIdle`;
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

    /* ------------------------------------------------------------------ *
     * Mention-aware text
     * ------------------------------------------------------------------ */

    /**
     * Render a body with the exact spans the server resolved highlighted.
     * The spans come from the stored mention records, not from a second parse,
     * so what the reader sees highlighted is what was actually delivered.
     */
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
            ? jsx('span', { key: index, className: `${P}mention`, title: `已投递给 ${segment.mention.displaySnapshot || segment.mention.targetMemberId}`, children: segment.text })
            : jsx('span', { key: index, children: segment.text }),
        ),
      });
    }

    /* ------------------------------------------------------------------ *
     * Avatar + context menu (the design notes)
     * ------------------------------------------------------------------ */

    function Avatar(props) {
      const { member, small, onMenu } = props;
      const { initial, hue } = avatarFor(member);
      const style = { background: `hsl(${hue} 62% 46%)` };
      return jsx('button', {
        type: 'button',
        className: small ? `${P}avatar ${P}avatarSm` : `${P}avatar`,
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
        children: initial,
      });
    }

    function MemberMenu(props) {
      const { state, onClose, onPick, members, canReply } = props;
      useEffect(() => {
        const close = () => onClose();
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('click', close);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('click', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [onClose]);
      // `state` is owned by the panel and may not be materialised yet on a first
      // render; treat a missing state as "no menu" rather than throwing.
      if (!state || !state.open) return null;
      const member = (members ?? []).find((entry) => entry.id === state.memberId);
      if (!member) return null;
      const self = member.id === state.selfId;
      const item = (label, action, options) =>
        jsx('button', {
          type: 'button',
          className: `${P}menuItem`,
          onClick: (event) => {
            event.stopPropagation();
            onPick(action, member);
          },
          children: label,
          ...(options ?? {}),
        });
      return jsx('div', {
        className: `${P}menu`,
        style: { left: state.x, top: Math.min(state.y, (window.innerHeight ?? 900) - 260) },
        onClick: (event) => event.stopPropagation(),
        role: 'menu',
        children: [
          item(self ? '@ 自己（留注记，不触发模型）' : `@ 他（${member.displayName}）`, 'mention'),
          canReply && state.messageId ? item('回复这条消息', 'reply') : null,
          jsx('div', { className: `${P}menuSep`, key: 'sep1' }),
          item('查看成员', 'detail'),
          item('选择或更换模型', 'model'),
          item('查看当前任务', 'task'),
          jsx('div', { className: `${P}menuSep`, key: 'sep2' }),
          member.status === 'paused' ? item('恢复该成员', 'resume') : item('暂停该成员', 'pause'),
          member.status === 'offline' ? null : item('让该成员退出本群', 'retire'),
        ].filter(Boolean),
      });
    }

    /* ------------------------------------------------------------------ *
     * Composer (the design notes)
     * ------------------------------------------------------------------ */

    function Composer(props) {
      const { room, members, selfId, onSend, onError, busy, pendingMention, onMentionHandled } = props;
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
      // the existing draft and keep focus, WITHOUT sending (the design notes, AT02).
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

      const onKeyDown = (event) => {
        // Never steal Enter/Tab from an in-progress IME composition: a Chinese
        // candidate must be committed by the IME first (the design notes).
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
              setChips((current) => [
                ...current,
                ...members
                  .filter((member) => member.kind === 'agent' && member.status !== 'offline' && member.id !== selfId)
                  .map((member) => ({ targetMemberId: member.id, origin: 'picker', displaySnapshot: member.displayName, span: null })),
              ]);
              setBody((current) => current.replace(/[@＠][^\s@＠]*$/, ''));
              setPicker({ open: false, query: '', index: 0, start: -1 });
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

      return jsxs('div', {
        className: `${P}composer`,
        children: [
          picker.open && candidates.length > 0
            ? jsx('div', {
                className: `${P}picker`,
                role: 'listbox',
                children: candidates.map((member, index) =>
                  jsxs(
                    'button',
                    {
                      type: 'button',
                      className: index === picker.index ? `${P}pickerItem ${P}pickerItemOn` : `${P}pickerItem`,
                      onMouseDown: (event) => {
                        event.preventDefault();
                        if (member.id === '__everyone__') {
                          setChips((current) => [
                            ...current,
                            ...members
                              .filter((entry) => entry.kind === 'agent' && entry.status !== 'offline' && entry.id !== selfId)
                              .map((entry) => ({ targetMemberId: entry.id, origin: 'picker', displaySnapshot: entry.displayName, span: null })),
                          ]);
                          setBody((current) => current.replace(/[@＠][^\s@＠]*$/, ''));
                        } else {
                          insertChip(member);
                        }
                        setPicker({ open: false, query: '', index: 0, start: -1 });
                      },
                      role: 'option',
                      'aria-selected': index === picker.index,
                      children: [
                        jsx(Avatar, { member, small: true, key: 'a' }),
                        jsxs('span', {
                          key: 't',
                          style: { minWidth: 0 },
                          children: [
                            jsx('div', { className: `${P}name`, children: member.id === '__everyone__' ? '所有人' : member.displayName }),
                            jsx('div', {
                              className: `${P}meta`,
                              children:
                                member.id === '__everyone__'
                                  ? `会触达 ${members.filter((entry) => entry.kind === 'agent' && entry.status !== 'offline' && entry.id !== selfId).length} 位 AI 成员`
                                  : `@${member.handle} · ${member.role}${member.aliases?.length ? ` · ${member.aliases.join('/')}` : ''}`,
                            }),
                          ],
                        }),
                      ],
                    },
                    member.id,
                  ),
                ),
              })
            : null,
          jsxs('div', {
            className: `${P}editorWrap`,
            children: [
              chips.length > 0
                ? jsx('div', {
                    className: `${P}chipsRow`,
                    children: chips.map((chip) =>
                      jsxs(
                        'span',
                        {
                          className: `${P}mChip`,
                          children: [
                            jsx('span', { children: `@${chip.displaySnapshot || chip.targetMemberId}` }),
                            jsx('button', {
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
              jsxs('div', {
                className: `${P}tools`,
                children: [
                  jsx('button', {
                    type: 'button',
                    className: `${P}btn ${P}btnGhost ${P}btnTiny`,
                    onClick: () => {
                      setPicker({ open: true, query: '', index: 0, start: -1 });
                      areaRef.current?.focus();
                    },
                    children: '@ 成员',
                  }),
                  jsx('span', {
                    className: `${P}meta`,
                    children:
                      aiTargetCount > 0
                        ? `将触达 ${aiTargetCount} 位 AI 成员${preview.targets.length - aiTargetCount > 0 ? ` + ${preview.targets.length - aiTargetCount} 位人类成员` : ''}`
                        : '没有点名：默认由主代理接收',
                  }),
                  jsx('span', { className: `${P}spacer` }),
                  jsx('button', {
                    type: 'button',
                    className: `${P}btn ${P}btnPrimary`,
                    disabled: busy || (!body.trim() && chips.length === 0),
                    onClick: () => void submit(),
                    children: busy ? '发送中…' : '发送',
                  }),
                ],
              }),
            ],
          }),
          preview.hints.length > 0
            ? jsx('div', { className: `${P}hint ${P}hintWarn`, style: { marginTop: 6 }, children: preview.hints.join('\n') })
            : null,
          preview.ambiguous.length > 0
            ? jsx('div', {
                className: `${P}hint ${P}hintErr`,
                style: { marginTop: 6 },
                children: `${preview.ambiguous[0].reason}（候选：${preview.ambiguous[0].candidates.map((candidate) => candidate.displayName).join('、')}）`,
              })
            : null,
          preview.unknown.length > 0
            ? jsx('div', { className: `${P}hint ${P}hintWarn`, style: { marginTop: 6 }, children: `无法识别的点名会被当作普通文本：${preview.unknown.join('、')}` })
            : null,
          toast ? jsx('div', { className: `${P}hint`, style: { marginTop: 6 }, children: toast.text }) : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Right column: model configuration (the design notes)
     * ------------------------------------------------------------------ */

    /**
     * Project-level model configuration.
     *
     * Without this surface the four-level precedence of the design notes is only half
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
        className: `${P}section`,
        children: [
          jsx('h4', { className: `${P}sectionTitle`, children: '模型与选型' }),

          jsxs('div', {
            className: `${P}fieldRow`,
            children: [
              jsx('span', { className: `${P}label`, children: '项目默认（没有单独配置的成员使用）' }),
              jsx('select', {
                className: `${P}select`,
                value: defaultRef,
                onChange: (event) => setDefaultRef(event.target.value),
                children: [
                  jsx('option', { value: '', children: hostDefault ? `未设置（暂用本 Harness 默认：${hostDefault.providerRoute}/${hostDefault.modelId}）` : '未设置（本 Harness 也没有可用默认模型）' }),
                  ...available.map((profile) => jsx('option', { value: profile.profileRef, children: `${profile.label} — ${profile.providerRoute}/${profile.modelId}` })),
                ],
              }),
            ],
          }),

          jsx('span', { className: `${P}label`, children: '角色默认（覆盖项目默认）' }),
          ...configuredRoles.map((role) =>
            jsxs(
              'div',
              {
                style: { display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0' },
                children: [
                  jsx('span', { style: { width: 56, flex: 'none', fontSize: 12 }, children: roleTemplate(role)?.title ?? role }),
                  jsx('select', {
                    className: `${P}select`,
                    style: { flex: 1 },
                    value: roleDrafts[role] ?? '',
                    onChange: (event) => setRoleDrafts((current) => ({ ...current, [role]: event.target.value })),
                    children: [
                      jsx('option', { value: '', children: '跟随项目默认' }),
                      ...available.map((profile) => jsx('option', { value: profile.profileRef, children: `${profile.label} — ${profile.providerRoute}/${profile.modelId}` })),
                    ],
                  }),
                ],
              },
              role,
            ),
          ),

          jsxs('div', {
            className: `${P}fieldRow`,
            style: { marginTop: 8 },
            children: [
              jsx('span', { className: `${P}label`, children: '选型模式' }),
              jsx('select', {
                className: `${P}select`,
                value: mode,
                onChange: (event) => setMode(event.target.value),
                children: [
                  jsx('option', { value: 'fixed', children: 'fixed —— 由我固定每位成员的模型（默认）' }),
                  jsx('option', { value: 'allowed-pool', children: 'allowed-pool —— 主代理仅在下述允许池内自动选型' }),
                ],
              }),
            ],
          }),

          mode === 'allowed-pool'
            ? jsxs('div', {
                className: `${P}fieldRow`,
                children: [
                  jsx('span', { className: `${P}label`, children: `允许池（必须非空；已选 ${pool.length}）` }),
                  jsx('div', {
                    className: `${P}scroll`,
                    style: { maxHeight: 150, border: '.5px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 6 },
                    children: available.map((profile) =>
                      jsxs(
                        'label',
                        {
                          className: `${P}check`,
                          style: { display: 'flex', gap: 6, margin: '3px 0' },
                          children: [
                            jsx('input', { type: 'checkbox', checked: pool.includes(profile.profileRef), onChange: () => togglePool(profile.profileRef) }),
                            `${profile.label}（${profile.providerRoute}/${profile.modelId}）`,
                          ],
                        },
                        profile.profileRef,
                      ),
                    ),
                  }),
                  jsx('div', { className: `${P}meta`, children: '自动选型不会覆盖被锁定的成员，也不会越出这个池子。' }),
                ],
              })
            : null,

          note ? jsx('div', { className: note.kind === 'error' ? `${P}hint ${P}hintErr` : `${P}hint`, children: note.text }) : null,
          jsx('button', {
            type: 'button',
            className: `${P}btn ${P}btnPrimary} ${P}btnTiny}`,
            style: { marginTop: 6 },
            disabled: busy,
            onClick: () => void save(),
            children: busy ? '保存中…' : '保存模型配置',
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

      return jsx('div', {
        className: `${P}timeline`,
        ref: scroller,
        children: messages.map((message) => {
          const author = memberById.get(message.authorId) ?? { id: message.authorId, displayName: message.authorId, role: '', kind: 'agent' };
          const template = roleTemplate(author.role);
          if (author.kind === 'human' && /^【/.test(message.body)) {
            return jsx('div', { className: `${P}sys`, children: message.body }, message.id);
          }
          const replySource = message.replyTo ? byId.get(message.replyTo) : null;
          const replyAuthor = replySource ? memberById.get(replySource.authorId) : null;
          return jsxs(
            'div',
            {
              className: `${P}msg`,
              children: [
                jsx(Avatar, { member: author, onMenu: (event, member, intent) => onAvatarMenu(event, member, intent, message) }, 'avatar'),
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
                            jsx('span', { className: `${P}author`, children: author.displayName }),
                            author.kind === 'agent' ? jsx('span', { className: `${P}aiTag`, children: 'AI' }) : null,
                            jsx('span', { className: `${P}role`, children: template?.title ?? author.role ?? '' }),
                            jsx('span', { className: `${P}time`, children: `#${message.seq} · ${timeOf(message.createdAt)}` }),
                            message.taskId ? jsx('span', { className: `${P}chip`, children: `任务 ${message.taskId}` }) : null,
                            jsx('span', { className: `${P}spacer` }),
                            jsx('button', {
                              type: 'button',
                              className: `${P}btn ${P}btnGhost ${P}btnTiny`,
                              onClick: () => onReply(message, author),
                              children: '回复',
                            }),
                          ],
                        },
                      ),
                      replySource
                        ? jsx('div', {
                            className: `${P}replyRef`,
                            children: `回复 ${replyAuthor?.displayName ?? replySource.authorId}：#${replySource.seq} ${String(replySource.body).slice(0, 120)}`,
                          })
                        : null,
                      jsx(MentionText, { body: message.body, mentions: message.mentions }),
                      message.deliveries?.length > 0
                        ? jsx('div', {
                            className: `${P}chips`,
                            children: message.deliveries.map((delivery) => {
                              const target = memberById.get(delivery.recipientId);
                              return jsx(
                                'span',
                                {
                                  className: toneOf(delivery.status),
                                  title: delivery.detail ?? '',
                                  children: `${target?.displayName ?? delivery.recipientId}：${deliveryLabel(delivery.status)}`,
                                },
                                delivery.recipientId,
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
          );
        }),
      });
    }

    /* ------------------------------------------------------------------ *
     * Right column: tasks, decisions, artifacts, recovery
     * ------------------------------------------------------------------ */

    function Board(props) {
      const { room, board, recovery, onAction, error } = props;
      if (!board) return jsx('div', { className: `${P}section`, children: '正在读取任务板…' });
      const tasks = board.tasks ?? [];
      const accepted = tasks.filter((task) => task.status === 'accepted').length;
      const ratio = tasks.length === 0 ? 0 : Math.round((accepted / tasks.length) * 100);
      return jsxs('div', {
        children: [
          jsxs('div', {
            className: `${P}section`,
            children: [
              jsx('h4', { className: `${P}sectionTitle`, children: '任务' }),
              jsxs('div', {
                className: `${P}kv`,
                children: [jsx('span', { className: `${P}kvKey`, children: '进度' }), jsx('span', { children: `${accepted}/${tasks.length} 已验收` })],
              }),
              jsx('div', { className: `${P}bar`, style: { marginTop: 5 }, children: jsx('div', { className: `${P}barFill`, style: { width: `${ratio}%` } }) }),
              jsx('div', { style: { height: 8 } }),
              tasks.length === 0
                ? jsx('div', { className: `${P}meta`, children: '还没有任务。把整体目标交给主代理，它会拆分并派发。' })
                : tasks.map((task) =>
                    jsxs(
                      'div',
                      {
                        className: `${P}taskRow`,
                        children: [
                          jsxs('div', {
                            className: `${P}taskTop`,
                            children: [
                              jsx('span', { className: `${P}chip`, children: taskLabel(task.status) }),
                              jsx('span', { className: `${P}name`, style: { flex: 1 }, children: task.objective }),
                            ],
                          }),
                          jsxs('div', {
                            className: `${P}meta`,
                            children: [
                              `r${task.revision}`,
                              task.ownerName ? ` · ${task.ownerName}` : ' · 未指派',
                              task.needsSync ? ' · 需同步新版本' : '',
                              task.blockedBy?.length ? ` · 等待 ${task.blockedBy.map((entry) => entry.objective).join('、')}` : '',
                            ].join(''),
                          }),
                          task.acceptance?.length
                            ? jsx('div', { className: `${P}meta`, children: `验收：${task.acceptance.join('；')}` })
                            : null,
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
              jsx('h4', { className: `${P}sectionTitle`, children: '项目决定' }),
              (board.decisions ?? []).length === 0
                ? jsx('div', { className: `${P}meta`, children: '还没有采纳的决定。' })
                : board.decisions.map((decision) =>
                    jsxs(
                      'div',
                      {
                        className: `${P}card`,
                        children: [
                          jsxs('div', {
                            className: `${P}cardTitle`,
                            children: [`r${decision.revision} `, decision.status === 'accepted' ? '已采纳' : decision.status === 'proposed' ? '提议中' : decision.status],
                          }),
                          jsx('div', { className: `${P}meta`, children: decision.statement }),
                          decision.acks?.length
                            ? jsx('div', {
                                className: `${P}chips`,
                                children: decision.acks.map((ack) => {
                                  const member = (board.members ?? []).find((entry) => entry.id === ack.memberId);
                                  return jsx('span', { className: `${P}chip`, children: `${member?.displayName ?? ack.memberId}：${ack.state}` }, ack.memberId);
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
            ? jsxs('div', {
                className: `${P}section`,
                children: [
                  jsx('h4', { className: `${P}sectionTitle`, children: '投递与恢复' }),
                  jsxs('div', {
                    className: `${P}kv`,
                    children: [jsx('span', { className: `${P}kvKey`, children: '写入者' }), jsx('span', { children: recovery.singleWriter ? '本进程唯一' : '未知' })],
                  }),
                  jsxs('div', {
                    className: `${P}kv`,
                    children: [jsx('span', { className: `${P}kvKey`, children: '上次恢复' }), jsx('span', { children: recovery.lastRecoveryAt ?? '本次会话内尚未恢复' })],
                  }),
                  (recovery.deliveries ?? []).length === 0
                    ? jsx('div', { className: `${P}meta`, children: '没有失败或不确定的投递。' })
                    : recovery.deliveries.map((delivery) =>
                        jsxs(
                          'div',
                          {
                            className: `${P}card`,
                            children: [
                              jsx('div', { className: `${P}cardTitle`, children: `${delivery.label}（#${delivery.seq ?? '?'}）` }),
                              jsx('div', { className: `${P}meta`, children: delivery.detail ?? '' }),
                              jsx('div', {
                                className: `${P}chips`,
                                children: jsx('button', {
                                  type: 'button',
                                  className: `${P}btn ${P}btnTiny`,
                                  onClick: () => onAction('retry', delivery),
                                  children: '核对后重投',
                                }),
                              }),
                            ],
                          },
                          `${delivery.messageId}:${delivery.recipientId}`,
                        ),
                      ),
                  jsx('div', { className: `${P}meta`, style: { marginTop: 6 }, children: recovery.note }),
                ],
              })
            : null,
          error ? jsx('div', { className: `${P}hint ${P}hintErr`, children: error }) : null,
        ],
      });
    }

    /* ------------------------------------------------------------------ *
     * Member list and detail
     * ------------------------------------------------------------------ */

    function MemberList(props) {
      const { members, selfId, onAvatarMenu, selectedId, onSelect } = props;
      return jsx('div', {
        className: `${P}section`,
        children: members.map((member) =>
          jsxs(
            'div',
            {
              className: `${P}memberRow`,
              onClick: () => onSelect(member),
              style: selectedId === member.id ? { background: 'var(--dsw-alias-bg-layer-2)' } : undefined,
              children: [
                jsx(Avatar, { member, small: true, onMenu: onAvatarMenu }, 'a'),
                jsxs('div', {
                  style: { minWidth: 0, flex: 1 },
                  children: [
                    jsxs('div', {
                      className: `${P}name`,
                      children: [
                        member.displayName,
                        member.kind === 'agent' ? jsx('span', { className: `${P}aiTag`, style: { marginLeft: 5 }, children: 'AI' }) : null,
                        member.id === selfId ? jsx('span', { className: `${P}meta`, style: { marginLeft: 5 }, children: '（你）' }) : null,
                      ],
                    }),
                    jsx('div', {
                      className: `${P}meta`,
                      children: `@${member.handle} · ${roleTemplate(member.role)?.title ?? member.role} · ${memberLabel(member.status)}`,
                    }),
                    member.effectiveModel
                      ? jsx('div', {
                          className: `${P}meta`,
                          children: `${member.effectiveModel.providerRoute}/${member.effectiveModel.modelId}${selectionSourceLabel(member.selectionSource)}`,
                        })
                      : jsx('div', { className: `${P}meta`, children: '未配置模型' }),
                    member.currentTask
                      ? jsx('div', { className: `${P}meta`, children: `任务：${member.currentTask.objective}（${taskLabel(member.currentTask.status)} r${member.currentTask.revision}）` })
                      : null,
                  ],
                }),
                jsx('span', { className: dotOf(member.status), title: memberLabel(member.status) }, 'dot'),
              ],
            },
            member.id,
          ),
        ),
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
        className: `${P}section`,
        children: [
          jsxs('div', { className: `${P}msgHead`, children: [jsx('span', { className: `${P}author`, children: member.displayName }), jsx('span', { className: `${P}spacer` }), jsx('button', { type: 'button', className: `${P}btn ${P}btnGhost ${P}btnTiny`, onClick: onClose, children: '关闭' })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '身份' }), jsx('span', { children: `@${member.handle}${member.aliases?.length ? ` · ${member.aliases.join('、')}` : ''}` })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '状态' }), jsx('span', { children: memberLabel(member.status) })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '会话' }), jsx('span', { className: `${P}mono`, children: member.sessionId ?? '未创建' })] }),
          jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '归属' }), jsx('span', { children: member.sessionOwnership === 'borrowed' ? '借用的用户会话（插件不会销毁）' : member.sessionOwnership === 'owned' ? '插件拥有' : '未知' })] }),
          observed
            ? jsxs('div', { className: `${P}kv`, children: [jsx('span', { className: `${P}kvKey`, children: '实际路由' }), jsx('span', { children: `${observed.providerRoute}/${observed.modelId}（第 ${observed.turn ?? '?'} 轮请求时观测到）` })] })
            : jsx('div', { className: `${P}meta`, children: '还没有观测到真实请求；改模型后请等它真正执行一次。' }),
          jsxs('div', {
            className: `${P}fieldRow`,
            style: { marginTop: 8 },
            children: [
              jsx('span', { className: `${P}label`, children: '模型（真实已接入的提供方/模型ID）' }),
              jsx('select', {
                className: `${P}select`,
                value: pending ?? member.modelProfileRef ?? '',
                onChange: (event) => setPending(event.target.value),
                children: [
                  jsx('option', { value: '', children: '未配置（使用角色/项目默认）' }),
                  ...options.map((profile) => jsx('option', { value: profile.profileRef, children: `${profile.label} — ${profile.providerRoute}/${profile.modelId}${profile.capabilityStatus === 'unverified' ? '（能力待验证）' : ''}` })),
                ],
              }),
              jsxs('div', {
                className: `${P}tools`,
                children: [
                  jsx('button', {
                    type: 'button',
                    className: `${P}btn ${P}btnPrimary ${P}btnTiny`,
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
                  jsx('span', { className: `${P}meta`, children: `配置版本 r${member.modelConfigRevision} · ${member.modelLocked ? '已锁定' : '未锁定'}` }),
                ],
              }),
              jsx('div', { className: `${P}meta`, children: `切换在安全边界生效：当前请求沿用旧路由，下一次请求使用新模型；成员身份、@ 名称与任务归属不变。项目选型模式：${settings?.selectionMode ?? 'fixed'}` }),
            ],
          }),
          jsxs('div', {
            className: `${P}tools`,
            children: [
              jsx('button', { type: 'button', className: `${P}btn ${P}btnTiny`, onClick: () => onControl(member, member.status === 'paused' ? 'resume' : 'pause'), children: member.status === 'paused' ? '恢复' : '暂停' }),
              jsx('button', { type: 'button', className: `${P}btn ${P}btnTiny`, onClick: () => onControl(member, 'stop'), children: '停止当前工作' }),
              jsx('button', { type: 'button', className: `${P}btn ${P}btnTiny`, onClick: () => onControl(member, 'retire'), children: '退出本群' }),
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

      return jsxs('div', {
        className: `${P}empty`,
        style: { alignItems: 'stretch', textAlign: 'left', maxWidth: 560, margin: '0 auto' },
        children: [
          jsx('div', { className: `${P}emptyTitle`, children: '新建项目群' }),
          jsx('div', { className: `${P}sub`, children: '一个项目一个群：主代理负责拆分与验收，成员各自使用你选择的真实模型。' }),
          jsxs('div', {
            style: { marginTop: 14 },
            children: [
              jsxs('div', { className: `${P}fieldRow`, children: [jsx('span', { className: `${P}label`, children: '群名称' }), jsx('input', { className: `${P}input`, value: title, placeholder: '例如：验证码登录功能', onChange: (event) => setTitle(event.target.value) })] }),
              jsxs('div', {
                className: `${P}fieldRow`,
                children: [
                  jsx('span', { className: `${P}label`, children: '工作区目录（成员的真实执行目录）' }),
                  jsx('input', { className: `${P}input`, value: workspace, placeholder: 'E:\\my-project', onChange: (event) => setWorkspace(event.target.value) }),
                ],
              }),
              jsxs('div', {
                className: `${P}fieldRow`,
                children: [
                  jsx('span', { className: `${P}label`, children: '整体目标（提交后主代理会拆分工作）' }),
                  jsx('textarea', {
                    className: `${P}input`,
                    style: { minHeight: 62 },
                    value: goal,
                    placeholder: '例如：做个验证码登录功能，顺便把运行说明补齐。',
                    onChange: (event) => setGoal(event.target.value),
                  }),
                ],
              }),
              jsxs('div', {
                className: `${P}fieldRow`,
                children: [
                  jsx('span', { className: `${P}label`, children: '初始成员' }),
                  jsx('div', {
                    className: `${P}checks`,
                    children: ROLE_TEMPLATES.map((template) =>
                      jsxs(
                        'label',
                        {
                          className: `${P}check`,
                          children: [
                            jsx('input', { type: 'checkbox', checked: roles.includes(template.role), onChange: () => toggle(template.role) }),
                            template.title,
                          ],
                        },
                        template.role,
                      ),
                    ),
                  }),
                ],
              }),
              jsxs('div', {
                className: `${P}fieldRow`,
                children: [
                  jsx('span', { className: `${P}label`, children: '每位成员的模型（可留空，之后在成员详情里改）' }),
                  roles.map((role) =>
                    jsxs(
                      'div',
                      {
                        style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 },
                        children: [
                          jsx('span', { style: { width: 68, flex: 'none', fontSize: 12.5 }, children: roleTemplate(role)?.title ?? role }),
                          jsx('select', {
                            className: `${P}select`,
                            style: { flex: 1 },
                            value: modelsByRole[role] ?? '',
                            onChange: (event) => setModelsByRole((current) => ({ ...current, [role]: event.target.value })),
                            children: [
                              jsx('option', { value: '', children: '使用项目/角色默认' }),
                              ...available.map((profile) => jsx('option', { value: profile.profileRef, children: `${profile.label} — ${profile.providerRoute}/${profile.modelId}` })),
                            ],
                          }),
                        ],
                      },
                      role,
                    ),
                  ),
                ],
              }),
              error ? jsx('div', { className: `${P}hint ${P}hintErr`, children: error }) : null,
              jsxs('div', {
                className: `${P}tools`,
                style: { marginTop: 6 },
                children: [
                  jsx('button', { type: 'button', className: `${P}btn ${P}btnPrimary`, disabled: busy || !roles.length, onClick: () => void submit(), children: busy ? '正在建群…' : '创建项目群' }),
                  jsx('button', { type: 'button', className: `${P}btn ${P}btnGhost`, onClick: onCancel, children: '取消' }),
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
      const [rooms, setRooms] = useState([]);
      const [roomId, setRoomId] = useState(null);
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [creating, setCreating] = useState(false);
      const [menu, setMenu] = useState({ open: false, x: 0, y: 0, memberId: null, messageId: null, selfId: null });
      const [selectedMember, setSelectedMember] = useState(null);
      const [replyTo, setReplyTo] = useState(null);
      const [notice, setNotice] = useState(null);
      // A mention requested from an avatar menu travels as state, so the composer
      // can put the chip at the caret of the draft the user already typed. A window
      // event would have raced the composer's own state and lost the draft.
      const [pendingMention, setPendingMention] = useState(null);

      const selfId = useMemo(() => state?.members?.find((member) => member.kind === 'human')?.id ?? null, [state]);

      const loadRooms = useCallback(async () => {
        try {
          const result = await post('room.list', {});
          setRooms(result.rooms ?? []);
          return result.rooms ?? [];
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          return [];
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
          if (list.length > 0) setRoomId((current) => current ?? list[0].id);
        })();
      }, [loadRooms]);

      useEffect(() => {
        if (roomId) void loadRoom(roomId);
      }, [roomId, loadRoom]);

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

      const handleMenuPick = useCallback(
        async (action, member) => {
          setMenu({ open: false, x: 0, y: 0, memberId: null, messageId: null, selfId });
          if (action === 'mention') {
            // The menu's whole purpose is to put a chip in the composer WITHOUT
            // sending (the design notes, AT02). The chip travels as state, not as a
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
            if (message) setReplyTo(message);
            return;
          }
          if (action === 'detail' || action === 'model' || action === 'task') {
            setSelectedMember(member);
            return;
          }
          if (action === 'pause' || action === 'resume' || action === 'retire') {
            await control(member, action);
          }
        },
        [state, menu.messageId, selfId],
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

      if (creating) {
        return jsxs('div', { className: `${P}root`, children: [jsx('style', { children: CSS }), jsx(CreateRoom, { models: state?.models, onCancel: () => setCreating(false), onCreated: async (result) => { setCreating(false); await loadRooms(); setRoomId(result.room.id); } })] });
      }

      return jsxs('div', {
        className: `${P}root`,
        children: [
          jsx('style', { children: CSS }),
          jsxs('div', {
            className: `${P}head`,
            children: [
              jsxs('div', {
                children: [
                  jsx('h2', { className: `${P}title`, children: state?.room?.title ?? '项目群' }),
                  jsx('p', {
                    className: `${P}sub`,
                    children: state
                      ? `${state.members.filter((member) => member.kind === 'agent').length} 位 AI 成员 · 成员表 r${state.room.membershipRevision} · 计划 r${state.room.planRevision} · 共 ${state.room.lastSeq} 条记录`
                      : '一个项目一个群：主代理拆分工作，成员各自用你选的模型真实执行。',
                  }),
                ],
              }),
              jsx('span', { className: `${P}spacer` }),
              state
                ? jsx('select', {
                    className: `${P}select`,
                    value: roomId ?? '',
                    onChange: (event) => setRoomId(event.target.value),
                    children: rooms.map((room) => jsx('option', { value: room.id, children: `${room.title}（${room.status}）` })),
                  })
                : null,
              jsx('button', { type: 'button', className: `${P}btn`, onClick: () => setCreating(true), children: '新建项目群' }),
              state ? jsx('button', { type: 'button', className: `${P}btn ${P}btnGhost`, onClick: () => void loadRoom(state.room.id), children: '刷新' }) : null,
            ],
          }),
          state?.capabilities?.notes?.length
            ? jsx('div', { className: `${P}hint ${P}hintWarn`, style: { margin: '0 18px 8px' }, children: `当前宿主能力缺口：${state.capabilities.notes.join('；')}` })
            : null,
          error ? jsx('div', { className: `${P}hint ${P}hintErr`, style: { margin: '0 18px 8px' }, children: error }) : null,
          notice ? jsx('div', { className: `${P}hint`, style: { margin: '0 18px 8px' }, children: notice.text }) : null,
          !state
            ? jsxs('div', {
                className: `${P}empty`,
                children: [
                  jsx('div', { className: `${P}emptyTitle`, children: '还没有项目群' }),
                  jsx('div', { children: '新建一个项目群，把整体目标交给主代理，它会把工作拆成有负责人和验收条件的任务。' }),
                  jsx('button', { type: 'button', className: `${P}btn ${P}btnPrimary`, onClick: () => setCreating(true), children: '新建项目群' }),
                ],
              })
            : jsxs('div', {
                className: `${P}cols`,
                children: [
                  jsxs('div', {
                    className: `${P}col ${P}colLeft`,
                    children: [
                      jsx('div', {
                        className: `${P}section`,
                        children: [
                          jsx('h4', { className: `${P}sectionTitle`, children: '项目群' }),
                          rooms.map((room) =>
                            jsx(
                              'button',
                              {
                                type: 'button',
                                className: room.id === roomId ? `${P}roomRow ${P}roomRowOn` : `${P}roomRow`,
                                onClick: () => setRoomId(room.id),
                                children: jsxs('span', {
                                  style: { minWidth: 0 },
                                  children: [jsx('span', { className: `${P}name`, children: room.title }), jsx('span', { className: `${P}meta`, children: `${room.status} · ${room.members} 位成员` })],
                                }),
                              },
                              room.id,
                            ),
                          ),
                        ],
                      }),
                      jsx(MemberList, {
                        members: state.members,
                        selfId,
                        selectedId: selectedMember?.id ?? null,
                        onSelect: (member) => setSelectedMember(member),
                        onAvatarMenu: (event, member, intent) =>
                          setMenu({ open: true, x: event.clientX, y: event.clientY, memberId: member.id, messageId: null, selfId }),
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
                  jsxs('div', {
                    className: `${P}col ${P}colMid`,
                    children: [
                      jsx(Timeline, {
                        messages: state.messages,
                        members: state.members,
                        selfId,
                        onReply: (message) => setReplyTo(message),
                        onAvatarMenu: (event, member, intent, message) =>
                          setMenu({ open: true, x: event.clientX, y: event.clientY, memberId: member.id, messageId: message?.id ?? null, selfId }),
                      }),
                      replyTo
                        ? jsx('div', {
                            className: `${P}hint`,
                            style: { margin: '0 14px 6px' },
                            children: jsxs('span', {
                              children: [`正在回复 #${replyTo.seq} `, jsx('button', { type: 'button', className: `${P}btn ${P}btnGhost ${P}btnTiny`, onClick: () => setReplyTo(null), children: '取消引用' })],
                            }),
                          })
                        : null,
                      jsx(Composer, {
                        room: state.room,
                        members: state.members,
                        selfId,
                        busy,
                        pendingMention,
                        onMentionHandled: () => setPendingMention(null),
                        onSend: send,
                        onError: (message) => setError(message),
                      }),
                    ],
                  }),
                  jsx('div', {
                    className: `${P}col ${P}colRight`,
                    children: jsxs(Fragment, {
                      children: [
                        jsx(ModelSettings, {
                          room: { ...state.room, members: state.members },
                          models: state.models,
                          settings: state.modelSettings,
                          hostDefault: state.modelSettings?.hostDefault ?? null,
                          onSave: saveModelSettings,
                        }),
                        jsx(Board, {
                          room: state.room,
                          board: { ...state.board, members: state.members },
                          recovery: state.recovery,
                          onAction,
                          error: null,
                        }),
                      ],
                    }),
                  }),
                ],
              }),
          jsx(MemberMenu, {
            state: menu,
            members: state?.members ?? [],
            canReply: true,
            onClose: () => setMenu({ open: false, x: 0, y: 0, memberId: null, messageId: null, selfId }),
            onPick: handleMenuPick,
          }),
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
          jsx('path', { d: 'M4 5.5h16v10H8.5L4 19z', key: 'p' }),
          jsx('path', { d: 'M8.5 9.5h7M8.5 12.5h4', key: 'l' }),
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
      selectionSourceLabel,
      MemberList,
      MemberDetail,
      CreateRoom,
      MemberMenu,
      Avatar,
      MentionText,
      post,
      avatarFor,
      toneOf,
      dotOf,
      CSS,
    };
    return module.exports;
  },
});
