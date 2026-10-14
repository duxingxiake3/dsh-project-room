/**
 * Project Room — shared contracts.
 *
 * Every type in this file is a Project Room type. None of them is a DeepSeek
 * Harness SDK type: the host half adapts these to the verified Host API at the
 * boundary (`src/host/adapter/host-adapter.js`), and the client half mirrors
 * them over the plugin's own `/api/dsh-project-room` route.
 *
 * Both halves load this module. The host imports it as ESM; the browser half
 * loads the same text through the client module table (`shared/` is served as a
 * package subpath), so the rules cannot drift between preview and server.
 *
 * @module dsh-project-room/shared/contracts
 */

/** @typedef {string} MemberId */
/** @typedef {string} MessageId */
/** @typedef {string} RoomId */
/** @typedef {string} TaskId */
/** @typedef {string} DecisionId */

/* ------------------------------------------------------------------ *
 * Identity vocabulary
 * ------------------------------------------------------------------ */

/**
 * How a mention reached the room. The three legal input paths of the design notes.
 * @typedef {'avatar' | 'picker' | 'typed'} MentionOrigin
 */

/**
 * Member species. System events are never members, and never作者 of a message.
 * @typedef {'human' | 'agent'} MemberKind
 */

/**
 * Who owns the member's runtime session.
 * - `owned`: the plugin created it and may stop/dispose it.
 * - `borrowed`: a user session the plugin bound to, which it must never destroy.
 * @typedef {'owned' | 'borrowed'} Ownership
 */

/**
 * Visible member state. Deliberately split from delivery and task state
 * (design D05): "online", "delivered" and "done" are three different facts.
 * @typedef {'idle' | 'working' | 'awaiting_reply' | 'needs_user' | 'paused' | 'offline'} MemberStatus
 */

/**
 * Team role. `role` decides duties, never a model brand.
 * @typedef {'coordinator' | 'frontend' | 'backend' | 'tester' | 'devops' | 'designer' | 'docs' | string} TeamRole
 */

/* ------------------------------------------------------------------ *
 * Mentions
 * ------------------------------------------------------------------ */

/**
 * One resolved mention target.
 *
 * `span` is a UTF-16 range into the ORIGINAL body. Structured chips inserted by
 * the picker or the avatar menu may carry no span, which is exactly why the
 * client sends them separately instead of relying on text.
 *
 * @typedef {object} Mention
 * @property {MemberId} targetMemberId
 * @property {MentionOrigin} origin
 * @property {string} displaySnapshot  Name as shown when the mention was made.
 * @property {{ start: number, end: number } | null} span
 */

/**
 * One `@token` found in free text, before member resolution.
 * @typedef {object} ParsedAtToken
 * @property {number} start  UTF-16 start offset of `@` in the original body.
 * @property {number} end    UTF-16 end offset (exclusive).
 * @property {string} raw    Exact source text, e.g. `@后端` or `＠「前端 小林」`.
 * @property {string} name   Extracted name without `@` or bracket quotes.
 */

/**
 * Resolution outcome for one token.
 * @typedef {object} MentionResolution
 * @property {ParsedAtToken} token
 * @property {'member' | 'everyone' | 'unknown' | 'ambiguous'} kind
 * @property {MemberId | null} memberId
 * @property {MemberId[]} candidates  Populated when `kind` is `ambiguous`.
 * @property {string} reason  Human-readable Chinese explanation for the UI.
 */

/* ------------------------------------------------------------------ *
 * Members and models
 * ------------------------------------------------------------------ */

/**
 * A host model configuration reference. Credentials never live here.
 * @typedef {object} ModelProfileRef
 * @property {string} id            Project Room's own id for this reference.
 * @property {string} hostProfileRef Host-side settings identity, when one exists.
 * @property {string} providerRoute  Registered provider route, e.g. `deepseek-official`.
 * @property {string} modelId        Exact provider model id — never a brand nickname.
 */

/**
 * A resolved, live-checked model profile.
 * @typedef {object} ResolvedModelProfile
 * @property {string} id
 * @property {string} providerRoute
 * @property {string} modelId
 * @property {string} label
 * @property {'verified' | 'unverified' | 'unavailable'} capabilityStatus
 * @property {string[]} capabilities
 * @property {string | null} contextWindow
 * @property {string | null} note
 */

/**
 * Where a member's effective model came from.
 * @typedef {'project-default' | 'role-default' | 'member-fixed' | 'allowed-pool'} SelectionSource
 */

