/**
 * Project Room — deep research (deep research).
 *
 * The hard rule is simple: a proposal is not a run. Only a real human approval,
 * persisted by the authenticated UI channel, can create an effective grant; the
 * run must then pass the same gate again before it becomes RUNNING and before
 * every experiment is admitted.
 *
 * The service deliberately reuses the project's existing Room/Task/Decision/
 * Artifact ledgers rather than creating a second chat or task universe.
 *
 * @module dsh-project-room/src/host/research/research-service
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { RoomError, isoTimestamp } from '../../../shared/contracts.js';
import { resolveInside } from '../security/safe-path.js';

export const RESEARCH_STATUS = Object.freeze({
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
  CANCELLED: 'CANCELLED',
  PAUSED_RECONCILE: 'PAUSED_RECONCILE',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
});

export const RESEARCH_CONCLUSIONS = new Set(['improved', 'no_change', 'inconclusive', 'rejected_candidate']);
export const RESEARCH_PHASES = new Set(['proposal', 'approved', 'independent', 'review', 'experiment', 'converge', 'completed', 'stopped']);

const DEFAULT_BUDGET = Object.freeze({
  maxModelCalls: 32,
  maxTotalTokens: 120000,
  maxWallClockMs: 3600000,
  maxExperimentRuns: 10,
  maxParallelAgents: 3,
});

/**
 * Stable JSON: the digest must not depend on object insertion order.
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value @param {number} fallback */
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** @param {object} usage */
function tokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const total = Number(usage.totalTokens ?? usage.total_tokens ?? usage.total ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  const input = Number(usage.inputTokens ?? usage.promptTokens ?? usage.input ?? 0);
  const output = Number(usage.outputTokens ?? usage.completionTokens ?? usage.output ?? 0);
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

export class ResearchService {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   * @param {import('./repository.js').ResearchRepository} input.repository
   * @param {import('../room/room-service.js').RoomService} input.rooms
   * @param {import('../models/model-service.js').ModelProfileService} input.models
   * @param {import('../room/message-service.js').MessageService} [input.messages]
   * @param {import('../tasks/task-service.js').TaskService} [input.tasks]
   * @param {import('../tasks/planning-service.js').PlanningService} [input.planning]
   * @param {import('../decisions/decision-service.js').DecisionService} [input.decisions]
   * @param {import('../workspace/artifact-service.js').ArtifactService} [input.artifacts]
   * @param {string[]} [input.protectedRoots]
   * @param {object} [input.budgetDefaults]
   * @param {boolean} [input.enabled]
   * @param {object} [input.logger]
   */
  constructor(input) {
    this.store = input.store;
    this.repository = input.repository;
    this.rooms = input.rooms;
    this.models = input.models;
    this.adapter = input.adapter ?? null;
    this.agentPreset = input.agentPreset;
    this.researchSessions = new Map();
    this.activeResearchTurns = new Set();
    this.messages = input.messages ?? null;
    this.tasks = input.tasks ?? null;
    this.planning = input.planning ?? null;
    this.decisions = input.decisions ?? null;
    this.artifacts = input.artifacts ?? null;
    this.protectedRoots = (input.protectedRoots ?? []).filter(Boolean).map((root) => resolve(root));
    this.budgetDefaults = { ...DEFAULT_BUDGET, ...(input.budgetDefaults ?? {}) };
    this.enabled = input.enabled !== false;
    this.logger = input.logger ?? null;
  }

  /* ------------------------------------------------------------------ *
   * Proposal and approval
   * ------------------------------------------------------------------ */

  /**
   * Create a proposal plus its (not yet runnable) research run. No model call,
   * task or experiment is created here.
   * @param {object} input
   */
  async propose(input) {
    this.#requireEnabled();
    const room = this.rooms.assertActive(input.roomId, '提出研究提议');
    const actor = this.rooms.requireMember(input.actorId);
    if (actor.kind !== 'human' && actor.role !== 'coordinator') {
      throw new RoomError('FORBIDDEN', '只有真实用户或主代理可以提出深度研究提议。', { actorId: actor.id, role: actor.role });
    }
    const topic = String(input.topic ?? '').trim();
    const objective = String(input.objective ?? '').trim();
    const justification = String(input.justification ?? '').trim();
    if (!topic) throw new RoomError('INVALID_REQUEST', '研究提议需要 topic。');
    if (!objective) throw new RoomError('INVALID_REQUEST', '研究提议需要 objective：要验证什么、成功标准是什么。');
    if (!justification) throw new RoomError('INVALID_REQUEST', '研究提议需要 justification：为什么普通流程不够。');

    const participants = this.#participants(room.id, input.participantPlan ?? input.participantIds ?? []);
    const scope = this.#scope(room, input);
    const budget = this.#budget(room, participants.length, input.budget);
    const modelProfileRefs = await this.#modelRefs(participants, input.modelProfileRefs ?? []);
    const hypotheses = (input.hypotheses ?? []).map((entry) => String(entry)).filter(Boolean);
    const expectedArtifacts = (input.expectedArtifacts ?? []).map((entry) => String(entry)).filter(Boolean);
    const participantPlan = participants.map((member) => ({
      memberId: member.id,
      displayName: member.displayName,
      role: member.role,
      kind: member.kind,
    }));
    const projectSnapshotRef = `room:${room.id}@plan:${room.planRevision}@updated:${room.updatedAt}`;
    const basePlanRevision = room.planRevision;
    const researchId = `research_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const proposalRevision = 1;
    const idempotencyKey = String(input.idempotencyKey ?? `research:${room.id}:${input.sourceMessageId ?? researchId}:${proposalRevision}`);
    const existing = this.repository.findProposalByKey(idempotencyKey);
    if (existing) {
      return { proposal: existing, run: this.repository.getRun(existing.researchId), duplicate: true };
    }

    const proposalInput = {
      roomId: room.id,
      researchId,
      sourceMessageId: input.sourceMessageId ?? null,
      requestedBy: actor.id,
      topic,
      objective,
      justification,
      hypotheses,
      expectedArtifacts,
      participantPlan,
      projectSnapshotRef,
      scope: { ...scope, allowedModelProfileRefs: modelProfileRefs, allowedMemberIds: participants.map((member) => member.id) },
      budget,
      proposalRevision,
      basePlanRevision,
    };
    const scopeDigest = this.#digest(room.id, researchId, proposalRevision, proposalInput);
    const pending = this.repository
      .listProposals(room.id, { status: RESEARCH_STATUS.AWAITING_APPROVAL })
      .find((proposal) => proposal.scopeDigest === scopeDigest);
    if (pending) {
      return { proposal: pending, run: this.repository.getRun(pending.researchId), duplicate: true };
    }

    const result = this.repository.transaction(() => {
      const proposal = this.repository.insertProposal({
        id: `proposal_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        ...proposalInput,
        scopeDigest,
        idempotencyKey,
        status: RESEARCH_STATUS.AWAITING_APPROVAL,
      });
      const run = this.repository.insertRun({
        id: researchId,
        roomId: room.id,
        proposalId: proposal.id,
        status: RESEARCH_STATUS.AWAITING_APPROVAL,
        currentPhase: 'proposal',
        basePlanRevision,
        participantIds: participants.map((member) => member.id),
        idempotencyKey: `run:${researchId}`,
      });
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'research.proposed',
        payload: {
          researchId,
          proposalId: proposal.id,
          proposalRevision,
          topic,
          objective,
          scopeDigest,
          participantIds: participants.map((member) => member.id),
          budget,
          requestedBy: actor.id,
        },
      });
      return { proposal, run };
    });
    this.rooms.publish(room.id, { type: 'research.changed', roomId: room.id, researchId });
    return { ...result, relatedExperience: this.repository.listExperienceForRoom(room.id, 5), duplicate: false };
  }

  /**
   * A human decision on one exact proposal revision and scope digest. An agent
   * caller is refused by identity, not by a prompt.
   * @param {object} input
   */
  approve(input) {
    return this.#decide(input, 'approved');
  }

  /** @param {object} input */
  reject(input) {
    return this.#decide(input, 'rejected');
  }

  /**
   * Withdraw a proposal without pretending it was approved or rejected. This is
   * the "user closed the card" path: it revokes any grant, marks the proposal
   * cancelled, and refuses to start.
   * @param {object} input
   */
  cancel(input) {
    this.#requireEnabled();
    const run = this.#requireRun(input.researchId);
    const room = this.rooms.assertWritable(run.roomId, '取消研究提议');
    this.#requireSingleHuman(room.id, input.actorId);
    if (run.status === RESEARCH_STATUS.CANCELLED) return { run, duplicate: true };
    if (![RESEARCH_STATUS.AWAITING_APPROVAL, RESEARCH_STATUS.APPROVED, RESEARCH_STATUS.REJECTED].includes(run.status)) {
      throw new RoomError('RESEARCH_INVALID_STATE', '只有尚未启动的研究提议可以取消。', { status: run.status });
    }
    const updated = this.repository.transaction(() => {
      this.repository.revokeApprovals(run.id, 'research proposal cancelled');
      this.repository.markResearchSessions(run.id, 'disposed');
      this.repository.updateProposal(run.proposalId, { status: RESEARCH_STATUS.CANCELLED });
      const next = this.repository.updateRun(run.id, {
        status: RESEARCH_STATUS.CANCELLED,
        pausedReason: String(input.reason ?? '用户取消'),
        endedAt: isoTimestamp(),
      });
      this.store.appendEvent({
        roomId: run.roomId,
        eventType: 'research.cancelled',
        payload: { researchId: run.id, proposalId: run.proposalId, by: input.actorId, reason: input.reason ?? null },
      });
      return next;
    });
    this.rooms.publish(room.id, { type: 'research.changed', roomId: room.id, researchId: run.id });
    return { run: updated, duplicate: false };
  }

  #decide(input, decision) {
    this.#requireEnabled();
    const run = this.repository.getRun(input.researchId);
    if (!run) throw new RoomError('RESEARCH_NOT_FOUND', `研究 ${input.researchId} 不存在。`);
    const proposal = this.repository.getProposal(run.proposalId);
    if (!proposal) throw new RoomError('RESEARCH_NOT_FOUND', `研究提议 ${run.proposalId} 不存在。`);
    const room = this.rooms.assertWritable(proposal.roomId, decision === 'approved' ? '批准研究' : '拒绝研究');
    const human = this.#requireSingleHuman(room.id, input.approvedBy);
    const idempotencyKey = String(input.idempotencyKey ?? '');
    if (!idempotencyKey) throw new RoomError('INVALID_REQUEST', '研究审批需要 idempotencyKey。');
    // A retry with the same key must return the original decision even though the
    // run has already moved on. This is checked before the state guard so a
    // network retry is idempotent rather than a false "already processed" error.
    const duplicate = this.repository.findApprovalByKey(idempotencyKey);
    if (duplicate) {
      if (duplicate.researchId !== run.id || duplicate.decision !== decision) {
        throw new RoomError('INVALID_REQUEST', '这个幂等键已经用于另一个研究决定。');
      }
      return { approval: duplicate, run: this.repository.getRun(run.id), proposal, duplicate: true };
    }
    if (run.status !== RESEARCH_STATUS.AWAITING_APPROVAL || proposal.status !== RESEARCH_STATUS.AWAITING_APPROVAL) {
      throw new RoomError('RESEARCH_INVALID_STATE', '这个提议已经处理过，不能再次批准或拒绝。', { status: run.status });
    }
    if (!Number.isInteger(input.expectedProposalRevision) || input.expectedProposalRevision !== proposal.proposalRevision) {
      throw new RoomError('REVISION_CONFLICT', '研究提议版本已经变化，请刷新后重新审批。', {
        expected: input.expectedProposalRevision,
        actual: proposal.proposalRevision,
      });
    }
    if (String(input.scopeDigest ?? '') !== proposal.scopeDigest) {
      throw new RoomError('RESEARCH_SCOPE_CHANGED', '批准的范围摘要与当前提议不一致，已拒绝；请重新打开提议。');
    }

    const approval = this.repository.transaction(() => {
      const record = this.repository.insertApproval({
        id: `approval_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        roomId: room.id,
        researchId: run.id,
        proposalId: proposal.id,
        proposalRevision: proposal.proposalRevision,
        scopeDigest: proposal.scopeDigest,
        decision,
        approvedBy: human.id,
        expiresAt: new Date(Date.now() + positiveInt(proposal.budget.maxWallClockMs, DEFAULT_BUDGET.maxWallClockMs)).toISOString(),
        channelRef: input.channelRef ?? 'authenticated-ui',
        auditRef: input.auditRef ?? null,
        idempotencyKey,
        scope: proposal.scope,
        budget: proposal.budget,
      });
      const updatedRun = this.repository.updateRun(run.id, {
        approvalId: record.id,
        status: decision === 'approved' ? RESEARCH_STATUS.APPROVED : RESEARCH_STATUS.REJECTED,
        pausedReason: decision === 'rejected' ? String(input.reason ?? '用户拒绝') : null,
        endedAt: decision === 'rejected' ? isoTimestamp() : null,
      });
      this.repository.updateProposal(proposal.id, { status: decision === 'approved' ? RESEARCH_STATUS.APPROVED : RESEARCH_STATUS.REJECTED });
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'research.approval_decided',
        payload: {
          researchId: run.id,
          proposalId: proposal.id,
          decision,
          approvedBy: human.id,
          scopeDigest: proposal.scopeDigest,
          reason: input.reason ?? null,
        },
      });
      return { approval: record, run: updatedRun };
    });
    this.rooms.publish(room.id, { type: 'research.changed', roomId: room.id, researchId: run.id });
    return { ...approval, proposal, duplicate: false };
  }

  /**
   * Replace a pending proposal with a new revision after the user changes scope
   * or budget. The old approval (if any) is revoked and can never be reused.
   * @param {object} input
   */
  async revise(input) {
    this.#requireEnabled();
    const run = this.repository.getRun(input.researchId);
    if (!run) throw new RoomError('RESEARCH_NOT_FOUND', `研究 ${input.researchId} 不存在。`);
    const proposal = this.repository.getProposal(run.proposalId);
    if (!proposal) throw new RoomError('RESEARCH_NOT_FOUND', '原研究提议不存在。');
    const room = this.rooms.assertWritable(proposal.roomId, '修改研究提议');
    const actor = this.rooms.requireMember(input.actorId);
    if (actor.kind !== 'human' && actor.role !== 'coordinator') {
      throw new RoomError('FORBIDDEN', '只有真实用户或主代理可以修改研究提议。');
    }
    if (![RESEARCH_STATUS.AWAITING_APPROVAL, RESEARCH_STATUS.REJECTED, RESEARCH_STATUS.APPROVED, RESEARCH_STATUS.PAUSED].includes(run.status)) {
      throw new RoomError('RESEARCH_INVALID_STATE', '只有待批准、已拒绝、已批准未启动或已暂停的提议可以修改。', { status: run.status });
    }
    const participants = this.#participants(room.id, input.participantPlan ?? run.participantIds);
    const scope = this.#scope(room, {
      allowedPaths: input.allowedPaths ?? proposal.scope.allowedPaths,
      excludedPaths: input.excludedPaths ?? proposal.scope.excludedPaths,
    });
    const budget = this.#budget(room, participants.length, { ...proposal.budget, ...(input.budget ?? {}) });
    const modelProfileRefs = await this.#modelRefs(participants, input.modelProfileRefs ?? proposal.scope.allowedModelProfileRefs ?? []);
    const revision = proposal.proposalRevision + 1;
    const newProposalInput = {
      roomId: room.id,
      researchId: run.id,
      sourceMessageId: proposal.sourceMessageId,
      requestedBy: actor.id,
      topic: proposal.topic,
      objective: proposal.objective,
      justification: proposal.justification,
      hypotheses: proposal.hypotheses,
      expectedArtifacts: proposal.expectedArtifacts,
      participantPlan: participants.map((member) => ({ memberId: member.id, displayName: member.displayName, role: member.role, kind: member.kind })),
      projectSnapshotRef: `room:${room.id}@plan:${room.planRevision}@updated:${room.updatedAt}`,
      scope: { ...scope, allowedModelProfileRefs: modelProfileRefs, allowedMemberIds: participants.map((member) => member.id) },
      budget,
      proposalRevision: revision,
      basePlanRevision: room.planRevision,
    };
    const scopeDigest = this.#digest(room.id, run.id, revision, newProposalInput);
    const result = this.repository.transaction(() => {
      this.repository.revokeApprovals(run.id, 'proposal revised');
      this.repository.updateProposal(proposal.id, { status: 'SUPERSEDED' });
      const created = this.repository.insertProposal({
        id: `proposal_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        ...newProposalInput,
        scopeDigest,
        idempotencyKey: `${proposal.idempotencyKey}:r${revision}`,
        status: RESEARCH_STATUS.AWAITING_APPROVAL,
      });
      const updated = this.repository.updateRun(run.id, {
        proposalId: created.id,
        approvalId: null,
        status: RESEARCH_STATUS.AWAITING_APPROVAL,
        currentPhase: 'proposal',
        basePlanRevision: room.planRevision,
        participantIds: participants.map((member) => member.id),
        pausedReason: null,
        endedAt: null,
      });
      this.store.appendEvent({
        roomId: room.id,
        eventType: 'research.proposed',
        payload: {
          researchId: run.id,
          proposalId: created.id,
          proposalRevision: revision,
          topic: created.topic,
          objective: created.objective,
          scopeDigest,
          participantIds: participants.map((member) => member.id),
          budget,
          revised: true,
        },
      });
      return { proposal: created, run: updated };
    });
    this.rooms.publish(room.id, { type: 'research.changed', roomId: room.id, researchId: run.id });
    return result;
  }

  /* ------------------------------------------------------------------ *
   * Run lifecycle
   * ------------------------------------------------------------------ */

  /**
   * APPROVED is not RUNNING. Start checks the persisted grant, frozen digest,
   * project revision and remaining budget before admitting anything.
   * @param {object} input
   */
  async start(input) {
    this.#requireEnabled();
    const run = this.#requireRun(input.researchId);
    const room = this.rooms.assertActive(run.roomId, '启动研究');
    if (run.status === RESEARCH_STATUS.RUNNING) return { run, duplicate: true };
    if (run.status !== RESEARCH_STATUS.APPROVED && run.status !== RESEARCH_STATUS.PAUSED) {
      throw new RoomError('RESEARCH_NOT_AUTHORIZED', '研究尚未获得批准，不能启动。', { status: run.status });
    }
    const proposal = this.repository.getProposal(run.proposalId);
    const approval = this.repository.getEffectiveApproval(run.id);
    if (!proposal || !approval) throw new RoomError('RESEARCH_NOT_AUTHORIZED', '没有有效的用户批准记录，不能启动研究。');
    this.#assertGrant(room, run, proposal, approval);
    if (!run.startedAt) {
      this.repository.insertBudget({
        researchId: run.id,
        maxCalls: approval.budget.maxModelCalls,
        maxTokens: approval.budget.maxTotalTokens,
        maxWallClockMs: approval.budget.maxWallClockMs,
        maxExperiments: approval.budget.maxExperimentRuns,
        maxParallelAgents: approval.budget.maxParallelAgents,
        startedAt: isoTimestamp(),
      });
    }
    const updated = this.repository.updateRun(run.id, {
      status: RESEARCH_STATUS.RUNNING,
      currentPhase: run.currentPhase === 'proposal' ? 'independent' : run.currentPhase,
      startedAt: run.startedAt ?? isoTimestamp(),
      endedAt: null,
      pausedReason: null,
    });
    const discussionId = `research-discussion-${run.id}`;
    if (!this.store.getDiscussion(discussionId)) {
      this.store.insertDiscussion({
        id: discussionId,
        roomId: room.id,
        topic: `深度研究：${proposal.topic}`,
        participants: run.participantIds,
        status: 'open',
      });
    }
    this.store.appendEvent({ roomId: room.id, eventType: 'research.started', payload: { researchId: run.id, approvalId: approval.id, discussionId } });
    this.rooms.publish(room.id, { type: 'research.changed', roomId: room.id, researchId: run.id });
    let kickoff = null;
    const dedicated = [];
    const hasLiveSessions = [...this.researchSessions.values()].some((entry) => entry.researchId === run.id);
    if (this.adapter?.createResearchSession && !hasLiveSessions) {
      for (const memberId of run.participantIds) {
        const member = this.store.getMember(memberId);
        if (!member || member.kind !== 'agent' || member.status === 'offline') continue;
        try {
          const effective = await this.models.effectiveFor(member);
          const profile = effective.profileRef ? await this.models.requireProfile(effective.profileRef) : null;
          const model = profile ? { providerRoute: profile.providerRoute, modelId: profile.modelId } : null;
          const created = await this.adapter.createResearchSession({
            researchId: run.id,
            memberId: member.id,
            roomId: room.id,
            cwd: room.workspaceRef ?? process.cwd(),
            model,
            personaInstructions: `你是本次深度研究的研究成员。只处理已批准的研究范围与预算；先独立提出假设，用 room_research_hypothesis 记录；实验和结论必须带真实证据。不要修改插件或 Harness 源码，不要启动新的研究。`,
            agentPreset: this.agentPreset,
            canAdmit: (sessionId) => this.#canAdmit(run.id, sessionId),
            guardTool: (exec) => this.guardResearchTool(run.id, exec),
          });
          this.researchSessions.set(created.sessionId, { researchId: run.id, memberId: member.id });
          this.repository.insertResearchSession({
            sessionId: created.sessionId,
            researchId: run.id,
            roomId: room.id,
            memberId: member.id,
            status: 'active',
          });
          dedicated.push({ memberId: member.id, sessionId: created.sessionId });
          await this.adapter.followupResearchSession(created.sessionId, this.#briefing(proposal, discussionId));
        } catch (error) {
          this.logger?.warn?.(`[project-room] dedicated research session failed for ${member.id}: ${error?.message ?? error}`);
        }
      }
    }
    try {
      kickoff = dedicated.length > 0 ? { sessions: dedicated } : await this.#kickoff(room, updated, proposal, discussionId);
    } catch (error) {
      this.logger?.warn?.(`[project-room] research kickoff failed: ${error?.message ?? error}`);
    }
    return { run: updated, kickoff, duplicate: false, sessions: dedicated };
  }

  /**
   * Resolve a tool caller that belongs to a dedicated research session, without
   * inventing a normal room member row.
   * @param {string} sessionId
   */
  sessionActor(sessionId) {
    const entry = this.researchSessions.get(sessionId);
    return entry ? this.store.getMember(entry.memberId) : null;
  }

  /**
   * Synchronous tool guard for a dedicated research session. This is policy-level
   * denial before dispatch, not an OS sandbox. File writes must stay inside the
   * approved paths; shell execution is denied in the B prototype until a real
   * command/path sandbox and receipt are proven.
   * @param {string} researchId
   * @param {{ name?: string, arguments?: object }} exec
   * @returns {string | undefined}
   */
  guardResearchTool(researchId, exec) {
    const run = this.repository.getRun(researchId);
    if (!run) return '研究不存在';
    if (run.status !== RESEARCH_STATUS.RUNNING) return '研究未处于 RUNNING 状态';
    const proposal = this.repository.getProposal(run.proposalId);
    if (!proposal) return '研究提议不存在';
    const name = String(exec?.name ?? '');
    if (name.startsWith('room_') && !name.startsWith('room_research_')) {
      return '研究会话不能使用普通群工具';
    }
    if (['pwsh', 'bash', 'shell', 'exec', 'run_code'].includes(name)) {
      return '受监督原型研究会话暂不执行 shell；实验需走受监督的 A+ 模式或宿主沙箱';
    }
    if (['write', 'edit', 'str_replace_editor', 'str-replace-editor', 'apply_patch'].includes(name)) {
      const args = exec?.arguments ?? {};
      const raw = args.path ?? args.file_path ?? args.filePath ?? args.target;
      if (typeof raw !== 'string' || !raw.trim()) return '写入工具缺少可核验的路径';
      // Resolve through the real filesystem: a symlink or junction inside the
      // workspace that points outside is refused here even though its text
      // prefix looks contained. This is policy-level denial, not an OS sandbox.
      const resolved = resolveInside(proposal.scope.workspaceRoot, raw);
      if (!resolved.ok) return `研究写入越出批准范围（链接解析后位于 ${resolved.root} 之外）：${raw}`;
      const target = resolved.realPath;
      const allowed = (proposal.scope.allowedPaths ?? []).some((path) => isInside(path, target));
      if (!allowed) return `研究写入越出批准范围：${raw}`;
      const excluded = (proposal.scope.excludedPaths ?? []).some((path) => isInside(path, target));
      if (excluded) return `研究写入落在排除范围内：${raw}`;
    }
    return undefined;
  }

  /** Synchronous pre-call gate for the dedicated session's agent/pre-step. */
  #canAdmit(researchId, sessionId = null) {
    try {
      if (this.activeResearchTurns.has(researchId)) return false;
      const run = this.repository.getRun(researchId);
      if (!run || run.status !== RESEARCH_STATUS.RUNNING) return false;
      const room = this.rooms.requireRoom(run.roomId);
      if (room.status !== 'active') return false;
      const proposal = this.repository.getProposal(run.proposalId);
      const approval = this.repository.getEffectiveApproval(run.id);
      if (!proposal || !approval) return false;
      if (room.planRevision !== run.basePlanRevision) return false;
      const budget = this.repository.getBudget(run.id);
      if (budget && (budget.usedCalls >= budget.maxCalls || budget.usedTokens >= budget.maxTokens)) return false;
      // Serialize research turns until the usage receipt arrives. The host does
      // not expose a per-request budget reservation token, so letting two
      // dedicated sessions pass this check concurrently would allow an overshoot.
      this.activeResearchTurns.add(researchId);
      return true;
    } catch {
      return false;
    }
  }

  /** @param {object} input */
  pause(input) {
    const run = this.#requireRun(input.researchId);
    if (run.status !== RESEARCH_STATUS.RUNNING) {
      throw new RoomError('RESEARCH_INVALID_STATE', '只有运行中的研究可以暂停。', { status: run.status });
    }
    const updated = this.repository.updateRun(run.id, {
      status: RESEARCH_STATUS.PAUSED,
      pausedReason: String(input.reason ?? '用户暂停'),
    });
    this.adapter?.cancelResearchSessions?.(run.id);
    this.activeResearchTurns.delete(run.id);
    this.store.appendEvent({ roomId: run.roomId, eventType: 'research.paused', payload: { researchId: run.id, reason: input.reason ?? null, by: input.actorId ?? null } });
    this.rooms.publish(run.roomId, { type: 'research.changed', roomId: run.roomId, researchId: run.id });
    return { run: updated };
  }

  /**
   * On process start, a RUNNING research cannot be trusted to continue by itself.
   * Move it to PAUSED_RECONCILE and force a human check of sessions, budgets and
   * side effects. This is deliberately not an automatic resume.
   * @returns {{ recovered: number }}
   */
  recoverStaleRuns() {
    const runs = this.repository.listRunsByStatuses([RESEARCH_STATUS.RUNNING]);
    for (const run of runs) {
      this.repository.updateRun(run.id, {
        status: RESEARCH_STATUS.PAUSED_RECONCILE,
        pausedReason: 'PROCESS_RESTART',
      });
      this.repository.markResearchSessions(run.id, 'stale');
      this.activeResearchTurns.delete(run.id);
      this.store.appendEvent({
        roomId: run.roomId,
        eventType: 'research.paused',
        payload: { researchId: run.id, reason: 'PROCESS_RESTART', reconcile: true },
      });
    }
    if (runs.length > 0) this.logger?.warn?.(`[project-room] ${runs.length} research run(s) require reconciliation after restart`);
    return { recovered: runs.length };
  }

  /**
   * A human confirms the post-restart state. Only then does the run return to
   * PAUSED; an explicit start/resume is still required afterwards.
   * @param {object} input
   */
  reconcile(input) {
    const run = this.#requireRun(input.researchId);
    const room = this.rooms.assertActive(run.roomId, '核对研究');
    if (run.status !== RESEARCH_STATUS.PAUSED_RECONCILE) {
      throw new RoomError('RESEARCH_INVALID_STATE', '只有重启后待核对的研究可以确认。', { status: run.status });
    }
    this.#requireSingleHuman(room.id, input.actorId);
    const updated = this.repository.updateRun(run.id, {
      status: RESEARCH_STATUS.PAUSED,
      pausedReason: 'RECONCILED_BY_HUMAN',
    });
    this.store.appendEvent({
      roomId: run.roomId,
      eventType: 'research.paused',
      payload: { researchId: run.id, reason: 'RECONCILED_BY_HUMAN', by: input.actorId },
    });
    this.rooms.publish(run.roomId, { type: 'research.changed', roomId: run.roomId, researchId: run.id });
    return { run: updated };
  }

  /** @param {object} input */
  resume(input) {
    const run = this.#requireRun(input.researchId);
    const room = this.rooms.assertActive(run.roomId, '恢复研究');
    if (run.status !== RESEARCH_STATUS.PAUSED) {
      throw new RoomError('RESEARCH_INVALID_STATE', '只有已暂停的研究可以恢复。', { status: run.status });
    }
    const proposal = this.repository.getProposal(run.proposalId);
    const approval = this.repository.getEffectiveApproval(run.id);
    if (!proposal || !approval) throw new RoomError('RESEARCH_NOT_AUTHORIZED', '批准已失效，不能恢复；请重新提议并审批。');
    this.#assertGrant(room, run, proposal, approval);
    const updated = this.repository.updateRun(run.id, { status: RESEARCH_STATUS.RUNNING, pausedReason: null });
    this.store.appendEvent({ roomId: run.roomId, eventType: 'research.started', payload: { researchId: run.id, resumed: true } });
    this.rooms.publish(run.roomId, { type: 'research.changed', roomId: run.roomId, researchId: run.id });
    return { run: updated };
  }

  /** @param {object} input */
  stop(input) {
    const run = this.#requireRun(input.researchId);
    if ([RESEARCH_STATUS.COMPLETED, RESEARCH_STATUS.STOPPED, RESEARCH_STATUS.REJECTED, RESEARCH_STATUS.CANCELLED].includes(run.status)) {
      return { run, duplicate: true };
    }
    const updated = this.repository.updateRun(run.id, {
      status: RESEARCH_STATUS.STOPPED,
      pausedReason: String(input.reason ?? '用户停止'),
      endedAt: isoTimestamp(),
    });
    this.adapter?.cancelResearchSessions?.(run.id);
    this.repository.markResearchSessions(run.id, 'disposed');
    this.#disposeDedicatedSessions(run.id);
    this.activeResearchTurns.delete(run.id);
    this.#closeDiscussion(run.id, 'closed');
    this.repository.revokeApprovals(run.id, 'research stopped');
    this.store.appendEvent({ roomId: run.roomId, eventType: 'research.stopped', payload: { researchId: run.id, reason: input.reason ?? null, by: input.actorId ?? null } });
    this.rooms.publish(run.roomId, { type: 'research.changed', roomId: run.roomId, researchId: run.id });
    return { run: updated };
  }

  /**
   * Stop or pause research when the project lifecycle changes. Archive/trash
   * revokes the grant; a restore must require a fresh human approval.
   * @param {string} roomId
   * @param {'pause'|'archive'|'trash'} mode
   * @param {string} [reason]
   */
  suspendForLifecycle(roomId, mode, reason = 'project lifecycle changed') {
    const runs = this.repository.listRuns(roomId, { statuses: [RESEARCH_STATUS.AWAITING_APPROVAL, RESEARCH_STATUS.APPROVED, RESEARCH_STATUS.RUNNING, RESEARCH_STATUS.PAUSED] });
    for (const run of runs) {
      const terminal = mode === 'archive' || mode === 'trash';
      this.repository.updateRun(run.id, {
        status: terminal ? RESEARCH_STATUS.STOPPED : RESEARCH_STATUS.PAUSED,
        pausedReason: reason,
        endedAt: terminal ? isoTimestamp() : run.endedAt,
      });
      if (terminal) {
        this.repository.revokeApprovals(run.id, reason);
        this.repository.markResearchSessions(run.id, 'disposed');
        this.#disposeDedicatedSessions(run.id);
        this.activeResearchTurns.delete(run.id);
        this.#closeDiscussion(run.id, 'closed');
      }
      this.store.appendEvent({
        roomId,
        eventType: terminal ? 'research.stopped' : 'research.paused',
        payload: { researchId: run.id, reason, lifecycle: mode },
      });
    }
    return { affected: runs.length };
  }

  /* ------------------------------------------------------------------ *
   * Evidence and budgeted execution
   * ------------------------------------------------------------------ */

  /** @param {object} input */
  hypothesis(input) {
    const { run, member } = this.#activeMember(input.researchId, input.actorId);
    const claim = String(input.claim ?? '').trim();
    if (!claim) throw new RoomError('INVALID_REQUEST', '假设需要 claim。');
    const hypothesis = this.repository.insertHypothesis({
      id: `hyp_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      researchId: run.id,
      authorMemberId: member.id,
      claim,
      predictedEffect: input.predictedEffect ?? '',
      falsificationTest: input.falsificationTest ?? '',
      evidenceRefs: input.evidenceRefs ?? [],
    });
    this.store.appendEvent({
      roomId: run.roomId,
      eventType: 'research.hypothesis_recorded',
      payload: { researchId: run.id, hypothesisId: hypothesis.id, authorMemberId: member.id, claim },
    });
    this.#maybeAdvanceToReview(run);
    return { hypothesis, run };
  }

  /**
   * Reserve one experiment slot before writing the record. The reservation is
   * committed only after the record exists, so a crash leaves a visible
   * reservation rather than a silent extra experiment.
   * @param {object} input
   */
  experiment(input) {
    const { run, member } = this.#activeMember(input.researchId, input.actorId);
    const idempotencyKey = String(input.idempotencyKey ?? `experiment:${run.id}:${randomUUID()}`);
    const { entry } = this.reserveStep({
      researchId: run.id,
      actorId: member.id,
      kind: 'experiment',
      idempotencyKey,
      detail: { hypothesisId: input.hypothesisId ?? null },
    });
    try {
      const experiment = this.repository.insertExperiment({
        id: `exp_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        researchId: run.id,
        hypothesisId: input.hypothesisId ?? null,
        ownerId: member.id,
        attemptId: input.attemptId ?? null,
        baselineCommit: input.baselineCommit ?? null,
        candidateCommit: input.candidateCommit ?? null,
        environmentRef: input.environmentRef ?? null,
        commandRefs: input.commandRefs ?? [],
        metrics: input.metrics ?? {},
        artifactRefs: input.artifactRefs ?? [],
        state: 'recorded',
      });
      this.#advancePhase(run, 'experiment', { experimentId: experiment.id });
      const committed = this.repository.commitBudget(entry.id);
      this.store.appendEvent({
        roomId: run.roomId,
        eventType: 'research.experiment_recorded',
        payload: { researchId: run.id, experimentId: experiment.id, ownerId: member.id, state: experiment.state },
      });
      return { experiment, run, budget: committed.budget };
    } catch (error) {
      try {
        this.repository.releaseBudget(entry.id);
      } catch {
        /* releasing a reservation is best-effort; the record is already failed */
      }
      throw error;
    }
  }

  /** @param {object} input */
  finding(input) {
    const { run, member } = this.#activeMember(input.researchId, input.actorId);
    const issue = String(input.issue ?? '').trim();
    if (!issue) throw new RoomError('INVALID_REQUEST', '发现需要 issue。');
    const level = String(input.evidenceLevel ?? 'unverified');
    if (!['fact', 'reproducible', 'hypothesis', 'unverified'].includes(level)) {
      throw new RoomError('INVALID_REQUEST', `未知证据级别：${level}。`);
    }
    const finding = this.repository.insertFinding({
      id: `finding_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      researchId: run.id,
      issue,
      evidenceLevel: level,
      supportingRefs: input.supportingRefs ?? [],
      counterRefs: input.counterRefs ?? [],
      recommendation: input.recommendation ?? '',
      uncertainty: input.uncertainty ?? '',
    });
    this.store.appendEvent({
      roomId: run.roomId,
      eventType: 'research.finding_recorded',
      payload: { researchId: run.id, findingId: finding.id, evidenceLevel: level, by: member.id },
    });
    this.#advancePhase(run, 'converge', { findingId: finding.id });
    return { finding, run };
  }

  /**
   * Close a research run with an honest conclusion. `improved` requires
   * reproducible regression evidence; a discussion or a confidence statement is
   * not evidence.
   * @param {object} input
   */
  complete(input) {
    const run = this.#requireRun(input.researchId);
    const room = this.rooms.assertWritable(run.roomId, '结束研究');
    if (![RESEARCH_STATUS.RUNNING, RESEARCH_STATUS.PAUSED, RESEARCH_STATUS.APPROVED].includes(run.status)) {
      throw new RoomError('RESEARCH_INVALID_STATE', '只有进行中、暂停或已批准的研究可以结束。', { status: run.status });
    }
    const decision = String(input.decision ?? '');
    if (!RESEARCH_CONCLUSIONS.has(decision)) {
      throw new RoomError('INVALID_REQUEST', `无效研究结论：${decision || '(空)'}。`);
    }
    const baseline = (input.baselineEvidenceRefs ?? []).filter(Boolean);
    const regression = (input.regressionEvidenceRefs ?? []).filter(Boolean);
    if (decision === 'improved' && (baseline.length === 0 || regression.length === 0)) {
      throw new RoomError('INVALID_REQUEST', 'improved 结论必须同时提供基线证据和回归证据。');
    }
    const outcome = this.repository.transaction(() => {
      const record = this.repository.upsertOutcome({
        researchId: run.id,
        decision,
        chosenCandidateRef: input.chosenCandidateRef ?? null,
        baselineEvidenceRefs: baseline,
        regressionEvidenceRefs: regression,
        remainingRisks: input.remainingRisks ?? [],
        integratedTaskRevision: input.integratedTaskRevision ?? null,
        acceptedBy: input.acceptedBy ?? null,
      });
      const updated = this.repository.updateRun(run.id, {
        status: RESEARCH_STATUS.COMPLETED,
        currentPhase: 'completed',
        conclusion: decision,
        outcome: record,
        endedAt: isoTimestamp(),
      });
      this.#closeDiscussion(run.id, 'closed');
      this.repository.revokeApprovals(run.id, 'research completed');
      this.repository.markResearchSessions(run.id, 'disposed');
      this.#disposeDedicatedSessions(run.id);
      this.activeResearchTurns.delete(run.id);
      if (input.reusableLesson) {
        this.repository.insertExperience({
          id: `exp_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          sourceResearchId: run.id,
          reusableLesson: String(input.reusableLesson),
          applicability: String(input.applicability ?? ''),
          pitfalls: String(input.pitfalls ?? ''),
          evidenceRefs: [...baseline, ...regression],
          reviewStatus: 'draft',
        });
      }
      this.store.appendEvent({
        roomId: run.roomId,
        eventType: 'research.completed',
        payload: { researchId: run.id, decision, chosenCandidateRef: record.chosenCandidateRef, acceptedBy: record.acceptedBy },
      });
      return { outcome: record, run: updated };
    });
    this.rooms.publish(room.id, { type: 'research.changed', roomId: room.id, researchId: run.id });
    return outcome;
  }

  /**
   * Flow a completed research outcome back into the project ledgers. The
   * coordinator writes a Decision sourced from the kickoff/source message; an
   * `improved` result also creates one integration Task, never an automatic
   * merge or deploy. The operation is idempotent through `research_flowback`.
   * @param {object} input
   */
  async flowBack(input) {
    const run = this.#requireRun(input.researchId);
    const room = this.rooms.assertActive(run.roomId, '研究回流');
    if (run.status !== RESEARCH_STATUS.COMPLETED) {
      throw new RoomError('RESEARCH_INVALID_STATE', '只有已完成的研究可以回流到项目。', { status: run.status });
    }
    const actor = this.rooms.requireMember(input.actorId);
    if (actor.roomId !== room.id || actor.role !== 'coordinator') {
      throw new RoomError('FORBIDDEN', '只有本项目的主代理可以把研究结论回流到项目。', { memberId: actor.id });
    }
    const existing = this.repository.getFlowback(run.id);
    if (existing) {
      return {
        flowback: existing,
        decision: existing.decisionId ? this.store.getDecision(existing.decisionId) : null,
        task: existing.taskId ? this.store.getTask(existing.taskId) : null,
        duplicate: true,
      };
    }
    const outcome = this.repository.getOutcome(run.id);
    if (!outcome) throw new RoomError('RESEARCH_NOT_FOUND', '研究结论记录缺失，不能回流。');
    const proposal = this.repository.getProposal(run.proposalId);
    const source = proposal?.sourceMessageId
      ? this.store.getMessage(proposal.sourceMessageId)
      : this.store.findMessageByClientKey(room.id, actor.id, `research-kickoff-${run.id}`);
    if (!source) {
      throw new RoomError('INVALID_REQUEST', '研究回流需要一条真实来源消息（提议来源或启动说明）。');
    }
    const conclusion = outcome.decision;
    const label = { improved: '有可验证提升', no_change: '保持不变更合适', inconclusive: '证据不足，无法结论', rejected_candidate: '候选被否决' }[conclusion] ?? conclusion;
    const decision = await this.decisions.propose({
      roomId: room.id,
      actorId: actor.id,
      sourceMessageId: source.id,
      scope: 'research',
      statement: `研究「${proposal?.topic ?? run.id}」结论：${label}。${outcome.chosenCandidateRef ? `候选：${outcome.chosenCandidateRef}。` : ''}${outcome.remainingRisks?.length ? `剩余风险：${outcome.remainingRisks.join('；')}。` : ''}`,
      affectedTaskIds: [],
      accept: true,
      supersedes: null,
    });
    let task = null;
    let artifact = null;
    if (conclusion === 'improved') {
      task = this.tasks.propose({
        roomId: room.id,
        actorId: actor.id,
        objective: `按研究结论实施候选：${proposal?.topic ?? run.id}`,
        suggestedOwnerId: actor.id,
        requiredRole: 'coordinator',
        deliverables: ['候选变更或方案落地', '基线与回归证据'],
        acceptance: ['按研究结论完成集成', '在集成结果上运行适用回归测试并保留证据'],
        sourceMessageId: source.id,
      });
      this.repository.linkTask({ researchId: run.id, taskId: task.id, kind: 'integration' });
    }
    // The report itself is an evidence index, not a copy of user source. Keep it
    // unverified: the plugin did not execute the experiments or verify the files.
    artifact = this.store.insertArtifact({
      id: `artifact_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      roomId: room.id,
      taskId: task?.id ?? null,
      attemptId: null,
      kind: 'research-report',
      location: `research:${run.id}`,
      contentHash: null,
      evidenceRef: source.id,
      verified: false,
    });
    const flowback = this.repository.insertFlowback({
      researchId: run.id,
      decisionId: decision.id,
      taskId: task?.id ?? null,
    });
    if (task) {
      this.repository.upsertOutcome({
        ...outcome,
        integratedTaskRevision: task.revision,
        acceptedBy: actor.id,
      });
    }
    this.store.appendEvent({
      roomId: room.id,
      eventType: 'research.flowed_back',
      payload: { researchId: run.id, decisionId: decision.id, taskId: task?.id ?? null, conclusion },
    });
    this.rooms.publish(room.id, { type: 'research.changed', roomId: room.id, researchId: run.id });
    return { flowback, decision, task, artifact, duplicate: false };
  }

  /**
   * Gate used by experiment admission and any future research step. It checks
   * the persisted grant, frozen scope digest, project version and remaining
   * budget before reserving capacity.
   * @param {object} input
   */
  reserveStep(input) {
    const run = this.#requireRun(input.researchId);
    const room = this.rooms.assertActive(run.roomId, '研究准入');
    if (run.status !== RESEARCH_STATUS.RUNNING) {
      throw new RoomError('RESEARCH_NOT_AUTHORIZED', '研究未处于 RUNNING 状态，已拒绝新准入。', { status: run.status });
    }
    const proposal = this.repository.getProposal(run.proposalId);
    const approval = this.repository.getEffectiveApproval(run.id);
    if (!proposal || !approval) throw new RoomError('RESEARCH_NOT_AUTHORIZED', '没有有效的用户批准记录，已拒绝研究准入。');
    this.#assertGrant(room, run, proposal, approval);
    const member = this.rooms.requireMember(input.actorId);
    if (!run.participantIds.includes(member.id)) {
      throw new RoomError('RESEARCH_OUT_OF_SCOPE', '该成员不在本次研究批准名单中。', { memberId: member.id });
    }
    const kind = input.kind === 'experiment' ? 'experiment' : 'model';
    const calls = kind === 'model' ? positiveInt(input.calls, 1) : 0;
    const tokens = positiveInt(input.tokens, 0);
    const result = this.repository.reserveBudget({
      researchId: run.id,
      kind,
      calls,
      tokens,
      idempotencyKey: String(input.idempotencyKey ?? `step:${run.id}:${randomUUID()}`),
      detail: input.detail ?? null,
    });
    return { ...result, run, approval };
  }

  /** @param {string} reservationId */
  commitStep(reservationId) {
    return this.repository.commitBudget(reservationId);
  }

  /** @param {string} reservationId */
  releaseStep(reservationId) {
    return this.repository.releaseBudget(reservationId);
  }

  /**
   * Usage settlement hook. It counts real model calls for an active run so a
   * budget overrun pauses the run immediately; it cannot un-spend an already
   * completed provider call.
   * @param {{ memberId: string, roomId: string, usage?: object }} input
   */
  recordModelUsage(input) {
    if (!this.enabled || !input?.memberId) return null;
    const runs = input.researchId ? [this.repository.getRun(input.researchId)].filter(Boolean) : this.repository.listActiveRunsForMember(input.memberId);
    if (runs.length === 0) return null;
    const run = runs[0];
    const budget = this.repository.recordUsage(run.id, { calls: 1, tokens: tokensOf(input.usage) });
    this.activeResearchTurns.delete(run.id);
    if (!budget) return null;
    if (budget.usedCalls >= budget.maxCalls || budget.usedTokens >= budget.maxTokens) {
      this.repository.updateRun(run.id, { status: RESEARCH_STATUS.PAUSED, pausedReason: 'RESEARCH_BUDGET_EXCEEDED' });
      this.store.appendEvent({
        roomId: run.roomId,
        eventType: 'research.paused',
        payload: { researchId: run.id, reason: 'RESEARCH_BUDGET_EXCEEDED', usedCalls: budget.usedCalls, usedTokens: budget.usedTokens },
      });
    }
    return { runId: run.id, budget };
  }

  /* ------------------------------------------------------------------ *
   * Read model
   * ------------------------------------------------------------------ */

  /** @param {string} roomId */
  summary(roomId) {
    if (!this.enabled) return { enabled: false };
    const proposals = this.repository.listProposals(roomId, { limit: 20 });
    const runs = this.repository.listRuns(roomId, { limit: 20 });
    const pending = proposals.find((proposal) => proposal.status === RESEARCH_STATUS.AWAITING_APPROVAL) ?? null;
    const latestRun = runs[0] ?? null;
    const proposal = pending ?? (latestRun ? this.repository.getProposal(latestRun.proposalId) : proposals[0] ?? null);
    const approval = latestRun ? this.repository.getEffectiveApproval(latestRun.id) : null;
    const budget = latestRun ? this.repository.getBudget(latestRun.id) : null;
    return {
      enabled: true,
      pending,
      proposal,
      run: latestRun,
      approval,
      budget,
      hypotheses: latestRun ? this.repository.listHypotheses(latestRun.id) : [],
      experiments: latestRun ? this.repository.listExperiments(latestRun.id) : [],
      findings: latestRun ? this.repository.listFindings(latestRun.id) : [],
      outcome: latestRun ? this.repository.getOutcome(latestRun.id) : null,
      flowback: latestRun ? this.repository.getFlowback(latestRun.id) : null,
      discussion: latestRun ? this.store.getDiscussion(`research-discussion-${latestRun.id}`) : null,
      sessions: latestRun ? this.repository.listResearchSessions(latestRun.id) : [],
      experience: this.repository.listExperienceForRoom(roomId),
      history: { proposals: proposals.slice(0, 8), runs: runs.slice(0, 8) },
    };
  }

  /** @param {string} roomId */
  listExperience(roomId) {
    // Experience is project-scoped by default; cross-project retrieval requires a
    // separate explicit scope and is not exposed here.
    return this.repository.listExperienceForRoom(roomId, 50);
  }

  /** Session ownership history for one project (read-only). */
  listSessions(roomId) {
    return this.repository.listResearchSessionsForRoom(roomId);
  }

  /* ------------------------------------------------------------------ *
   * Internals
   * ------------------------------------------------------------------ */

  #requireEnabled() {
    if (!this.enabled) throw new RoomError('RESEARCH_DISABLED', '深度研究功能未启用。');
  }

  /**
   * The plugin has no host-provided authenticated user identity. Until it does,
   * only a genuinely single-human project may approve/pause/stop research; a
   * multi-human project fails closed rather than treating the first human as the
   * authenticated approver.
   */
  #requireSingleHuman(roomId, actorId) {
    const actor = this.rooms.requireMember(actorId);
    if (actor.kind !== 'human' || actor.roomId !== roomId) {
      throw new RoomError('FORBIDDEN', '研究审批必须来自这个项目群的真实人类成员。', { actorId });
    }
    const humans = this.store.listMembers(roomId).filter((member) => member.kind === 'human');
    if (humans.length !== 1) {
      throw new RoomError('FORBIDDEN', '当前项目有多个活跃人类成员，无法验证具体审批人；多人类审批已停用。', {
        humans: humans.map((member) => member.id),
      });
    }
    return actor;
  }

  /** Record a phase transition once; a repeated evidence call is not a new phase. */
  #advancePhase(run, phase, detail = {}) {
    if (!RESEARCH_PHASES.has(phase) || run.currentPhase === phase) return;
    this.repository.updateRun(run.id, { currentPhase: phase });
    this.store.appendEvent({
      roomId: run.roomId,
      eventType: 'research.phase_changed',
      payload: { researchId: run.id, from: run.currentPhase, to: phase, ...detail },
    });
  }

  /**
   * The independent-proposal phase ends only when every approved agent has
   * contributed at least one hypothesis. One member submitting twice does not
   * fake a second independent proposal.
   */
  #maybeAdvanceToReview(run) {
    if (run.currentPhase !== 'independent') return;
    const agents = run.participantIds
      .map((memberId) => this.store.getMember(memberId))
      .filter((member) => member?.kind === 'agent');
    if (agents.length === 0) return;
    const authors = new Set(this.repository.listHypotheses(run.id).map((entry) => entry.authorMemberId));
    if (agents.every((member) => authors.has(member.id))) {
      this.#advancePhase(run, 'review', { participants: agents.length, hypotheses: authors.size });
    }
  }

  /** Close the research discussion when the run reaches a terminal state. */
  #closeDiscussion(researchId, status) {
    const discussionId = `research-discussion-${researchId}`;
    if (this.store.getDiscussion(discussionId)) this.store.updateDiscussion(discussionId, { status });
  }

  /**
   * Dispose the dedicated research sessions of a terminal run. The receipt is
   * asynchronous (the host owns the handle), but the run state is already
   * durable; a failed dispose stays visible through the live session map and the
   * ownership ledger, so a purge reports it instead of claiming success.
   * @param {string} researchId
   */
  #disposeDedicatedSessions(researchId) {
    const pending = this.adapter?.disposeResearchSessions?.(researchId);
    if (pending && typeof pending.catch === 'function') {
      pending.catch((error) => this.logger?.warn?.(`[project-room] research session dispose failed for ${researchId}: ${error?.message ?? error}`));
    }
  }

  /** @param {string} researchId */
  #requireRun(researchId) {
    const run = this.repository.getRun(researchId);
    if (!run) throw new RoomError('RESEARCH_NOT_FOUND', `研究 ${researchId} 不存在。`);
    return run;
  }

  /** @param {string} researchId @param {string} actorId */
  #activeMember(researchId, actorId) {
    const run = this.#requireRun(researchId);
    const member = this.rooms.requireMember(actorId);
    if (run.status !== RESEARCH_STATUS.RUNNING) {
      throw new RoomError('RESEARCH_NOT_AUTHORIZED', '研究未处于 RUNNING 状态，已拒绝该操作。', { status: run.status });
    }
    if (!run.participantIds.includes(member.id)) {
      throw new RoomError('RESEARCH_OUT_OF_SCOPE', '该成员不在本次研究批准名单中。', { memberId: member.id });
    }
    return { run, member };
  }

  /**
   * @param {object} room
   * @param {object} run
   * @param {object} proposal
   * @param {object} approval
   */
  #assertGrant(room, run, proposal, approval) {
    if (approval.scopeDigest !== proposal.scopeDigest) {
      throw new RoomError('RESEARCH_SCOPE_CHANGED', '研究范围已经变化，批准失效；请重新审批。');
    }
    if (approval.revokedAt) {
      throw new RoomError('RESEARCH_NOT_AUTHORIZED', '研究批准已撤销，不能继续。');
    }
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
      this.repository.updateRun(run.id, { status: RESEARCH_STATUS.EXPIRED, pausedReason: 'APPROVAL_EXPIRED' });
      throw new RoomError('RESEARCH_NOT_AUTHORIZED', '研究批准已过期，请重新审批。');
    }
    if (room.planRevision !== run.basePlanRevision) {
      this.repository.updateRun(run.id, { status: RESEARCH_STATUS.PAUSED, pausedReason: 'RESEARCH_PROJECT_VERSION_CHANGED' });
      throw new RoomError('RESEARCH_PROJECT_VERSION_CHANGED', '项目计划版本已经变化，研究已暂停并要求重新核对范围。');
    }
    const budget = this.repository.getBudget(run.id);
    if (budget && budget.usedCalls >= budget.maxCalls) {
      this.repository.updateRun(run.id, { status: RESEARCH_STATUS.PAUSED, pausedReason: 'RESEARCH_BUDGET_EXCEEDED' });
      throw new RoomError('RESEARCH_BUDGET_EXCEEDED', '研究调用预算已经用尽，已暂停。');
    }
  }

  /** @param {object} room @param {object} input */
  #scope(room, input) {
    const workspace = room.workspaceRef ? resolve(room.workspaceRef) : null;
    if (!workspace) throw new RoomError('RESEARCH_OUT_OF_SCOPE', '项目没有登记工作区，不能开展深度研究。');
    const workspaceReal = existsSync(workspace) ? realpathSync(workspace) : workspace;
    for (const protectedRoot of this.protectedRoots) {
      const realProtected = existsSync(protectedRoot) ? realpathSync(protectedRoot) : protectedRoot;
      if (isInside(realProtected, workspaceReal)) {
        throw new RoomError('RESEARCH_OUT_OF_SCOPE', '项目工作区位于插件或 Harness 源码内，禁止在该项目开展深度研究。', {
          workspace,
          protectedRoot,
        });
      }
    }
    const allowedPaths = (input.allowedPaths ?? []).map((entry) => this.#insidePath(workspaceReal, entry, 'allowedPaths'));
    const excludedPaths = (input.excludedPaths ?? []).map((entry) => this.#insidePath(workspaceReal, entry, 'excludedPaths'));
    if (allowedPaths.length === 0) throw new RoomError('INVALID_REQUEST', '研究范围至少需要一个 allowedPaths。');
    for (const path of allowedPaths) {
      for (const protectedRoot of this.protectedRoots) {
        const realProtected = existsSync(protectedRoot) ? realpathSync(protectedRoot) : protectedRoot;
        if (isInside(realProtected, path) || isInside(path, realProtected)) {
          throw new RoomError('RESEARCH_OUT_OF_SCOPE', '研究范围包含插件或 Harness 受保护路径，已拒绝。', { path, protectedRoot });
        }
      }
    }
    return {
      workspaceRoot: workspaceReal,
      allowedPaths,
      excludedPaths,
      allowedActions: ['read', 'test', 'experiment', 'candidate-patch'],
    };
  }

  /** @param {string} workspace @param {string} entry @param {string} field */
  #insidePath(workspace, entry, field) {
    if (typeof entry !== 'string' || !entry.trim()) throw new RoomError('INVALID_REQUEST', `${field} 包含空路径。`);
    const absolute = resolve(workspace, entry);
    const real = existsSync(absolute) ? realpathSync(absolute) : absolute;
    if (!isInside(workspace, real)) {
      throw new RoomError('RESEARCH_OUT_OF_SCOPE', `研究路径越出项目工作区：${entry}。`, { field, path: absolute, workspace });
    }
    return real;
  }

  /** @param {object} room @param {number} participantCount @param {object} [input] */
  #budget(room, participantCount, input = {}) {
    const merged = { ...this.budgetDefaults, ...(input ?? {}) };
    const budget = {
      maxModelCalls: positiveInt(merged.maxModelCalls, DEFAULT_BUDGET.maxModelCalls),
      maxTotalTokens: positiveInt(merged.maxTotalTokens, DEFAULT_BUDGET.maxTotalTokens),
      maxWallClockMs: positiveInt(merged.maxWallClockMs, DEFAULT_BUDGET.maxWallClockMs),
      maxExperimentRuns: positiveInt(merged.maxExperimentRuns, DEFAULT_BUDGET.maxExperimentRuns),
      maxParallelAgents: positiveInt(merged.maxParallelAgents, Math.min(3, participantCount || 1)),
    };
    budget.maxParallelAgents = Math.min(budget.maxParallelAgents, Math.max(1, participantCount));
    if (budget.maxModelCalls > 1000 || budget.maxTotalTokens > 10_000_000 || budget.maxWallClockMs > 7 * 24 * 3600_000) {
      throw new RoomError('INVALID_REQUEST', '研究预算超出单次研究的硬上限；请拆分提议，不能一次批准无限预算。');
    }
    return budget;
  }

  /** @param {string} roomId @param {string[]} ids */
  #participants(roomId, ids) {
    const unique = [...new Set((ids ?? []).map((entry) => (typeof entry === 'object' ? entry.memberId : entry)).filter(Boolean))];
    if (unique.length === 0) throw new RoomError('INVALID_REQUEST', '研究提议至少需要一位参与成员。');
    const members = unique.map((id) => this.rooms.requireMember(id));
    for (const member of members) {
      if (member.roomId !== roomId) throw new RoomError('NOT_A_ROOM_MEMBER', `成员 ${member.id} 不属于这个项目群。`);
      if (member.status === 'offline') throw new RoomError('MEMBER_UNAVAILABLE', `成员 ${member.displayName} 已离线，不能加入研究。`);
    }
    return members;
  }

  /** @param {object[]} participants @param {string[]} refs */
  async #modelRefs(participants, refs) {
    const explicit = [...new Set((refs ?? []).filter(Boolean))];
    if (explicit.length > 0) {
      for (const ref of explicit) await this.models.requireProfile(ref);
      return explicit;
    }
    return [...new Set(participants.map((member) => member.modelProfileRef).filter(Boolean))];
  }

  /** @param {string} roomId @param {string} researchId @param {number} revision @param {object} input */
  #digest(roomId, researchId, revision, input) {
    return sha256(
      stableJson({
        roomId,
        researchId,
        proposalRevision: revision,
        topic: input.topic,
        objective: input.objective,
        justification: input.justification,
        hypotheses: input.hypotheses,
        expectedArtifacts: input.expectedArtifacts,
        participantPlan: input.participantPlan,
        projectSnapshotRef: input.projectSnapshotRef,
        scope: input.scope,
        budget: input.budget,
      }),
    );
  }

  /**
   * Send one concise kickoff to the research participants. The coordinator is
   * named as the author; the message is ordinary room data, not an approval.
   * @param {object} room
   * @param {object} run
   * @param {object} proposal
   */
  #briefing(proposal, discussionId) {
    return [
      `【深度研究已获批准】${proposal.topic}`,
      `目标：${proposal.objective}`,
      `范围：${proposal.scope.allowedPaths.join('、')}`,
      `预算：${proposal.budget.maxModelCalls} 次模型调用 / ${proposal.budget.maxTotalTokens} tokens / ${proposal.budget.maxExperimentRuns} 次实验。`,
      `讨论专题：${discussionId}（成员可互相质疑，不必每条都经主代理转述）。`,
      '请参与成员先独立阅读需求与必要代码，用 room_research_hypothesis 提交假设；实验用 room_research_experiment 登记真实命令与证据；结论用 room_research_finding。',
      '这是被批准的一次研究，不要把它扩成新研究；预算或范围变化必须停下来重新审批。',
    ].join('\n');
  }

  async #kickoff(room, run, proposal, discussionId) {
    if (!this.messages) return null;
    const members = this.store.listMembers(room.id).filter((member) => member.kind === 'agent' && member.status !== 'offline');
    const coordinator = members.find((member) => member.role === 'coordinator');
    if (!coordinator) return null;
    const participants = run.participantIds.filter((id) => id !== coordinator.id);
    const nameOf = (id) => members.find((member) => member.id === id)?.displayName ?? id;
    const body = this.#briefing(proposal, discussionId);
    return this.messages.send({
      roomId: room.id,
      authorId: coordinator.id,
      clientMessageId: `research-kickoff-${run.id}`,
      body,
      mentions: participants.map((memberId) => ({
        targetMemberId: memberId,
        origin: 'picker',
        displaySnapshot: nameOf(memberId),
      })),
      mode: 'queue',
      purpose: 'research',
      membershipRevision: room.membershipRevision,
    });
  }
}
