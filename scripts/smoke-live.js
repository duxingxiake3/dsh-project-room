/**
 * Project Room — live-host smoke test.
 *
 * This one MUST run inside the real Electron host process: it verifies the two
 * facts the whole design rests on and that no shim can prove — that
 * `node:sqlite` loads inside the packaged runtime, and that the store's schema,
 * transactions and lock behave there. Unit tests run under plain Node; this file
 * runs under `DeepSeek Harness.exe`, which is a different runtime with a
 * different module resolution path.
 *
 * It creates a throwaway room, exercises the real code path, prints one JSON
 * line, and leaves nothing behind.
 *
 * Run it with the host's own Node, not the profile's:
 *   & '<DSH-APP>\DeepSeek Harness.exe' ...   (through the harness plugin, see
 *   _probe/host.js for the pattern)
 *
 * @module dsh-project-room/scripts/smoke-live
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MentionResolver, mergeMentions } from '../shared/mention-resolver.js';
import { RoomStore } from '../src/host/storage/store.js';
import { RoomService } from '../src/host/room/room-service.js';
import { ContextBuilder } from '../src/host/room/context-builder.js';
import { MessageService } from '../src/host/room/message-service.js';
import { LoopGuard } from '../src/host/room/loop-guard.js';
import { TaskService } from '../src/host/tasks/task-service.js';
import { DecisionService } from '../src/host/decisions/decision-service.js';

/**
 * Run the smoke test and return a plain report object.
 *
 * Deliberately dependency-injected: the caller supplies the `ctx`-shaped object,
 * so this same function runs under the real host (from the probe plugin) and
 * under plain Node (from a test), and the report is comparable.
 *
 * @param {object} [ctx] A Cordis-shaped context; only `logger` is used.
 * @returns {Promise<object>}
 */
