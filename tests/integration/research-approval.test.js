/**
 * Deep research —  approval, scope, budget and evidence gates.
 *
 * These tests deliberately use the real ResearchService and the real SQLite
 * schema. A proposal never starts by itself; only a persisted human decision can
 * create an effective grant.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createRoomStack, createStandardRoom } from './harness.js';

/** @param {import('node:test').TestContext} t */
async function freshRoom(t, budget = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'research-project-'));
  writeFileSync(join(workspace, 'README.md'), '# research target\n');
  const stack = createRoomStack({
    research: {
      maxModelCalls: 6,
      maxTotalTokens: 5000,
      maxWallClockMs: 600000,
      maxExperimentRuns: 2,
      maxParallelAgents: 3,
      ...budget,
    },
  });
  const team = await createStandardRoom(stack, { workspaceRef: workspace });
  t.after(async () => {
    await stack.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  return { stack, team, workspace };
}

/** @param {Awaited<ReturnType<typeof freshRoom>>} context */
function proposal(context) {
  const { stack, team, workspace } = context;
  return {
    roomId: team.room.id,
    actorId: team.agents.coordinator.id,
    topic: '验证码登录的并发限流与重发一致性',
    objective: '比较两种限流方案在并发与重发下的一致性，并给出可复现证据。',
    justification: '普通单测无法覆盖竞态；两个候选方案各有风险，需要受控实验。',
    hypotheses: ['令牌桶在重发竞态下可能重复计数'],
    expectedArtifacts: ['方案对比', '可复现测试记录'],
    participantPlan: [team.agents.coordinator.id, team.agents.backend.id, team.agents.tester.id],
    allowedPaths: [workspace],
    budget: {
      maxModelCalls: 3,
      maxTotalTokens: 2000,
      maxWallClockMs: 120000,
      maxExperimentRuns: 1,
      maxParallelAgents: 3,
    },
  };
}

describe('research — approval is the only way to run', () => {
  it('keeps a proposal pending and refuses to start before a human decides', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));

    assert.equal(created.proposal.status, 'AWAITING_APPROVAL');
    assert.equal(created.run.status, 'AWAITING_APPROVAL');
    assert.equal(stack.store.listTasks(team.room.id).length, 0, '提议阶段不得派发研究任务');
    await assert.rejects(
      () => stack.research.start({ researchId: created.run.id }),
      (error) => error.code === 'RESEARCH_NOT_AUTHORIZED',
    );

    // An agent identity is not a human approval, even if it is the coordinator.
    assert.throws(
      () =>
        stack.research.approve({
          researchId: created.run.id,
          expectedProposalRevision: created.proposal.proposalRevision,
          scopeDigest: created.proposal.scopeDigest,
          approvedBy: team.agents.coordinator.id,
          idempotencyKey: 'agent-approval',
        }),
      (error) => error.code === 'FORBIDDEN',
    );

    // A wrong digest cannot approve a changed scope.
    assert.throws(
      () =>
        stack.research.approve({
          researchId: created.run.id,
          expectedProposalRevision: created.proposal.proposalRevision,
          scopeDigest: '0'.repeat(64),
          approvedBy: team.human.id,
          idempotencyKey: 'wrong-digest',
        }),
      (error) => error.code === 'RESEARCH_SCOPE_CHANGED',
    );

    const approved = await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-1',
    });
    assert.equal(approved.run.status, 'APPROVED');
    assert.equal(approved.approval.decision, 'approved');

    const started = await stack.research.start({ researchId: created.run.id });
    assert.equal(started.run.status, 'RUNNING');
    assert.ok(started.run.startedAt);
    assert.equal(stack.store.listTasks(team.room.id).length, 0, '启动研究不能伪装成普通任务派发');
    assert.ok(stack.adapter.researchSessions.size >= 2, '应为研究参与者建立专用 Session');
    const firstSession = [...stack.adapter.researchSessions.keys()][0];
    assert.ok(stack.research.sessionActor(firstSession)?.id, '研究会话必须映射回真实参与者');
    assert.ok(stack.researchRepository.listResearchSessions(created.run.id).every((session) => session.status === 'active'), '研究 Session 归属必须持久化');
    assert.ok(stack.research.listSessions(team.room.id).length >= 2, '研究 Session 历史必须可按项目查询');
  });

  it('makes approval and start idempotent for a retried request', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    const input = {
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-idem',
    };
    const first = await stack.research.approve(input);
    const second = await stack.research.approve(input);
    assert.equal(first.approval.id, second.approval.id);
    assert.equal(second.duplicate, true);

    const started = await stack.research.start({ researchId: created.run.id });
    const again = await stack.research.start({ researchId: created.run.id });
    assert.equal(started.run.id, again.run.id);
    assert.equal(again.duplicate, true);
  });

  it('rejects a proposal without creating a run grant', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    const rejected = await stack.research.reject({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'reject-1',
      reason: '当前不值得投入',
    });
    assert.equal(rejected.run.status, 'REJECTED');
    assert.equal(rejected.approval.decision, 'rejected');
    await assert.rejects(
      () => stack.research.start({ researchId: created.run.id }),
      (error) => error.code === 'RESEARCH_NOT_AUTHORIZED',
    );
  });

  it('invalidates the old grant when the user changes the budget or scope', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-before-revise',
    });
    const revised = await stack.research.revise({
      researchId: created.run.id,
      actorId: team.agents.coordinator.id,
      budget: { maxModelCalls: 9 },
    });
    assert.equal(revised.proposal.proposalRevision, 2);
    assert.equal(revised.run.status, 'AWAITING_APPROVAL');
    assert.notEqual(revised.proposal.scopeDigest, created.proposal.scopeDigest);
    await assert.rejects(
      () => stack.research.start({ researchId: created.run.id }),
      (error) => error.code === 'RESEARCH_NOT_AUTHORIZED',
    );
  });
});

