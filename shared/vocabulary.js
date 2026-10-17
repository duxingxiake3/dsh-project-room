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
export const AT_SIGN = '@';
export const AT_SIGN_FULL_WIDTH = '\uFF20';

/** Route served by the plugin's host half on the authenticated `/api` channel. */
export const ROUTE = '/api/dsh-project-room';

/** Wire protocol marker for the message envelope handed to a member session. */
export const ENVELOPE_PROTOCOL = 'project-room.v1';

/** Authored time is always stored as UTC ISO 8601. */
export const TIME_FORMAT = 'utc-iso8601';

/** Everything a client may send as an action name starts with this. */
export const ACTION_PREFIX = 'room.';

/**
 * Delivery states. "Delivered" is not "read": `claimed` requires a real host
 * observation.
 * @type {Readonly<Record<string, string>>}
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
 * Task states.
 * @type {Readonly<Record<string, string>>}
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
 * Legal task transitions. Anything absent is rejected rather than accepted.
 * @type {Readonly<Record<string, readonly string[]>>}
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
 * Member states. Deliberately separate from delivery and task state: `working`
 * comes from a real agent status, never from a pending message.
 * @type {Readonly<Record<string, string>>}
 */
export const MEMBER_STATUS_LABELS = Object.freeze({
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
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TASK_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Research run states (deep research). Kept here so the host and the panel cannot label
 * "approved" as "running".
 * @type {Readonly<Record<string, string>>}
 */
export const RESEARCH_STATUS_LABELS = Object.freeze({
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
export const RESEARCH_CONCLUSION_LABELS = Object.freeze({
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
export const PROJECT_LIFECYCLE_LABELS = Object.freeze({
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
export const RESEARCH_PHASE_LABELS = Object.freeze({
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
export const ERROR_LABELS = Object.freeze({
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
export function isoTimestamp(epochMs = Date.now()) {
  return new Date(epochMs).toISOString();
}

/**
 * Human label for a delivery state.
 * @param {string} status
 * @returns {string}
 */
export function deliveryLabel(status) {
  return DELIVERY_LABELS[status] ?? status;
}

/**
 * Human label for a task state.
 * @param {string} status
 * @returns {string}
 */
export function taskLabel(status) {
  return TASK_STATUS_LABELS[status] ?? status;
}

/**
 * Human label for a member state.
 * @param {string} status
 * @returns {string}
 */
export function memberLabel(status) {
  return MEMBER_STATUS_LABELS[status] ?? status;
}
