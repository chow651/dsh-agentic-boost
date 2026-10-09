/**
 * Verifiable task state + failure-evidence/closed-loop for the v2 slice.
 *
 * No durable host persistence contract exists for plugin task state
 * (confirmed: no generic native hook registry in DSH 0.2.0-rc.2), so this
 * module is intentionally evidence-shaped, not storage-shaped:
 *
 * - `TASK_PHASES`: plan → active → verify → done, with `blocked` reachable
 *   from any non-done phase. `done` requires a verify record reference
 *   BOUND to a passed `verify_check` observed in THIS session (H2); the tool
 *   execute path enforces that (prompt text alone cannot complete).
 * - `normalizeTaskStateArgs`: strict allowlist + REQUIRED explicit `from`
 *   (H1: only an explicit legal from→to edge is accepted; `plan→plan`
 *   records the initial plan) + redaction + length caps via
 *   the shared diagnostics redactor (same function as guard/verify/supervisor).
 * - Session-bound verify registry (`recordVerifySuccess`, fed by the
 *   plugin entry's verify_check wrapper): in-process WeakMap keyed by the
 *   owning session object, so `verifyRef` must equal the command of a
 *   verify_check success seen for the SAME session object (H2). Survives
 *   only in-process; after a restart the check must be re-run and
 *   re-recorded. Never reads deprecated synchronous session snapshots.
 * - `TASK_STATE_EVENT_TYPE`: session event appended on every transition so
 *   state is observable and replayable in UIs.
 * - `buildFailureSummary`: redacted, length-capped failure evidence for the
 *   locate → fix →定向复验 loop; unmet repair stays BLOCKED/NOT RUN.
 */

import { redactSummary } from './diagnostics.js';

/** Model tool name. */
export const TASK_STATE_TOOL_NAME = 'task_state';

/** Session event type appended on each state transition. */
export const TASK_STATE_EVENT_TYPE = 'agentic-boost/task-state';

/** Ordered working phases; `blocked` is a side state from any of them. */
export const TASK_PHASES = Object.freeze(['plan', 'active', 'verify', 'done', 'blocked']);

/** Allowed transitions: from -> Set(to). `plan→plan` records the initial plan. */
const TRANSITIONS = Object.freeze({
  plan: Object.freeze(new Set(['plan', 'active', 'blocked'])),
  active: Object.freeze(new Set(['verify', 'blocked'])),
  verify: Object.freeze(new Set(['done', 'active', 'blocked'])),
  done: Object.freeze(new Set([])),
  blocked: Object.freeze(new Set(['active', 'plan'])),
});

/**
 * In-process registry of verify_check successes, keyed by owning session
 * object (WeakMap — no leak, no cross-session bleed, no durable read).
 * The plugin entry's verify_check wrapper calls `recordVerifySuccess`
 * after a successful execute; `task_state done` checks membership (H2).
 * Keyed by session identity string when available (`session.id`), else by
 * session object reference. Commands are stored redacted (canonical form).
 */
const verifySuccessBySession = new WeakMap();
const verifyCommandsBySessionId = new Map();

function sessionKeys(session) {
  const keys = [];
  if (session !== null && (typeof session === 'object' || typeof session === 'function')) {
    keys.push({ map: verifySuccessBySession, key: session });
  }
  try {
    const id = session?.id;
    if (typeof id === 'string' && id.length > 0) keys.push({ sid: id });
  } catch {
    // session.id getter threw — object-key path above still applies.
  }
  return keys;
}

/**
 * Record one passed verify_check for its owning session (H2 feeder).
 * Called by the plugin entry wrapper after a successful verify_check
 * execute with passed=true. Pure in-memory; never persisted.
 * @param {unknown} session owning session object.
 * @param {string} command canonical (redacted) verify command.
 */
export function recordVerifySuccess(session, command) {
  const cmd = String(command ?? '');
  if (cmd.length === 0) return;
  for (const entry of sessionKeys(session)) {
    if (entry.map) {
      let set = entry.map.get(entry.key);
      if (!set) {
        set = new Set();
        entry.map.set(entry.key, set);
      }
      set.add(cmd);
    } else if (entry.sid) {
      let set = verifyCommandsBySessionId.get(entry.sid);
      if (!set) {
        set = new Set();
        verifyCommandsBySessionId.set(entry.sid, set);
      }
      set.add(cmd);
    }
  }
}