export async function smoke(ctx) {
  const report = { ok: false, steps: [], errors: [], versions: { node: process.versions.node, electron: process.versions.electron ?? null } };
  const step = (name, detail) => report.steps.push({ name, detail, at: new Date().toISOString() });

  const dir = join(tmpdir(), `dpr-smoke-${Date.now()}`);
  const file = join(dir, 'rooms.sqlite');
  let store = null;
  try {
    store = new RoomStore({ file, lockFile: `${file}.lock`, logger: null });
    store.open();
    step('sqlite-open', { file, journal: store.db.prepare('pragma journal_mode').get() });
    step('sqlite-version', store.db.prepare('select sqlite_version() as v').get());

    // A minimal host-shaped adapter: this smoke test exercises storage, the room
    // services and the mention rules — NOT the model routing, which needs the
    // real host and is covered by the live room test.
    const sent = [];
    const adapter = {
      capabilities: () => ({
        ownedSessions: true,
        borrowedMainBinding: false,
        steer: true,
        stableInputIdentity: true,
        lookupAcceptedInput: true,
        observeClaimedInput: true,
        observeReply: true,
        persistence: true,
        perMemberModelRouting: true,
        modelCatalog: true,
        safeModelRebinding: true,
        sqlite: true,
        dshVersion: 'smoke',
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron ?? '',
        notes: [],
      }),
      statusOf: () => 'idle',
      observedRoutes: () => [],
      listModelProfiles: async () => [],
      deliver: (input) => {
        sent.push({ memberId: input.memberId, mode: input.mode, text: input.message.content[0].text.slice(0, 200) });
        return { actualMode: 'queue', hostMessageId: input.message.id };
      },
      reconcile: () => 'pending',
    };

    const rooms = new RoomService({ store, adapter });
    const context = new ContextBuilder({ store });
    const guard = new LoopGuard({});
    const tasks = new TaskService({ store, rooms, guard });
    const messages = new MessageService({ store, rooms, context, adapter, delivery: null });
    const decisions = new DecisionService({ store, rooms, tasks, messages });

    const created = await rooms.createRoom({
      title: '冒烟测试群',
      ownerRef: 'smoke',
      workspaceRef: dir,
      goal: '验证群、任务与变更闭环。',
      members: [{ role: 'coordinator' }, { role: 'frontend' }, { role: 'backend' }, { role: 'tester' }],
      createSession: async (input) => {
        store.updateMember(input.memberId, { sessionId: `smoke-${input.memberId}`, sessionOwnership: 'owned' });
        return { sessionId: `smoke-${input.memberId}` };
      },
    });
    step('room-created', { roomId: created.room.id, members: created.members.length, warnings: created.warnings });

    const human = created.members.find((member) => member.kind === 'human');
    const backend = created.members.find((member) => member.role === 'backend');
    const frontend = created.members.find((member) => member.role === 'frontend');
    if (!human || !backend || !frontend) throw new Error('房间成员不完整');

    // The three @ forms, on the real member table.
    const resolver = rooms.resolverFor(created.room.id);
    const typed = mergeMentions({ body: '@后端 接口字段改到 v2 了', resolver });
    step('mention-typed', { targets: typed.targets.map((target) => target.targetMemberId) });
    const chipped = mergeMentions({
      body: '',
      mentions: [{ targetMemberId: frontend.id, origin: 'avatar', displaySnapshot: frontend.displayName, span: null }],
      resolver,
    });
    step('mention-avatar-chip', { targets: chipped.targets.map((target) => target.targetMemberId) });
    const masked = mergeMentions({ body: '请联系 dev@example.com，代码 `@前端` 里也有', resolver });
    step('mention-masked', { targets: masked.targets.length, unknown: masked.unknownText.length });
    if (typed.targets.length !== 1 || typed.targets[0].targetMemberId !== backend.id) {
      throw new Error('纯文本 @后端 解析失败');
    }
    if (masked.targets.length !== 0) throw new Error('邮箱/行内代码不应触发点名');

    // A real message with deliveries.
    const message = await messages.send({
      roomId: created.room.id,
      authorId: human.id,
      body: '@后端 接口字段怎么变了？',
      clientMessageId: 'smoke-1',
      purpose: 'question',
    });
    step('message-sent', { seq: message.message.seq, deliveries: message.message.deliveries.length });
    if (message.message.deliveries.length !== 1) throw new Error('投递记录数量不是 1');

    // Idempotency: the same key must not create a second message.
    const again = await messages.send({
      roomId: created.room.id,
      authorId: human.id,
      body: '@后端 接口字段怎么变了？',
      clientMessageId: 'smoke-1',
      purpose: 'question',
    });
    if (!again.duplicate) throw new Error('重复发送请求没有被识别为重复');
    step('idempotency', { duplicate: again.duplicate, lastSeq: store.getRoom(created.room.id).lastSeq });

    // Task + human requirement change + sync gate.
    const task = tasks.propose({ roomId: created.room.id, actorId: human.id, objective: '登录接口返回验证码错误码', suggestedOwnerId: backend.id, acceptance: ['错误码为 AUTH_CODE_INVALID'] });
    tasks.assign({ roomId: created.room.id, taskId: task.id, memberId: backend.id, actorId: human.id });
    const decision = await decisions.recordHumanChange({
      roomId: created.room.id,
      sourceMessageId: message.message.id,
      statement: '验证码错误改为返回 code=AUTH_CODE_INVALID',
      scope: '登录接口',
      affectedTaskIds: [task.id],
      actorId: human.id,
    });
    step('decision-accepted', { decisionId: decision.id, revision: decision.revision, affected: decision.affectedTaskIds });
    let gated = null;
    try {
      tasks.update({ roomId: created.room.id, actorId: backend.id, taskId: task.id, status: 'submitted', evidenceRefs: ['node --test tests/auth.test.js 退出码 0'] });
    } catch (error) {
      gated = error.code;
    }
    step('needs-sync-gate', { refusedWith: gated });
    if (gated !== 'REVISION_CONFLICT') throw new Error('未同步新版本的任务不应被允许提交');

    // Baseline mention performance (the design notes target: local filter P95 ≤ 100ms).
    const bodies = [
      '@后端 接口好了吗',
      '请发到 dev@example.com',
      '```\n@前端 在代码块里\n```',
      '@frontend @backend 你们对齐一下',
    ];
    const started = Date.now();
    for (let index = 0; index < 200; index += 1) {
      const instance = new MentionResolver({ members: store.listMembers(created.room.id), membershipRevision: 1 });
      mergeMentions({ body: bodies[index % bodies.length], resolver: instance });
    }
    step('mention-perf', { iterations: 200, totalMs: Date.now() - started, perCallMs: (Date.now() - started) / 200 });

    report.ok = true;
  } catch (error) {
    report.errors.push({ message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
    ctx?.logger?.warn?.(`[project-room] smoke failed: ${error?.message ?? error}`);
  } finally {
    try {
      store?.close();
    } catch {
      /* nothing left to do */
    }
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp directory is harmless */
    }
  }
  return report;
}
