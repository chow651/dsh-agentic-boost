/**
 * v2 host-contract test (DSH 0.2.0-rc.2 real contract).
 *
 * Contract sources (installed, read-only — not inferred):
 * - `tools/post-execute` listener signature
 *   `(exec, result, next: () => Promise<PostToolDecision>)`:
 *   @deepseek-ai/dsh-tools `lib/types/index.d.ts:70`
 * - `ToolExecutionResult` discriminated union (`isError` success/failure):
 *   `lib/types/index.d.ts:413-435`
 * - `PostToolDecision` (`accept`/`block`, `additionalContexts` rides the
 *   RETURNED decision): `lib/types/index.d.ts:465-479`
 * - Host consumes the listener RETURN value and ferries
 *   `decision.additionalContexts` onto the result
 *   (`postExecute` waterfall + default accept):
 *   @deepseek-ai/dsh-tools `lib/index.js:3503-3505,3516-3531`
 * - Cordis waterfall `next` is zero-argument (`const next = () => ...`)
 *   and the waterfall returns the outermost listener's return value:
 *   @deepseek-ai/cordis `lib/index.js:317-325`
 *
 * Behaviors under test (via the plugin's real `apply` listener):
 * - H3: failure evidence MUST be read from the failed `result`
 *   (real summary / error content), never from `exec.arguments`.
 * - H4: `additionalContexts` MUST propagate via the RETURNED
 *   `PostToolDecision`; `next` MUST be called with zero arguments.
 *   A `next(patch)`-accepting fake is forbidden, so the `next` double
 *   below declares zero parameters (`next.length === 0`) and records
 *   any smuggled argument via `arguments`.
 *
 * Run: `node --test test/v2-host-contract.test.js` (cwd `plugin/`).
 * Stdlib only (`node:test`, `node:assert/strict`, `node:fs`, `node:os`,
 * `node:path`); no external dependencies.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

function createHostCtx() {
  const state = { listeners: new Map(), sections: [], tools: [] };
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

/**
 * Cordis-faithful `next` double: zero declared parameters, mirroring
 * `@deepseek-ai/cordis` `lib/index.js:320` (`const next = () => ...`).
 * Any argument passed by the listener is captured through `arguments`
 * (available even with zero formal params) so `next(patch)` is observed
 * as a contract violation instead of being silently accepted.
 */
function createStrictNext() {
  const calls = [];
  async function next() {
    calls.push(Array.from(arguments));
    return { kind: 'accept' };
  }
  assert.equal(
    next.length,
    0,
    'contract double itself must keep Cordis no-argument next shape (next.length === 0)',
  );
  return { next, calls };
}

function getPostListener() {
  const { ctx, state } = createHostCtx();
  apply(ctx, {});
  const post = state.listeners.get('tools/post-execute');
  assert.ok(post, 'tools/post-execute listener must be registered via apply()');
  assert.equal(typeof post, 'function');
  return post;
}

function contextsText(decision) {
  return JSON.stringify(decision?.additionalContexts ?? null);
}

describe('v2 host contract (real DSH 0.2.0-rc.2 + Cordis waterfall)', () => {
  let workDir;
  let previousEnv;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'abv2host-'));
    previousEnv = process.env.DSH_AGENTIC_BOOST_LOG_DIR;
    process.env.DSH_AGENTIC_BOOST_LOG_DIR = join(workDir, 'logs');
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.DSH_AGENTIC_BOOST_LOG_DIR;
    else process.env.DSH_AGENTIC_BOOST_LOG_DIR = previousEnv;
    rmSync(workDir, { recursive: true, force: true });
  });

  it('H3: failure evidence comes from the failed result, not exec arguments', async () => {
    const post = getPostListener();
    const REAL_H3 = 'REAL-H3-VERIFY-OUTPUT-line-42-checksum-7f3a';
    const DECOY_H3 = 'DECOY-H3-ARGS-should-never-be-evidence-9b21';
    const exec = {
      name: 'verify_check',
      arguments: { command: `npm test ${DECOY_H3}`, extra: DECOY_H3 },
    };
    // Source-supported failure shape: ToolExecutionFailure
    // (types/index.d.ts:425-432: isError:true + error.message + content).
    const result = {
      isError: true,
      error: { message: `verification exploded: ${REAL_H3}` },
      content: [{ type: 'text', text: `FAIL output body ${REAL_H3}` }],
    };
    const { next, calls } = createStrictNext();

    const decision = await post(exec, result, next);

    assert.equal(calls.length, 1, 'H3: next() must be reached exactly once');
    assert.equal(calls[0].length, 0, 'H3: next must be called with zero arguments (Cordis no-arg semantics)');
    assert.equal(decision?.kind, 'accept', 'H3: failed result is enriched, not blocked');
    assert.ok(
      Array.isArray(decision?.additionalContexts),
      'H3: additionalContexts must ride the returned PostToolDecision (dsh-tools/lib/index.js:3505,3516)',
    );
    const text = contextsText(decision);
    assert.match(text, new RegExp(REAL_H3), 'H3: attached context must carry the real result failure text');
    assert.doesNotMatch(text, new RegExp(DECOY_H3), 'H3: exec-arguments decoy must not become failure evidence');
  });

  it('H4: additionalContexts propagate via returned decision; next stays zero-arg', async () => {
    const post = getPostListener();
    const REAL_H4 = 'REAL-H4-TASKSTATE-FAIL-blocked-evidence-5c1d';
    const DECOY_H4 = 'DECOY-H4-ARGS-patch-smuggle-probe-8e77';
    const exec = {
      name: 'task_state',
      arguments: { phase: 'blocked', summary: `args decoy ${DECOY_H4}` },
    };
    // Source-supported second failure shape observed by the listener:
    // success-value with `passed === false` (plugin/lib/index.js:228-232).
    const result = {
      isError: false,
      value: { passed: false, summary: `blocked detail ${REAL_H4}` },
      content: [{ type: 'text', text: `Verification FAIL ${REAL_H4}` }],
    };
    const { next, calls } = createStrictNext();

    const decision = await post(exec, result, next);

    assert.equal(calls.length, 1, 'H4: next() must be reached exactly once');
    assert.equal(calls[0].length, 0, 'H4: next must be called with zero arguments (cordis/lib/index.js:320-321)');
    assert.ok(
      !JSON.stringify(calls).includes('additionalContexts'),
      'H4: patch/context must never be passed as a next() argument',
    );
    assert.equal(decision?.kind, 'accept', 'H4: enrichment keeps an accept decision (never a deny bypass)');
    assert.ok(
      Array.isArray(decision?.additionalContexts) && decision.additionalContexts.length > 0,
      'H4: returned decision must carry additionalContexts (dsh-tools/lib/index.js:3505 consumes the return value)',
    );
    const [message] = decision.additionalContexts;
    assert.equal(message?.role, 'user', 'H4: attached context is a user message');
    assert.ok(Array.isArray(message?.content) && message.content[0]?.type === 'text');
    const text = contextsText(decision);
    assert.match(text, new RegExp(REAL_H4), 'H4: attached context must carry the real result failure text');
    assert.doesNotMatch(text, new RegExp(DECOY_H4), 'H4: exec-arguments decoy must not leak into attached context');
  });
});
