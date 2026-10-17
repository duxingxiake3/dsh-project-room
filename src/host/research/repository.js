/**
 * Project Room — deep research repository.
 *
 * The research tables live in the same SQLite database and the same writer lock
 * as rooms. This repository owns only their SQL; authorization, scope validation,
 * budget policy and the gate live in `ResearchService`.
 *
 * @module dsh-project-room/src/host/research/repository
 */

import { randomUUID } from 'node:crypto';

import { RoomError, isoTimestamp } from '../../../shared/contracts.js';

/**
 * @param {unknown} value
 * @param {any} fallback
 */
function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    const parsed = JSON.parse(String(value));
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function mapProposal(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    researchId: row.research_id,
    sourceMessageId: row.source_message_id ?? null,
    requestedBy: row.requested_by,
    topic: row.topic,
    objective: row.objective,
    justification: row.justification,
    hypotheses: parseJson(row.hypotheses, []),
    expectedArtifacts: parseJson(row.expected_artifacts, []),
    participantPlan: parseJson(row.participant_plan, []),
    projectSnapshotRef: row.project_snapshot_ref,
    scope: parseJson(row.scope, {}),
    budget: parseJson(row.budget, {}),
    status: row.status,
    proposalRevision: row.proposal_revision,
    scopeDigest: row.scope_digest,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApproval(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    researchId: row.research_id,
    proposalId: row.proposal_id,
    proposalRevision: row.proposal_revision,
    scopeDigest: row.scope_digest,
    decision: row.decision,
    approvedBy: row.approved_by ?? null,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at ?? null,
    channelRef: row.channel_ref ?? null,
    auditRef: row.audit_ref ?? null,
    idempotencyKey: row.idempotency_key,
    scope: parseJson(row.scope, {}),
    budget: parseJson(row.budget, {}),
    revokedAt: row.revoked_at ?? null,
    revokeReason: row.revoke_reason ?? null,
  };
}

