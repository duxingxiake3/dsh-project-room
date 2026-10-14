/**
 * M0 environment probe + live-host smoke test for the Project Room plugin.
 *
 * This row exists to answer, INSIDE the real desktop host process, the questions
 * the design document's §8.3 matrix lists as "must verify": which core version
 * actually runs, whether `node:sqlite` is loadable from a plugin, which services
 * the plugin may compose, and whether this plugin's own storage and room services
 * behave in THIS runtime. It registers no services, tools or UI.
 *
 * It is deliberately self-contained (one file, no import of the plugin sources)
 * so reinstalling it cannot be defeated by a stale module cache.
 *
 * It writes one JSON report next to itself. Delete the `_probe/` package once
 * `notes/host notes` records the answers.
 */

import { createRequire } from 'node:module';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { arch, hostname, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const REPORT = join(HERE, 'probe-report.json');

function probeSqlite() {
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec('create table t(a integer, b text)');
    db.prepare('insert into t values (?, ?)').run(1, 'ok');
    const row = db.prepare('select a, b from t').get();
    const version = db.prepare('select sqlite_version() as v').get();
    db.close();
    return { ok: true, row, sqliteVersion: version?.v };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/**
 * Run the plugin's real storage + room services in this process.
 *
 * Loaded through an absolute `file://` URL with a cache-busting query so a
 * reinstall always evaluates the current sources.
 */
async function probePluginModules(ctx) {
  const steps = [];
  const errors = [];
  const step = (name, detail) => steps.push({ name, detail });
  let store = null;
  const dir = join(tmpdir(), `dpr-probe-${Date.now()}`);
  const file = join(dir, 'rooms.sqlite');
  try {
    const bust = `?v=${Date.now()}`;
    const load = (relative) => import(pathToFileURL(join(PLUGIN_ROOT, relative)).href + bust);
    const { RoomStore } = await load('src/host/storage/store.js');
    const { RoomService } = await load('src/host/room/room-service.js');
    const { ContextBuilder } = await load('src/host/room/context-builder.js');
    const { MessageService } = await load('src/host/room/message-service.js');
    const { LoopGuard } = await load('src/host/room/loop-guard.js');
    const { TaskService } = await load('src/host/tasks/task-service.js');
    const { DecisionService } = await load('src/host/decisions/decision-service.js');
    const { mergeMentions } = await load('shared/mention-resolver.js');
    step('modules-loaded', { root: PLUGIN_ROOT });

    store = new RoomStore({ file, lockFile: `${file}.lock`, logger: null });
    store.open();
    step('sqlite-open', { file, journalMode: store.db.prepare('pragma journal_mode').get() });

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
        dshVersion: 'probe',
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron ?? '',
        notes: [],
      }),
      statusOf: () => 'idle',
      observedRoutes: () => [],
      listModelProfiles: async () => [],
      deliver: (input) => {
        sent.push({ memberId: input.memberId, mode: input.mode, preview: input.message.content[0].text.slice(0, 160) });
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
      ownerRef: 'probe',
      workspaceRef: dir,
      goal: '验证群、任务与变更闭环。',
      members: [{ role: 'coordinator' }, { role: 'frontend' }, { role: 'backend' }, { role: 'tester' }],
      createSession: async (input) => {
        store.updateMember(input.memberId, { sessionId: `probe-${input.memberId}`, sessionOwnership: 'owned' });
        return { sessionId: `probe-${input.memberId}` };
      },
    });
    step('room-created', { roomId: created.room.id, members: created.members.length, warnings: created.warnings });

    const human = created.members.find((member) => member.kind === 'human');
    const backend = created.members.find((member) => member.role === 'backend');
    const frontend = created.members.find((member) => member.role === 'frontend');
    if (!human || !backend || !frontend) throw new Error('房间成员不完整');

    const resolver = rooms.resolverFor(created.room.id);
    const typed = mergeMentions({ body: '@后端 接口字段改到 v2 了', resolver });
    step('mention-typed', { targets: typed.targets.map((target) => target.targetMemberId), expected: backend.id });
    if (typed.targets.length !== 1 || typed.targets[0].targetMemberId !== backend.id) {
      throw new Error('纯文本 @后端 解析失败');
    }
    const chipped = mergeMentions({
      body: '',
      mentions: [{ targetMemberId: frontend.id, origin: 'avatar', displaySnapshot: frontend.displayName, span: null }],
      resolver,
    });
    step('mention-avatar-chip', { targets: chipped.targets.map((target) => target.targetMemberId) });
    const masked = mergeMentions({ body: '请联系 dev@example.com，代码 `@前端` 里也有', resolver });
    step('mention-masked', { targets: masked.targets.length, unknown: masked.unknownText.length });
    if (masked.targets.length !== 0) throw new Error('邮箱/行内代码不应触发点名');

    const message = await messages.send({
      roomId: created.room.id,
      authorId: human.id,
      body: '@后端 接口字段怎么变了？',
      clientMessageId: 'probe-1',
      purpose: 'question',
    });
    step('message-sent', { seq: message.message.seq, deliveries: message.message.deliveries.length });
    if (message.message.deliveries.length !== 1) throw new Error('投递记录数量不是 1');

    const again = await messages.send({
      roomId: created.room.id,
      authorId: human.id,
      body: '@后端 接口字段怎么变了？',
      clientMessageId: 'probe-1',
      purpose: 'question',
    });
    if (!again.duplicate) throw new Error('重复发送请求没有被识别为重复');
    step('idempotency', { duplicate: again.duplicate, lastSeq: store.getRoom(created.room.id).lastSeq });

    const task = tasks.propose({
      roomId: created.room.id,
      actorId: human.id,
      objective: '登录接口返回验证码错误码',
      suggestedOwnerId: backend.id,
      acceptance: ['错误码为 AUTH_CODE_INVALID'],
    });
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
      tasks.update({
        roomId: created.room.id,
        actorId: backend.id,
        taskId: task.id,
        status: 'submitted',
        evidenceRefs: ['node --test tests/auth.test.js 退出码 0'],
      });
    } catch (error) {
      gated = error.code;
    }
    step('needs-sync-gate', { refusedWith: gated });
    if (gated !== 'REVISION_CONFLICT') throw new Error('未同步新版本的任务不应被允许提交');

    const bodies = [
      '@后端 接口好了吗',
      '请发到 dev@example.com',
      '```\n@前端 在代码块里\n```',
      '@frontend @backend 你们对齐一下',
    ];
    const started = Date.now();
    for (let index = 0; index < 200; index += 1) {
      const instance = rooms.resolverFor(created.room.id);
      mergeMentions({ body: bodies[index % bodies.length], resolver: instance });
    }
    step('mention-perf', { iterations: 200, totalMs: Date.now() - started, perCallMs: Number(((Date.now() - started) / 200).toFixed(3)) });

    return { ok: true, steps, errors, delivered: sent };
  } catch (error) {
    errors.push({ message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
    ctx?.logger?.warn?.(`[project-room-probe] smoke failed: ${error?.message ?? error}`);
    return { ok: false, steps, errors };
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
}

export const name = 'project-room-probe';

export async function apply(ctx) {
  const report = {
    generatedAt: new Date().toISOString(),
    probeRevision: 2,
    pluginRoot: PLUGIN_ROOT,
    pid: process.pid,
    argv: process.argv.slice(0, 4),
    profileDir: process.env.DSH_PROFILE_DIR ?? null,
    versions: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      v8: process.versions.v8,
      modules: process.versions.modules,
      dshCore: undefined,
    },
    host: { platform: platform(), release: release(), arch: arch(), hostname: hostname() },
    sqlite: probeSqlite(),
    services: [],
    serviceErrors: {},
    modelRoutes: { agentDefaultModel: null, error: null },
    smoke: null,
  };

  const wanted = [
    'agents',
    'agentLoop',
    'tools',
    'systemPrompt',
    'storage',
    'storageDomain',
    'webServer',
    'skills',
    'commands',
    'clientModules',
    'subagents',
    'llm',
    'sessionPersistence',
    'userQuestions',
    'permissionPresets',
    'web',
  ];
  for (const key of wanted) {
    try {
      report.services.push({ key, present: ctx.get(key) !== undefined });
    } catch (error) {
      report.services.push({ key, present: false, error: String(error?.message ?? error) });
    }
  }

  try {
    const profileDir = process.env.DSH_PROFILE_DIR;
    if (profileDir) {
      const require = createRequire(join(profileDir, 'package.json'));
      const pkg = require('@deepseek-ai/dsh-base/package.json');
      report.versions.dshCore = pkg.version;
    } else {
      report.serviceErrors.dshBase = 'no DSH_PROFILE_DIR in this process';
    }
  } catch (error) {
    report.serviceErrors.dshBase = String(error?.message ?? error);
  }

  try {
    report.modelRoutes.agentDefaultModel = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null;
  } catch (error) {
    report.modelRoutes.error = String(error?.message ?? error);
  }

  report.smoke = await probePluginModules(ctx);

  try {
    writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    ctx.logger?.info?.(`[project-room-probe] report written to ${REPORT}`);
  } catch (error) {
    ctx.logger?.warn?.(`[project-room-probe] could not write report: ${error?.message ?? error}`);
  }
}
