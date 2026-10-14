/**
 * Project Room — durable store.
 *
 * The room database is the authority for "this group message was saved"; the
 * host session log is the authority for "this input entered a turn". They are
 * deliberately different ledgers (the design notes), and this module owns only the
 * first one.
 *
 * Design choices worth stating out loud:
 *
 *   - **SQLite through `node:sqlite`.** Verified present in the desktop host
 *     (Node 24.18.1 / SQLite 3.53.1) with no native build step, so group
 *     messages, deliveries, tasks and decisions share one transaction boundary
 *     as §9.2 requires.
 *   - **A single writer.** A lock file beside the database refuses a second
 *     process rather than letting two writers interleave (the design notes).
 *   - **Migration with a backup.** `schemaVersion` is stored in `meta`;
 *     upgrading copies the file aside first, and a failed migration stops
 *     writes instead of leaving half-converted data (the design notes).
 *   - **`seq` is the only ordering authority.** Timestamps are for display;
 *     `last_seq` is bumped inside the same transaction that inserts the message
 *     and its event, so a message and its `message.created` event can never
 *     carry two different numbers.
 *
 * @module dsh-project-room/src/host/storage/store
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { RoomError, canTransition, isoTimestamp } from '../../../shared/contracts.js';
import { backupDir, databasePath, ensureDir, lockPath } from './paths.js';

/** Bump when the schema changes; migrations below must handle every older value. */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
create table if not exists meta (
  key   text primary key,
  value text not null
);

create table if not exists room (
  id                  text primary key,
  title               text not null,
  workspace_ref       text,
  owner_ref           text not null,
  status              text not null,
  language            text not null,
  plan_revision       integer not null default 0,
  membership_revision integer not null default 0,
  last_seq            integer not null default 0,
  config              text not null default '{}',
  created_at          text not null,
  updated_at          text not null
);

create table if not exists member (
  id                       text primary key,
  room_id                  text not null references room(id) on delete cascade,
  kind                     text not null,
  role                     text not null,
  display_name             text not null,
  handle                   text not null,
  aliases                  text not null default '[]',
  status                   text not null,
  membership_revision      integer not null default 1,
  persona_revision         integer not null default 1,
  model_profile_ref        text,
  model_config_revision    integer not null default 0,
  selection_mode           text not null default 'fixed',
  selection_source         text not null default 'project-default',
  model_locked             integer not null default 1,
  current_task_id          text,
  session_id               text,
  session_ownership        text,
  last_seen_seq            integer not null default 0,
  last_applied_decision_revision integer not null default 0,
  created_at               text not null,
  updated_at               text not null
);
create unique index if not exists member_session_unique on member(session_id) where session_id is not null;
create index if not exists member_room on member(room_id);

create table if not exists member_alias (
  room_id          text not null,
  normalized_alias text not null,
  member_id        text not null,
  state            text not null default 'active',
  created_at       text not null,
  primary key (room_id, normalized_alias)
);

create table if not exists member_session (
  member_id       text not null,
  session_id      text not null,
  ownership       text not null,
  runtime_kind    text not null default 'root',
  config_revision integer not null default 0,
  active          integer not null default 1,
  created_at      text not null,
  primary key (member_id, session_id)
);

create table if not exists member_model_revision (
  member_id        text not null,
  revision         integer not null,
  profile_ref      text not null,
  selection_source text not null,
  effective_at     text not null,
  reason           text,
  status           text not null,
  primary key (member_id, revision)
);

create table if not exists model_profile (
  id                text primary key,
  host_profile_ref  text,
  provider_route    text not null,
  model_id          text not null,
  label             text not null default '',
  capabilities      text not null default '[]',
  capabilities_revision integer not null default 0,
  created_at        text not null
);

create table if not exists model_invocation (
  id                    text primary key,
  room_id               text not null,
  member_id             text not null,
  session_id            text,
  host_request_ref      text,
  task_attempt_id       text,
  model_config_revision integer not null default 0,
  provider_route        text not null,
  model_id              text not null,
  usage                 text not null default '{}',
  created_at            text not null
);

create table if not exists room_event (
  room_id    text not null,
  seq        integer not null,
  event_type text not null,
  payload    text not null,
  created_at text not null,
  primary key (room_id, seq)
);

create table if not exists message (
  id                text primary key,
  room_id           text not null references room(id) on delete cascade,
  seq               integer not null,
  author_id         text not null,
  author_kind       text not null,
  body              text not null,
  mentions          text not null default '[]',
  reply_to          text,
  thread_id         text,
  task_id           text,
  causal_root_id    text not null,
  client_message_id text not null,
  payload_hash      text not null,
  created_at        text not null,
  unique (room_id, author_id, client_message_id)
);
create index if not exists message_room_seq on message(room_id, seq);

create table if not exists delivery (
  message_id       text not null references message(id) on delete cascade,
  recipient_id     text not null,
  status           text not null,
  requested_mode   text not null,
  actual_mode      text,
  host_message_id  text,
  delivery_attempt integer not null default 0,
  updated_at       text not null,
  error_code       text,
  detail           text,
  primary key (message_id, recipient_id)
);

create table if not exists plan (
  id                text primary key,
  room_id           text not null references room(id) on delete cascade,
  revision          integer not null,
  source_message_id text,
  scope             text not null,
  status            text not null,
  task_ids          text not null default '[]',
  assumptions       text not null default '[]',
  coverage          text not null default '{}',
  created_at        text not null,
  updated_at        text not null
);

create table if not exists task (
  id                   text primary key,
  room_id              text not null references room(id) on delete cascade,
  plan_id              text,
  parent_task_id       text,
  objective            text not null,
  owner_id             text,
  required_role        text,
  required_capabilities text not null default '[]',
  deliverables         text not null default '[]',
  status               text not null,
  revision             integer not null default 1,
  decision_revision    integer not null default 0,
  acceptance           text not null default '[]',
  dependencies         text not null default '[]',
  assignment_revision  text not null default 'a1',
  needs_sync           integer not null default 0,
  created_at           text not null,
  updated_at           text not null
);
create index if not exists task_room on task(room_id);

create table if not exists task_attempt (
  id                    text primary key,
  task_id               text not null references task(id) on delete cascade,
  room_id               text not null,
  actor_id              text,
  base_revision         integer not null default 0,
  assignment_revision   text not null default 'a1',
  model_config_revision integer not null default 0,
  state                 text not null,
  worktree_ref          text,
  result_ref            text,
  created_at            text not null,
  updated_at            text not null
);
create index if not exists attempt_task on task_attempt(task_id);

create table if not exists decision (
  id                text primary key,
  room_id           text not null references room(id) on delete cascade,
  revision          integer not null,
  status            text not null,
  source_message_id text not null,
  scope             text not null,
  statement         text not null,
  supersedes        text,
  accepted_by       text,
  affected_task_ids text not null default '[]',
  created_at        text not null
);
create index if not exists decision_room_rev on decision(room_id, revision);

create table if not exists decision_ack (
  decision_id         text not null references decision(id) on delete cascade,
  member_id           text not null,
  state               text not null,
  applied_task_revision integer,
  detail              text,
  updated_at          text not null,
  primary key (decision_id, member_id)
);

