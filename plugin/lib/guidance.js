/**
 * Task-loop guidance section text for dsh-agentic-boost-mvp.
 *
 * Short, static prompt section: evidence citation + verify-before-done.
 * Registered at order 450 (between DEPLOYMENT_PERSONA_PREFIX/0 and
 * PLAN_POLICY/500, clear of reserved SECTION_ORDERS slots).
 */
export const SECTION_NAME = 'agentic-boost:task-loop';
export const SECTION_ORDER = 450;

export const SECTION_TEXT = [
  '# Agentic task loop (agentic-boost-mvp)',
  '',
  'For every engineering task, follow this loop: understand → plan → act → verify → summarize.',
  '',
  '1. Cite evidence as `path:line` for each factual claim about the repo.',
  '2. Before reporting done, run the relevant automated check (tests, build, or lint) and quote its result.',
  '3. If a check fails, fix the implementation (never the test to make it pass) and re-run until green.',
  '4. State what changed, why, and the exact verification command plus its outcome.',
  '',
  'This is guidance only; it grants no extra tools and changes no permissions.',
].join('\n');