function mapRun(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    proposalId: row.proposal_id,
    approvalId: row.approval_id ?? null,
    status: row.status,
    currentPhase: row.current_phase,
    basePlanRevision: row.base_plan_revision,
    participantIds: parseJson(row.participant_ids, []),
    taskIds: parseJson(row.task_ids, []),
    pausedReason: row.paused_reason ?? null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    conclusion: row.conclusion ?? null,
    outcome: parseJson(row.outcome, null),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBudget(row) {
  return {
    researchId: row.research_id,
    maxCalls: row.max_calls,
    reservedCalls: row.reserved_calls,
    usedCalls: row.used_calls,
    maxTokens: row.max_tokens,
    reservedTokens: row.reserved_tokens,
    usedTokens: row.used_tokens,
    maxWallClockMs: row.max_wall_clock_ms,
    maxExperiments: row.max_experiments,
    reservedExperiments: row.reserved_experiments,
    experimentsUsed: row.experiments_used,
    maxParallelAgents: row.max_parallel_agents,
    startedAt: row.started_at ?? null,
    updatedAt: row.updated_at,
  };
}

function mapBudgetEntry(row) {
  return {
    id: row.id,
    researchId: row.research_id,
    kind: row.kind,
    units: row.units,
    tokens: row.tokens,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    detail: parseJson(row.detail, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHypothesis(row) {
  return {
    id: row.id,
    researchId: row.research_id,
    authorMemberId: row.author_member_id,
    claim: row.claim,
    predictedEffect: row.predicted_effect,
    falsificationTest: row.falsification_test,
    status: row.status,
    evidenceRefs: parseJson(row.evidence_refs, []),
    createdAt: row.created_at,
  };
}

function mapExperiment(row) {
  return {
    id: row.id,
    researchId: row.research_id,
    hypothesisId: row.hypothesis_id ?? null,
    ownerId: row.owner_id,
    attemptId: row.attempt_id ?? null,
    baselineCommit: row.baseline_commit ?? null,
    candidateCommit: row.candidate_commit ?? null,
    environmentRef: row.environment_ref ?? null,
    commandRefs: parseJson(row.command_refs, []),
    metrics: parseJson(row.metrics, {}),
    artifactRefs: parseJson(row.artifact_refs, []),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFinding(row) {
  return {
    id: row.id,
    researchId: row.research_id,
    issue: row.issue,
    evidenceLevel: row.evidence_level,
    supportingRefs: parseJson(row.supporting_refs, []),
    counterRefs: parseJson(row.counter_refs, []),
    recommendation: row.recommendation,
    uncertainty: row.uncertainty,
    createdAt: row.created_at,
  };
}

function mapOutcome(row) {
  return {
    researchId: row.research_id,
    decision: row.decision,
    chosenCandidateRef: row.chosen_candidate_ref ?? null,
    baselineEvidenceRefs: parseJson(row.baseline_evidence_refs, []),
    regressionEvidenceRefs: parseJson(row.regression_evidence_refs, []),
    remainingRisks: parseJson(row.remaining_risks, []),
    integratedTaskRevision: row.integrated_task_revision ?? null,
    acceptedBy: row.accepted_by ?? null,
    closedAt: row.closed_at,
  };
}

function mapExperience(row) {
  return {
    id: row.id,
    sourceResearchId: row.source_research_id,
    reusableLesson: row.reusable_lesson,
    applicability: row.applicability,
    pitfalls: row.pitfalls,
    evidenceRefs: parseJson(row.evidence_refs, []),
    reviewStatus: row.review_status,
    createdAt: row.created_at,
  };
}

export class ResearchRepository {
  /**
   * @param {object} input
   * @param {import('../storage/store.js').RoomStore} input.store
   */
  constructor(input) {
    this.store = input.store;
    this.db = input.store.database();
  }

  /** @param {() => any} operation */
  transaction(operation) {
    return this.store.transaction(operation);
  }

  /* ------------------------------------------------------------------ *
   * Proposals and approvals
   * ------------------------------------------------------------------ */

  insertProposal(input) {
    this.db
      .prepare(
        `insert into research_proposal
           (id, room_id, research_id, source_message_id, requested_by, topic, objective, justification,
            hypotheses, expected_artifacts, participant_plan, project_snapshot_ref, scope, budget,
            status, proposal_revision, scope_digest, idempotency_key, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.roomId,
        input.researchId,
        input.sourceMessageId ?? null,
        input.requestedBy,
        input.topic,
        input.objective,
        input.justification,
        JSON.stringify(input.hypotheses ?? []),
        JSON.stringify(input.expectedArtifacts ?? []),
        JSON.stringify(input.participantPlan ?? []),
        input.projectSnapshotRef,
        JSON.stringify(input.scope ?? {}),
        JSON.stringify(input.budget ?? {}),
        input.status ?? 'AWAITING_APPROVAL',
        input.proposalRevision ?? 1,
        input.scopeDigest,
        input.idempotencyKey,
        input.createdAt ?? isoTimestamp(),
        input.updatedAt ?? isoTimestamp(),
      );
    return this.getProposal(input.id);
  }

  /** @param {string} id */
  getProposal(id) {
    const row = this.db.prepare('select * from research_proposal where id = ?').get(id);
    return row ? mapProposal(row) : null;
  }

  /** @param {string} key */
  findProposalByKey(key) {
    const row = this.db.prepare('select * from research_proposal where idempotency_key = ?').get(key);
    return row ? mapProposal(row) : null;
  }

  /** @param {string} roomId @param {{ status?: string, limit?: number }} [options] */
  listProposals(roomId, options = {}) {
    const clauses = ['room_id = ?'];
    const values = [roomId];
    if (options.status) {
      clauses.push('status = ?');
      values.push(options.status);
    }
    return this.db
      .prepare(`select * from research_proposal where ${clauses.join(' and ')} order by created_at desc limit ?`)
      .all(...values, options.limit ?? 100)
      .map(mapProposal);
  }

  /** @param {string} id @param {object} patch */
  updateProposal(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of [
      ['status', 'status'],
      ['researchId', 'research_id'],
      ['scope', 'scope'],
      ['budget', 'budget'],
      ['proposalRevision', 'proposal_revision'],
      ['scopeDigest', 'scope_digest'],
      ['idempotencyKey', 'idempotency_key'],
    ]) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key] === null ? null : typeof patch[key] === 'object' ? JSON.stringify(patch[key]) : patch[key]);
      }
    }
    if (sets.length === 0) return this.getProposal(id);
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), id);
    this.db.prepare(`update research_proposal set ${sets.join(', ')} where id = ?`).run(...values);
    return this.getProposal(id);
  }

  insertApproval(input) {
    this.db
      .prepare(
        `insert into research_approval
           (id, room_id, research_id, proposal_id, proposal_revision, scope_digest, decision, approved_by,
            decided_at, expires_at, channel_ref, audit_ref, idempotency_key, scope, budget)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.roomId,
        input.researchId,
        input.proposalId,
        input.proposalRevision,
        input.scopeDigest,
        input.decision,
        input.approvedBy ?? null,
        input.decidedAt ?? isoTimestamp(),
        input.expiresAt ?? null,
        input.channelRef ?? null,
        input.auditRef ?? null,
        input.idempotencyKey,
        JSON.stringify(input.scope ?? {}),
        JSON.stringify(input.budget ?? {}),
      );
    return this.getApproval(input.id);
  }

  /** @param {string} id */
  getApproval(id) {
    const row = this.db.prepare('select * from research_approval where id = ?').get(id);
    return row ? mapApproval(row) : null;
  }

  /** @param {string} key */
  findApprovalByKey(key) {
    const row = this.db.prepare('select * from research_approval where idempotency_key = ?').get(key);
    return row ? mapApproval(row) : null;
  }

  /** @param {string} researchId */
  getEffectiveApproval(researchId) {
    const row = this.db
      .prepare("select * from research_approval where research_id = ? and decision = 'approved' and revoked_at is null order by decided_at desc limit 1")
      .get(researchId);
    return row ? mapApproval(row) : null;
  }

  /** @param {string} researchId @param {string} reason */
  revokeApprovals(researchId, reason) {
    this.db
      .prepare("update research_approval set revoked_at = ?, revoke_reason = ? where research_id = ? and decision = 'approved' and revoked_at is null")
      .run(isoTimestamp(), reason, researchId);
  }

  /* ------------------------------------------------------------------ *
   * Runs
   * ------------------------------------------------------------------ */

  insertRun(input) {
    this.db
      .prepare(
        `insert into research_run
           (id, room_id, proposal_id, approval_id, status, current_phase, base_plan_revision,
            participant_ids, task_ids, paused_reason, started_at, ended_at, conclusion, outcome,
            idempotency_key, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.roomId,
        input.proposalId,
        input.approvalId ?? null,
        input.status ?? 'AWAITING_APPROVAL',
        input.currentPhase ?? 'proposal',
        input.basePlanRevision ?? 0,
        JSON.stringify(input.participantIds ?? []),
        JSON.stringify(input.taskIds ?? []),
        input.pausedReason ?? null,
        input.startedAt ?? null,
        input.endedAt ?? null,
        input.conclusion ?? null,
        JSON.stringify(input.outcome ?? null),
        input.idempotencyKey,
        input.createdAt ?? isoTimestamp(),
        input.updatedAt ?? isoTimestamp(),
      );
    return this.getRun(input.id);
  }

  /** @param {string} id */
  getRun(id) {
    const row = this.db.prepare('select * from research_run where id = ?').get(id);
    return row ? mapRun(row) : null;
  }

  /** @param {string} key */
  findRunByKey(key) {
    const row = this.db.prepare('select * from research_run where idempotency_key = ?').get(key);
    return row ? mapRun(row) : null;
  }

  /** @param {string} proposalId */
  getRunByProposal(proposalId) {
    const row = this.db.prepare('select * from research_run where proposal_id = ? order by created_at desc limit 1').get(proposalId);
    return row ? mapRun(row) : null;
  }

  /** @param {string} roomId @param {{ status?: string, statuses?: string[], limit?: number }} [options] */
  listRuns(roomId, options = {}) {
    const clauses = ['room_id = ?'];
    const values = [roomId];
    if (options.status) {
      clauses.push('status = ?');
      values.push(options.status);
    }
    if (options.statuses?.length) {
      clauses.push(`status in (${options.statuses.map(() => '?').join(', ')})`);
      values.push(...options.statuses);
    }
    return this.db
      .prepare(`select * from research_run where ${clauses.join(' and ')} order by created_at desc limit ?`)
      .all(...values, options.limit ?? 100)
      .map(mapRun);
  }

  /** @param {string} memberId */
  listActiveRunsForMember(memberId) {
    return this.db
      .prepare("select * from research_run where status = 'RUNNING' order by created_at desc")
      .all()
      .map(mapRun)
      .filter((run) => run.participantIds.includes(memberId));
  }

  /** @param {string[]} statuses */
  listRunsByStatuses(statuses) {
    if (!statuses?.length) return [];
    return this.db
      .prepare(`select * from research_run where status in (${statuses.map(() => '?').join(', ')}) order by created_at asc`)
      .all(...statuses)
      .map(mapRun);
  }

  /** @param {string} id @param {object} patch */
  updateRun(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of [
      ['proposalId', 'proposal_id'],
      ['approvalId', 'approval_id'],
      ['status', 'status'],
      ['currentPhase', 'current_phase'],
      ['basePlanRevision', 'base_plan_revision'],
      ['participantIds', 'participant_ids'],
      ['taskIds', 'task_ids'],
      ['pausedReason', 'paused_reason'],
      ['startedAt', 'started_at'],
      ['endedAt', 'ended_at'],
      ['conclusion', 'conclusion'],
      ['outcome', 'outcome'],
    ]) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key] === null ? null : typeof patch[key] === 'object' ? JSON.stringify(patch[key]) : patch[key]);
      }
    }
    if (sets.length === 0) return this.getRun(id);
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), id);
    this.db.prepare(`update research_run set ${sets.join(', ')} where id = ?`).run(...values);
    return this.getRun(id);
  }

  /* ------------------------------------------------------------------ *
   * Budget
   * ------------------------------------------------------------------ */

  insertBudget(input) {
    this.db
      .prepare(
        `insert or replace into research_budget
           (research_id, max_calls, reserved_calls, used_calls, max_tokens, reserved_tokens, used_tokens,
            max_wall_clock_ms, max_experiments, reserved_experiments, experiments_used, max_parallel_agents,
            started_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.researchId,
        input.maxCalls,
        input.reservedCalls ?? 0,
        input.usedCalls ?? 0,
        input.maxTokens,
        input.reservedTokens ?? 0,
        input.usedTokens ?? 0,
        input.maxWallClockMs,
        input.maxExperiments,
        input.reservedExperiments ?? 0,
        input.experimentsUsed ?? 0,
        input.maxParallelAgents,
        input.startedAt ?? null,
        input.updatedAt ?? isoTimestamp(),
      );
    return this.getBudget(input.researchId);
  }

  /** @param {string} researchId */
  getBudget(researchId) {
    const row = this.db.prepare('select * from research_budget where research_id = ?').get(researchId);
    return row ? mapBudget(row) : null;
  }

  /** @param {string} researchId @param {object} patch */
  updateBudget(researchId, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of [
      ['reservedCalls', 'reserved_calls'],
      ['usedCalls', 'used_calls'],
      ['reservedTokens', 'reserved_tokens'],
      ['usedTokens', 'used_tokens'],
      ['reservedExperiments', 'reserved_experiments'],
      ['experimentsUsed', 'experiments_used'],
      ['startedAt', 'started_at'],
    ]) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key]);
      }
    }
    if (sets.length === 0) return this.getBudget(researchId);
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), researchId);
    this.db.prepare(`update research_budget set ${sets.join(', ')} where research_id = ?`).run(...values);
    return this.getBudget(researchId);
  }

  /** @param {string} researchId @param {string} key */
  findBudgetEntry(researchId, key) {
    const row = this.db.prepare('select * from research_budget_entry where research_id = ? and idempotency_key = ?').get(researchId, key);
    return row ? mapBudgetEntry(row) : null;
  }

  /**
   * Reserve calls/tokens and/or one experiment atomically. Throws a typed error
   * when the approved limit would be exceeded; the caller turns it into a pause.
   * @param {object} input
   */
  reserveBudget(input) {
    return this.transaction(() => {
      const existing = this.findBudgetEntry(input.researchId, input.idempotencyKey);
      if (existing) return { budget: this.getBudget(input.researchId), entry: existing, duplicate: true };
      const budget = this.getBudget(input.researchId);
      if (!budget) throw new RoomError('RESEARCH_BUDGET_MISSING', '研究预算账本不存在，已拒绝准入。');
      const calls = Number(input.calls ?? 0);
      const tokens = Number(input.tokens ?? 0);
      const experiments = input.kind === 'experiment' ? 1 : 0;
      if (budget.usedCalls + budget.reservedCalls + calls > budget.maxCalls) {
        throw new RoomError('RESEARCH_BUDGET_EXCEEDED', '模型调用预算不足，已拒绝新的研究准入。', {
          maxCalls: budget.maxCalls,
          usedCalls: budget.usedCalls,
          reservedCalls: budget.reservedCalls,
        });
      }
      if (budget.usedTokens + budget.reservedTokens + tokens > budget.maxTokens) {
        throw new RoomError('RESEARCH_BUDGET_EXCEEDED', 'Token 预算不足，已拒绝新的研究准入。', {
          maxTokens: budget.maxTokens,
          usedTokens: budget.usedTokens,
          reservedTokens: budget.reservedTokens,
        });
      }
      if (budget.experimentsUsed + budget.reservedExperiments + experiments > budget.maxExperiments) {
        throw new RoomError('RESEARCH_BUDGET_EXCEEDED', '实验次数预算不足，已拒绝新的研究准入。', {
          maxExperiments: budget.maxExperiments,
          experimentsUsed: budget.experimentsUsed,
          reservedExperiments: budget.reservedExperiments,
        });
      }
      const id = `rbe_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      this.db
        .prepare(
          `insert into research_budget_entry
             (id, research_id, kind, units, tokens, state, idempotency_key, detail, created_at, updated_at)
           values (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.researchId,
          input.kind ?? 'model',
          calls || experiments,
          tokens,
          input.idempotencyKey,
          JSON.stringify(input.detail ?? null),
          isoTimestamp(),
          isoTimestamp(),
        );
      this.updateBudget(input.researchId, {
        reservedCalls: budget.reservedCalls + calls,
        reservedTokens: budget.reservedTokens + tokens,
        reservedExperiments: budget.reservedExperiments + experiments,
      });
      return { budget: this.getBudget(input.researchId), entry: this.findBudgetEntry(input.researchId, input.idempotencyKey), duplicate: false };
    });
  }

  /** @param {string} entryId @param {{ tokens?: number }} [actual] */
  commitBudget(entryId, actual = {}) {
    return this.transaction(() => {
      const row = this.db.prepare('select * from research_budget_entry where id = ?').get(entryId);
      if (!row) throw new RoomError('RESEARCH_NOT_FOUND', `预算预留 ${entryId} 不存在。`);
      if (row.state !== 'reserved') return { budget: this.getBudget(row.research_id), entry: mapBudgetEntry(row), duplicate: true };
      const budget = this.getBudget(row.research_id);
      const tokens = Math.max(Number(row.tokens), Number(actual.tokens ?? 0));
      const experiments = row.kind === 'experiment' ? 1 : 0;
      const calls = row.kind === 'experiment' ? 0 : Math.max(1, row.units);
      this.db
        .prepare("update research_budget_entry set state = 'committed', tokens = ?, updated_at = ? where id = ?")
        .run(tokens, isoTimestamp(), entryId);
      this.updateBudget(row.research_id, {
        reservedCalls: Math.max(0, budget.reservedCalls - calls),
        usedCalls: budget.usedCalls + calls,
        reservedTokens: Math.max(0, budget.reservedTokens - row.tokens),
        usedTokens: budget.usedTokens + tokens,
        reservedExperiments: Math.max(0, budget.reservedExperiments - experiments),
        experimentsUsed: budget.experimentsUsed + experiments,
      });
      return { budget: this.getBudget(row.research_id), entry: this.findBudgetEntry(row.research_id, row.idempotency_key), duplicate: false };
    });
  }

  /** @param {string} entryId */
  releaseBudget(entryId) {
    return this.transaction(() => {
      const row = this.db.prepare('select * from research_budget_entry where id = ?').get(entryId);
      if (!row) throw new RoomError('RESEARCH_NOT_FOUND', `预算预留 ${entryId} 不存在。`);
      if (row.state !== 'reserved') return { budget: this.getBudget(row.research_id), entry: mapBudgetEntry(row), duplicate: true };
      const budget = this.getBudget(row.research_id);
      const experiments = row.kind === 'experiment' ? 1 : 0;
      const calls = row.kind === 'experiment' ? 0 : Math.max(0, row.units);
      this.db.prepare("update research_budget_entry set state = 'released', updated_at = ? where id = ?").run(isoTimestamp(), entryId);
      this.updateBudget(row.research_id, {
        reservedCalls: Math.max(0, budget.reservedCalls - calls),
        reservedTokens: Math.max(0, budget.reservedTokens - row.tokens),
        reservedExperiments: Math.max(0, budget.reservedExperiments - experiments),
      });
      return { budget: this.getBudget(row.research_id), entry: this.findBudgetEntry(row.research_id, row.idempotency_key), duplicate: false };
    });
  }

  /**
   * Record an observed model invocation against the active run. This is usage
   * settlement, not admission; the gate reserves before a step.
   * @param {string} researchId
   * @param {{ calls?: number, tokens?: number }} usage
   */
  recordUsage(researchId, usage) {
    const budget = this.getBudget(researchId);
    if (!budget) return null;
    return this.updateBudget(researchId, {
      usedCalls: budget.usedCalls + Number(usage.calls ?? 0),
      usedTokens: budget.usedTokens + Number(usage.tokens ?? 0),
    });
  }

  /* ------------------------------------------------------------------ *
   * Evidence and outcomes
   * ------------------------------------------------------------------ */

  insertHypothesis(input) {
    this.db
      .prepare(
        `insert into research_hypothesis
           (id, research_id, author_member_id, claim, predicted_effect, falsification_test, status, evidence_refs, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.researchId,
        input.authorMemberId,
        input.claim,
        input.predictedEffect ?? '',
        input.falsificationTest ?? '',
        input.status ?? 'proposed',
        JSON.stringify(input.evidenceRefs ?? []),
        input.createdAt ?? isoTimestamp(),
      );
    return this.getHypothesis(input.id);
  }

  /** @param {string} id */
  getHypothesis(id) {
    const row = this.db.prepare('select * from research_hypothesis where id = ?').get(id);
    return row ? mapHypothesis(row) : null;
  }

  /** @param {string} researchId */
  listHypotheses(researchId) {
    return this.db.prepare('select * from research_hypothesis where research_id = ? order by created_at asc').all(researchId).map(mapHypothesis);
  }

  insertExperiment(input) {
    this.db
      .prepare(
        `insert into research_experiment
           (id, research_id, hypothesis_id, owner_id, attempt_id, baseline_commit, candidate_commit,
            environment_ref, command_refs, metrics, artifact_refs, state, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.researchId,
        input.hypothesisId ?? null,
        input.ownerId,
        input.attemptId ?? null,
        input.baselineCommit ?? null,
        input.candidateCommit ?? null,
        input.environmentRef ?? null,
        JSON.stringify(input.commandRefs ?? []),
        JSON.stringify(input.metrics ?? {}),
        JSON.stringify(input.artifactRefs ?? []),
        input.state ?? 'recorded',
        input.createdAt ?? isoTimestamp(),
        input.updatedAt ?? isoTimestamp(),
      );
    return this.getExperiment(input.id);
  }

  /** @param {string} id */
  getExperiment(id) {
    const row = this.db.prepare('select * from research_experiment where id = ?').get(id);
    return row ? mapExperiment(row) : null;
  }

  /** @param {string} researchId */
  listExperiments(researchId) {
    return this.db.prepare('select * from research_experiment where research_id = ? order by created_at asc').all(researchId).map(mapExperiment);
  }

  /** @param {string} id @param {object} patch */
  updateExperiment(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of [
      ['state', 'state'],
      ['metrics', 'metrics'],
      ['artifactRefs', 'artifact_refs'],
      ['candidateCommit', 'candidate_commit'],
    ]) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key] === null ? null : typeof patch[key] === 'object' ? JSON.stringify(patch[key]) : patch[key]);
      }
    }
    if (sets.length === 0) return this.getExperiment(id);
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), id);
    this.db.prepare(`update research_experiment set ${sets.join(', ')} where id = ?`).run(...values);
    return this.getExperiment(id);
  }

  insertFinding(input) {
    this.db
      .prepare(
        `insert into research_finding
           (id, research_id, issue, evidence_level, supporting_refs, counter_refs, recommendation, uncertainty, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.researchId,
        input.issue,
        input.evidenceLevel,
        JSON.stringify(input.supportingRefs ?? []),
        JSON.stringify(input.counterRefs ?? []),
        input.recommendation ?? '',
        input.uncertainty ?? '',
        input.createdAt ?? isoTimestamp(),
      );
    return this.getFinding(input.id);
  }

  /** @param {string} id */
  getFinding(id) {
    const row = this.db.prepare('select * from research_finding where id = ?').get(id);
    return row ? mapFinding(row) : null;
  }

  /** @param {string} researchId */
  listFindings(researchId) {
    return this.db.prepare('select * from research_finding where research_id = ? order by created_at asc').all(researchId).map(mapFinding);
  }

  /** @param {object} input */
  upsertOutcome(input) {
    this.db
      .prepare(
        `insert or replace into research_outcome
           (research_id, decision, chosen_candidate_ref, baseline_evidence_refs, regression_evidence_refs,
            remaining_risks, integrated_task_revision, accepted_by, closed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.researchId,
        input.decision,
        input.chosenCandidateRef ?? null,
        JSON.stringify(input.baselineEvidenceRefs ?? []),
        JSON.stringify(input.regressionEvidenceRefs ?? []),
        JSON.stringify(input.remainingRisks ?? []),
        input.integratedTaskRevision ?? null,
        input.acceptedBy ?? null,
        input.closedAt ?? isoTimestamp(),
      );
    return this.getOutcome(input.researchId);
  }

  /** @param {string} researchId */
  getOutcome(researchId) {
    const row = this.db.prepare('select * from research_outcome where research_id = ?').get(researchId);
    return row ? mapOutcome(row) : null;
  }

  insertExperience(input) {
    this.db
      .prepare(
        `insert into research_experience
           (id, source_research_id, reusable_lesson, applicability, pitfalls, evidence_refs, review_status, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sourceResearchId,
        input.reusableLesson,
        input.applicability ?? '',
        input.pitfalls ?? '',
        JSON.stringify(input.evidenceRefs ?? []),
        input.reviewStatus ?? 'draft',
        input.createdAt ?? isoTimestamp(),
      );
    return this.getExperience(input.id);
  }

  /** @param {string} id */
  getExperience(id) {
    const row = this.db.prepare('select * from research_experience where id = ?').get(id);
    return row ? mapExperience(row) : null;
  }

  /** @param {{ limit?: number }} [options] */
  listExperience(options = {}) {
    return this.db
      .prepare('select * from research_experience order by created_at desc limit ?')
      .all(options.limit ?? 100)
      .map(mapExperience);
  }

  /** Experience only from this project's research runs. */
  listExperienceForRoom(roomId, limit = 10) {
    return this.db
      .prepare(
        `select e.* from research_experience e
         join research_run r on r.id = e.source_research_id
         where r.room_id = ?
         order by e.created_at desc limit ?`,
      )
      .all(roomId, limit)
      .map(mapExperience);
  }

  linkTask(input) {
    this.db
      .prepare(
        `insert or replace into research_task_link (research_id, task_id, kind, hypothesis_id, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(input.researchId, input.taskId, input.kind ?? 'research', input.hypothesisId ?? null, input.createdAt ?? isoTimestamp());
    return this.findTaskLink(input.taskId);
  }

  /** @param {string} taskId */
  findTaskLink(taskId) {
    const row = this.db.prepare('select * from research_task_link where task_id = ?').get(taskId);
    return row ? { researchId: row.research_id, taskId: row.task_id, kind: row.kind, hypothesisId: row.hypothesis_id ?? null, createdAt: row.created_at } : null;
  }

  /** @param {string} researchId */
  listTaskLinks(researchId) {
    return this.db.prepare('select * from research_task_link where research_id = ? order by created_at asc').all(researchId).map((row) => ({
      researchId: row.research_id,
      taskId: row.task_id,
      kind: row.kind,
      hypothesisId: row.hypothesis_id ?? null,
      createdAt: row.created_at,
    }));
  }

  /** @param {object} input */
  insertFlowback(input) {
    this.db
      .prepare(
        `insert or replace into research_flowback (research_id, decision_id, task_id, created_at)
         values (?, ?, ?, ?)`,
      )
      .run(input.researchId, input.decisionId ?? null, input.taskId ?? null, input.createdAt ?? isoTimestamp());
    return this.getFlowback(input.researchId);
  }

  /** @param {string} researchId */
  getFlowback(researchId) {
    const row = this.db.prepare('select * from research_flowback where research_id = ?').get(researchId);
    return row
      ? { researchId: row.research_id, decisionId: row.decision_id ?? null, taskId: row.task_id ?? null, createdAt: row.created_at }
      : null;
  }

  /** @param {object} input */
  insertResearchSession(input) {
    this.db
      .prepare(
        `insert or replace into research_session
           (session_id, research_id, room_id, member_id, status, created_at, disposed_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.researchId,
        input.roomId,
        input.memberId,
        input.status ?? 'active',
        input.createdAt ?? isoTimestamp(),
        input.disposedAt ?? null,
      );
    return this.getResearchSession(input.sessionId);
  }

  /** @param {string} sessionId */
  getResearchSession(sessionId) {
    const row = this.db.prepare('select * from research_session where session_id = ?').get(sessionId);
    return row
      ? {
          sessionId: row.session_id,
          researchId: row.research_id,
          roomId: row.room_id,
          memberId: row.member_id,
          status: row.status,
          createdAt: row.created_at,
          disposedAt: row.disposed_at ?? null,
        }
      : null;
  }

  /** @param {string} researchId */
  listResearchSessions(researchId) {
    return this.db.prepare('select * from research_session where research_id = ? order by created_at asc').all(researchId).map((row) => ({
      sessionId: row.session_id,
      researchId: row.research_id,
      roomId: row.room_id,
      memberId: row.member_id,
      status: row.status,
      createdAt: row.created_at,
      disposedAt: row.disposed_at ?? null,
    }));
  }

  /** @param {string} roomId */
  listResearchSessionsForRoom(roomId, limit = 100) {
    return this.db.prepare('select * from research_session where room_id = ? order by created_at desc limit ?').all(roomId, limit).map((row) => ({
      sessionId: row.session_id,
      researchId: row.research_id,
      roomId: row.room_id,
      memberId: row.member_id,
      status: row.status,
      createdAt: row.created_at,
      disposedAt: row.disposed_at ?? null,
    }));
  }

  /** @param {string} researchId @param {string} status */
  markResearchSessions(researchId, status) {
    this.db
      .prepare('update research_session set status = ?, disposed_at = ? where research_id = ? and status = ?')
      .run(status, status === 'active' ? null : isoTimestamp(), researchId, 'active');
  }
}