create table if not exists artifact (
  id           text primary key,
  room_id      text not null references room(id) on delete cascade,
  task_id      text,
  attempt_id   text,
  kind         text not null,
  location     text not null,
  content_hash text,
  evidence_ref text,
  verified     integer not null default 0,
  created_at   text not null
);
create index if not exists artifact_task on artifact(task_id);

create table if not exists discussion (
  id            text primary key,
  room_id       text not null references room(id) on delete cascade,
  topic         text not null,
  participants  text not null default '[]',
  status        text not null,
  decision_ref  text,
  created_at    text not null,
  updated_at    text not null
);

create table if not exists reminder (
  id         text primary key,
  room_id    text not null,
  task_id    text,
  target_id  text not null,
  due_at     text not null,
  dedupe_key text not null,
  state      text not null,
  created_at text not null,
  unique (room_id, dedupe_key)
);

create table if not exists dispatch (
  dispatch_key text primary key,
  room_id      text not null,
  plan_id      text,
  task_id      text,
  member_id    text,
  state        text not null,
  detail       text,
  created_at   text not null,
  updated_at   text not null
);

create table if not exists admin_note (
  id         text primary key,
  room_id    text not null,
  kind       text not null,
  body       text not null,
  created_at text not null
);
`;

/**
 * Parse a JSON text column, falling back to a default instead of throwing on
 * data that a future version wrote.
 * @template T
 * @param {unknown} value
 * @param {T} fallback
 * @returns {T}
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

/**
 * Stable content hash for send idempotency: the same `clientMessageId` with a
 * different payload is a conflict, not a retry (the design notes).
 * @param {object} input
 * @returns {string}
 */
export function payloadHash(input) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        body: input.body ?? '',
        mentions: (input.mentions ?? []).map((mention) => mention.targetMemberId).sort(),
        replyTo: input.replyTo ?? null,
        threadId: input.threadId ?? null,
        taskId: input.taskId ?? null,
      }),
    )
    .digest('hex');
}

/**
 * The room store. One instance per plugin activation; it owns the SQLite handle
 * and the writer lock.
 */
export class RoomStore {
  /**
   * @param {object} [options]
   * @param {string} [options.file]        Database path; defaults to the DSH home.
   * @param {string} [options.lockFile]    Lock path; defaults to beside the database.
   * @param {boolean} [options.singleWriter] Whether to take the process lock.
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    this.file = options.file ?? databasePath();
    this.lockFile = options.lockFile ?? (options.file ? `${options.file}.lock` : lockPath());
    this.singleWriter = options.singleWriter !== false;
    this.logger = options.logger ?? null;
    this.db = null;
    this.migrations = [];
    this.closed = false;

    ensureDir(this.file.replace(/[\\/][^\\/]+$/, ''));
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Open the database, take the writer lock, validate the schema version and
   * run migrations.
   * @returns {RoomStore}
   */
  open() {
    if (this.db) return this;
    if (this.singleWriter) this.#acquireLock();
    try {
      this.db = new DatabaseSync(this.file);
      this.db.exec('pragma journal_mode = WAL');
      this.db.exec('pragma foreign_keys = ON');
      this.db.exec('pragma busy_timeout = 4000');
      this.#migrate();
    } catch (error) {
      // A failed open must not leave the lock behind for the next process.
      this.db?.close?.();
      this.db = null;
      this.#releaseLock();
      throw error;
    }
    return this;
  }

  /** Close the handle and release the lock. Idempotent. */
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db?.close?.();
    } finally {
      this.db = null;
      this.#releaseLock();
    }
  }

  /**
   * Run `operation` inside one transaction. Nested calls join the outer
   * transaction rather than opening a second one, so a service may compose.
   * @template T
   * @param {() => T} operation
   * @returns {T}
   */
  transaction(operation) {
    const db = this.#db();
    if (this.inTransaction) return operation();
    db.exec('begin immediate');
    this.inTransaction = true;
    try {
      const result = operation();
      db.exec('commit');
      return result;
    } catch (error) {
      try {
        db.exec('rollback');
      } catch {
        /* the transaction was already rolled back by SQLite */
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /** @returns {DatabaseSync} */
  #db() {
    if (!this.db) throw new RoomError('INTERNAL', '群数据库尚未打开。');
    return this.db;
  }

  #acquireLock() {
    if (existsSync(this.lockFile)) {
      const raw = readFileSync(this.lockFile, 'utf8');
      const [pidText, stamp] = raw.split('|');
      const pid = Number(pidText);
      if (Number.isFinite(pid) && pid === process.pid) {
        // The same process already holds this database. Two RoomStore instances
        // over one file would interleave transactions behind SQLite's back, so
        // this is refused exactly like a second process (the design notes).
        throw new RoomError(
          'FORBIDDEN',
          `本进程已经打开了同一个项目群数据库（${this.file}），已拒绝第二个写入者；请复用同一个群服务实例。`,
          { file: this.file, since: stamp },
        );
      }
      if (Number.isFinite(pid) && isProcessAlive(pid)) {
        throw new RoomError(
          'FORBIDDEN',
          `项目群数据已被另一个 Harness 进程（pid ${pid}）占用，已拒绝第二个写入者。请先关闭那个实例。`,
          { pid, since: stamp },
        );
      }
      // A stale lock from a dead process is ours to replace.
      this.logger?.warn?.(`[project-room] replacing stale writer lock from pid ${pidText}`);
    }
    writeFileSync(this.lockFile, `${process.pid}|${isoTimestamp()}`, 'utf8');
  }

  #releaseLock() {
    if (!this.singleWriter) return;
    try {
      if (!existsSync(this.lockFile)) return;
      const [pidText] = readFileSync(this.lockFile, 'utf8').split('|');
      if (Number(pidText) === process.pid) rmSync(this.lockFile, { force: true });
    } catch {
      /* releasing the lock is best-effort by design */
    }
  }

  #migrate() {
    const db = this.#db();
    db.exec(SCHEMA);
    const row = db.prepare('select value from meta where key = ?').get('schemaVersion');
    const current = row ? Number(row.value) : null;

    if (current === null) {
      db.prepare('insert or replace into meta (key, value) values (?, ?)').run('schemaVersion', String(SCHEMA_VERSION));
      db.prepare('insert or replace into meta (key, value) values (?, ?)').run('createdAt', isoTimestamp());
      return;
    }
    if (current === SCHEMA_VERSION) return;

    // Older data: back it up before touching it, and refuse to continue if the
    // copy cannot be made (the design notes).
    const backup = join(backupDir(), `pre-migration-v${current}-${Date.now()}.sqlite`);
    try {
      copyFileSync(this.file, backup);
    } catch (error) {
      throw new RoomError('INTERNAL', `迁移前备份失败，已停止写入以保留旧数据：${String(error?.message ?? error)}`);
    }
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      const step = this.migrations.find((migration) => migration.from === version);
      if (!step) {
        throw new RoomError('INTERNAL', `缺少 v${version} → v${version + 1} 的迁移步骤，已停止写入（备份在 ${backup}）。`);
      }
      step.run(db);
    }
    db.prepare('insert or replace into meta (key, value) values (?, ?)').run('schemaVersion', String(SCHEMA_VERSION));
    this.logger?.info?.(`[project-room] migrated room database v${current} → v${SCHEMA_VERSION}, backup at ${backup}`);
  }

  /* ---------------------------------------------------------------- *
   * Rooms
   * ---------------------------------------------------------------- */

  /**
   * @param {object} room
   * @returns {object}
   */
  insertRoom(room) {
    const now = isoTimestamp();
    this.#db()
      .prepare(
        `insert into room (id, title, workspace_ref, owner_ref, status, language, plan_revision,
                           membership_revision, last_seq, config, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        room.id,
        room.title,
        room.workspaceRef ?? null,
        room.ownerRef,
        room.status ?? 'active',
        room.language ?? 'zh-CN',
        room.planRevision ?? 0,
        room.membershipRevision ?? 0,
        room.lastSeq ?? 0,
        JSON.stringify(room.config ?? {}),
        room.createdAt ?? now,
        now,
      );
    return this.getRoom(room.id);
  }

  /** @param {string} roomId */
  getRoom(roomId) {
    const row = this.#db().prepare('select * from room where id = ?').get(roomId);
    return row ? mapRoom(row) : null;
  }

  /** @returns {object[]} */
  listRooms() {
    return this.#db()
      .prepare('select * from room order by updated_at desc')
      .all()
      .map(mapRoom);
  }

  /**
   * Patch a room row. Only the keys present are written.
   * @param {string} roomId
   * @param {object} patch
   */
  updateRoom(roomId, patch) {
    const columns = {
      title: 'title',
      status: 'status',
      planRevision: 'plan_revision',
      membershipRevision: 'membership_revision',
      lastSeq: 'last_seq',
      language: 'language',
      workspaceRef: 'workspace_ref',
      config: 'config',
    };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(key === 'config' ? JSON.stringify(patch[key] ?? {}) : patch[key]);
    }
    if (sets.length === 0) return this.getRoom(roomId);
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), roomId);
    this.#db()
      .prepare(`update room set ${sets.join(', ')} where id = ?`)
      .run(...values);
    return this.getRoom(roomId);
  }

  /** Delete a room and everything that hangs off it. */
  deleteRoom(roomId) {
    this.#db().prepare('delete from room where id = ?').run(roomId);
  }

  /**
   * Bump and return the room's `membershipRevision`.
   * @param {string} roomId
   * @returns {number}
   */
  bumpMembershipRevision(roomId) {
    const room = this.getRoom(roomId);
    if (!room) throw new RoomError('NOT_FOUND', `项目群 ${roomId} 不存在。`);
    const next = room.membershipRevision + 1;
    this.updateRoom(roomId, { membershipRevision: next });
    return next;
  }

  /**
   * Bump and return the room's `planRevision`.
   * @param {string} roomId
   * @returns {number}
   */
  bumpPlanRevision(roomId) {
    const room = this.getRoom(roomId);
    if (!room) throw new RoomError('NOT_FOUND', `项目群 ${roomId} 不存在。`);
    const next = room.planRevision + 1;
    this.updateRoom(roomId, { planRevision: next });
    return next;
  }

  /* ---------------------------------------------------------------- *
   * Members and aliases
   * ---------------------------------------------------------------- */

  /** @param {object} member */
  insertMember(member) {
    const now = isoTimestamp();
    this.#db()
      .prepare(
        `insert into member (id, room_id, kind, role, display_name, handle, aliases, status,
                             membership_revision, persona_revision, model_profile_ref,
                             model_config_revision, selection_mode, selection_source, model_locked,
                             current_task_id, session_id, session_ownership, last_seen_seq,
                             last_applied_decision_revision, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        member.id,
        member.roomId,
        member.kind,
        member.role,
        member.displayName,
        member.handle,
        JSON.stringify(member.aliases ?? []),
        member.status ?? 'idle',
        member.membershipRevision ?? 1,
        member.personaRevision ?? 1,
        member.modelProfileRef ?? null,
        member.modelConfigRevision ?? 0,
        member.selectionMode ?? 'fixed',
        member.selectionSource ?? 'project-default',
        member.modelLocked === false ? 0 : 1,
        member.currentTaskId ?? null,
        member.sessionId ?? null,
        member.sessionOwnership ?? null,
        member.lastSeenSeq ?? 0,
        member.lastAppliedDecisionRevision ?? 0,
        member.createdAt ?? now,
        now,
      );
    return this.getMember(member.id);
  }

  /** @param {string} memberId */
  getMember(memberId) {
    const row = this.#db().prepare('select * from member where id = ?').get(memberId);
    return row ? mapMember(row) : null;
  }

  /**
   * @param {string} roomId
   * @param {{ includeRetired?: boolean }} [options]
   * @returns {object[]}
   */
  listMembers(roomId, options = {}) {
    const includeRetired = options.includeRetired === true;
    const rows = includeRetired
      ? this.#db().prepare('select * from member where room_id = ? order by created_at').all(roomId)
      : this.#db()
          .prepare("select * from member where room_id = ? and status <> 'offline' order by created_at")
          .all(roomId);
    return rows.map(mapMember);
  }

  /**
   * Patch a member row.
   * @param {string} memberId
   * @param {object} patch
   */
  updateMember(memberId, patch) {
    const columns = {
      displayName: 'display_name',
      role: 'role',
      aliases: 'aliases',
      status: 'status',
      membershipRevision: 'membership_revision',
      personaRevision: 'persona_revision',
      modelProfileRef: 'model_profile_ref',
      modelConfigRevision: 'model_config_revision',
      selectionMode: 'selection_mode',
      selectionSource: 'selection_source',
      modelLocked: 'model_locked',
      currentTaskId: 'current_task_id',
      sessionId: 'session_id',
      sessionOwnership: 'session_ownership',
      lastSeenSeq: 'last_seen_seq',
      lastAppliedDecisionRevision: 'last_applied_decision_revision',
    };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      const value = patch[key];
      if (key === 'aliases') values.push(JSON.stringify(value ?? []));
      else if (key === 'modelLocked') values.push(value === false ? 0 : 1);
      else values.push(value);
    }
    if (sets.length === 0) return this.getMember(memberId);
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), memberId);
    this.#db()
      .prepare(`update member set ${sets.join(', ')} where id = ?`)
      .run(...values);
    return this.getMember(memberId);
  }

  /**
   * Register one alias for a member. Refuses a name already active for another
   * member, and refuses a tombstoned name (the design notes rule 12: "禁止注册规范化
   * 后冲突的别名").
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.normalizedAlias
   * @param {string} input.memberId
   * @returns {'registered' | 'already-owned'}
   */
  registerAlias(input) {
    const existing = this.#db()
      .prepare('select * from member_alias where room_id = ? and normalized_alias = ?')
      .get(input.roomId, input.normalizedAlias);
    if (existing) {
      if (existing.member_id === input.memberId && existing.state === 'active') return 'already-owned';
      throw new RoomError('MENTION_AMBIGUOUS', `别名“${input.normalizedAlias}”已被占用或已停用，不能重复注册。`, {
        alias: input.normalizedAlias,
        owner: existing.member_id,
        state: existing.state,
      });
    }
    this.#db()
      .prepare('insert into member_alias (room_id, normalized_alias, member_id, state, created_at) values (?, ?, ?, ?, ?)')
      .run(input.roomId, input.normalizedAlias, input.memberId, 'active', isoTimestamp());
    return 'registered';
  }

  /**
   * Retire every alias of a member into tombstones.
   * @param {string} memberId
   * @param {string} roomId
   */
  retireAliases(memberId, roomId) {
    this.#db()
      .prepare("update member_alias set state = 'tombstone' where member_id = ? and room_id = ?")
      .run(memberId, roomId);
  }

  /**
   * Names that must not resolve to anyone, because their owner left.
   * @param {string} roomId
   * @returns {string[]}
   */
  listTombstones(roomId) {
    return this.#db()
      .prepare("select normalized_alias from member_alias where room_id = ? and state = 'tombstone'")
      .all(roomId)
      .map((row) => row.normalized_alias);
  }

  /** @param {object} record */
  appendModelRevision(record) {
    this.#db()
      .prepare(
        `insert or replace into member_model_revision
           (member_id, revision, profile_ref, selection_source, effective_at, reason, status)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.memberId,
        record.revision,
        record.profileRef,
        record.selectionSource,
        record.effectiveAt ?? isoTimestamp(),
        record.reason ?? null,
        record.status ?? 'applied',
      );
  }

  /** @param {string} memberId */
  listModelRevisions(memberId) {
    return this.#db()
      .prepare('select * from member_model_revision where member_id = ? order by revision desc')
      .all(memberId)
      .map((row) => ({
        memberId: row.member_id,
        revision: row.revision,
        profileRef: row.profile_ref,
        selectionSource: row.selection_source,
        effectiveAt: row.effective_at,
        reason: row.reason,
        status: row.status,
      }));
  }

  /* ---------------------------------------------------------------- *
   * Model profiles
   * ---------------------------------------------------------------- */

  /** @param {object} profile */
  upsertModelProfile(profile) {
    this.#db()
      .prepare(
        `insert or replace into model_profile
           (id, host_profile_ref, provider_route, model_id, label, capabilities, capabilities_revision, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.hostProfileRef ?? null,
        profile.providerRoute,
        profile.modelId,
        profile.label ?? '',
        JSON.stringify(profile.capabilities ?? []),
        profile.capabilitiesRevision ?? 0,
        profile.createdAt ?? isoTimestamp(),
      );
    return this.getModelProfile(profile.id);
  }

  /** @param {string} id */
  getModelProfile(id) {
    const row = this.#db().prepare('select * from model_profile where id = ?').get(id);
    return row ? mapModelProfile(row) : null;
  }

  /** @returns {object[]} */
  listModelProfiles() {
    return this.#db()
      .prepare('select * from model_profile order by provider_route, model_id')
      .all()
      .map(mapModelProfile);
  }

  /** @param {object} invocation */
  recordInvocation(invocation) {
    this.#db()
      .prepare(
        `insert or replace into model_invocation
           (id, room_id, member_id, session_id, host_request_ref, task_attempt_id,
            model_config_revision, provider_route, model_id, usage, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invocation.id ?? randomUUID(),
        invocation.roomId,
        invocation.memberId,
        invocation.sessionId ?? null,
        invocation.hostRequestRef ?? null,
        invocation.taskAttemptId ?? null,
        invocation.modelConfigRevision ?? 0,
        invocation.providerRoute,
        invocation.modelId,
        JSON.stringify(invocation.usage ?? {}),
        invocation.createdAt ?? isoTimestamp(),
      );
  }

  /* ---------------------------------------------------------------- *
   * Events, messages and deliveries
   * ---------------------------------------------------------------- */

  /**
   * Append one room event, assigning the next `seq`.
   *
   * `message.created` is special-cased by its caller: the message row and this
   * event share one `seq` so nothing can observe two different orders for one
   * creation (the design notes).
   *
   * @param {object} input
   * @param {string} input.roomId
   * @param {string} input.eventType
   * @param {object} input.payload
   * @param {number} [input.seq]  Explicit seq (used to share one with a message).
   * @returns {{ seq: number, event: object }}
   */
  appendEvent(input) {
    const room = this.getRoom(input.roomId);
    if (!room) throw new RoomError('NOT_FOUND', `项目群 ${input.roomId} 不存在。`);
    const seq = input.seq ?? room.lastSeq + 1;
    if (seq > room.lastSeq) this.updateRoom(input.roomId, { lastSeq: seq });
    const createdAt = isoTimestamp();
    this.#db()
      .prepare('insert into room_event (room_id, seq, event_type, payload, created_at) values (?, ?, ?, ?, ?)')
      .run(input.roomId, seq, input.eventType, JSON.stringify(input.payload ?? {}), createdAt);
    return {
      seq,
      event: { roomId: input.roomId, seq, eventType: input.eventType, payload: input.payload ?? {}, createdAt },
    };
  }

  /**
   * Messages after a cursor, oldest first.
   * @param {string} roomId
   * @param {{ afterSeq?: number, limit?: number, threadId?: string, taskId?: string }} [options]
   * @returns {object[]}
   */
  listMessages(roomId, options = {}) {
    const afterSeq = Number.isFinite(options.afterSeq) ? options.afterSeq : 0;
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, options.limit)) : 200;
    const clauses = ['room_id = ?', 'seq > ?'];
    const values = [roomId, afterSeq];
    if (options.threadId) {
      clauses.push('thread_id = ?');
      values.push(options.threadId);
    }
    if (options.taskId) {
      clauses.push('task_id = ?');
      values.push(options.taskId);
    }
    values.push(limit);
    const rows = this.#db()
      .prepare(`select * from message where ${clauses.join(' and ')} order by seq asc limit ?`)
      .all(...values);
    return rows.map((row) => this.#hydrateMessage(row));
  }

  /**
   * Messages after a cursor, newest first — the order `room_read` needs when a
   * member asks "what did I miss" without paging the whole history.
   * @param {string} roomId
   * @param {{ limit?: number, threadId?: string, taskId?: string }} [options]
   * @returns {object[]}
   */
  listRecentMessages(roomId, options = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, options.limit)) : 30;
    const clauses = ['room_id = ?'];
    const values = [roomId];
    if (options.threadId) {
      clauses.push('thread_id = ?');
      values.push(options.threadId);
    }
    if (options.taskId) {
      clauses.push('task_id = ?');
      values.push(options.taskId);
    }
    values.push(limit);
    const rows = this.#db()
      .prepare(`select * from message where ${clauses.join(' and ')} order by seq desc limit ?`)
      .all(...values);
    return rows.reverse().map((row) => this.#hydrateMessage(row));
  }

  /** @param {string} messageId */
  getMessage(messageId) {
    const row = this.#db().prepare('select * from message where id = ?').get(messageId);
    return row ? this.#hydrateMessage(row) : null;
  }

  /**
   * Find an existing message by its idempotency key.
   * @param {string} roomId
   * @param {string} authorId
   * @param {string} clientMessageId
   * @returns {object | null}
   */
  findMessageByClientKey(roomId, authorId, clientMessageId) {
    const row = this.#db()
      .prepare('select * from message where room_id = ? and author_id = ? and client_message_id = ?')
      .get(roomId, authorId, clientMessageId);
    return row ? this.#hydrateMessage(row) : null;
  }

  /**
   * Insert one message row. The caller supplies the `seq` it already assigned
   * to the matching `message.created` event.
   * @param {object} message
   * @returns {object}
   */
  insertMessage(message) {
    this.#db()
      .prepare(
        `insert into message (id, room_id, seq, author_id, author_kind, body, mentions, reply_to,
                              thread_id, task_id, causal_root_id, client_message_id, payload_hash, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.roomId,
        message.seq,
        message.authorId,
        message.authorKind,
        message.body,
        JSON.stringify(message.mentions ?? []),
        message.replyTo ?? null,
        message.threadId ?? null,
        message.taskId ?? null,
        message.causalRootId,
        message.clientMessageId,
        message.payloadHash,
        message.createdAt ?? isoTimestamp(),
      );
    return this.getMessage(message.id);
  }

  /**
   * Create or update one delivery record.
   * @param {object} delivery
   * @returns {object}
   */
  upsertDelivery(delivery) {
    this.#db()
      .prepare(
        `insert into delivery (message_id, recipient_id, status, requested_mode, actual_mode,
                               host_message_id, delivery_attempt, updated_at, error_code, detail)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (message_id, recipient_id) do update set
           status = excluded.status,
           actual_mode = excluded.actual_mode,
           host_message_id = coalesce(excluded.host_message_id, delivery.host_message_id),
           delivery_attempt = excluded.delivery_attempt,
           updated_at = excluded.updated_at,
           error_code = excluded.error_code,
           detail = excluded.detail`,
      )
      .run(
        delivery.messageId,
        delivery.recipientId,
        delivery.status,
        delivery.requestedMode ?? 'queue',
        delivery.actualMode ?? null,
        delivery.hostMessageId ?? null,
        delivery.deliveryAttempt ?? 0,
        delivery.updatedAt ?? isoTimestamp(),
        delivery.errorCode ?? null,
        delivery.detail ?? null,
      );
    return this.getDelivery(delivery.messageId, delivery.recipientId);
  }

  /**
   * @param {string} messageId
   * @param {string} recipientId
   * @returns {object | null}
   */
  getDelivery(messageId, recipientId) {
    const row = this.#db()
      .prepare('select * from delivery where message_id = ? and recipient_id = ?')
      .get(messageId, recipientId);
    return row ? mapDelivery(row) : null;
  }

  /**
   * Deliveries that still need work, oldest first — the recovery ledger.
   * @param {string} roomId
   * @param {string[]} [statuses]
   * @returns {object[]}
   */
  listPendingDeliveries(roomId, statuses = ['pending', 'paused', 'admitting', 'uncertain']) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.#db()
      .prepare(
        `select d.* from delivery d join message m on m.id = d.message_id
          where m.room_id = ? and d.status in (${placeholders})
          order by m.seq asc`,
      )
      .all(roomId, ...statuses);
    return rows.map(mapDelivery);
  }

  /**
   * Deliveries for one member that were accepted or claimed and never replied —
   * what "waiting for you" means for the member's status line.
   * @param {string} roomId
   * @param {string} recipientId
   * @returns {object[]}
   */
  listOpenDeliveries(roomId, recipientId) {
    const rows = this.#db()
      .prepare(
        `select d.* from delivery d join message m on m.id = d.message_id
          where m.room_id = ? and d.recipient_id = ? and d.status in ('accepted', 'claimed')
          order by m.seq asc`,
      )
      .all(roomId, recipientId);
    return rows.map(mapDelivery);
  }

  #hydrateMessage(row) {
    const deliveries = this.#db()
      .prepare('select * from delivery where message_id = ? order by recipient_id')
      .all(row.id)
      .map(mapDelivery);
    return {
      id: row.id,
      roomId: row.room_id,
      seq: row.seq,
      authorId: row.author_id,
      authorKind: row.author_kind,
      body: row.body,
      mentions: parseJson(row.mentions, []),
      replyTo: row.reply_to ?? null,
      threadId: row.thread_id ?? null,
      taskId: row.task_id ?? null,
      causalRootId: row.causal_root_id,
      clientMessageId: row.client_message_id,
      // The request-level payload hash, kept so a retry of the same send request
      // can be recognised as a duplicate even though `mentions` below holds the
      // RESOLVED targets (the design notes).
      payloadHash: row.payload_hash,
      createdAt: row.created_at,
      deliveries,
    };
  }

  /* ---------------------------------------------------------------- *
   * Tasks, plans, decisions, artifacts
   * ---------------------------------------------------------------- */

  /** @param {object} task */
  insertTask(task) {
    const now = isoTimestamp();
    this.#db()
      .prepare(
        `insert into task (id, room_id, plan_id, parent_task_id, objective, owner_id, required_role,
                           required_capabilities, deliverables, status, revision, decision_revision,
                           acceptance, dependencies, assignment_revision, needs_sync, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.roomId,
        task.planId ?? null,
        task.parentTaskId ?? null,
        task.objective,
        task.ownerId ?? null,
        task.requiredRole ?? null,
        JSON.stringify(task.requiredCapabilities ?? []),
        JSON.stringify(task.deliverables ?? []),
        task.status ?? 'proposed',
        task.revision ?? 1,
        task.decisionRevision ?? 0,
        JSON.stringify(task.acceptance ?? []),
        JSON.stringify(task.dependencies ?? []),
        task.assignmentRevision ?? 'a1',
        task.needsSync ? 1 : 0,
        task.createdAt ?? now,
        now,
      );
    return this.getTask(task.id);
  }

  /** @param {string} taskId */
  getTask(taskId) {
    const row = this.#db().prepare('select * from task where id = ?').get(taskId);
    return row ? mapTask(row) : null;
  }

  /**
   * @param {string} roomId
   * @param {{ statuses?: string[], ownerId?: string, planId?: string }} [options]
   * @returns {object[]}
   */
  listTasks(roomId, options = {}) {
    const clauses = ['room_id = ?'];
    const values = [roomId];
    if (Array.isArray(options.statuses) && options.statuses.length > 0) {
      clauses.push(`status in (${options.statuses.map(() => '?').join(', ')})`);
      values.push(...options.statuses);
    }
    if (options.ownerId) {
      clauses.push('owner_id = ?');
      values.push(options.ownerId);
    }
    if (options.planId) {
      clauses.push('plan_id = ?');
      values.push(options.planId);
    }
    return this.#db()
      .prepare(`select * from task where ${clauses.join(' and ')} order by created_at asc`)
      .all(...values)
      .map(mapTask);
  }

  /**
   * Patch a task, enforcing the transition table and the expected revision.
   *
   * A stale `expectedRevision` is a conflict the caller must resolve by
   * re-reading, never a silent overwrite (the design notes).
   *
   * @param {string} taskId
   * @param {object} patch
   * @param {{ expectedRevision?: number }} [options]
   * @returns {object}
   */
  updateTask(taskId, patch, options = {}) {
    const current = this.getTask(taskId);
    if (!current) throw new RoomError('NOT_FOUND', `任务 ${taskId} 不存在。`);
    if (Number.isFinite(options.expectedRevision) && options.expectedRevision !== current.revision) {
      throw new RoomError(
        'REVISION_CONFLICT',
        `任务已被其他人更新（当前 r${current.revision}，你提交的是 r${options.expectedRevision}）。请重新读取后再提交。`,
        { current: current.revision, expected: options.expectedRevision, taskId },
      );
    }
    if (patch.status && patch.status !== current.status && !canTransition(current.status, patch.status)) {
      throw new RoomError('INVALID_REQUEST', `任务状态不能从 ${current.status} 直接变为 ${patch.status}。`, {
        from: current.status,
        to: patch.status,
      });
    }

    const columns = {
      objective: 'objective',
      ownerId: 'owner_id',
      requiredRole: 'required_role',
      requiredCapabilities: 'required_capabilities',
      deliverables: 'deliverables',
      status: 'status',
      decisionRevision: 'decision_revision',
      acceptance: 'acceptance',
      dependencies: 'dependencies',
      assignmentRevision: 'assignment_revision',
      needsSync: 'needs_sync',
      planId: 'plan_id',
      parentTaskId: 'parent_task_id',
    };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      const value = patch[key];
      if (['requiredCapabilities', 'deliverables', 'acceptance', 'dependencies'].includes(key)) {
        values.push(JSON.stringify(value ?? []));
      } else if (key === 'needsSync') {
        values.push(value ? 1 : 0);
      } else {
        values.push(value);
      }
    }
    sets.push('revision = ?');
    values.push(current.revision + 1);
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), taskId);
    this.#db()
      .prepare(`update task set ${sets.join(', ')} where id = ?`)
      .run(...values);
    return this.getTask(taskId);
  }

  /** @param {object} attempt */
  insertAttempt(attempt) {
    const now = isoTimestamp();
    this.#db()
      .prepare(
        `insert into task_attempt (id, task_id, room_id, actor_id, base_revision, assignment_revision,
                                   model_config_revision, state, worktree_ref, result_ref, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.taskId,
        attempt.roomId,
        attempt.actorId ?? null,
        attempt.baseRevision ?? 0,
        attempt.assignmentRevision ?? 'a1',
        attempt.modelConfigRevision ?? 0,
        attempt.state ?? 'running',
        attempt.worktreeRef ?? null,
        attempt.resultRef ?? null,
        attempt.createdAt ?? now,
        now,
      );
    return this.getAttempt(attempt.id);
  }

  /** @param {string} attemptId */
  getAttempt(attemptId) {
    const row = this.#db().prepare('select * from task_attempt where id = ?').get(attemptId);
    return row ? mapAttempt(row) : null;
  }

  /**
   * @param {string} taskId
   * @param {{ activeOnly?: boolean }} [options]
   * @returns {object[]}
   */
  listAttempts(taskId, options = {}) {
    const rows = options.activeOnly
      ? this.#db()
          .prepare("select * from task_attempt where task_id = ? and state = 'running' order by created_at desc")
          .all(taskId)
      : this.#db().prepare('select * from task_attempt where task_id = ? order by created_at desc').all(taskId);
    return rows.map(mapAttempt);
  }

  /** @param {string} attemptId @param {object} patch */
  updateAttempt(attemptId, patch) {
    const columns = { state: 'state', worktreeRef: 'worktree_ref', resultRef: 'result_ref' };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    if (sets.length === 0) return this.getAttempt(attemptId);
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), attemptId);
    this.#db()
      .prepare(`update task_attempt set ${sets.join(', ')} where id = ?`)
      .run(...values);
    return this.getAttempt(attemptId);
  }

  /** @param {object} plan */
  insertPlan(plan) {
    const now = isoTimestamp();
    const revision = plan.revision ?? this.bumpPlanRevision(plan.roomId);
    this.#db()
      .prepare(
        `insert into plan (id, room_id, revision, source_message_id, scope, status, task_ids,
                           assumptions, coverage, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.roomId,
        revision,
        plan.sourceMessageId ?? null,
        plan.scope ?? '',
        plan.status ?? 'proposed',
        JSON.stringify(plan.taskIds ?? []),
        JSON.stringify(plan.assumptions ?? []),
        JSON.stringify(plan.coverage ?? {}),
        plan.createdAt ?? now,
        now,
      );
    return this.getPlan(plan.id);
  }

  /** @param {string} planId */
  getPlan(planId) {
    const row = this.#db().prepare('select * from plan where id = ?').get(planId);
    return row ? mapPlan(row) : null;
  }

  /**
   * @param {string} roomId
   * @param {{ statuses?: string[] }} [options]
   * @returns {object[]}
   */
  listPlans(roomId, options = {}) {
    const clauses = ['room_id = ?'];
    const values = [roomId];
    if (Array.isArray(options.statuses) && options.statuses.length > 0) {
      clauses.push(`status in (${options.statuses.map(() => '?').join(', ')})`);
      values.push(...options.statuses);
    }
    return this.#db()
      .prepare(`select * from plan where ${clauses.join(' and ')} order by revision desc`)
      .all(...values)
      .map(mapPlan);
  }

  /** @param {string} planId @param {object} patch */
  updatePlan(planId, patch) {
    const columns = {
      status: 'status',
      taskIds: 'task_ids',
      assumptions: 'assumptions',
      coverage: 'coverage',
      scope: 'scope',
      revision: 'revision',
    };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      const value = patch[key];
      values.push(['taskIds', 'assumptions', 'coverage'].includes(key) ? JSON.stringify(value ?? (key === 'coverage' ? {} : [])) : value);
    }
    if (sets.length === 0) return this.getPlan(planId);
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), planId);
    this.#db()
      .prepare(`update plan set ${sets.join(', ')} where id = ?`)
      .run(...values);
    return this.getPlan(planId);
  }

  /** @param {object} decision */
  insertDecision(decision) {
    const room = this.getRoom(decision.roomId);
    if (!room) throw new RoomError('NOT_FOUND', `项目群 ${decision.roomId} 不存在。`);
    const revision = decision.revision ?? this.#nextDecisionRevision(decision.roomId);
    this.#db()
      .prepare(
        `insert into decision (id, room_id, revision, status, source_message_id, scope, statement,
                               supersedes, accepted_by, affected_task_ids, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.roomId,
        revision,
        decision.status ?? 'proposed',
        decision.sourceMessageId,
        decision.scope ?? '',
        decision.statement,
        decision.supersedes ?? null,
        decision.acceptedBy ?? null,
        JSON.stringify(decision.affectedTaskIds ?? []),
        decision.createdAt ?? isoTimestamp(),
      );
    return this.getDecision(decision.id);
  }

  /** @param {string} decisionId */
  getDecision(decisionId) {
    const row = this.#db().prepare('select * from decision where id = ?').get(decisionId);
    return row ? mapDecision(row) : null;
  }

  /**
   * @param {string} roomId
   * @param {{ statuses?: string[] }} [options]
   * @returns {object[]}
   */
  listDecisions(roomId, options = {}) {
    const clauses = ['room_id = ?'];
    const values = [roomId];
    if (Array.isArray(options.statuses) && options.statuses.length > 0) {
      clauses.push(`status in (${options.statuses.map(() => '?').join(', ')})`);
      values.push(...options.statuses);
    }
    return this.#db()
      .prepare(`select * from decision where ${clauses.join(' and ')} order by revision asc`)
      .all(...values)
      .map(mapDecision);
  }

  /** @param {string} decisionId @param {object} patch */
  updateDecision(decisionId, patch) {
    const columns = { status: 'status', acceptedBy: 'accepted_by', affectedTaskIds: 'affected_task_ids', supersedes: 'supersedes', statement: 'statement' };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(key === 'affectedTaskIds' ? JSON.stringify(patch[key] ?? []) : patch[key]);
    }
    if (sets.length === 0) return this.getDecision(decisionId);
    values.push(decisionId);
    this.#db()
      .prepare(`update decision set ${sets.join(', ')} where id = ?`)
      .run(...values);
    return this.getDecision(decisionId);
  }

  #nextDecisionRevision(roomId) {
    const row = this.#db().prepare('select max(revision) as max from decision where room_id = ?').get(roomId);
    return Number(row?.max ?? 0) + 1;
  }

  /** @param {object} ack */
  upsertDecisionAck(ack) {
    this.#db()
      .prepare(
        `insert into decision_ack (decision_id, member_id, state, applied_task_revision, detail, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict (decision_id, member_id) do update set
           state = excluded.state,
           applied_task_revision = excluded.applied_task_revision,
           detail = excluded.detail,
           updated_at = excluded.updated_at`,
      )
      .run(
        ack.decisionId,
        ack.memberId,
        ack.state,
        ack.appliedTaskRevision ?? null,
        ack.detail ?? null,
        isoTimestamp(),
      );
    return this.listDecisionAcks(ack.decisionId).find((entry) => entry.memberId === ack.memberId) ?? null;
  }

  /** @param {string} decisionId */
  listDecisionAcks(decisionId) {
    return this.#db()
      .prepare('select * from decision_ack where decision_id = ? order by member_id')
      .all(decisionId)
      .map((row) => ({
        decisionId: row.decision_id,
        memberId: row.member_id,
        state: row.state,
        appliedTaskRevision: row.applied_task_revision ?? null,
        detail: row.detail ?? null,
        updatedAt: row.updated_at,
      }));
  }

  /** @param {object} artifact */
  insertArtifact(artifact) {
    this.#db()
      .prepare(
        `insert or replace into artifact (id, room_id, task_id, attempt_id, kind, location,
                                          content_hash, evidence_ref, verified, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.roomId,
        artifact.taskId ?? null,
        artifact.attemptId ?? null,
        artifact.kind,
        artifact.location,
        artifact.contentHash ?? null,
        artifact.evidenceRef ?? null,
        artifact.verified ? 1 : 0,
        artifact.createdAt ?? isoTimestamp(),
      );
    return this.getArtifact(artifact.id);
  }

  /** @param {string} artifactId */
  getArtifact(artifactId) {
    const row = this.#db().prepare('select * from artifact where id = ?').get(artifactId);
    return row ? mapArtifact(row) : null;
  }

  /**
   * @param {string} roomId
   * @param {{ taskId?: string, attemptId?: string }} [options]
   * @returns {object[]}
   */
  listArtifacts(roomId, options = {}) {
    const clauses = ['room_id = ?'];
    const values = [roomId];
    if (options.taskId) {
      clauses.push('task_id = ?');
      values.push(options.taskId);
    }
    if (options.attemptId) {
      clauses.push('attempt_id = ?');
      values.push(options.attemptId);
    }
    return this.#db()
      .prepare(`select * from artifact where ${clauses.join(' and ')} order by created_at asc`)
      .all(...values)
      .map(mapArtifact);
  }

  /** @param {object} discussion */
  insertDiscussion(discussion) {
    const now = isoTimestamp();
    this.#db()
      .prepare(
        `insert into discussion (id, room_id, topic, participants, status, decision_ref, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        discussion.id,
        discussion.roomId,
        discussion.topic,
        JSON.stringify(discussion.participants ?? []),
        discussion.status ?? 'open',
        discussion.decisionRef ?? null,
        discussion.createdAt ?? now,
        now,
      );
    return this.getDiscussion(discussion.id);
  }

  /** @param {string} id */
  getDiscussion(id) {
    const row = this.#db().prepare('select * from discussion where id = ?').get(id);
    return row
      ? {
          id: row.id,
          roomId: row.room_id,
          topic: row.topic,
          participants: parseJson(row.participants, []),
          status: row.status,
          decisionRef: row.decision_ref ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  /** @param {string} roomId */
  listDiscussions(roomId) {
    return this.#db()
      .prepare('select id from discussion where room_id = ? order by created_at desc')
      .all(roomId)
      .map((row) => this.getDiscussion(row.id));
  }

  /** @param {string} id @param {object} patch */
  updateDiscussion(id, patch) {
    const columns = { status: 'status', decisionRef: 'decision_ref', participants: 'participants' };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(key === 'participants' ? JSON.stringify(patch[key] ?? []) : patch[key]);
    }
    if (sets.length === 0) return this.getDiscussion(id);
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), id);
    this.#db()
      .prepare(`update discussion set ${sets.join(', ')} where id = ?`)
      .run(...values);
    return this.getDiscussion(id);
  }

  /* ---------------------------------------------------------------- *
   * Idempotent dispatch ledger
   * ---------------------------------------------------------------- */

  /**
   * Claim a dispatch key exactly once. Returns `true` when this call created the
   * record, `false` when the same work was already dispatched — which is what
   * makes "restart does not re-assign the same work" true (the design notes).
   * @param {object} input
   * @returns {{ claimed: boolean, record: object }}
   */
  claimDispatch(input) {
    const existing = this.#db().prepare('select * from dispatch where dispatch_key = ?').get(input.dispatchKey);
    if (existing) {
      return {
        claimed: false,
        record: {
          dispatchKey: existing.dispatch_key,
          roomId: existing.room_id,
          planId: existing.plan_id ?? null,
          taskId: existing.task_id ?? null,
          memberId: existing.member_id ?? null,
          state: existing.state,
          detail: existing.detail ?? null,
          createdAt: existing.created_at,
          updatedAt: existing.updated_at,
        },
      };
    }
    const now = isoTimestamp();
    this.#db()
      .prepare(
        `insert into dispatch (dispatch_key, room_id, plan_id, task_id, member_id, state, detail, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.dispatchKey,
        input.roomId,
        input.planId ?? null,
        input.taskId ?? null,
        input.memberId ?? null,
        input.state ?? 'pending',
        input.detail ?? null,
        now,
        now,
      );
    return { claimed: true, record: { ...input, state: input.state ?? 'pending', createdAt: now, updatedAt: now } };
  }

  /** @param {string} dispatchKey @param {object} patch */
  updateDispatch(dispatchKey, patch) {
    const sets = [];
    const values = [];
    if ('state' in patch) {
      sets.push('state = ?');
      values.push(patch.state);
    }
    if ('memberId' in patch) {
      // Member creation records its intent before the member exists, so the
      // dispatch row is where the resulting member id has to land: a retry reads
      // it back and reuses that member instead of building a second one
      // (the design notes, AT41).
      sets.push('member_id = ?');
      values.push(patch.memberId);
    }
    if ('detail' in patch) {
      sets.push('detail = ?');
      values.push(patch.detail);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(isoTimestamp(), dispatchKey);
    this.#db()
      .prepare(`update dispatch set ${sets.join(', ')} where dispatch_key = ?`)
      .run(...values);
  }

  /* ---------------------------------------------------------------- *
   * Reminders and notes
   * ---------------------------------------------------------------- */

  /** @param {object} reminder */
  upsertReminder(reminder) {
    this.#db()
      .prepare(
        `insert into reminder (id, room_id, task_id, target_id, due_at, dedupe_key, state, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (room_id, dedupe_key) do update set
           due_at = excluded.due_at,
           state = excluded.state`,
      )
      .run(
        reminder.id,
        reminder.roomId,
        reminder.taskId ?? null,
        reminder.targetId,
        reminder.dueAt,
        reminder.dedupeKey,
        reminder.state ?? 'pending',
        isoTimestamp(),
      );
  }

  /**
   * @param {string} roomId
   * @param {{ state?: string, dueBefore?: string }} [options]
   * @returns {object[]}
   */
  listReminders(roomId, options = {}) {
    const clauses = ['room_id = ?'];
    const values = [roomId];
    if (options.state) {
      clauses.push('state = ?');
      values.push(options.state);
    }
    if (options.dueBefore) {
      clauses.push('due_at <= ?');
      values.push(options.dueBefore);
    }
    return this.#db()
      .prepare(`select * from reminder where ${clauses.join(' and ')} order by due_at asc`)
      .all(...values)
      .map((row) => ({
        id: row.id,
        roomId: row.room_id,
        taskId: row.task_id ?? null,
        targetId: row.target_id,
        dueAt: row.due_at,
        dedupeKey: row.dedupe_key,
        state: row.state,
        createdAt: row.created_at,
      }));
  }

  /** @param {string} roomId @param {string} kind @param {string} body */
  addAdminNote(roomId, kind, body) {
    this.#db()
      .prepare('insert into admin_note (id, room_id, kind, body, created_at) values (?, ?, ?, ?, ?)')
      .run(randomUUID(), roomId, kind, body, isoTimestamp());
  }

  /** @param {string} roomId @param {number} [limit] */
  listAdminNotes(roomId, limit = 50) {
    return this.#db()
      .prepare('select * from admin_note where room_id = ? order by created_at desc limit ?')
      .all(roomId, limit)
      .map((row) => ({ id: row.id, roomId: row.room_id, kind: row.kind, body: row.body, createdAt: row.created_at }));
  }

  /** Store a room-level key/value fact (recovery markers, last recovery result). */
  setMeta(key, value) {
    this.#db().prepare('insert or replace into meta (key, value) values (?, ?)').run(key, String(value));
  }

  /** @param {string} key */
  getMeta(key) {
    const row = this.#db().prepare('select value from meta where key = ?').get(key);
    return row ? row.value : null;
  }
}

/* ------------------------------------------------------------------ *
 * Row mappers — one place where snake_case storage becomes the shared
 * camelCase contract, so a column rename cannot leak into the UI.
 * ------------------------------------------------------------------ */

function mapRoom(row) {
  return {
    id: row.id,
    title: row.title,
    workspaceRef: row.workspace_ref ?? null,
    ownerRef: row.owner_ref,
    status: row.status,
    language: row.language,
    planRevision: row.plan_revision,
    membershipRevision: row.membership_revision,
    lastSeq: row.last_seq,
    config: parseJson(row.config, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMember(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    kind: row.kind,
    role: row.role,
    displayName: row.display_name,
    handle: row.handle,
    aliases: parseJson(row.aliases, []),
    status: row.status,
    membershipRevision: row.membership_revision,
    personaRevision: row.persona_revision,
    modelProfileRef: row.model_profile_ref ?? null,
    modelConfigRevision: row.model_config_revision,
    selectionMode: row.selection_mode,
    selectionSource: row.selection_source,
    modelLocked: row.model_locked === 1,
    currentTaskId: row.current_task_id ?? null,
    sessionId: row.session_id ?? null,
    sessionOwnership: row.session_ownership ?? null,
    lastSeenSeq: row.last_seen_seq,
    lastAppliedDecisionRevision: row.last_applied_decision_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapModelProfile(row) {
  return {
    id: row.id,
    hostProfileRef: row.host_profile_ref ?? null,
    providerRoute: row.provider_route,
    modelId: row.model_id,
    label: row.label,
    capabilities: parseJson(row.capabilities, []),
    capabilitiesRevision: row.capabilities_revision,
    createdAt: row.created_at,
  };
}

function mapDelivery(row) {
  return {
    messageId: row.message_id,
    recipientId: row.recipient_id,
    status: row.status,
    requestedMode: row.requested_mode,
    actualMode: row.actual_mode ?? null,
    hostMessageId: row.host_message_id ?? null,
    deliveryAttempt: row.delivery_attempt,
    updatedAt: row.updated_at,
    errorCode: row.error_code ?? null,
    detail: row.detail ?? null,
  };
}

function mapTask(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    planId: row.plan_id ?? null,
    parentTaskId: row.parent_task_id ?? null,
    objective: row.objective,
    ownerId: row.owner_id ?? null,
    requiredRole: row.required_role ?? null,
    requiredCapabilities: parseJson(row.required_capabilities, []),
    deliverables: parseJson(row.deliverables, []),
    status: row.status,
    revision: row.revision,
    decisionRevision: row.decision_revision,
    acceptance: parseJson(row.acceptance, []),
    dependencies: parseJson(row.dependencies, []),
    assignmentRevision: row.assignment_revision,
    needsSync: row.needs_sync === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttempt(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    roomId: row.room_id,
    actorId: row.actor_id ?? null,
    baseRevision: row.base_revision,
    assignmentRevision: row.assignment_revision,
    modelConfigRevision: row.model_config_revision,
    state: row.state,
    worktreeRef: row.worktree_ref ?? null,
    resultRef: row.result_ref ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPlan(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    revision: row.revision,
    sourceMessageId: row.source_message_id ?? null,
    scope: row.scope,
    status: row.status,
    taskIds: parseJson(row.task_ids, []),
    assumptions: parseJson(row.assumptions, []),
    coverage: parseJson(row.coverage, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDecision(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    revision: row.revision,
    status: row.status,
    sourceMessageId: row.source_message_id,
    scope: row.scope,
    statement: row.statement,
    supersedes: row.supersedes ?? null,
    acceptedBy: row.accepted_by ?? null,
    affectedTaskIds: parseJson(row.affected_task_ids, []),
    createdAt: row.created_at,
  };
}

function mapArtifact(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: row.task_id ?? null,
    attemptId: row.attempt_id ?? null,
    kind: row.kind,
    location: row.location,
    contentHash: row.content_hash ?? null,
    evidenceRef: row.evidence_ref ?? null,
    verified: row.verified === 1,
    createdAt: row.created_at,
  };
}

/**
 * Whether a process id is alive. Used only to tell a crashed writer's lock from
 * a live one.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Directory used by tests that need a throwaway database path. */
export function temporaryDatabasePath() {
  return join(ensureDir(join(tmpdir(), 'dsh-project-room-tests')), `room-${randomUUID()}.sqlite`);
}
