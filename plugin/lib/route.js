/**
 * Task-type router for dsh-agentic-boost v2 slice.
 *
 * Short, stable task constraints: map one of four task kinds to the context
 * package, the resumable skill name(s), the minimal tool posture, and the
 * verification gate. Pure functions — no I/O — so the routing decision is
 * unit-testable and the prompt section stays static text.
 *
 * Task kinds (from docs/PROMPT_SYSTEM_DESIGN.md §3, design reference only):
 * - `qa`: simple question answering.
 * - `code-change`: code modification with tests.
 * - `investigation`: survey / review across read-only sources.
 * - `multi-step`: multi-stage project work with explicit state.
 */

/** Valid task kinds. */
export const TASK_KINDS = Object.freeze(['qa', 'code-change', 'investigation', 'multi-step']);

/**
 * Routing table: kind -> context package, skill(s), tool posture, gate.
 * Skill names are kebab-case plugin-bundled skills under `plugin/skills/`.
 */
export const TASK_ROUTES = Object.freeze({
  'qa': Object.freeze({
    context: 'minimal: task + acceptance only',
    skills: Object.freeze(['v2-answer']),
    tools: 'read-only (fs-search/skill/web)',
    gate: 'answer + citation with path:line',
  }),
  'code-change': Object.freeze({
    context: 'target files + test entry',
    skills: Object.freeze(['v2-verify-loop']),
    tools: 'minimal write set; guard blocks test/log edits',
    gate: 'target test green + verify_check record',
  }),
  'investigation': Object.freeze({
    context: 'multi-source read-only',
    skills: Object.freeze(['v2-investigate']),
    tools: 'read + search; ask-leaning pre-gate',
    gate: 'conclusion with path:line refs',
  }),
  'multi-step': Object.freeze({
    context: 'goal/todo explicit state',
    skills: Object.freeze(['v2-verify-loop', 'v2-recover']),
    tools: 'staged allowlist; full gates',
    gate: 'per-stage gate + summary; BLOCKED when unmet',
  }),
});

/**
 * Route a task kind to its constraint bundle.
 * @param {string} kind task kind.
 * @returns {{ context: string, skills: readonly string[], tools: string, gate: string }} route.
 * @throws {Error} on unknown kind (never silently default).
 */
export function routeTaskKind(kind) {
  const route = TASK_ROUTES[String(kind)];
  if (!route) {
    throw new Error(
      `agentic-boost v2: unknown task kind ${JSON.stringify(String(kind))}; expected one of ${TASK_KINDS.join(', ')}`,
    );
  }
  return route;
}

/**
 * Whether a task kind is known.
 * @param {unknown} kind candidate.
 * @returns {boolean} true for the four kinds.
 */
export function isTaskKind(kind) {
  return Object.hasOwn(TASK_ROUTES, String(kind));
}
