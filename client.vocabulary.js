/**
 * GENERATED FILE — do not edit.
 *
 * Browser half of shared/vocabulary.js, emitted by scripts/build-client.mjs so
 * both halves run the same rules (the design notes rule 11). Edit the source module
 * and run `node scripts/build-client.mjs`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-project-room#vocabulary',
  chunk: 'client.vocabulary.js',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const __deps = {  };

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

    module.exports = { AT_SIGN, AT_SIGN_FULL_WIDTH, ROUTE, ENVELOPE_PROTOCOL, TIME_FORMAT, ACTION_PREFIX, DELIVERY_LABELS, TASK_STATUS_LABELS, TASK_TRANSITIONS, MEMBER_STATUS_LABELS, ROLE_TEMPLATES, ERROR_LABELS, roleTemplate, canTransition, isoTimestamp, deliveryLabel, taskLabel, memberLabel };
    return module.exports;
  },
});
