/**
 * Behavior tests for the v2 slice: task router, task_state tool, failure
 * evidence, Skill frontmatter, and plugin entry wiring.
 * Run: `npm test` (node:test, stdlib only).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';
import { ROUTE_SECTION_NAME, ROUTE_SECTION_ORDER, ROUTE_SECTION_TEXT } from '../lib/route-section.js';
import { TASK_KINDS, isTaskKind, routeTaskKind } from '../lib/route.js';
import {
  TASK_STATE_EVENT_TYPE,
  TASK_STATE_TOOL_NAME,
  __resetVerifyRegistryForTests,
  buildFailureSummary,
  hasVerifySuccess,
  isLegalTransition,
  normalizeTaskStateArgs,
  recordVerifySuccess,
} from '../lib/task-state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HERE);

function createFakeCtx() {
  const state = { sections: [], tools: [], listeners: new Map(), appendedEvents: [] };
  const ctx = {
    systemPrompt: {
      section(section) {
        state.sections.push(section);
        return () => {};
      },
    },
    tools: {
      register(definition) {
        state.tools.push(definition);
        return () => {};
      },
    },
    on(event, listener) {
      state.listeners.set(event, listener);
      return () => {};
    },
    effect(fn) {
      return fn();
    },
  };
  return { ctx, state };
}

function makeSession(state) {
  return {
    append(type, data) {
      state.appendedEvents.push({ type, data });
    },
  };
}

describe('routeTaskKind', () => {
  it('routes all four kinds to a context/skills/tools/gate bundle', () => {
    assert.deepEqual([...TASK_KINDS].sort(), ['code-change', 'investigation', 'multi-step', 'qa']);
    for (const kind of TASK_KINDS) {
      assert.ok(isTaskKind(kind));
      const route = routeTaskKind(kind);
      assert.ok(typeof route.context === 'string' && route.context.length > 0);
      assert.ok(Array.isArray(route.skills));
      assert.ok(typeof route.gate === 'string' && route.gate.length > 0);
    }
    assert.deepEqual(routeTaskKind('code-change').skills, ['v2-verify-loop']);
    assert.deepEqual(routeTaskKind('qa').skills, ['v2-answer']);
    assert.deepEqual(routeTaskKind('investigation').skills, ['v2-investigate']);
    assert.deepEqual(routeTaskKind('multi-step').skills, ['v2-verify-loop', 'v2-recover']);
  });

  it('throws on unknown kind (never silently defaults)', () => {
    assert.throws(() => routeTaskKind('ship-it'), /unknown task kind/);
    assert.equal(isTaskKind('ship-it'), false);
  });
});

describe('task_state transitions', () => {
  it('allows the happy path plan->active->verify->done with session-bound verifyRef (H1+H2)', () => {
    __resetVerifyRegistryForTests();
    assert.ok(isLegalTransition('plan', 'active'));
    assert.ok(isLegalTransition('plan', 'plan'), 'initial plan records plan→plan');
    assert.ok(isLegalTransition('active', 'verify'));
    assert.ok(isLegalTransition('verify', 'done'));
    const session = { id: 'test-session-h1h2' };
    // Without a recorded verify success the same ref must be rejected…
    assert.throws(
      () =>
        normalizeTaskStateArgs(
          { phase: 'done', from: 'verify', taskKind: 'code-change', summary: 'green', verifyRef: 'npm test' },
          session,
        ),
      /must match a passed verify_check/,
    );
    // …and accepted once the owning session observed the passed check.
    recordVerifySuccess(session, 'npm test');
    assert.ok(hasVerifySuccess(session, 'npm test'));
    const value = normalizeTaskStateArgs(
      {
        phase: 'done',
        from: 'verify',
        taskKind: 'code-change',
        summary: 'target test green',
        verifyRef: 'npm test',
      },
      session,
    );
    assert.equal(value.phase, 'done');
    // Cross-session bleed is rejected: another session object/id cannot reuse it.
    assert.throws(
      () =>
        normalizeTaskStateArgs(
          { phase: 'done', from: 'verify', taskKind: 'code-change', summary: 'x', verifyRef: 'npm test' },
          { id: 'other-session' },
        ),
      /must match a passed verify_check/,
    );
  });

  it('reachable blocked from any working phase; re-entry via active/plan', () => {
    for (const from of ['plan', 'active', 'verify']) {
      assert.ok(isLegalTransition(from, 'blocked'), `${from} must reach blocked`);
    }
    assert.ok(isLegalTransition('blocked', 'active'));
    assert.ok(isLegalTransition('blocked', 'plan'));
    assert.equal(isLegalTransition('done', 'active'), false);
  });

  it('done without verifyRef throws (prompt alone never completes)', () => {
    assert.throws(
      () =>
        normalizeTaskStateArgs(
          { phase: 'done', from: 'verify', taskKind: 'qa', summary: 'looks good' },
          { id: 's-h2-missing' },
        ),
      /verifyRef/,
    );
  });

  it('missing from is rejected (H1: explicit edge required)', () => {
    assert.throws(
      () =>
        normalizeTaskStateArgs(
          { phase: 'active', taskKind: 'qa', summary: 'starting' },
          { id: 's-h1-missing' },
        ),
      /`from`.*required/,
    );
  });

  it('blocked without failure evidence throws (no silent stop)', () => {
    assert.throws(
      () =>
        normalizeTaskStateArgs({ phase: 'blocked', from: 'active', taskKind: 'multi-step', summary: 'stuck' }),
      /failure/,
    );
  });

  it('illegal transition throws; unknown keys rejected', () => {
    __resetVerifyRegistryForTests();
    assert.throws(
      () =>
        normalizeTaskStateArgs(
          { phase: 'done', from: 'plan', taskKind: 'qa', summary: 'x', verifyRef: 'v' },
          { id: 's-h1-illegal' },
        ),
      /illegal transition/,
    );
    assert.throws(
      () =>
        normalizeTaskStateArgs(
          {
            phase: 'active',
            from: 'plan',
            taskKind: 'qa',
            summary: 'x',
            extra: 'sentinel',
          },
          { id: 's-h1-keys' },
        ),
      /unsupported keys/,
    );
  });
});

describe('buildFailureSummary', () => {
  it('redacts secrets/user paths and caps length (redact first, then truncate)', () => {
    const out = buildFailureSummary(
      `FAIL Authorization: Bearer SNTL-V2-BEARER-901 token SNTL-V2-TOKEN-902 at /home/SNTLV2USER903/work ` +
        'x'.repeat(2000),
    );
    assert.doesNotMatch(out, /SNTL-V2-BEARER-901/);
    assert.doesNotMatch(out, /SNTL-V2-TOKEN-902/);
    assert.doesNotMatch(out, /SNTLV2USER903/);
    assert.match(out, /\[redacted\]/);
    assert.ok(Array.from(out).length <= 1000 + '…[truncated]'.length);
  });
});

describe('skill frontmatter', () => {
  it('all four bundled skills exist with name/description/version/output-contract', () => {
    for (const name of ['v2-verify-loop', 'v2-investigate', 'v2-answer', 'v2-recover']) {
      const text = readFileSync(join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
      assert.match(text, /^---\n/);
      assert.match(text, new RegExp(`name: ${name}`));
      assert.match(text, /description: .+/);
      assert.match(text, /version: 0\.1\.0/);
      assert.match(text, /output-contract:/);
      const firstLine = text.split('\n')[0];
      assert.equal(firstLine, '---');
    }
  });
});

describe('v2 plugin entry (fake host ctx)', () => {
  let workDir;
  let previousEnv;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'abv2-'));
    previousEnv = process.env.DSH_AGENTIC_BOOST_LOG_DIR;
    process.env.DSH_AGENTIC_BOOST_LOG_DIR = join(workDir, 'logs');
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.DSH_AGENTIC_BOOST_LOG_DIR;
    else process.env.DSH_AGENTIC_BOOST_LOG_DIR = previousEnv;
    rmSync(workDir, { recursive: true, force: true });
  });

  it('registers both prompt sections (task-loop + task-route)', () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const names = state.sections.map((s) => s.name).sort();
    assert.ok(names.includes('agentic-boost:task-loop'));
    assert.ok(names.includes(ROUTE_SECTION_NAME));
    const route = state.sections.find((s) => s.name === ROUTE_SECTION_NAME);
    assert.equal(route.order, ROUTE_SECTION_ORDER);
    assert.equal(route.text, ROUTE_SECTION_TEXT);
    assert.ok(Array.from(ROUTE_SECTION_TEXT).length < 2000, 'route section stays short');
  });

  it('registers task_state; full loop via session-bound verify, done-without-evidence throws', async () => {
    __resetVerifyRegistryForTests();
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const verifyTool = state.tools.find((t) => t.name === 'verify_check');
    const tool = state.tools.find((t) => t.name === TASK_STATE_TOOL_NAME);
    assert.ok(tool, 'task_state must be registered');
    const session = makeSession(state);
    const value = await tool.execute(
      { phase: 'active', from: 'plan', taskKind: 'multi-step', summary: 'starting' },
      { agent: { session }, signal: new AbortController().signal },
    );
    assert.equal(value.phase, 'active');
    // done without a session-bound verify success is rejected (H2)…
    await assert.rejects(
      () =>
        tool.execute(
          { phase: 'done', from: 'verify', taskKind: 'code-change', summary: 'done-ish', verifyRef: 'npm test' },
          { agent: { session }, signal: new AbortController().signal },
        ),
      /must match a passed verify_check/,
    );
    // …while the full loop (verify_check pass → done) appends both events.
    const record = await verifyTool.execute(
      { command: 'npm test', exitCode: 0, passed: true, summary: 'green' },
      { agent: { session }, signal: new AbortController().signal },
    );
    assert.equal(record.passed, true);
    const done = await tool.execute(
      { phase: 'done', from: 'verify', taskKind: 'code-change', summary: 'green', verifyRef: 'npm test' },
      { agent: { session }, signal: new AbortController().signal },
    );
    assert.equal(done.phase, 'done');
    const types = state.appendedEvents.map((e) => e.type);
    assert.ok(types.includes('agentic-boost/verify-check'));
    assert.ok(types.includes(TASK_STATE_EVENT_TYPE));
  });

  it('post-execute enrichment: failed verify returns decision contexts; next stays zero-arg', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const post = state.listeners.get('tools/post-execute');
    assert.ok(post, 'post-execute listener must be registered');
    // Cordis-faithful zero-arg next: records any smuggled argument (H4).
    const calls = [];
    async function strictNext() {
      calls.push(Array.from(arguments));
      return { kind: 'accept' };
    }
    assert.equal(strictNext.length, 0, 'double keeps Cordis no-arg shape');
    // Failed verify_check with REAL result text + args decoy (H3).
    const REAL = 'REAL-V2SLICE-RESULT-111';
    const DECOY = 'DECOY-V2SLICE-ARGS-222';
    const decision = await post(
      { name: 'verify_check', arguments: { command: `cmd ${DECOY}` } },
      {
        isError: false,
        value: { passed: false, summary: `fail body ${REAL}` },
        content: [{ type: 'text', text: `FAIL ${REAL}` }],
      },
      strictNext,
    );
    assert.equal(decision.kind, 'accept');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 0, 'next must be zero-arg');
    assert.ok(Array.isArray(decision.additionalContexts));
    assert.match(JSON.stringify(decision.additionalContexts), new RegExp(REAL));
    assert.doesNotMatch(JSON.stringify(decision.additionalContexts), new RegExp(DECOY));
    // Unrelated tool -> plain next(), returned decision is the inner accept.
    calls.length = 0;
    const passthrough = await post({ name: 'edit', arguments: {} }, { value: { ok: true } }, strictNext);
    assert.equal(passthrough.kind, 'accept');
    assert.equal(passthrough.additionalContexts, undefined);
  });

  it('post-execute listener failure is contained (real result preserved)', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const post = state.listeners.get('tools/post-execute');
    const throwingNext = async () => ({ kind: 'accept' });
    // Hostile result whose content getter throws: enrichment must contain it.
    const evilResult = { isError: false, value: { passed: false, summary: 'x' } };
    Object.defineProperty(evilResult, 'content', {
      enumerable: true,
      get() {
        throw new Error('SNTL-V2-POST-904 enricher probe');
      },
    });
    const outcome = await post({ name: 'verify_check', arguments: {} }, evilResult, throwingNext);
    assert.equal(outcome.kind, 'accept', 'enricher failure must not mask the result');
  });

  it('task_state redacts sentinels from session event and value', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const tool = state.tools.find((t) => t.name === TASK_STATE_TOOL_NAME);
    const session = makeSession(state);
    const value = await tool.execute(
      {
        phase: 'blocked',
        from: 'active',
        taskKind: 'multi-step',
        summary: 'token SNTL-V2-SUM-905 done',
        failure: 'Bearer SNTL-V2-FAIL-906 at /home/SNTLV2USER907/x',
      },
      { agent: { session }, signal: new AbortController().signal },
    );
    const raw = JSON.stringify({ value, events: state.appendedEvents });
    for (const s of ['SNTL-V2-SUM-905', 'SNTL-V2-FAIL-906', 'SNTLV2USER907']) {
      assert.doesNotMatch(raw, new RegExp(s));
    }
  });
});
