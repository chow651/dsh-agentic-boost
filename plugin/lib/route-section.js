/**
 * Short task-route prompt section for the v2 slice.
 *
 * A second static section beside `agentic-boost:task-loop` (order 450):
 * this one (order 460) states the four task kinds and their verification
 * gates in under 20 lines. Guidance only — no tools granted, no permissions
 * changed, no `complete` rewrite.
 */
export const ROUTE_SECTION_NAME = 'agentic-boost:task-route';
export const ROUTE_SECTION_ORDER = 460;

export const ROUTE_SECTION_TEXT = [
  '# Task route (agentic-boost v2 slice)',
  '',
  'Pick one kind, then meet its gate. Prompt alone never marks done —',
  '`verify_check` (or a BLOCKED record) is the evidence.',
  '',
  '- qa: answer + cite `path:line`. No skill load. Read-only tools.',
  '- code-change: load `v2-verify-loop`. Run the target test, record via',
  '  `verify_check`, never edit tests/logs to pass.',
  '- investigation: load `v2-investigate`. Conclude with `path:line` refs.',
  '- multi-step: track `task_state` (plan→active→verify→done/blocked).',
  '  Load `v2-verify-loop` + `v2-recover` on failure. Unmet gate = BLOCKED.',
].join('\n');
