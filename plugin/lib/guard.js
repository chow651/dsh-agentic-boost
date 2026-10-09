/**
 * Pre-execute guard policy for dsh-agentic-boost-mvp.
 *
 * Minimal, observable, deny-by-default-name guard: blocks model tool calls
 * that attempt to modify test files or logs covered by the verify loop
 * (pilot D1 rule "禁止修改测试文件与日志"), while allowing everything else
 * through untouched. It never rewrites arguments and never reports a blocked
 * call as success — a denial returns `{ kind: 'deny', reason }`.
 *
 * Why name-based: the `tools/pre-execute` contract hands the guard the
 * pending call identity (`exec.name`, parsed `exec.arguments`) but resolved
 * host paths live behind each tool's own schema; guessing host path
 * resolution would be inventing API. So the guard inspects string arguments
 * for test/log file references and denies only on clear matches. Host
 * approval/sandbox policy remains authoritative for everything else.
 */
import { basename } from 'node:path';

// Single shared redactor: guard denial surfaces use the exact same function
// as diagnostics/supervisor (no copied regex). No cycle: diagnostics.js
// imports only node: builtins, never guard.js (verified by grep over
// plugin/lib — the only sibling import of diagnostics.js is verify-tool.js).
import { redactSummary } from './diagnostics.js';

/** Maximum chars kept for a denial `match` detail (paths can be long). */
export const GUARD_MATCH_MAX_CHARS = 200;

/** Tool names this guard inspects (file-writing model tools). */
export const GUARDED_TOOL_NAMES = Object.freeze(['edit', 'write', 'str_replace_editor']);

/** Basename patterns treated as protected verify-loop artifacts. */
const PROTECTED_BASENAME_PATTERNS = [
  /(^|[_.-])test[_.-].*\.[a-z0-9]+$/i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /^fail\.log$/i,
  /^accept\.sh$/i,
];

/** Directory segments that mark a path as test-owned. */
const PROTECTED_DIR_SEGMENTS = Object.freeze(['__tests__', 'tests', 'test']);

function normalizeSeparators(value) {
  return String(value).replace(/\\/g, '/');
}

function splitSegments(value) {
  // Preserve the leading `/` so downstream redaction sees an absolute path
  // (`/home/<user>/…`) and the denial match keeps its absolute form.
  const normalized = normalizeSeparators(value);
  const leadingSlash = normalized.startsWith('/') ? '/' : '';
  const segments = normalized.split('/').filter(Boolean);
  return { leadingSlash, segments };
}

/**
 * Decide whether one string argument value references a protected artifact.
 * @param {string} value raw argument string.
 * @returns {{ protected: boolean, match: string|null }} match detail.
 */
export function matchProtectedValue(value) {
  const text = String(value ?? '');
  if (text.trim().length === 0) return { protected: false, match: null };
  const { leadingSlash, segments } = splitSegments(text);
  if (segments.some((segment) => PROTECTED_DIR_SEGMENTS.includes(segment.toLowerCase()))) {
    return { protected: true, match: `${leadingSlash}${segments.join('/')}` };
  }
  const base = basename(normalizeSeparators(text));
  if (PROTECTED_BASENAME_PATTERNS.some((pattern) => pattern.test(base))) {
    return { protected: true, match: base };
  }
  return { protected: false, match: null };
}

function collectStrings(value, out, depth = 0) {
  if (depth > 6 || out.length >= 50) return out;
  if (typeof value === 'string') {
    if (value.length <= 4096) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
  return out;
}

/**
 * Summarize a protected-artifact match for denial surfaces (reason text +
 * diagnostics). Applies the shared `redactSummary` (diagnostics.js — same
 * function supervisor tails and diagnostics records use) and the match
 * length cap, so raw absolute user paths and secret-looking segments never
 * reach session events, tool/UI display, or diagnostics logs. Precision loss
 * (chosen for safety): the exact username / secret value is replaced —
 * replay shows the artifact kind and sub-path, not the raw path.
 * @param {string|null|undefined} match raw match detail.
 * @returns {string} redacted, length-capped summary.
 */
export function summarizeGuardMatch(match) {
  const raw = String(match ?? 'protected artifact');
  // Redact FIRST on the full match (username may sit beyond the cap window),
  // then apply the length cap.
  const redacted = redactSummary(raw);
  const chars = Array.from(redacted);
  if (chars.length <= GUARD_MATCH_MAX_CHARS) return chars.join('');
  return `${chars.slice(0, GUARD_MATCH_MAX_CHARS).join('')}…[truncated]`;
}

/**
 * Decide a pre-execute outcome for one pending tool call.
 * Pure function: no I/O, no logging — the plugin entry point logs denials
 * and listener crashes via the diagnostics logger.
 * @param {string} toolName pending tool name.
 * @param {unknown} args parsed tool arguments.
 * @returns {{ verdict: 'allow'|'deny', reason?: string, match?: string }} decision.
 */
export function decidePreExecute(toolName, args) {
  if (!GUARDED_TOOL_NAMES.includes(String(toolName))) {
    return { verdict: 'allow' };
  }
  const strings = collectStrings(args, []);
  for (const text of strings) {
    const hit = matchProtectedValue(text);
    if (hit.protected) {
      const safeMatch = summarizeGuardMatch(hit.match);
      return {
        verdict: 'deny',
        reason:
          `agentic-boost-mvp: refusing to modify protected verify-loop artifact (${safeMatch}). ` +
          'Repair the implementation and re-run the check; never edit tests or logs to make them pass.',
        match: safeMatch,
      };
    }
  }
  return { verdict: 'allow' };
}
