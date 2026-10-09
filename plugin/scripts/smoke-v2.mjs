/**
 * Single-invocation transparent live-smoke runner for the v2 slice.
 *
 * Everything (isolated DSH_HOME + profile + install + dump-config + ONE
 * `dsh --json` run + JSONL parse + cleanup) happens inside ONE process
 * invocation, because the sandbox /tmp does NOT persist across turns
 * (observed: files created in one turn are gone in the next — the root
 * cause of the earlier cross-turn `task.txt ENOENT`). Nothing is split
 * across turns; V2TMP is created here, passed to children via env, parsed
 * here, and removed here.
 *
 * Safety: isolated DSH_HOME only (never real ~/.dsh); read-only synthetic
 * task (2+3, no secrets); model package/provider/model are supplied by the
 * caller via flags or DSH_MODEL_* environment variables; no personal profile
 * is assumed. Skills use $DSH_BUNDLED_SKILL_DIR; one model invocation, no retry.
 *
 * Usage:
 *   node plugin/scripts/smoke-v2.mjs --run --model-dir D --model-package P
 *     --model-provider P --model-id ID [--task "..."] [--timeout-ms N]
 *     [--plugin-dir D] [--profile-name P] [--keep-tmp]
 *   Alternatively set DSH_MODEL_DIR, DSH_MODEL_PACKAGE, DSH_MODEL_PROVIDER,
 *     and DSH_MODEL_ID in the environment.
 * Without --run: prints the NOT RUN plan ledger, exit 0.
 * With --run: exit 0 PASS ONLY when task-specific evidence is fully proven
 *   (currently impossible: skill/verify/task_state specifics stay `unknown`,
 *   so the best terminal verdict is INCONCLUSIVE/BLOCKED, exit 1, no retry).
 *   The ledger never stores the task text (only `promptChars`), never stores
 *   raw stdout/stderr, and redacts every error summary (<=500 chars).
 */
import { mkdtemp, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildSmokeEvidence, summarizeSmokeStderr, taskPromptMeta } from './smoke-events.mjs';

// Import-safe: importing this module (e.g. from a synthetic test) must
// never print the plan, exit the process, or spawn a model run.
const IS_MAIN = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return fileURLToPath(import.meta.url) === resolve(entry)
      || import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
})();

/**
 * Pure evidence entry used by the live runner AND the runner-level
 * synthetic test: parses child `--json` stdout structurally (no
 * substring checks) and summarizes stderr redacted. Never retains raw
 * stdout/stderr, prompts, tool input/result, or absolute paths.
 */
export function summarizeRunEvidence(stdout, stderr) {
  return buildSmokeEvidence(stdout, stderr);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] !== undefined ? ARGV[i + 1] : fallback;
};

const PLUGIN_DIR = resolve(opt('--plugin-dir', join(HERE, '..')));
const MODEL_DIR = opt('--model-dir', process.env.DSH_MODEL_DIR ?? '');
const MODEL_PACKAGE = opt('--model-package', process.env.DSH_MODEL_PACKAGE ?? '');
const MODEL_PROVIDER = opt('--model-provider', process.env.DSH_MODEL_PROVIDER ?? '');
const MODEL_ID = opt('--model-id', process.env.DSH_MODEL_ID ?? '');
const PROFILE_NAME = opt('--profile-name', 'dsh-agentic-boost-v2');
const TIMEOUT_MS = Number(opt('--timeout-ms', '180000'));
const KEEP_TMP = ARGV.includes('--keep-tmp');
const DEFAULT_TASK = [
  'Load the skill named v2-answer with the skill tool and follow its steps.',
  'Question: what is 2+3?',
  'Then record your check with verify_check (command SMOKE-V2-ADD, exitCode 0, passed true, one-line summary),',
  'then mark task_state from verify to done with taskKind qa and the same verifyRef.',
  'End your final message with exactly: SMOKE-DONE',
].join(' ');

