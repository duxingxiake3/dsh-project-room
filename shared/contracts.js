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
 * How a mention reached the room. The three legal input paths.
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
 * Visible member state. Deliberately split from delivery and task state:
 * "online", "delivered" and "done" are three different facts.
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
 * @property {string} displaySnapshot Name as shown when the mention was made.
 * @property {{ start: number, end: number } | null} span
 */

/**
 * One `@token` found in free text, before member resolution.
 * @typedef {object} ParsedAtToken
 * @property {number} start UTF-16 start offset of `@` in the original body.
 * @property {number} end UTF-16 end offset (exclusive).
 * @property {string} raw Exact source text, e.g. `@后端` or `＠「前端 小林」`.
 * @property {string} name Extracted name without `@` or bracket quotes.
 */

/**
 * Resolution outcome for one token.
 * @typedef {object} MentionResolution
 * @property {ParsedAtToken} token
 * @property {'member' | 'everyone' | 'unknown' | 'ambiguous'} kind
 * @property {MemberId | null} memberId
 * @property {MemberId[]} candidates Populated when `kind` is `ambiguous`.
 * @property {string} reason Human-readable Chinese explanation for the UI.
 */

/* ------------------------------------------------------------------ *
 * Members and models
 * ------------------------------------------------------------------ */

/**
 * A host model configuration reference. Credentials never live here.
 * @typedef {object} ModelProfileRef
 * @property {string} id Project Room's own id for this reference.
 * @property {string} hostProfileRef Host-side settings identity, when one exists.
 * @property {string} providerRoute Registered provider route, e.g. `deepseek-official`.
 * @property {string} modelId Exact provider model id — never a brand nickname.
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
 *
 * `host-default` is deliberately its own value: on a project nobody has configured,
 * the model comes from the Harness itself, and reporting that as "project default"
 * would imply the user chose it.
 * @typedef {'project-default' | 'role-default' | 'member-fixed' | 'allowed-pool' | 'host-default'} SelectionSource
 */

/**
 * @typedef {object} RoomMember
 * @property {MemberId} id
 * @property {RoomId} roomId
 * @property {MemberKind} kind
 * @property {TeamRole} role
 * @property {string} displayName
 * @property {string} handle Unique ASCII mention handle, e.g. `backend`.
 * @property {string[]} aliases Additional unique aliases, e.g. `后端`, `阿北`.
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
 * observation.
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
 * messages and system events.
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
 * Task lifecycle. Transitions are validated, not free-form.
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
 * feature.
 *
 * @typedef {object} HostCapabilities
 * @property {boolean} ownedSessions Can create plugin-owned root sessions.
 * @property {boolean} borrowedMainBinding Can bind a user's live session without owning it.
 * @property {boolean} steer Can deliver at a step boundary of a running turn.
 * @property {boolean} stableInputIdentity Caller-side message identity survives into the log.
 * @property {boolean} lookupAcceptedInput Can confirm a specific input landed.
 * @property {boolean} observeClaimedInput Can observe that a turn consumed a specific input.
 * @property {boolean} observeReply Can observe assistant output of a turn.
 * @property {boolean} persistence Session persistence present.
 * @property {boolean} perMemberModelRouting Per-session provider/model routing.
 * @property {boolean} modelCatalog Can enumerate real models per provider.
 * @property {boolean} safeModelRebinding Can change a live session's route safely.
 * @property {boolean} sqlite Local durable storage available.
 * @property {string} dshVersion
 * @property {string} nodeVersion
 * @property {string} electronVersion
 * @property {string[]} notes Precise gaps, shown to the user.
 */

/* ------------------------------------------------------------------ *
 * Client ⇄ host wire
 * ------------------------------------------------------------------ */

/**
 * Structured error codes returned by every write operation.
 * @typedef {'MENTION_AMBIGUOUS' | 'MEMBER_UNAVAILABLE' | 'REVISION_CONFLICT' | 'HOST_CAPABILITY_MISSING' | 'DELIVERY_UNCERTAIN' | 'ROOM_PAUSED' | 'ROOM_TRASHED' | 'ROOM_ARCHIVED' | 'PROJECT_BUSY' | 'PROJECT_SNAPSHOT_MISSING' | 'PROJECT_SNAPSHOT_MISMATCH' | 'RESEARCH_DISABLED' | 'RESEARCH_NOT_FOUND' | 'RESEARCH_NOT_AUTHORIZED' | 'RESEARCH_INVALID_STATE' | 'RESEARCH_SCOPE_CHANGED' | 'RESEARCH_OUT_OF_SCOPE' | 'RESEARCH_BUDGET_EXCEEDED' | 'RESEARCH_BUDGET_MISSING' | 'RESEARCH_PROJECT_VERSION_CHANGED' | 'NOT_A_ROOM_MEMBER' | 'ARTIFACT_NOT_VERIFIED' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'FORBIDDEN' | 'INTERNAL'} RoomErrorCode
 */

/**
 * @typedef {object} RoomErrorShape
 * @property {RoomErrorCode} code
 * @property {string} message Natural Chinese for the user.
 * @property {object} [details]
 */

/**
 * Wire constants, label tables, the task transition table and the role templates
 * are declared in `vocabulary.js` — the dependency-free module BOTH halves load,
 * where the browser half receives them as a generated chunk. They are re-exported
 * here so host modules keep importing everything from this file, without a second
 * definition that could drift out of step with the browser's copy.
 *
 * The types this file owns (rooms, members, messages, tasks, decisions,
 * artifacts, host capabilities and the wire error shape) stay declared here.
 */
export {
  ROUTE,
  ENVELOPE_PROTOCOL,
  AT_SIGN,
  AT_SIGN_FULL_WIDTH,
  TIME_FORMAT,
  DELIVERY_LABELS,
  TASK_STATUS_LABELS,
  TASK_TRANSITIONS,
  MEMBER_STATUS_LABELS,
  ROLE_TEMPLATES,
  roleTemplate,
  canTransition,
  isoTimestamp,
} from './vocabulary.js';

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