/**
 * @typedef {object} RoomMember
 * @property {MemberId} id
 * @property {RoomId} roomId
 * @property {MemberKind} kind
 * @property {TeamRole} role
 * @property {string} displayName
 * @property {string} handle          Unique ASCII mention handle, e.g. `backend`.
 * @property {string[]} aliases       Additional unique aliases, e.g. `后端`, `阿北`.
 * @property {MemberStatus} status
 * @property {number} membershipRevision
 * @property {number} personaRevision
 * @property {string | null} modelProfileRef
 * @property {number} modelConfigRevision
 * @property {SelectionSource} selectionSource
 * @property {boolean} modelLocked
 * @property {string | null} currentTaskId
 * @property {string | null} sessionId
 * @property {Ownership | null} sessionOwnership
 * @property {number} lastSeenSeq
 * @property {number} lastAppliedDecisionRevision
 * @property {string} createdAt
 */

/* ------------------------------------------------------------------ *
 * Messages and delivery
 * ------------------------------------------------------------------ */

/**
 * Delivery states. "Delivered" is not "read": `claimed` requires a real host
 * observation (the design notes).
 * @typedef {'pending' | 'paused' | 'admitting' | 'accepted' | 'claimed' | 'replied' | 'discarded' | 'failed' | 'uncertain'} DeliveryStatus
 */

/**
 * @typedef {object} Delivery
 * @property {MessageId} messageId
 * @property {MemberId} recipientId
 * @property {DeliveryStatus} status
 * @property {'queue' | 'steer'} requestedMode
 * @property {'queue' | 'steer' | null} actualMode
 * @property {string | null} hostMessageId
 * @property {number} deliveryAttempt
 * @property {string} updatedAt
 * @property {string | null} errorCode
 * @property {string | null} detail
 */

/**
 * @typedef {object} RoomMessage
 * @property {MessageId} id
 * @property {RoomId} roomId
 * @property {number} seq
 * @property {MemberId} authorId
 * @property {MemberKind} authorKind
 * @property {string} body
 * @property {Mention[]} mentions
 * @property {MessageId | null} replyTo
 * @property {string | null} threadId
 * @property {TaskId | null} taskId
 * @property {string} causalRootId
 * @property {string} clientMessageId
 * @property {string} createdAt
 * @property {Delivery[]} deliveries
 */

/**
 * One append-only room event. `seq` is the single ordering authority for both
 * messages and system events (the design notes).
 * @typedef {object} RoomEvent
 * @property {RoomId} roomId
 * @property {number} seq
 * @property {string} eventType
 * @property {object} payload
 * @property {string} createdAt
 */

/* ------------------------------------------------------------------ *
 * Tasks, plans, decisions, artifacts
 * ------------------------------------------------------------------ */

/**
 * Task lifecycle (the design notes). Transitions are validated, not free-form.
 * @typedef {'proposed' | 'ready' | 'in_progress' | 'blocked' | 'submitted' | 'verifying' | 'accepted' | 'rework' | 'superseded' | 'failed' | 'cancelled'} TaskStatus
 */

/**
 * @typedef {object} Task
 * @property {TaskId} id
 * @property {RoomId} roomId
 * @property {string | null} planId
 * @property {TaskId | null} parentTaskId
 * @property {string} objective
 * @property {MemberId | null} ownerId
 * @property {TeamRole | null} requiredRole
 * @property {string[]} requiredCapabilities
 * @property {string[]} deliverables
 * @property {TaskStatus} status
 * @property {number} revision
 * @property {number} decisionRevision
 * @property {string[]} acceptance
 * @property {TaskId[]} dependencies
 * @property {string} assignmentRevision
 * @property {boolean} needsSync
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} Decision
 * @property {DecisionId} id
 * @property {RoomId} roomId
 * @property {number} revision
 * @property {'proposed' | 'accepted' | 'rejected' | 'superseded'} status
 * @property {string} sourceMessageId
 * @property {string} scope
 * @property {string} statement
 * @property {string | null} supersedes
 * @property {MemberId | null} acceptedBy
 * @property {TaskId[]} affectedTaskIds
 * @property {string} createdAt
 */

/**
 * @typedef {object} DecisionAck
 * @property {DecisionId} decisionId
 * @property {MemberId} memberId
 * @property {'synced' | 'needs_clarification' | 'rework' | 'unaffected' | 'pending'} state
 * @property {number | null} appliedTaskRevision
 * @property {string | null} detail
 * @property {string} updatedAt
 */

/**
 * @typedef {object} Artifact
 * @property {string} id
 * @property {RoomId} roomId
 * @property {TaskId | null} taskId
 * @property {string | null} attemptId
 * @property {'diff' | 'file' | 'test-run' | 'note' | 'commit'} kind
 * @property {string} location
 * @property {string | null} contentHash
 * @property {string | null} evidenceRef
 * @property {boolean} verified
 * @property {string} createdAt
 */

/* ------------------------------------------------------------------ *
 * Host capabilities — what this installation can actually do
 * ------------------------------------------------------------------ */

