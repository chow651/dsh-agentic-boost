/**
 * Observable verification behavior for dsh-agentic-boost-mvp.
 *
 * The `verify_check` model tool records one verification outcome
 * (command + exit code + truncated output summary) as a session event so the
 * task loop's "verify before done" step is observable and replayable.
 * It performs no I/O itself: the model runs the check with its own tools
 * and reports the outcome here. Pure presenters, no side effects.
 */

import { redactSummary } from './diagnostics.js';

/** Model tool name. */
export const VERIFY_TOOL_NAME = 'verify_check';

/** Session event type appended on each verification record. */
export const VERIFY_EVENT_TYPE = 'agentic-boost/verify-check';

export const VERIFY_COMMAND_MAX_CHARS = 500;
export const VERIFY_SUMMARY_MAX_CHARS = 2000;

/**
 * Truncate a string to a char budget (code-point aware).
 * @param {string} text input.
 * @param {number} maxChars budget.
 * @returns {string} truncated text.
 */
export function truncateText(text, maxChars) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars).join('')}…[truncated]`;
}

/**
 * Coerce an exit-code-like value to an integer. Accepts integers and
 * integer-valued strings (models often pass "0"); anything else throws.
 * @param {unknown} raw raw value.
 * @returns {number} integer exit code.
 */
function toExitCode(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  throw new Error('verify_check: `exitCode` must be an integer');
}

/**
 * Narrow and normalize raw tool arguments. Throws on invalid input.
 * Pure: no I/O. `command`/`summary` go through the shared diagnostics
 * redactor (`redactSummary`) then length caps, so session events, tool/UI
 * display values, and diagnostics never carry raw secrets or raw user paths.
 * Precision loss (chosen for safety): exact secret values / usernames are
 * replaced by `[redacted]` — replay shows the kind, not the value.
 * @param {unknown} args raw model arguments.
 * @returns {{ command: string, exitCode: number, passed: boolean, summary: string }} normalized record.
 */
export function normalizeVerifyArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('verify_check: `args` must be an object');
  }
  const input = /** @type {Record<string, unknown>} */ (args);
  for (const key of Object.keys(input)) {
    if (key !== 'command' && key !== 'exitCode' && key !== 'passed' && key !== 'summary') {
      throw new Error('verify_check: `args` contains unsupported keys');
    }
  }
  if (typeof input.command !== 'string' || input.command.trim().length === 0) {
    throw new Error('verify_check: `command` must be a non-empty string');
  }
  if (typeof input.passed !== 'boolean') {
    throw new Error('verify_check: `passed` must be a boolean');
  }
  if (typeof input.summary !== 'string') {
    throw new Error('verify_check: `summary` must be a string');
  }
  return {
    command: truncateText(redactSummary(input.command.trim()), VERIFY_COMMAND_MAX_CHARS),
    exitCode: toExitCode(input.exitCode),
    passed: input.passed,
    summary: truncateText(redactSummary(input.summary), VERIFY_SUMMARY_MAX_CHARS),
  };
}

/**
 * Build the canonical tool value (JSON) for one verification record.
 * Pure: deterministic given args.
 * @param {unknown} args raw model arguments.
 * @returns {{ command: string, exitCode: number, passed: boolean, summary: string }} canonical value.
 */
export function toVerifyValue(args) {
  return normalizeVerifyArgs(args);
}

/**
 * Render one canonical value to model-facing content. Pure, no I/O.
 * @param {unknown} _args validated args (unused in text).
 * @param {{ command: string, exitCode: number, passed: boolean, summary: string }} value canonical value.
 * @returns {Array<{ type: 'text', text: string }>} content blocks.
 */
export function renderVerifyValue(_args, value) {
  const status = value.passed ? 'PASS' : 'FAIL';
  return [
    {
      type: 'text',
      text: `Verification ${status}: \`${value.command}\` exited ${value.exitCode}. ${value.summary}`,
    },
  ];
}

/**
 * The `defineTool`-compatible tool definition factory.
 * Takes `defineTool` as an argument so unit tests can run without the DSH
 * host packages installed; the plugin entry passes the real one.
 * Falls back to a plain definition object when `defineTool` is unavailable
 * (matches the skills-manager precedent of registering a plain object with
 * `ctx.tools.register`).
 * @param {(options: object) => object} [defineTool] host `defineTool`, when available.
 * @returns {object} tool definition for `ctx.tools.register`.
 */
export function createVerifyToolDefinition(defineTool) {
  const definition = {
    name: VERIFY_TOOL_NAME,
    description:
      'Record one verification outcome for the agentic task loop (command, exit code, pass/fail, short output summary). Call after running the relevant automated check; the record is appended to the session and replayed in UIs.',
    // NOTE (DSH 0.2.0-rc.2 `defineTool` value-schema DSL): `parameters` is an
    // implicit open property map — NOT a JSON-Schema `{ type: 'object', ... }`
    // wrapper. Requiredness is a per-property `required: true` annotation.
    // Passing the wrapped form rejects with
    // `parameters.type must be a value schema object`. Property meanings,
    // descriptions, and requiredness are unchanged from the previous shape.
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The exact verification command that was run (e.g. `npm test`).',
      },
      exitCode: {
        type: 'integer',
        required: true,
        description: 'Process exit code of the verification command (0 = success).',
      },
      passed: {
        type: 'boolean',
        required: true,
        description: 'Whether the verification passed.',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'Short output summary (key lines only, no secrets).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          exitCode: { type: 'integer' },
          passed: { type: 'boolean' },
          summary: { type: 'string' },
        },
      },
      render: renderVerifyValue,
    },
    /**
     * Append the verification record to the calling agent's session.
     * Throws (never reports success) when there is no owning agent or the
     * arguments are invalid. Plugin-owned failures are logged by the entry
     * point's diagnostics wrapper, not here.
     */
    async execute(args, exec) {
      const value = toVerifyValue(args);
      if (!exec || !exec.agent) {
        throw new Error('verify_check requires an owning agent session');
      }
      exec.agent.session.append(VERIFY_EVENT_TYPE, value);
      return value;
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Record verification result',
      kind: 'other',
      // Present only the redacted, 120-char display form of the command:
      // `rawInput` reaches tool-call cards/UIs, so raw secrets or raw user
      // paths must never appear here.
      rawInput:
        args !== null && typeof args === 'object' && 'command' in args
          ? truncateText(
              redactSummary(String(/** @type {Record<string, unknown>} */ (args).command)),
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
