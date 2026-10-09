/**
 * Plugin-scoped error diagnostics for dsh-agentic-boost-mvp.
 *
 * Scope: only wraps this plugin's own event handlers (tool execute,
 * pre-execute guard, prompt section provider). Never installs process-level
 * `uncaughtException` / `unhandledRejection` handlers and never touches host
 * errors outside this plugin's handlers.
 *
 * Record shape (one JSON object per line):
 *   { ts, plugin, pluginVersion, phase, category, summary }
 *
 * Privacy: `summary` is a truncated, redacted error message. Full prompts,
 * source code, secrets, API keys and model hidden reasoning are never
 * written here — callers pass only `error.message`-scale strings.
 */
import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const PLUGIN_NAME = 'dsh-agentic-boost-mvp';

export const DEFAULT_LOG_MAX_BYTES = 64 * 1024;
export const DEFAULT_LOG_MAX_FILES = 3;
export const MAX_SUMMARY_CHARS = 500;

/** Phases this plugin logs: which own-handler failed. */
export const PHASES = Object.freeze([
  'tool-execute',
  'pre-execute-guard',
  'prompt-section',
]);

/** Stable error categories for the plugin's own failures. */
export const CATEGORIES = Object.freeze([
  'validation',
  'config',
  'io',
  'internal',
]);

// Value-shaped secrets: redacting these never destroys the label word, so
// debug context (`Bearer …`, `token=…`) stays readable. Bare key words
// (`token`, `authorization`, …) are deliberately NOT in this list — replacing
// the label itself (old behavior: `Authorization: Bearer x` →
// `[redacted]: [redacted] [redacted]`) destroys debuggability without hiding
// any value. Values are caught by the targeted rules in redactSummary.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi,
  /sk-[A-Za-z0-9][A-Za-z0-9-_]{8,}/g,
  /xox[bap]-[A-Za-z0-9-]+/g,
];

/**
 * Redact likely-secret material from a short error summary.
 * Conservative: replaces the matched value, keeps the surrounding text so
 * the category stays debuggable.
 *
 * Covers (evidence-first, sentinel-tested):
 * - `Authorization: Bearer <value>` / bare `Bearer <value>` (Bearer first,
 *   otherwise the generic key=value rule leaves the token tail behind);
 * - `token <value>` with a space separator (not only `:`/`=`);
 * - URL query secrets (`?token=..&api_key=..&password=..`);
 * - absolute user paths (`/home/<user>`, `/Users/<user>`, `/root`,
 *   `C:\Users\<user>`) — the username segment becomes `[redacted]` while the
 *   sub-path is kept for debuggability;
 * - existing `sk-…` / `xox…` / PEM patterns.
 *
 * Precision loss (chosen for safety): the exact secret value and the OS
 * username are unrecoverable from the record; only the secret *kind* and the
 * sub-path below the home directory remain.
 * @param {string} text short error text to redact.
 * @returns {string} redacted text.
 */