/**
 * Revoke one passed verify_check for its owning session on a later real
 * failure for the SAME command (stale-proof invalidation).
 * Called by the plugin entry wrapper after a verify_check execute that
 * returns passed=false. Removes only that command; other commands stay.
 * Limited claim: no verifiable tree-state event exists, so this does NOT
 * detect arbitrary code changes — only a subsequent failed verify attempt.
 * @param {unknown} session owning session object.
 * @param {string} command canonical (redacted) verify command.
 */
export function revokeVerifySuccess(session, command) {
  const cmd = String(command ?? '');
  if (cmd.length === 0) return;
  for (const entry of sessionKeys(session)) {
    try {
      if (entry.map) entry.map.get(entry.key)?.delete(cmd);
      else if (entry.sid) verifyCommandsBySessionId.get(entry.sid)?.delete(cmd);
    } catch {
      // Best-effort revocation; a hostile session key must not throw.
    }
  }
}

/**
 * Whether this session object observed a passed verify_check for `command`.
 * @param {unknown} session owning session object.
 * @param {string} command canonical (redacted) verify command.
 * @returns {boolean} binding holds.
 */
export function hasVerifySuccess(session, command) {
  const cmd = String(command ?? '');
  for (const entry of sessionKeys(session)) {
    if (entry.map && entry.map.get(entry.key)?.has(cmd)) return true;
    if (entry.sid && verifyCommandsBySessionId.get(entry.sid)?.has(cmd)) return true;
  }
  return false;
}

/** Test-only reset for the session-id fallback map (WeakMap needs no reset). */
export function __resetVerifyRegistryForTests() {
  verifyCommandsBySessionId.clear();
}

export const TASK_KIND_VALUES = Object.freeze(['qa', 'code-change', 'investigation', 'multi-step']);

export const TASK_STATE_COMMAND_MAX_CHARS = 300;
export const TASK_STATE_SUMMARY_MAX_CHARS = 1000;
export const FAILURE_SUMMARY_MAX_CHARS = 1000;

/**
 * Truncate to a char budget (code-point aware).
 */
