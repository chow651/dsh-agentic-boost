/**
 * v2 risk regression (C-V2-RISK-REGRESSION-01): two focused red-expected tests.
 *
 * Scope: stdlib only (`node:test`, `node:assert/strict`, `node:fs`,
 * `node:os`, `node:path`). Run: `node --test test/v2-risk-regression.test.js`
 * (cwd `plugin/`). No production change; record the real pass/fail as-is.
 *
 * Contract sources (installed, read-only, DSH 0.2.0-rc.2):
 * - `tools/post-execute (exec, result, next: () => Promise<PostToolDecision>)`:
 *   @deepseek-ai/dsh-tools `lib/types/index.d.ts:70`
 * - `PostToolDecision` block shape `{ kind:'block', feedback: ContentBlock[] }`:
 *   `lib/types/index.d.ts:465-479`; `TextBlock { type:'text', text:string }`:
 *   @deepseek-ai/dsh-llm `lib/types/types.d.ts:46-49`
 * - Host consumes the RETURNED decision (`block` -> isError from `feedback`):
 *   @deepseek-ai/dsh-tools `lib/index.js:3503-3531`
 * - Cordis waterfall runs outermost-first, returns outermost return value,
 *   `next = () => ...` zero-arg: @deepseek-ai/cordis `lib/index.js:317-325`
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

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

describe('v2 risk regression', () => {
  let workDir;
  let previousEnv;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'abv2risk-'));
    previousEnv = process.env.DSH_AGENTIC_BOOST_LOG_DIR;
    process.env.DSH_AGENTIC_BOOST_LOG_DIR = join(workDir, 'logs');
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.DSH_AGENTIC_BOOST_LOG_DIR;
    else process.env.DSH_AGENTIC_BOOST_LOG_DIR = previousEnv;
    rmSync(workDir, { recursive: true, force: true });
  });

  it('inner post-execute block/feedback survives the plugin outer listener', async () => {
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const post = state.listeners.get('tools/post-execute');
    assert.ok(post, 'tools/post-execute listener must be registered via apply()');
    // Cordis-faithful zero-arg inner next returning a legal block decision
    // (PostToolDecision block: feedback ContentBlock[]; TextBlock shape verified
    // against dsh-llm types). Records smuggled args via `arguments`.
    const INNER_FEEDBACK_TEXT = 'INNER-RISK-BLOCK-feedback-3fa7 must survive outer listener';
    const calls = [];
    async function innerNext() {
      calls.push(Array.from(arguments));
      return { kind: 'block', feedback: [{ type: 'text', text: INNER_FEEDBACK_TEXT }] };
    }
    assert.equal(innerNext.length, 0, 'inner next must keep Cordis zero-arg shape');
    // Failed verify result so the plugin enrichment path is taken; inner
    // decision is the block above (outer-first waterfall semantics).
    const decision = await post(
      { name: 'verify_check', arguments: {} },
      {
        isError: false,
        value: { passed: false, summary: 'enrichment-path probe failure body' },
        content: [{ type: 'text', text: 'FAIL probe' }],
      },
      innerNext,
    );
    assert.equal(calls.length, 1, 'inner next() must be reached exactly once');
    assert.equal(calls[0].length, 0, 'outer listener must call next() with zero arguments');
    assert.equal(decision?.kind, 'block', 'outer listener must not rewrite inner block into accept');
    const feedbackText = JSON.stringify(decision?.feedback ?? null);
    assert.match(feedbackText, /INNER-RISK-BLOCK-feedback-3fa7/, 'inner feedback must be preserved');
  });

  it('stale verify success is unusable for done after a later failed attempt (same session, same command)', async () => {
    // Limited claim: only "after a subsequent failed verify attempt for the
    // same command, the old passed evidence must not authorize done". This
    // test observes only verify/task_state tool behavior; host/plugin expose
    // no verifiable git/tree code-state event, so it does NOT cover arbitrary
    // code changes.
    const { ctx, state } = createFakeCtx();
    apply(ctx, {});
    const verifyTool = state.tools.find((t) => t.name === 'verify_check');
    const taskTool = state.tools.find((t) => t.name === 'task_state');
    assert.ok(verifyTool, 'verify_check must be registered via apply()');
    assert.ok(taskTool, 'task_state must be registered via apply()');
    const session = makeSession(state);
    const exec = { agent: { session }, signal: new AbortController().signal };
    const command = 'npm test --risk-regression-stale-evidence';
    const passed = await verifyTool.execute(
      { command, exitCode: 0, passed: true, summary: 'green once' },
      exec,
    );
    assert.equal(passed.passed, true);
    const failed = await verifyTool.execute(
      { command, exitCode: 1, passed: false, summary: 'same check now fails' },
      exec,
    );
    assert.equal(failed.passed, false);
    await assert.rejects(
      () =>
        taskTool.execute(
          {
            phase: 'done',
            from: 'verify',
            taskKind: 'code-change',
            summary: 'attempt done on stale evidence',
            verifyRef: command,
          },
          exec,
        ),
      /must match a passed verify_check|stale|invalid|fail/i,
      'done with a stale verifyRef after a later failed attempt must be rejected',
    );
  });
});