describe('research — scope, budget and evidence', () => {
  it('rejects paths outside the approved project workspace', async (t) => {
    const context = await freshRoom(t);
    const { stack } = context;
    const input = proposal(context);
    input.allowedPaths = ['../outside'];
    await assert.rejects(
      () => stack.research.propose(input),
      (error) => error.code === 'RESEARCH_OUT_OF_SCOPE',
    );
  });

  it('reserves experiment budget atomically and refuses when exhausted', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-budget',
    });
    await stack.research.start({ researchId: created.run.id });

    const hypothesis = stack.research.hypothesis({
      researchId: created.run.id,
      actorId: team.agents.backend.id,
      claim: '令牌桶在重发竞态下会重复计数',
      falsificationTest: '并发 20 次重发，计数器不应超过 1',
    });
    assert.equal(hypothesis.hypothesis.authorMemberId, team.agents.backend.id);

    const first = stack.research.experiment({
      researchId: created.run.id,
      actorId: team.agents.tester.id,
      hypothesisId: hypothesis.hypothesis.id,
      commandRefs: ['node tests/rate-limit.mjs'],
      metrics: { passed: 20, failed: 0 },
      idempotencyKey: 'exp-1',
    });
    assert.equal(first.experiment.state, 'recorded');

    assert.throws(
      () =>
        stack.research.experiment({
          researchId: created.run.id,
          actorId: team.agents.tester.id,
          hypothesisId: hypothesis.hypothesis.id,
          commandRefs: ['node tests/rate-limit-2.mjs'],
          metrics: { passed: 1, failed: 0 },
          idempotencyKey: 'exp-2',
        }),
      (error) => error.code === 'RESEARCH_BUDGET_EXCEEDED',
    );
  });

  it('pauses on real model usage above the approved budget', async (t) => {
    const context = await freshRoom(t, { maxModelCalls: 1 });
    const { stack, team } = context;
    const input = proposal(context);
    input.budget.maxModelCalls = 1;
    const created = await stack.research.propose(input);
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-usage',
    });
    await stack.research.start({ researchId: created.run.id });
    stack.research.recordModelUsage({ memberId: team.agents.backend.id, roomId: team.room.id, usage: { totalTokens: 10 } });
    const run = stack.researchRepository.getRun(created.run.id);
    assert.equal(run.status, 'PAUSED');
    assert.equal(run.pausedReason, 'RESEARCH_BUDGET_EXCEEDED');
  });

  it('requires regression evidence for an improved conclusion', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-complete',
    });
    await stack.research.start({ researchId: created.run.id });

    assert.throws(
      () => stack.research.complete({ researchId: created.run.id, decision: 'improved', baselineEvidenceRefs: ['baseline.log'] }),
      (error) => error.code === 'INVALID_REQUEST',
    );

    const completed = stack.research.complete({
      researchId: created.run.id,
      decision: 'improved',
      chosenCandidateRef: 'candidate-a',
      baselineEvidenceRefs: ['baseline.log'],
      regressionEvidenceRefs: ['regression.log'],
      remainingRisks: ['高并发下未验证'],
      reusableLesson: '重发路径必须在同一事务里核销令牌',
    });
    assert.equal(completed.run.status, 'COMPLETED');
    assert.equal(completed.outcome.decision, 'improved');
    assert.equal(stack.research.summary(team.room.id).outcome.decision, 'improved');
    assert.ok(stack.research.summary(team.room.id).experience.some((entry) => entry.sourceResearchId === created.run.id), '经验只从本项目研究回流');
    assert.ok(stack.research.listExperience(team.room.id).some((entry) => entry.sourceResearchId === created.run.id), '经验接口必须按项目过滤');
    const next = await stack.research.propose({ ...proposal(context), topic: '下一轮研究', idempotencyKey: 'experience-reuse' });
    assert.ok(next.relatedExperience.some((entry) => entry.sourceResearchId === created.run.id), '新提议必须拿到本项目经验提示');
  });

  it('advances through independent proposals, review, experiment and converge', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-phases',
    });
    await stack.research.start({ researchId: created.run.id });
    assert.equal(stack.researchRepository.getRun(created.run.id).currentPhase, 'independent');
    assert.equal(stack.store.getDiscussion(`research-discussion-${created.run.id}`).status, 'open');

    stack.research.hypothesis({ researchId: created.run.id, actorId: team.agents.backend.id, claim: '后端假设' });
    assert.equal(stack.researchRepository.getRun(created.run.id).currentPhase, 'independent');
    stack.research.hypothesis({ researchId: created.run.id, actorId: team.agents.tester.id, claim: '测试假设' });
    assert.equal(stack.researchRepository.getRun(created.run.id).currentPhase, 'independent');
    stack.research.hypothesis({ researchId: created.run.id, actorId: team.agents.coordinator.id, claim: '主代理假设' });
    assert.equal(stack.researchRepository.getRun(created.run.id).currentPhase, 'review');

    stack.research.experiment({ researchId: created.run.id, actorId: team.agents.tester.id, commandRefs: ['node test.mjs'], idempotencyKey: 'phase-exp' });
    assert.equal(stack.researchRepository.getRun(created.run.id).currentPhase, 'experiment');
    stack.research.finding({ researchId: created.run.id, actorId: team.agents.backend.id, issue: '候选仍需验证', evidenceLevel: 'hypothesis' });
    assert.equal(stack.researchRepository.getRun(created.run.id).currentPhase, 'converge');
    stack.research.complete({ researchId: created.run.id, decision: 'inconclusive' });
    assert.equal(stack.researchRepository.getRun(created.run.id).currentPhase, 'completed');
    assert.equal(stack.store.getDiscussion(`research-discussion-${created.run.id}`).status, 'closed');
  });

  it('requires reconciliation after a restart instead of silently continuing', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-restart',
    });
    await stack.research.start({ researchId: created.run.id });

    const recovered = stack.research.recoverStaleRuns();
    assert.equal(recovered.recovered, 1);
    assert.equal(stack.researchRepository.getRun(created.run.id).status, 'PAUSED_RECONCILE');
    assert.ok(stack.researchRepository.listResearchSessions(created.run.id).every((session) => session.status === 'stale'), '重启后旧研究 Session 必须标为 stale');
    await assert.rejects(
      () => stack.research.start({ researchId: created.run.id }),
      (error) => error.code === 'RESEARCH_NOT_AUTHORIZED',
    );

    const reconciled = stack.research.reconcile({ researchId: created.run.id, actorId: team.human.id });
    assert.equal(reconciled.run.status, 'PAUSED');
    const resumed = await stack.research.start({ researchId: created.run.id });
    assert.equal(resumed.run.status, 'RUNNING');
  });

  it('fails closed for multi-human approval until a verified identity exists', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    stack.store.insertMember({
      id: 'member_human_second',
      roomId: team.room.id,
      kind: 'human',
      role: 'owner',
      displayName: '第二位用户',
      handle: 'user2',
      status: 'idle',
    });
    const created = await stack.research.propose(proposal(context));
    assert.throws(
      () =>
        stack.research.approve({
          researchId: created.run.id,
          expectedProposalRevision: created.proposal.proposalRevision,
          scopeDigest: created.proposal.scopeDigest,
          approvedBy: team.human.id,
          idempotencyKey: 'multi-human-approval',
        }),
      (error) => error.code === 'FORBIDDEN' && /多.*人类成员/.test(error.message),
    );
  });

  it('gives dedicated sessions a pre-step gate and denies normal room tools', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-dedicated',
    });
    await stack.research.start({ researchId: created.run.id });
    const sessionId = [...stack.adapter.researchSessions.keys()][0];
    const record = stack.host.record(sessionId);
    const gate = [...record.listeners.get('agent/pre-step')][0];
    const enter = await gate({}, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(enter.kind, 'enter');
    const secondSession = [...stack.adapter.researchSessions.keys()][1];
    const secondGate = [...stack.host.record(secondSession).listeners.get('agent/pre-step')][0];
    const blocked = await secondGate({}, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(blocked.kind, 'reject', '并发研究请求必须串行化，避免预算超支');
    stack.research.recordModelUsage({ researchId: created.run.id, memberId: team.agents.tester.id, usage: { totalTokens: 1 } });
    const admitted = await secondGate({}, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(admitted.kind, 'enter');
    assert.ok(record.toolRestrictions.some((filter) => filter.deny?.includes('room_send')), '研究会话必须拒绝普通群工具');
    const guard = record.toolGuards[0];
    assert.match(guard({ name: 'write', arguments: { path: join(context.workspace, '..', 'outside.txt') } }), /越出批准范围/);
    assert.match(guard({ name: 'write', arguments: { path: '../outside.txt' } }), /越出批准范围/);
    assert.match(guard({ name: 'apply_patch', arguments: {} }), /缺少可核验的路径/);
    assert.equal(guard({ name: 'write', arguments: { path: join(context.workspace, 'inside.txt') } }), undefined);
    assert.match(guard({ name: 'pwsh', arguments: {} }), /暂不执行 shell/);

    stack.research.pause({ researchId: created.run.id, reason: 'test pause' });
    const rejected = await gate({}, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(rejected.kind, 'reject', '暂停后模型请求前必须被拒绝');
  });

  it('flows an improved outcome back to one Decision and one integration Task', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const source = await stack.messages.send({
      roomId: team.room.id,
      authorId: team.human.id,
      body: '请研究限流方案并给出可复现结论。',
      mentions: [],
    });
    const input = proposal(context);
    input.sourceMessageId = source.message.id;
    const created = await stack.research.propose(input);
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-flowback',
    });
    await stack.research.start({ researchId: created.run.id });
    stack.research.complete({
      researchId: created.run.id,
      decision: 'improved',
      chosenCandidateRef: 'candidate-b',
      baselineEvidenceRefs: ['baseline.log'],
      regressionEvidenceRefs: ['regression.log'],
    });

    const flowed = await stack.research.flowBack({ researchId: created.run.id, actorId: team.agents.coordinator.id });
    assert.equal(flowed.duplicate, false);
    assert.ok(flowed.decision.id, '研究结论必须写入一条 Decision');
    assert.ok(flowed.task, 'improved 结论必须生成一张集成任务');
    assert.ok(flowed.artifact?.id, '研究回流必须留下报告 artifact 索引');
    assert.equal(stack.researchRepository.getFlowback(created.run.id).taskId, flowed.task.id);
    const again = await stack.research.flowBack({ researchId: created.run.id, actorId: team.agents.coordinator.id });
    assert.equal(again.duplicate, true);
    assert.equal(again.task.id, flowed.task.id);
  });

  it('pauses, resumes only with a valid grant, and makes stop terminal', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-lifecycle',
    });
    await stack.research.start({ researchId: created.run.id });

    const paused = stack.research.pause({ researchId: created.run.id, reason: '用户暂停' });
    assert.equal(paused.run.status, 'PAUSED');
    const resumed = await stack.research.start({ researchId: created.run.id });
    assert.equal(resumed.run.status, 'RUNNING');

    const stopped = stack.research.stop({ researchId: created.run.id, reason: '用户停止' });
    assert.equal(stopped.run.status, 'STOPPED');
    assert.ok(stack.researchRepository.listResearchSessions(created.run.id).every((session) => session.status === 'disposed'), '停止后研究 Session 归属必须标为 disposed');
    await assert.rejects(
      () => stack.research.start({ researchId: created.run.id }),
      (error) => error.code === 'RESEARCH_NOT_AUTHORIZED',
    );
  });

  it('pauses instead of admitting an experiment after the project plan changed', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-revision',
    });
    await stack.research.start({ researchId: created.run.id });
    stack.store.bumpPlanRevision(team.room.id);
    assert.throws(
      () =>
        stack.research.experiment({
          researchId: created.run.id,
          actorId: team.agents.tester.id,
          commandRefs: ['node tests/new-plan.mjs'],
          idempotencyKey: 'exp-after-plan-change',
        }),
      (error) => error.code === 'RESEARCH_PROJECT_VERSION_CHANGED',
    );
    assert.equal(stack.researchRepository.getRun(created.run.id).status, 'PAUSED');
  });

  it('rejects a project workspace inside a protected plugin root', async (t) => {
    const parent = mkdtempSync(join(tmpdir(), 'research-protected-'));
    const workspace = join(parent, 'project');
    mkdirSync(workspace);
    const stack = createRoomStack({ protectedRoots: [parent] });
    const team = await createStandardRoom(stack, { workspaceRef: workspace });
    t.after(async () => {
      await stack.close();
      rmSync(parent, { recursive: true, force: true });
    });
    await assert.rejects(
      () =>
        stack.research.propose({
          roomId: team.room.id,
          actorId: team.agents.coordinator.id,
          topic: '受保护工作区',
          objective: '不应被允许',
          justification: '仅用于验证保护根',
          participantPlan: [team.agents.coordinator.id],
          allowedPaths: [workspace],
        }),
      (error) => error.code === 'RESEARCH_OUT_OF_SCOPE',
    );
  });

  it('binds participant model profiles without inventing a model', async (t) => {
    const context = await freshRoom(t);
    const { stack } = context;
    const input = proposal(context);
    input.participantPlan = [context.team.agents.coordinator.id, context.team.agents.backend.id, context.team.agents.tester.id];
    const created = await stack.research.propose(input);
    assert.ok(created.proposal.scope.allowedModelProfileRefs.includes('deepseek-official/deepseek-flash'));
    assert.ok(created.proposal.scope.allowedModelProfileRefs.includes('pi-ai/glm-4.6'));
  });

  it('allows an honest no_change conclusion without claiming an improvement', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-nochange',
    });
    await stack.research.start({ researchId: created.run.id });
    const completed = stack.research.complete({
      researchId: created.run.id,
      decision: 'no_change',
      baselineEvidenceRefs: ['baseline.log'],
      remainingRisks: ['没有在真实高并发环境验证'],
    });
    assert.equal(completed.outcome.decision, 'no_change');
    assert.equal(completed.run.status, 'COMPLETED');
  });
});

