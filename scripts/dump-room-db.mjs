/**
 * Dump a project-room database: rooms, members with their model binding, messages,
 * deliveries and tasks. Read-only.
 *
 * Written because "which model is this member actually bound to" has to be
 * answered from the durable ledger, not from what a UI claims.
 *
 * Usage: node scripts/dump-room-db.mjs [path-to-rooms.sqlite]
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2] ?? join(process.env.DSH_HOME ?? '', 'storages', 'project-room', 'rooms.sqlite');
if (!existsSync(file)) {
  process.stderr.write(`no database at ${file}\n`);
  process.exit(2);
}

const db = new DatabaseSync(file, { readOnly: true });
const rows = (sql) => db.prepare(sql).all();

const out = {
  file,
  meta: rows('select key, value from meta order by key'),
  rooms: rows('select id, title, status, membership_revision, plan_revision, last_seq from room'),
  members: rows(
    `select id, room_id, kind, role, display_name, handle, status, model_profile_ref,
            selection_source, model_locked, model_config_revision, session_id, session_ownership,
            last_seen_seq, last_applied_decision_revision
       from member order by created_at`,
  ),
  modelProfiles: rows('select id, provider_route, model_id, label from model_profile order by id'),
  modelRevisions: rows('select member_id, revision, profile_ref, selection_source, status from member_model_revision order by member_id, revision'),
  counts: {
    messages: rows('select count(*) as n from message')[0].n,
    deliveries: rows('select count(*) as n from delivery')[0].n,
    events: rows('select count(*) as n from room_event')[0].n,
    tasks: rows('select count(*) as n from task')[0].n,
    decisions: rows('select count(*) as n from decision')[0].n,
  },
  recentEvents: rows('select seq, event_type from room_event order by seq desc limit 15').reverse(),
  tasks: rows('select id, objective, status, owner_id, revision, decision_revision, needs_sync, acceptance, dependencies from task order by created_at'),
  deliveries: rows('select message_id, recipient_id, status, requested_mode, actual_mode, error_code, detail from delivery limit 20'),
};
db.close();
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
