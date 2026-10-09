/**
 * Runner-level synthetic tests for `scripts/smoke-v2.mjs`.
 * Imports ONLY the pure `summarizeRunEvidence` (importing the runner must
 * never print, exit, or spawn a model run — reaching these assertions
 * proves the `IS_MAIN` guard holds). No smoke run, no model call, no I/O.
 * Run: `node --test test/smoke-runner.test.js` (cwd `plugin/`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeRunEvidence } from '../scripts/smoke-v2.mjs';

const SID = 'session-123e4567-e89b-12d3-a456-426614174000';

describe('summarizeRunEvidence (runner wiring)', () => {
  it('legal JSONL yields structured success but NEVER PASS (verdict INCONCLUSIVE, specifics unknown)', () => {
    const stdout = [
      JSON.stringify({ type: 'session', sessionId: SID, cwd: '/must/not/retain' }),
      JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'skill', input: { name: 'v2-answer' } }),
      JSON.stringify({ type: 'tool_result', callId: 'c1', status: 'completed', result: { anything: 'unread' } }),
      JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, reasoningTokens: 0 } }),
      JSON.stringify({ type: 'final', text: 'SMOKE-DONE' }),
    ].join('\n');
    const out = summarizeRunEvidence(stdout, '');
    assert.equal(out.parsed.sessionId, SID);
    assert.equal(out.parsed.evidence.structuredToolSuccess, true);
    assert.equal(out.parsed.evidence.finalPresent, true);
    // Generic call + final must NOT pass: specifics are unproven.
    assert.equal(out.verdict, 'INCONCLUSIVE');
    assert.ok(!('pass' in out), 'legacy pass flag must be gone');
    assert.equal(out.parsed.evidence.skillCall, 'unknown');
    assert.equal(out.parsed.evidence.verifyEvent, 'unknown');
    assert.equal(out.parsed.evidence.taskStateDone, 'unknown');
    assert.deepEqual(out.parsed.usage.lastTotals, { inputTokens: 5, outputTokens: 1, totalTokens: 6, reasoningTokens: 0 });
    // Whitelist only: no raw stdout/stderr, prompt, input, or result retained.
    assert.ok(!('raw' in out) && !('stdout' in out) && !('stderr' in out) && !('prompt' in out));
    const parsedKeys = Object.keys(out.parsed).sort();
    assert.ok(!parsedKeys.includes('raw') && !parsedKeys.includes('text') && !parsedKeys.includes('result'));
  });

  it('body-text lure without structured events proves nothing', () => {
    const stdout = [
      JSON.stringify({ type: 'text', text: 'v2-answer verify_check task_state done SMOKE-DONE passed true' }),
      JSON.stringify({ type: 'text', text: 'skill tool called with verifyRef, all green' }),
    ].join('\n');
    const out = summarizeRunEvidence(stdout, '');
    assert.equal(out.parsed.evidence.structuredToolSuccess, false);
    assert.equal(out.parsed.evidence.finalPresent, false);
    assert.equal(out.verdict, 'BLOCKED');
    assert.ok(!('pass' in out), 'legacy pass flag must be gone');
    assert.equal(out.parsed.evidence.skillCall, 'unknown');
    assert.equal(out.parsed.evidence.verifyEvent, 'unknown');
    assert.equal(out.parsed.evidence.taskStateDone, 'unknown');
  });

  it('dangling tool_call without a completed result does not pass', () => {
    const stdout = JSON.stringify({ type: 'tool_call', callId: 'c9', tool: 'skill', input: {} });
    const out = summarizeRunEvidence(stdout, '');
    assert.equal(out.verdict, 'BLOCKED');
    assert.equal(out.parsed.completedCalls, 0);
  });

  it('custom task text and secret stderr never survive in evidence', () => {
    // Boundary: the shared redactor covers label-first secrets
    // (`token <v>`, `api_key=<v>`, `Bearer <v>`, URL params); a bare value
    // with no adjacent label cannot be distinguished from ordinary words
    // and is NOT redacted — documented, not claimed.
    const evilTask = 'do thing with token hunter2 at /home/eve/secret api_key=k2';
    const stdout = JSON.stringify({ type: 'session', sessionId: SID });
    const stderr = `install failed for task "${evilTask}" Bearer abc999`;
    const out = summarizeRunEvidence(stdout, stderr);
    const blob = JSON.stringify(out);
    assert.ok(!blob.includes(evilTask), 'task text must not be retained');
    assert.ok(!blob.includes('hunter2'), 'secret value must be gone');
    assert.ok(!blob.includes('k2'), 'api_key value must be gone');
    assert.ok(!blob.includes('abc999'), 'bearer value must be gone');
    assert.ok(!blob.includes('/home/eve'), 'username segment must be gone');
    assert.ok(out.stderrSummary.includes('install failed'), 'diagnostic kind stays');
  });

  it('stderr is redacted and capped, secrets never survive', () => {
    const stderr = 'dsh: UNKNOWN: boom Authorization: Bearer tok123 '
      + 'at /home/bob/work url https://h.test/?api_key=k2 token hunter2';
    const out = summarizeRunEvidence('', stderr);
    assert.ok(!out.stderrSummary.includes('tok123'));
    assert.ok(!out.stderrSummary.includes('k2'));
    assert.ok(!out.stderrSummary.includes('hunter2'));
    assert.ok(!out.stderrSummary.includes('/home/bob'));
    assert.ok(out.stderrSummary.includes('boom'), 'diagnostic kind stays');
    assert.equal(Array.from(out.stderrSummary).length <= 500, true);
  });
});