describe('research — cancel, expiry and execution boundaries', () => {
  it('cancels a pending proposal and refuses a later approval or start', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));

    const cancelled = stack.research.cancel({ researchId: created.run.id, actorId: team.human.id, reason: '不做了' });
    assert.equal(cancelled.run.status, 'CANCELLED');
    assert.equal(cancelled.duplicate, false);
    assert.equal(stack.researchRepository.getProposal(created.proposal.id).status, 'CANCELLED');

    await assert.rejects(
      () => stack.research.start({ researchId: created.run.id }),
      (error) => error.code === 'RESEARCH_NOT_AUTHORIZED',
    );
    assert.throws(
      () =>
        stack.research.approve({
          researchId: created.run.id,
          expectedProposalRevision: created.proposal.proposalRevision,
          scopeDigest: created.proposal.scopeDigest,
          approvedBy: team.human.id,
          idempotencyKey: 'approve-after-cancel',
        }),
      (error) => error.code === 'RESEARCH_INVALID_STATE',
    );
    assert.equal(stack.research.cancel({ researchId: created.run.id, actorId: team.human.id }).duplicate, true);
  });

  it('marks an expired approval EXPIRED and refuses to start with it', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const input = proposal(context);
    input.budget = { ...input.budget, maxWallClockMs: 1 };
    const created = await stack.research.propose(input);
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-expiring',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      () => stack.research.start({ researchId: created.run.id }),
      (error) => error.code === 'RESEARCH_NOT_AUTHORIZED' && /过期/.test(error.message),
    );
    assert.equal(stack.researchRepository.getRun(created.run.id).status, 'EXPIRED');
  });

  it('denies a write through a junction that escapes the approved workspace', async (t) => {
    const context = await freshRoom(t);
    const { stack, team, workspace } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-escape',
    });
    await stack.research.start({ researchId: created.run.id });

    const outside = mkdtempSync(join(tmpdir(), 'research-escape-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const link = join(workspace, 'escape-link');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const guard = (arguments_) => stack.research.guardResearchTool(created.run.id, { name: 'write', arguments: arguments_ });
    assert.equal(guard({ path: join(workspace, 'inside.txt') }), undefined, '批准范围内部的写入允许');
    const escaped = guard({ path: join(link, 'pwn.txt') });
    assert.match(escaped, /越出批准范围/, 'junction 解析后的真实路径越界，必须拒绝');
    assert.match(guard({ path: join(workspace, '..', 'outside.txt') }), /越出批准范围/, '.. 文本越界必须拒绝');
    assert.match(
      stack.research.guardResearchTool(created.run.id, { name: 'pwsh', arguments: { command: 'dir' } }),
      /shell/,
      '受监督原型不允许研究会话执行 shell',
    );
    assert.equal(existsSync(join(outside, 'pwn.txt')), false, '被拒绝的写入没有产生副作用');
  });

  it('stops research and revokes its grant when the project is trashed', async (t) => {
    const context = await freshRoom(t);
    const { stack, team } = context;
    const created = await stack.research.propose(proposal(context));
    await stack.research.approve({
      researchId: created.run.id,
      expectedProposalRevision: created.proposal.proposalRevision,
      scopeDigest: created.proposal.scopeDigest,
      approvedBy: team.human.id,
      idempotencyKey: 'approve-at83',
    });
    await stack.research.start({ researchId: created.run.id });
    assert.ok(stack.adapter.researchSessions.size >= 1);

    const trashed = await stack.lifecycle.trash(team.room.id, {
      expectedLifecycleRevision: 0,
      idempotencyKey: 'at83-trash',
      requestedBy: team.human.id,
    });
    assert.equal(trashed.room.status, 'trashed');
    const run = stack.researchRepository.getRun(created.run.id);
    assert.equal(run.status, 'STOPPED', '归档/回收站必须停止研究');
    assert.equal(stack.researchRepository.getEffectiveApproval(created.run.id), null, '恢复后不能复用旧批准');
    assert.ok(stack.researchRepository.listResearchSessions(created.run.id).every((session) => session.status === 'disposed'));

    await stack.lifecycle.restore(team.room.id, {
      expectedLifecycleRevision: trashed.room.lifecycleRevision,
      idempotencyKey: 'at83-restore',
      requestedBy: team.human.id,
    });
    await assert.rejects(
      () => stack.research.start({ researchId: created.run.id }),
      (error) => error.code === 'ROOM_PAUSED' || error.code === 'RESEARCH_NOT_AUTHORIZED',
      '恢复后停放在暂停态，且旧批准不能复活',
    );
  });
});
