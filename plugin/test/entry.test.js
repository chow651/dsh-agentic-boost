/**
 * Behavior tests for the verify_check tool definition + plugin entry wiring.
 * Uses a fake host ctx (no DSH runtime): asserts tool registration, section
 * registration, guard listener behavior, execute success/failure semantics,
 * and that failures land in redacted JSONL diagnostics.
 * Run: `npm test` (node:test, stdlib only).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';
import { SECTION_NAME, SECTION_ORDER, SECTION_TEXT } from '../lib/guidance.js';
import { VERIFY_EVENT_TYPE, VERIFY_TOOL_NAME } from '../lib/verify-tool.js';

/** Build a minimal fake Cordis ctx capturing registrations. */
function createFakeCtx() {
  const state = {
    sections: [],
    tools: [],
    listeners: new Map(),
    appendedEvents: [],
  };
  const ctx = {
    systemPrompt: {
      section(section) {
        state.sections.push(section);
        return () => {};
      },
      getSectionOrder: () => SECTION_ORDER,
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

function makeAgentSession(state) {
  return {
    append(type, data) {
      state.appendedEvents.push({ type, data });
    },
  };
}

describe('plugin entry (fake host ctx)', () => {
  let workDir;
  let previousEnv;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'abmvp-'));
    previousEnv = process.env.DSH_AGENTIC_BOOST_LOG_DIR;
    process.env.DSH_AGENTIC_BOOST_LOG_DIR = join(workDir, 'logs');
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.DSH_AGENTIC_BOOST_LOG_DIR;
    else process.env.DSH_AGENTIC_BOOST_LOG_DIR = previousEnv;
    rmSync(workDir, { recursive: true, force: true });
  });

  it('registers the guidance section with the documented name/order', () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    // v2 slice adds a second static section (task-route, order 460); the
    // original task-loop registration is unchanged.
    const loop = state.sections.find((s) => s.name === SECTION_NAME);
    assert.ok(loop, 'task-loop section must be registered');
    assert.equal(loop.order, 450);
    assert.match(loop.text, /understand → plan → act → verify → summarize/);
    assert.equal(loop.text, SECTION_TEXT);
  });

  it('registers verify_check and appends an observable session event on execute', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const tool = state.tools.find((t) => t.name === VERIFY_TOOL_NAME);
    assert.ok(tool, 'verify_check must be registered');
    const session = makeAgentSession(state);
    const value = await tool.execute(
      { command: 'npm test', exitCode: 0, passed: true, summary: '8 passed' },
      { agent: { session }, signal: new AbortController().signal },
    );
    assert.equal(value.passed, true);
    assert.equal(state.appendedEvents.length, 1);
    assert.equal(state.appendedEvents[0].type, VERIFY_EVENT_TYPE);
    assert.equal(state.appendedEvents[0].data.command, 'npm test');
    // Model-facing render is deterministic text.
    const blocks = tool.output.render({ command: 'npm test' }, value);
    assert.equal(blocks[0].type, 'text');
    assert.match(blocks[0].text, /Verification PASS/);
  });

  it('execute coerces integer-valued strings, still throws on garbage (never success)', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const tool = state.tools.find((t) => t.name === VERIFY_TOOL_NAME);
    const session = makeAgentSession(state);
    const value = await tool.execute(
      { command: 'npm test', exitCode: '0', passed: true, summary: 'ok' },
      { agent: { session }, signal: new AbortController().signal },
    );
    assert.equal(value.exitCode, 0);
    await assert.rejects(
      () =>
        tool.execute(
          { command: 'npm test', exitCode: 'zero', passed: true, summary: 'ok' },
          { agent: { session }, signal: new AbortController().signal },
        ),
      /must be an integer/,
    );
  });

  it('execute without an owning agent throws and writes a diagnostics record (never success)', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const tool = state.tools.find((t) => t.name === VERIFY_TOOL_NAME);
    await assert.rejects(
      () =>
        tool.execute(
          { command: 'npm test', exitCode: 1, passed: false, summary: 'red' },
          { agent: undefined, signal: new AbortController().signal },
        ),
      /requires an owning agent session/,
    );
    const logFile = join(process.env.DSH_AGENTIC_BOOST_LOG_DIR, 'diagnostics.jsonl');
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.phase, 'tool-execute');
    assert.equal(record.plugin, 'dsh-agentic-boost-mvp');
    assert.equal(typeof record.ts, 'string');
    assert.match(record.summary, /owning agent/);
  });

  it('pre-execute guard denies test edits and allows normal calls via next()', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const listener = state.listeners.get('tools/pre-execute');
    assert.ok(listener, 'guard listener must be registered');
    const next = async () => ({ kind: 'allow' });

    const denied = await listener(
      { name: 'edit', arguments: { path: 'tests/a.test.js' } },
      next,
    );
    assert.equal(denied.kind, 'deny');
    assert.match(denied.reason, /refusing to modify protected verify-loop artifact/);

    const allowed = await listener({ name: 'edit', arguments: { path: 'src/a.js' } }, next);
    assert.equal(allowed.kind, 'allow');
  });

  it('disabled config refuses to half-load', () => {
    const { ctx } = createFakeCtx();
    assert.throws(() => apply(ctx, { enabled: false }), /disabled by config/);
  });

  it('redacts secret-looking material in diagnostics summaries', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const tool = state.tools.find((t) => t.name === VERIFY_TOOL_NAME);
    await assert.rejects(() =>
      tool.execute(
        { command: 'x', exitCode: 1, passed: false, summary: 't' },
        {
          agent: {
            session: {
              append() {
                throw new Error('store failed with api_key=SECRET-VALUE-123 and more');
              },
            },
          },
          signal: new AbortController().signal,
        },
      ),
    );
    const logFile = join(process.env.DSH_AGENTIC_BOOST_LOG_DIR, 'diagnostics.jsonl');
    const record = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop());
    assert.doesNotMatch(record.summary, /SECRET-VALUE-123/);
    assert.match(record.summary, /\[redacted\]/);
  });

  it('verify_check redacts command/summary sentinels from session event, render, presentCall, and diagnostics', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const tool = state.tools.find((t) => t.name === VERIFY_TOOL_NAME);
    assert.ok(tool, 'verify_check must be registered');
    const sentinels = {
      bearer: 'SNTL-VCMD-BEARER-201',
      token: 'SNTL-VCMD-TOKEN-202',
      url: 'SNTL-VCMD-URL-203',
      user: 'SNTLVCMDUSER204',
    };
    const rawCommand =
      `npm test --auth Bearer ${sentinels.bearer} --url https://example.test/x?token=${sentinels.url}`;
    const rawSummary =
      `token ${sentinels.token} at /home/${sentinels.user}/work/output`;
    const session = makeAgentSession(state);
    const value = await tool.execute(
      { command: rawCommand, exitCode: 0, passed: true, summary: rawSummary },
      { agent: { session }, signal: new AbortController().signal },
    );
    const sessionJson = JSON.stringify(state.appendedEvents);
    for (const sentinel of Object.values(sentinels)) {
      assert.doesNotMatch(sessionJson, new RegExp(sentinel), 'session event must not carry raw sentinel');
      assert.doesNotMatch(JSON.stringify(value), new RegExp(sentinel), 'tool value must not carry raw sentinel');
    }
    const blocks = tool.output.render({ command: rawCommand }, value);
    for (const sentinel of Object.values(sentinels)) {
      assert.doesNotMatch(blocks[0].text, new RegExp(sentinel), 'rendered UI text must not carry raw sentinel');
    }
    const card = tool.presentCall({ command: rawCommand });
    for (const sentinel of [sentinels.bearer, sentinels.url, sentinels.user]) {
      assert.doesNotMatch(String(card.rawInput ?? ''), new RegExp(sentinel), 'presentCall must not carry raw sentinel');
    }
    assert.ok(String(card.rawInput ?? '').length <= 120 + '…[truncated]'.length);
    const logFile = join(process.env.DSH_AGENTIC_BOOST_LOG_DIR, 'diagnostics.jsonl');
    let logRaw = '';
    try {
      logRaw = readFileSync(logFile, 'utf8');
    } catch {
      logRaw = '';
    }
    for (const sentinel of Object.values(sentinels)) {
      assert.doesNotMatch(logRaw, new RegExp(sentinel), 'diagnostics must not carry raw sentinel');
    }
  });

  it('guard denial redacts the raw user path in reason, diagnostics, and match (with length cap)', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const listener = state.listeners.get('tools/pre-execute');
    assert.ok(listener, 'guard listener must be registered');
    const next = async () => ({ kind: 'allow' });
    const rawUser = 'SNTLGDUSER205';
    const longPath = `/home/${rawUser}/` + `${'w/'.repeat(150)}tests/a.test.js`;
    const denied = await listener({ name: 'edit', arguments: { path: longPath } }, next);
    assert.equal(denied.kind, 'deny');
    assert.doesNotMatch(String(denied.reason ?? ''), new RegExp(rawUser), 'deny reason must not carry the raw username');
    assert.ok(String(denied.reason ?? '').length <= 200 + 250, 'deny reason stays bounded');
    const logFile = join(process.env.DSH_AGENTIC_BOOST_LOG_DIR, 'diagnostics.jsonl');
    const logRaw = readFileSync(logFile, 'utf8');
    assert.doesNotMatch(logRaw, new RegExp(rawUser), 'diagnostics must not carry the raw username');
    assert.match(logRaw, /\[redacted\]/);
  });

  it('guard internal failure fails closed with an explicit deny (never a silent allow)', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const listener = state.listeners.get('tools/pre-execute');
    assert.ok(listener, 'guard listener must be registered');
    let nextCalled = false;
    const next = async () => {
      nextCalled = true;
      return { kind: 'allow' };
    };
    // A throwing `arguments` getter simulates a guard-internal crash inside
    // `decidePreExecute` (collectStrings rethrows on property access).
    const evilArgs = {};
    Object.defineProperty(evilArgs, 'boom', {
      enumerable: true,
      get() {
        throw new Error('SNTL-GUARD-THROW-206 policy load failure');
      },
    });
    const outcome = await listener({ name: 'edit', arguments: evilArgs }, next);
    assert.equal(outcome.kind, 'deny', 'internal failure must block, not pass through');
    assert.match(String(outcome.reason ?? ''), /guard internal failure/i);
    assert.equal(nextCalled, false, 'next() must not run on internal failure');
    const logFile = join(process.env.DSH_AGENTIC_BOOST_LOG_DIR, 'diagnostics.jsonl');
    const logRaw = readFileSync(logFile, 'utf8');
    assert.match(logRaw, /pre-execute-guard/);
  });
});
