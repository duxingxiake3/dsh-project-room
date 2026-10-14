/**
 * Project Room — storage paths.
 *
 * Room data is plugin-owned state, so it lives under the DSH home; it must not
 * land inside a user's project directory where a `git add -A` would commit the
 * conversation (the design notes).
 *
 * @module dsh-project-room/src/host/storage/paths
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * DSH home directory, as the running process sees it.
 * @returns {string}
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

/**
 * Root directory of this plugin's durable state.
 *
 * `DSH_PROJECT_ROOM_DATA` overrides it, which is what the integration tests use
 * to get an isolated store per run.
 * @returns {string}
 */
export function dataRoot() {
  const override = process.env.DSH_PROJECT_ROOM_DATA;
  if (typeof override === 'string' && override.trim()) return resolve(override.trim());
  return join(dshHome(), 'storages', 'project-room');
}

/**
 * Ensure a directory exists.
 * @param {string} dir
 * @returns {string} the same path
 */
export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Absolute path of the room database.
 * @returns {string}
 */
export function databasePath() {
  return join(ensureDir(dataRoot()), 'rooms.sqlite');
}

/**
 * Absolute path of the single-writer lock file.
 * @returns {string}
 */
export function lockPath() {
  return join(ensureDir(dataRoot()), 'writer.lock');
}

/**
 * Directory that holds pre-migration backups.
 * @returns {string}
 */
export function backupDir() {
  return ensureDir(join(dataRoot(), 'backups'));
}
