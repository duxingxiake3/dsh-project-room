/**
 * Role policy that both the composition root and recovery must agree on.
 *
 * It lives in its own module because it has two callers on two different paths:
 * `index.js` when it creates or resumes a member during a turn, and
 * `recovery-service.js` when it resumes members after a restart. A restart that
 * applied a different policy than a live turn would be invisible until someone
 * checked the member's tool list — which is exactly the kind of split this module
 * exists to prevent.
 *
 * @module dsh-project-room/src/host/roles
 */

/**
 * Detail-only roles get coordination tools but no code-writing tools, so "this
 * member does not modify the repository" is enforced rather than requested.
 *
 * @param {string} role
 * @returns {boolean}
 */
export function shouldRestrictTools(role) {
  return role === 'designer' || role === 'docs';
}
