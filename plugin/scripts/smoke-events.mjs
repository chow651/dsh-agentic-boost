/**
 * Structured JSONL evidence parser for the v2 smoke runner.
 *
 * Scope: pure functions only — no I/O, no model calls, no process exit.
 * The live runner (`smoke-v2.mjs`) must call `parseSmokeEvents` on the
 * `--json` stdout instead of substring-matching stdout text.
 *
 * Evidence rule (Codi finding): a claim is proven ONLY by a legal
 * structured event — `tool_call.tool` for the name plus a `tool_result`
 * with the SAME `callId` and `status === 'completed'` for success.
 * The `result` value is NEVER read (no content/args/output inspection),
 * and stdout `text`/`final` bodies are NEVER substring-matched.
 * Specific `v2-answer` / `verify_check` / `task_state` successes have no
 * verified safe sub-schema here, so they stay `'unknown'` — never inferred
 * from a bare tool name or from body text.
 * Trust boundary: the input is whatever stdout the runner passes in
 * (a local child-process string). This parser proves structure, not origin —
 * it cannot authenticate that the bytes came from a real DSH run.
 *
 * Whitelist output only: event-type counts, safe tool names, sessionId
 * (when verifiable), boolean/`unknown` evidence, and a redacted +
 * truncated error summary. Full tool input/output, raw JSONL, commands,
 * prompts, absolute personal paths, secrets, and hidden reasoning are
 * never retained.
 */
import { redactSummary } from '../lib/diagnostics.js';

export const SMOKE_EVENT_TYPES = Object.freeze([
  'session',
  'status',
  'text',
  'tool_call',
  'tool_result',
  'final',
]);

export const MAX_SMOKE_SUMMARY_CHARS = 500;

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** DSH session ids observed on-machine: `session-<UUID>`. Anything else is not retained. */
const SESSION_ID_PATTERN = /^session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const TRUNCATION_MARKER = '…[truncated]';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Redact + truncate an stderr/error-scale string for safe ledger storage.
 * Uses the shared `redactSummary` (Bearer / key=value / URL-query secrets /
 * `/home/<user>`-style paths / sk-/xox-/PEM) then caps length.
 * @param {unknown} raw short error text (never a full log/prompt).
 * @param {number} [maxChars] char budget (default 500).
 * @returns {string} redacted, length-capped summary.
 */
export function summarizeSmokeStderr(raw, maxChars = MAX_SMOKE_SUMMARY_CHARS) {
  const budget = Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : MAX_SMOKE_SUMMARY_CHARS;
  // Total length (marker included) must stay within budget: redact first,
  // then cut the prefix so prefix + marker fits the budget.
  const redacted = redactSummary(String(raw ?? ''));
  const chars = Array.from(redacted);
  if (chars.length <= budget) return chars.join('');
  if (budget <= Array.from(TRUNCATION_MARKER).length) {
    return Array.from(TRUNCATION_MARKER).slice(0, budget).join('');
  }
  const keep = budget - Array.from(TRUNCATION_MARKER).length;
  return `${chars.slice(0, keep).join('')}${TRUNCATION_MARKER}`;
}

/**
 * Parse `--json` newline-delimited events into whitelist-only evidence.
 * @param {unknown} jsonl stdout text (newline-delimited JSON objects).
 * @returns {{
 *   sessionId: (string|null),
 *   jsonlLines: number,
 *   malformedLines: number,
 *   eventCounts: Record<string, number>,
 *   tools: string[],
 *   completedCalls: number,
 *   usage: { statusEventsWithUsage: number, lastTotals: ({ inputTokens: number, outputTokens: number, totalTokens: number, reasoningTokens: number }|null) },
 *   evidence: {
 *     structuredToolSuccess: boolean,
 *     skillCall: 'unknown',
 *     verifyEvent: 'unknown',
 *     taskStateDone: 'unknown',
 *     finalPresent: boolean
 *   }
 * }} whitelist-only summary (no raw bodies retained).
 */