if (IS_MAIN && !ARGV.includes('--run')) {
  console.log(JSON.stringify({
    status: 'NOT RUN',
    reason: 'smoke runner requires explicit --run; without it this is a plan print only',
    plan: {
      profile: 'isolated copy (never the real profile)',
      model: {
        package: MODEL_PACKAGE || 'provide --model-package or DSH_MODEL_PACKAGE',
        provider: MODEL_PROVIDER || 'provide --model-provider or DSH_MODEL_PROVIDER',
        id: MODEL_ID || 'provide --model-id or DSH_MODEL_ID',
      },
      skills: '$DSH_BUNDLED_SKILL_DIR -> plugin/skills (documented mechanism)',
      budget: '1 dsh invocation, single prompt, no retry',
      lifecycle: 'mkdtemp + install + dump + run + parse + cleanup in ONE process (tmp is turn-volatile)',
      ledger: ['prompt-chars-only', 'profile-config', 'skill-call-unknown-unless-proven', 'verify-event-unknown-unless-proven', 'task-state-unknown-unless-proven', 'final-presence', 'exit-code', 'usage-totals', 'workdir-diff'],
      trust: 'parser input is the local child stdout string (structure proven, origin not authenticated); skill/verify/task_state specifics have no verified schema and stay unknown',
    },
  }, null, 2));
  process.exit(0);
}