export function redactSummary(text) {
  let out = String(text ?? '');
  // 1. Bearer tokens first: `Bearer <value>`.
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer [redacted]');
  // 2. URL query secrets: `?token=abc&api_key=xyz` — value ends at `&`, `#`,
  // whitespace, quote, or end of string.
  out = out.replace(
    /([?&](?:api[-_]?key|secret|token|password|passwd|pwd|authorization|access[_-]?token|session|auth)[^=]*=)([^&\s#;"']+)/gi,
    '$1[redacted]',
  );
  // 3. Redact key=value / key: value / key<space>value pairs for known
  // secret-ish keys. The separator class includes whitespace so
  // `token abc123` is covered, not only `token=abc123`.
  // The value lookahead skips `Bearer` (the `Authorization: Bearer <v>`
  // header is handled as one unit by rule 1 — without this, the generic
  // rule would eat `Bearer` as the value and leave the token tail behind)
  // and skips already-redacted values.
  out = out.replace(
    /((?:api[-_]?key|secret|token|password|passwd|pwd|authorization)\s*[:=\s]\s*)(?!Bearer\b|\[redacted\])([^\s,};"']+)/gi,
    '$1[redacted]',
  );
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  // 4. Absolute user paths: hide the username segment, keep the sub-path.
  out = out
    .replace(/(\/home\/)[^/\s"']+/g, '$1[redacted]')
    .replace(/(\/Users\/)[^/\s"']+/g, '$1[redacted]')
    .replace(/(C:\\Users\\)[^\\\s"']+/gi, '$1[redacted]')
    .replace(/(C:\/Users\/)[^/\s"']+/gi, '$1[redacted]');
  return out;
}

/**
 * Truncate a string to a char budget (code-point aware).
 * @param {string} text input text.
 * @param {number} maxChars char budget.
 * @returns {string} truncated text.
 */
export function truncateSummary(text, maxChars = MAX_SUMMARY_CHARS) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars).join('')}…[truncated]`;
}

/**
 * Resolve the diagnostics directory in a cross-platform way.
 * Precedence: explicit `dir` argument, `DSH_AGENTIC_BOOST_LOG_DIR` env,
 * then `<os.homedir()>/.dsh/logs/dsh-agentic-boost-mvp`.
 * Never hard-codes `/tmp`, `/home`, or path separators.
 * @param {string} [dir] explicit directory override.
 * @returns {string} absolute directory path.
 */
export function resolveLogDir(dir) {
  if (typeof dir === 'string' && dir.trim().length > 0) {
    return resolve(dir);
  }
  const fromEnv = process.env.DSH_AGENTIC_BOOST_LOG_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return resolve(fromEnv);
  }
  return join(homedir(), '.dsh', 'logs', PLUGIN_NAME);
}

/**
 * Resolve the active log file path for a directory.
 * @param {string} dir log directory.
 * @returns {string} absolute file path.
 */
export function resolveLogFile(dir) {
  return join(resolveLogDir(dir), 'diagnostics.jsonl');
}

/**
 * Classify a thrown value into a stable category.
 * @param {unknown} error thrown value.
 * @returns {string} one of CATEGORIES.
 */
export function classifyError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/config|disabled|schema|argument|parameter|validation|invalid/i.test(message)) {
    return 'validation';
  }
  if (/ENOENT|EACCES|EPERM|EROFS|ENOSPC|EISDIR|ENOTDIR/i.test(message)) {
    return 'io';
  }
  if (/log|rotate|directory/i.test(message)) {
    return 'config';
  }
  return 'internal';
}

/**
 * Rotate log files when the active file reaches the byte budget.
 * Keeps `diagnostics.jsonl` plus `.1 .. .<maxFiles-1>`; deletes the oldest.
 * Failures are swallowed: diagnostics must never break the plugin.
 * @param {string} file active log file path.
 * @param {number} maxBytes rotation threshold in bytes.
 * @param {number} maxFiles total files to keep (active + rotated).
 */
export async function maybeRotate(file, maxBytes, maxFiles) {
  try {
    const current = await stat(file).catch(() => null);
    if (!current || current.size < maxBytes) return;
    const oldest = `${file}.${Math.max(maxFiles - 1, 1)}`;
    await rm(oldest, { force: true });
    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      const to = `${file}.${index + 1}`;
      try {
        await rename(from, to);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await rename(file, `${file}.1`);
  } catch {
    // Diagnostics are best-effort; never throw out of rotation.
  }
}

/**
 * Create a plugin-scoped JSONL diagnostics logger.
 * @param {object} [options] logger options.
 * @param {string} [options.dir] log directory override.
 * @param {string} [options.pluginVersion] plugin version string.
 * @param {number} [options.maxBytes] per-file byte budget.
 * @param {number} [options.maxFiles] files to keep.
 * @returns {{ file: string, log: (phase: string, error: unknown) => Promise<void> }} logger.
 */
export function createDiagnosticsLogger(options = {}) {
  const dir = resolveLogDir(options.dir);
  const file = join(dir, 'diagnostics.jsonl');
  const pluginVersion =
    typeof options.pluginVersion === 'string' && options.pluginVersion.length > 0
      ? options.pluginVersion
      : 'unknown';
  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : DEFAULT_LOG_MAX_BYTES;
  const maxFiles =
    Number.isFinite(options.maxFiles) && options.maxFiles >= 1
      ? Math.floor(options.maxFiles)
      : DEFAULT_LOG_MAX_FILES;

  let queue = Promise.resolve();

  /**
   * Append one redacted diagnostics record. Never throws.
   * @param {string} phase one of PHASES.
   * @param {unknown} error thrown value from this plugin's own handler.
   */
  async function log(phase, error) {
    queue = queue.then(async () => {
      try {
        const safePhase = PHASES.includes(phase) ? phase : 'internal';
        const category = classifyError(error);
        const rawMessage = error instanceof Error ? error.message : String(error ?? 'unknown error');
        const summary = truncateSummary(redactSummary(rawMessage));
        const record = {
          ts: new Date().toISOString(),
          plugin: PLUGIN_NAME,
          pluginVersion,
          phase: safePhase,
          category,
          summary,
        };
        await mkdir(dirname(file), { recursive: true });
        await maybeRotate(file, maxBytes, maxFiles);
        await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
      } catch {
        // Never let diagnostics break the host or the plugin's own result.
      }
    });
    await queue;
  }

  return { file, log };
}

/**
 * List existing diagnostics files (for tests; best-effort).
 * @param {string} [dir] log directory override.
 * @returns {Promise<string[]>} absolute file paths, active file first.
 */
export async function listDiagnosticsFiles(dir) {
  const resolved = resolveLogDir(dir);
  const entries = await readdir(resolved).catch(() => []);
  const files = entries
    .filter((name) => name === 'diagnostics.jsonl' || /^diagnostics\.jsonl\.\d+$/.test(name))
    .sort();
  const activeIndex = files.indexOf('diagnostics.jsonl');
  if (activeIndex > 0) {
    files.splice(activeIndex, 1);
    files.unshift('diagnostics.jsonl');
  }
  return files.map((name) => join(resolved, name));
}