export function parseSmokeEvents(jsonl) {
  const text = typeof jsonl === 'string' ? jsonl : '';
  const lines = text.split('\n').filter((l) => l.trim().length > 0);

  const eventCounts = {
    session: 0,
    status: 0,
    text: 0,
    tool_call: 0,
    tool_result: 0,
    final: 0,
    unknown: 0,
  };
  let malformedLines = 0;
  let sessionId = null;
  let finalPresent = false;
  // Usage: counts + last numeric totals only — no text/usage blobs retained.
  let statusEventsWithUsage = 0;
  let lastTotals = null;

  /** callIds with a first legal tool_call, in JSONL order. */
  const seenCalls = new Set();
  /** callIds already closed by a first tool_result (repeats ignored). */
  const closedCalls = new Set();
  const toolNames = new Set();
  let completedCalls = 0;

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      eventCounts.unknown += 1;
      continue;
    }
    const type = event.type;
    if (typeof type !== 'string' || !SMOKE_EVENT_TYPES.includes(type)) {
      eventCounts.unknown += 1;
      continue;
    }
    eventCounts[type] += 1;

    if (type === 'session') {
      // Whitelist: only a `session-<UUID>` id is retained (cwd never kept);
      // anything else stays null — never stored raw/unredacted.
      if (sessionId === null && isNonEmptyString(event.sessionId)
        && SESSION_ID_PATTERN.test(event.sessionId)) {
        sessionId = event.sessionId;
      }
    } else if (type === 'final') {
      // Presence only — final text body is never read or matched.
      finalPresent = true;
    } else if (type === 'tool_call') {
      // Name comes ONLY from the legal `tool` field; input is never read.
      // Duplicate callIds keep the first call only (repeats ignored).
      if (isNonEmptyString(event.callId) && isNonEmptyString(event.tool)
        && TOOL_NAME_PATTERN.test(event.tool)) {
        if (!seenCalls.has(event.callId)) {
          seenCalls.add(event.callId);
          toolNames.add(event.tool);
        }
      }
    } else if (type === 'status') {
      // Counts + last numeric totals only. No text/reason blobs retained.
      const u = event.usage;
      if (u && typeof u === 'object' && !Array.isArray(u)) {
        statusEventsWithUsage += 1;
        if (isFiniteNumber(u.inputTokens) && isFiniteNumber(u.outputTokens)
          && isFiniteNumber(u.totalTokens) && isFiniteNumber(u.reasoningTokens)) {
          const totals = {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            totalTokens: u.totalTokens,
            reasoningTokens: u.reasoningTokens,
          };
          if (isFiniteNumber(u.cacheReadTokens)) totals.cacheReadTokens = u.cacheReadTokens;
          lastTotals = totals;
        }
      }
    } else if (type === 'tool_result') {
      // Success needs a PRIOR legal tool_call with the same callId and
      // exactly one first `status === 'completed'` result. Orphaned,
      // reversed (result before its call), duplicate, and non-completed
      // results prove nothing. The `result` value is never read.
      if (isNonEmptyString(event.callId) && typeof event.status === 'string'
        && !closedCalls.has(event.callId)) {
        closedCalls.add(event.callId);
        if (event.status === 'completed' && seenCalls.has(event.callId)) {
          completedCalls += 1;
        }
      }
    }
    // `status` / `text` events contribute counts only — no bodies retained.
  }

  return {
    sessionId,
    jsonlLines: lines.length,
    malformedLines,
    eventCounts,
    tools: [...toolNames].sort(),
    completedCalls,
    usage: { statusEventsWithUsage, lastTotals },
    evidence: {
      structuredToolSuccess: completedCalls > 0,
      // No verified safe sub-schema for skill name / verify args /
      // task_state args — never infer from bare tool names or body text.
      skillCall: 'unknown',
      verifyEvent: 'unknown',
      taskStateDone: 'unknown',
      finalPresent,
    },
  };
}

/**
 * Build the runner's safe evidence block from child stdout/stderr.
 * Pure: parses stdout structurally, summarizes stderr redacted.
 * Never retains raw stdout/stderr, prompts, tool input/result, or paths.
 * Trust boundary: input is whatever stdout the local runner passes in;
 * structure is proven, origin is not authenticated.
 * @param {unknown} stdout child `--json` stdout.
 * @param {unknown} stderr child stderr (error-scale summary input only).
 * @returns {{ parsed: ReturnType<typeof parseSmokeEvents>, stderrSummary: string, verdict: string }}
 *   verdict is NEVER `'PASS'`: skill/verify/task_state specifics have no
 *   verified schema and stay `unknown`, so a generic completed call + final
 *   event is at most `'INCONCLUSIVE'` (anything less is `'BLOCKED'`).
 */
export function buildSmokeEvidence(stdout, stderr) {
  const parsed = parseSmokeEvents(stdout);
  const stderrSummary = summarizeSmokeStderr(stderr);
  const verdict = parsed.evidence.structuredToolSuccess && parsed.evidence.finalPresent
    ? 'INCONCLUSIVE'
    : 'BLOCKED';
  return { parsed, stderrSummary, verdict };
}

/**
 * Safe task-prompt metadata: char count only, never the text.
 * @param {unknown} prompt task text (never retained).
 * @returns {{ promptChars: number }} length number only.
 */
export function taskPromptMeta(prompt) {
  return { promptChars: Array.from(String(prompt ?? '')).length };
}
