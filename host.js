/**
 * dsh-project-room — host half entry point.
 *
 * The package root export, so the DSH loader row `name: 'dsh-project-room'`
 * resolves here. All behaviour lives in `src/host/`; this file exists to keep the
 * loader contract stable and explicit.
 *
 * @module dsh-project-room
 */

export { apply, name, Config, pluginStartedAt, activationId, bindHumanSession } from './src/host/index.js';