async function main() {
  if (ARGV.includes('--run') && (!MODEL_DIR || !MODEL_PACKAGE || !MODEL_PROVIDER || !MODEL_ID)) {
    console.error('For --run, provide --model-dir, --model-package, --model-provider, and --model-id (or the matching DSH_MODEL_* environment variables).');
    process.exitCode = 2;
    return;
  }
  const taskText = opt('--task', DEFAULT_TASK);
  const ledger = {
    status: 'BLOCKED',
    promptChars: taskPromptMeta(taskText).promptChars,
    profile: PROFILE_NAME,
    model: { package: MODEL_PACKAGE, provider: MODEL_PROVIDER, model: MODEL_ID },
    checks: {},
    rawExit: null,
  };
  const base = await mkdtemp(join(tmpdir(), 'abv2-smoke-'));
  const finish = async (extra) => {
    Object.assign(ledger, extra);
    if (!KEEP_TMP) await rm(base, { recursive: true, force: true }).catch(() => {});
    else console.log(`kept tmp: ${base}`);
    console.log(JSON.stringify(ledger, null, 2));
    process.exit(ledger.status === 'PASS' ? 0 : 1);
  };
  try {
    const home = join(base, 'home');
    const work = join(base, 'work');
    const profileDir = join(home, 'profiles', PROFILE_NAME);
    await mkdir(profileDir, { recursive: true });
    await mkdir(work, { recursive: true });
    await writeFile(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: `dsh-profile-${PROFILE_NAME}`,
        private: true,
        dependencies: {
          'dsh-agentic-boost-mvp': `link:${PLUGIN_DIR}`,
          [MODEL_PACKAGE]: `link:${resolve(MODEL_DIR)}`,
        },
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@deepseek-ai/dsh-headless',
              MODEL_PACKAGE,
              'dsh-agentic-boost-mvp',
            ],
          },
        },
      }),
      'utf8',
    );
    await writeFile(
      join(profileDir, 'cordis.patch.yml'),
      [
        '- id: agent-default-model',
        '  name: "@deepseek-ai/dsh-agent-default-model"',
        '  config:',
        `    provider: ${JSON.stringify(MODEL_PROVIDER)}`,
        `    model: ${JSON.stringify(MODEL_ID)}`,
        '    reasoningEffort: balanced',
        '',
      ].join('\n'),
      'utf8',
    );
    const isoEnv = {
      ...process.env,
      DSH_HOME: home,
      DSH_BUNDLED_SKILL_DIR: join(PLUGIN_DIR, 'skills'),
      XDG_DATA_HOME: join(base, 'xdg-data'),
      XDG_CACHE_HOME: join(base, 'xdg-cache'),
      XDG_STATE_HOME: join(base, 'xdg-state'),
      NPM_CONFIG_CACHE: join(base, 'npm-cache'),
      COREPACK_HOME: join(base, 'corepack'),
    };
    const install = spawnSync('dsh', ['plugin', '--profile', PROFILE_NAME, 'install'], {
      env: isoEnv, encoding: 'utf8', timeout: 120000,
    });
    ledger.checks.installExit = install.status;
    if (install.status !== 0) {
      await finish({ reason: `plugin install exit ${install.status}`, installStderr: summarizeSmokeStderr(install.stderr) });
      return;
    }
    const dump = spawnSync('dsh', ['--profile', PROFILE_NAME, '--dump-config'], {
      env: isoEnv, encoding: 'utf8', timeout: 120000,
    });
    ledger.checks.dumpExit = dump.status;
    ledger.checks.bundleRow = String(dump.stdout ?? '').includes('agentic-boost-mvp');
    ledger.checks.modelRow = String(dump.stdout ?? '').includes(MODEL_ID);
    if (dump.status !== 0 || !ledger.checks.bundleRow || !ledger.checks.modelRow) {
      await finish({ reason: 'dump-config missing bundle/model row', dumpStderr: summarizeSmokeStderr(dump.stderr) });
      return;
    }
    // Task file is created HERE, in the same live directory the child runs in.
    // The ledger keeps only promptChars; the local variable is live-only.
    await writeFile(join(work, 'task.txt'), `${taskText}\n`, 'utf8');
    const run = spawnSync('dsh', ['--profile', PROFILE_NAME, '--json', taskText], {
      env: isoEnv, cwd: work, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    });
    ledger.rawExit = run.status;
    // Structured evidence only: parse child `--json` stdout via the pure
    // parser (no substring checks on stdout bodies). Raw stdout/stderr are
    // never persisted — only the whitelist summary below is kept.
    const evidence = summarizeRunEvidence(run.stdout, run.stderr);
    ledger.sessionId = evidence.parsed.sessionId;
    ledger.checks.jsonlLines = evidence.parsed.jsonlLines;
    ledger.checks.malformedLines = evidence.parsed.malformedLines;
    ledger.checks.eventCounts = evidence.parsed.eventCounts;
    ledger.checks.tools = evidence.parsed.tools;
    ledger.checks.completedCalls = evidence.parsed.completedCalls;
    ledger.checks.structuredToolSuccess = evidence.parsed.evidence.structuredToolSuccess;
    // Specific skill / verify_check / task_state successes have no verified
    // safe sub-schema: they stay `unknown`, never inferred from tool names
    // or body text (Codi trust boundary).
    ledger.checks.skillCall = evidence.parsed.evidence.skillCall;
    ledger.checks.verifyEvent = evidence.parsed.evidence.verifyEvent;
    ledger.checks.taskStateDone = evidence.parsed.evidence.taskStateDone;
    ledger.checks.finalPresent = evidence.parsed.evidence.finalPresent;
    ledger.checks.workdirAfter = await readdir(work).catch(() => []);
    ledger.usage = evidence.parsed.usage.lastTotals ?? '日志未提供';
    ledger.usageStatusEvents = evidence.parsed.usage.statusEventsWithUsage;
    ledger.stderrSummary = evidence.stderrSummary;
    if (run.status !== 0) {
      await finish({ reason: `dsh run exit ${run.status} (signal ${run.signal ?? 'none'}) — no retry` });
      return;
    }
    // PASS is impossible while task specifics stay `unknown`: the best
    // terminal verdict is INCONCLUSIVE (generic call + final) or BLOCKED.
    // The process exit stays non-PASS (exit 1) either way.
    await finish({ status: evidence.verdict, reason: `structured verdict ${evidence.verdict}: skill=${evidence.parsed.evidence.skillCall} verify=${evidence.parsed.evidence.verifyEvent} task_state=${evidence.parsed.evidence.taskStateDone} — recorded as-is, no retry` });
  } catch (error) {
    await finish({ reason: 'runner exception (no model call may have happened)', exception: summarizeSmokeStderr(error?.message ?? error) });
  }
}

if (IS_MAIN) await main();