/**
 * Probed once at activation and reported to the user verbatim. A `false` field
 * must degrade the product visibly; it must never silently become a different
 * feature (the design notes).
 *
 * @typedef {object} HostCapabilities
 * @property {boolean} ownedSessions           Can create plugin-owned root sessions.
 * @property {boolean} borrowedMainBinding     Can bind a user's live session without owning it.
 * @property {boolean} steer                   Can deliver at a step boundary of a running turn.
 * @property {boolean} stableInputIdentity     Caller-side message identity survives into the log.
 * @property {boolean} lookupAcceptedInput     Can confirm a specific input landed.
 * @property {boolean} observeClaimedInput     Can observe that a turn consumed a specific input.
 * @property {boolean} observeReply            Can observe assistant output of a turn.
 * @property {boolean} persistence             Session persistence present.
 * @property {boolean} perMemberModelRouting   Per-session provider/model routing.
 * @property {boolean} modelCatalog            Can enumerate real models per provider.
 * @property {boolean} safeModelRebinding      Can change a live session's route safely.
 * @property {boolean} sqlite                  Local durable storage available.
 * @property {string} dshVersion
 * @property {string} nodeVersion
 * @property {string} electronVersion
 * @property {string[]} notes                  Precise gaps, shown to the user.
 */

/* ------------------------------------------------------------------ *
 * Client ⇄ host wire
 * ------------------------------------------------------------------ */

/**
 * Structured error codes returned by every write operation (the design notes).
 * @typedef {'MENTION_AMBIGUOUS' | 'MEMBER_UNAVAILABLE' | 'REVISION_CONFLICT' | 'HOST_CAPABILITY_MISSING' | 'DELIVERY_UNCERTAIN' | 'ROOM_PAUSED' | 'NOT_A_ROOM_MEMBER' | 'ARTIFACT_NOT_VERIFIED' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'FORBIDDEN' | 'INTERNAL'} RoomErrorCode
 */

/**
 * @typedef {object} RoomErrorShape
 * @property {RoomErrorCode} code
 * @property {string} message       Natural Chinese for the user.
 * @property {object} [details]
 */

/** Route served by the plugin's host half on the authenticated `/api` channel. */
export const ROUTE = '/api/dsh-project-room';

/** Wire protocol marker for the message envelope handed to a member session. */
export const ENVELOPE_PROTOCOL = 'project-room.v1';

/* ------------------------------------------------------------------ *
 * Mention parsing vocabulary shared by client and server
 * ------------------------------------------------------------------ */

/** ASCII `@` and full-width `＠`. */
export const AT_SIGN = '@';
export const AT_SIGN_FULL_WIDTH = '\uFF20';

/** Authored time of a body is always stored as UTC ISO 8601. */
export const TIME_FORMAT = 'utc-iso8601';

/**
 * Natural Chinese for each delivery state, used by the timeline. Kept beside
 * the states so the UI cannot invent a friendlier but untrue word.
 * @type {Readonly<Record<DeliveryStatus, string>>}
 */
export const DELIVERY_LABELS = Object.freeze({
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
 * Natural Chinese for each task state.
 * @type {Readonly<Record<TaskStatus, string>>}
 */
export const TASK_STATUS_LABELS = Object.freeze({
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
 * Legal task transitions. Anything absent is rejected with
 * `REVISION_CONFLICT`-free, explicit validation rather than silently accepted.
 * @type {Readonly<Record<TaskStatus, readonly TaskStatus[]>>}
 */
export const TASK_TRANSITIONS = Object.freeze({
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
 * Role templates. A template supplies duties and a default handle; it never
 * pins a model brand (design D11).
 * @type {ReadonlyArray<{ role: TeamRole, handle: string, title: string, aliases: string[], duties: string, defaultObjectives: string[] }>}
 */
export const ROLE_TEMPLATES = Object.freeze([
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
export function roleTemplate(role) {
  return ROLE_TEMPLATES.find((template) => template.role === role);
}

/**
 * Whether a task transition is legal.
 * @param {TaskStatus} from
 * @param {TaskStatus} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TASK_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Build a successful wire reply.
 * @param {object} data
 * @returns {{ ok: true } & object}
 */
export function ok(data) {
  return { ok: true, ...data };
}

/**
 * Build a failed wire reply.
 * @param {RoomErrorCode} code
 * @param {string} message
 * @param {object} [details]
 * @returns {{ ok: false, error: RoomErrorShape }}
 */
export function fail(code, message, details) {
  return { ok: false, error: details === undefined ? { code, message } : { code, message, details } };
}

/**
 * `RoomError` — a failure carrying a wire error code, raised inside host
 * services and converted to a `fail()` reply at the route boundary.
 */
export class RoomError extends Error {
  /**
   * @param {RoomErrorCode} code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * ISO 8601 UTC timestamp for "now".
 * @param {number} [epochMs]
 * @returns {string}
 */
export function isoTimestamp(epochMs = Date.now()) {
  return new Date(epochMs).toISOString();
}
