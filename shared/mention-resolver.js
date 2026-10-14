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

import { AT_SIGN, AT_SIGN_FULL_WIDTH } from './vocabulary.js';

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
export const EVERYONE_KEYWORDS = Object.freeze(['所有人', '全员', 'all', 'everyone', 'all-members']);

/** The literal keywords that address the human user rather than an agent. */
export const HUMAN_KEYWORDS = Object.freeze(['用户', '老板', 'user', 'owner', 'human']);

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
export function normalizeName(value) {
  return String(value ?? '').normalize('NFC').trim();
}

/**
 * Case-insensitive fold for ASCII handles only.
 * @param {string} value
 * @returns {string}
 */
export function foldAscii(value) {
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
export function sameName(a, b) {
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
export function maskBody(body) {
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
export function extractAtTokens(body) {
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
export class MentionResolver {
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
export function mergeMentions(input) {
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
export function segmentsForDisplay(body, mentions) {
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
export function stripMentionSyntax(body) {
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