function truncateText(text, maxChars) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars).join('')}…[truncated]`;
}

/**
 * Whether a transition is legal.
 * @param {string} from current phase.
 * @param {string} to next phase.
 * @returns {boolean} legality.
 */
export function isLegalTransition(from, to) {
  const allowed = TRANSITIONS[String(from)];
  if (!allowed) return false;
  return allowed.has(String(to));
}

/**
 * Narrow and normalize raw `task_state` arguments. Throws on invalid input
 * (never reports a bad transition as success).
 *
 * H1: `from` is REQUIRED and must form an explicit legal from→to edge —
 * a missing `from` is rejected (the model must state where it stands).
 * Required: `phase` (one of TASK_PHASES), `from` (explicit current phase),
 * `taskKind` (one of four kinds), `summary` (non-empty string).
 * `verifyRef` (required when phase=done: must equal the canonical command
 * of a verify_check success observed for THIS session object — H2; the
 * session is supplied as the second parameter by the tool execute path),
 * `failure` (when phase=blocked: short redacted failure note).
 * @param {unknown} args raw model arguments.
 * @param {unknown} [session] owning session object (required for phase=done binding).
 */
export function normalizeTaskStateArgs(args, session) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('task_state: `args` must be an object');
  }
  const input = /** @type {Record<string, unknown>} */ (args);
  for (const key of Object.keys(input)) {
    if (!['phase', 'from', 'taskKind', 'summary', 'verifyRef', 'failure'].includes(key)) {
      throw new Error('task_state: `args` contains unsupported keys');
    }
  }
  if (typeof input.phase !== 'string' || !TASK_PHASES.includes(input.phase)) {
    throw new Error('task_state: `phase` must be one of plan/active/verify/done/blocked');
  }
  if (typeof input.taskKind !== 'string' || !TASK_KIND_VALUES.includes(input.taskKind)) {
    throw new Error('task_state: `taskKind` must be one of qa/code-change/investigation/multi-step');
  }
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) {
    throw new Error('task_state: `summary` must be a non-empty string');
  }
  if (typeof input.from !== 'string' || !TASK_PHASES.includes(input.from)) {
    throw new Error('task_state: `from` (explicit current phase) is required and must be a known phase');
  }
  if (!isLegalTransition(input.from, input.phase)) {
    throw new Error(`task_state: illegal transition ${input.from} → ${input.phase}`);
  }
  let canonicalVerifyRef;
  if (input.phase === 'done') {
    if (typeof input.verifyRef !== 'string' || input.verifyRef.trim().length === 0) {
      throw new Error('task_state: `verifyRef` (verify_check evidence) is required to mark done');
    }
    canonicalVerifyRef = truncateText(
      redactSummary(input.verifyRef.trim()),
      TASK_STATE_COMMAND_MAX_CHARS,
    );
    if (session === undefined || !hasVerifySuccess(session, canonicalVerifyRef)) {
      throw new Error(
        'task_state: `verifyRef` must match a passed verify_check command observed in this session — re-run the check and record via verify_check first',
      );
    }
  }
  if (input.phase === 'blocked') {
    if (typeof input.failure !== 'string' || input.failure.trim().length === 0) {
      throw new Error('task_state: `failure` evidence is required to mark blocked');
    }
  }
  return {
    phase: input.phase,
    from: input.from,
    taskKind: input.taskKind,
    summary: truncateText(redactSummary(input.summary.trim()), TASK_STATE_SUMMARY_MAX_CHARS),
    verifyRef:
      typeof input.verifyRef === 'string'
        ? (canonicalVerifyRef ?? truncateText(redactSummary(input.verifyRef.trim()), TASK_STATE_COMMAND_MAX_CHARS))
        : undefined,
    failure:
      typeof input.failure === 'string'
        ? truncateText(redactSummary(input.failure.trim()), FAILURE_SUMMARY_MAX_CHARS)
        : undefined,
  };
}

/**
 * Build redacted, length-capped failure evidence for the repair loop.
 * Pure: no I/O. Shared redactor first, then cap — usernames/secrets beyond
 * the cap window are still masked.
 * @param {unknown} raw raw failure text (command output, error message).
 * @returns {string} safe evidence string.
 */
export function buildFailureSummary(raw) {
  return truncateText(redactSummary(String(raw ?? '')), FAILURE_SUMMARY_MAX_CHARS);
}

/**
 * Build the `task_state` tool definition (defineTool-compatible factory,
 * mirroring verify-tool.js so unit tests run without the host installed).
 * @param {(options: object) => object} [defineTool] host `defineTool`.
 * @returns {object} tool definition for `ctx.tools.register`.
 */
export function createTaskStateToolDefinition(defineTool) {
  const definition = {
    name: TASK_STATE_TOOL_NAME,
    description:
      'Record one task-state transition for the agentic v2 loop (plan/active/verify/done/blocked). from is required; done requires a verifyRef matching a passed verify_check observed in this session; blocked requires failure evidence. Each record is appended to the session.',
    parameters: {
      phase: {
        type: 'string',
        required: true,
        description: 'Next phase: plan, active, verify, done, or blocked.',
      },
      from: {
        type: 'string',
        required: true,
        description: 'Explicit current phase (only legal from→to edges accepted).',
      },
      taskKind: {
        type: 'string',
        required: true,
        description: 'Task kind: qa, code-change, investigation, or multi-step.',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'Short status summary (no secrets).',
      },
      verifyRef: {
        type: 'string',
        required: false,
        description: 'Canonical passed verify_check command observed in this session; required when phase=done.',
      },
      failure: {
        type: 'string',
        required: false,
        description: 'Redacted failure note; required when phase=blocked.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          phase: { type: 'string' },
          from: { type: 'string' },
          taskKind: { type: 'string' },
          summary: { type: 'string' },
          verifyRef: { type: 'string' },
          failure: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Task ${value.taskKind} → ${value.phase}: ${value.summary}${
            value.phase === 'done' ? ` (verified: ${value.verifyRef ?? 'n/a'})` : ''
          }${value.phase === 'blocked' ? ` (blocked: ${value.failure ?? 'n/a'})` : ''}`,
        },
      ],
    },
    async execute(args, exec) {
      if (!exec || !exec.agent) {
        throw new Error('task_state requires an owning agent session');
      }
      // H2: session binding checked inside normalize via the owning session.
      const value = normalizeTaskStateArgs(args, exec.agent.session);
      exec.agent.session.append(TASK_STATE_EVENT_TYPE, value);
      return value;
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Record task state',
      kind: 'other',
      rawInput:
        args !== null && typeof args === 'object' && 'phase' in args
          ? truncateText(
              redactSummary(String(/** @type {Record<string, unknown>} */ (args).phase)),
              120,
            )
          : undefined,
    }),
  };
  if (typeof defineTool === 'function') {
    return defineTool(definition);
  }
  return definition;
}
