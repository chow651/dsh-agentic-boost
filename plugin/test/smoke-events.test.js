/**
 * Synthetic tests for `scripts/smoke-events.mjs`.
 * No smoke run, no model call, no I/O — pure in-memory fixtures only.
 * Run: `node --test test/smoke-events.test.js` (cwd `plugin/`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSmokeEvidence,
  parseSmokeEvents,
  summarizeSmokeStderr,
  taskPromptMeta,
} from '../scripts/smoke-events.mjs';

describe('parseSmokeEvents structural evidence', () => {
  it('proves tool success only via tool_call.tool + matching completed tool_result', () => {
    const jsonl = [
      JSON.stringify({ type: 'session', sessionId: 'session-123e4567-e89b-12d3-a456-426614174000', cwd: '/should/not/retain' }),
      JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'skill', input: { name: 'v2-answer' } }),
      JSON.stringify({ type: 'tool_result', callId: 'c1', status: 'completed', result: { anything: 'goes-unread' } }),
      JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, reasoningTokens: 1 } }),
      JSON.stringify({ type: 'final', text: 'SMOKE-DONE' }),
    ].join('\n');
    const out = parseSmokeEvents(jsonl);
    assert.equal(out.sessionId, 'session-123e4567-e89b-12d3-a456-426614174000');
    assert.equal(out.jsonlLines, 5);
    assert.equal(out.malformedLines, 0);
    assert.deepEqual(out.tools, ['skill']);
    assert.equal(out.completedCalls, 1);
    assert.equal(out.evidence.structuredToolSuccess, true);
    assert.equal(out.evidence.finalPresent, true);
    // No verified sub-schema: specific claims stay unknown, never inferred.
    assert.equal(out.evidence.skillCall, 'unknown');
    assert.equal(out.evidence.verifyEvent, 'unknown');
    assert.equal(out.evidence.taskStateDone, 'unknown');
    // Whitelist only: no raw bodies retained anywhere.
    const keys = Object.keys(out).sort();
    assert.deepEqual(keys, ['completedCalls', 'eventCounts', 'evidence', 'jsonlLines', 'malformedLines', 'sessionId', 'tools', 'usage']);
    assert.ok(!('raw' in out) && !('text' in out) && !('result' in out) && !('input' in out) && !('cwd' in out));
    assert.equal(out.eventCounts.session, 1);
    assert.equal(out.eventCounts.tool_call, 1);
    assert.equal(out.eventCounts.tool_result, 1);
    assert.equal(out.eventCounts.final, 1);
    assert.deepEqual(out.usage, {
      statusEventsWithUsage: 1,
      lastTotals: { inputTokens: 10, outputTokens: 2, totalTokens: 12, reasoningTokens: 1 },
    });
  });

  it('rejects non-UUID session ids (stays null, never stored raw)', () => {
    for (const bad of ['sess-123', 'session-not-a-uuid', '', 'session-zzzz', 42, null]) {
      const jsonl = JSON.stringify({ type: 'session', sessionId: bad });
      assert.equal(parseSmokeEvents(jsonl).sessionId, null, `bad id must stay null: ${String(bad)}`);
    }
  });

  it('body text mentioning verify/skill/check proves nothing (false/unknown)', () => {
    const jsonl = [
      JSON.stringify({ type: 'text', text: 'verify skill check v2-answer task_state done SMOKE-DONE passed true' }),
      JSON.stringify({ type: 'text', text: 'another line about verify_check and skill tool' }),
    ].join('\n');
    const out = parseSmokeEvents(jsonl);
    assert.equal(out.evidence.structuredToolSuccess, false);
    assert.equal(out.completedCalls, 0);
    assert.deepEqual(out.tools, []);
    assert.equal(out.evidence.skillCall, 'unknown');
    assert.equal(out.evidence.verifyEvent, 'unknown');
    assert.equal(out.evidence.taskStateDone, 'unknown');
    assert.equal(out.evidence.finalPresent, false);
  });

  it('tool_call without a matching tool_result is not success', () => {
    const dangling = [
      JSON.stringify({ type: 'tool_call', callId: 'c9', tool: 'skill', input: {} }),
    ].join('\n');
    assert.equal(parseSmokeEvents(dangling).evidence.structuredToolSuccess, false);

    const mismatched = [
      JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'skill', input: {} }),
      JSON.stringify({ type: 'tool_result', callId: 'c-other', status: 'completed', result: {} }),
    ].join('\n');
    assert.equal(parseSmokeEvents(mismatched).evidence.structuredToolSuccess, false);

    const errored = [
      JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'skill', input: {} }),
      JSON.stringify({ type: 'tool_result', callId: 'c1', status: 'error', result: {} }),
    ].join('\n');
    const out = parseSmokeEvents(errored);
    assert.equal(out.evidence.structuredToolSuccess, false);
    assert.equal(out.completedCalls, 0);
  });

  it('result-before-call, duplicate callIds, and duplicate results prove nothing extra', () => {
    const reversed = [
      JSON.stringify({ type: 'tool_result', callId: 'c1', status: 'completed', result: {} }),
      JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'skill', input: {} }),
    ].join('\n');
    assert.equal(parseSmokeEvents(reversed).completedCalls, 0, 'reversed order must not count');

    const dupCall = [
      JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'skill', input: {} }),
      JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'other', input: {} }),
      JSON.stringify({ type: 'tool_result', callId: 'c1', status: 'completed', result: {} }),
    ].join('\n');
    const dupOut = parseSmokeEvents(dupCall);
    assert.equal(dupOut.completedCalls, 1, 'first call wins, counted once');
    assert.deepEqual(dupOut.tools, ['skill'], 'duplicate tool name must not leak in');

    const dupResult = [
      JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'skill', input: {} }),
      JSON.stringify({ type: 'tool_result', callId: 'c1', status: 'completed', result: {} }),
      JSON.stringify({ type: 'tool_result', callId: 'c1', status: 'completed', result: {} }),
    ].join('\n');
    assert.equal(parseSmokeEvents(dupResult).completedCalls, 1, 'first result wins, counted once');
  });

  it('counts malformed and unknown-type lines without proving anything', () => {
    const jsonl = [
      '{not-json',
      JSON.stringify({ type: 'bogus-future-type', x: 1 }),
      JSON.stringify({ nope: true }),
      '',
    ].join('\n');
    const out = parseSmokeEvents(jsonl);
    assert.equal(out.malformedLines, 1);
    assert.equal(out.eventCounts.unknown, 2);
    assert.equal(out.evidence.structuredToolSuccess, false);
  });
});

describe('summarizeSmokeStderr redaction + cap', () => {
  it('redacts secrets, headers, URL params and absolute user paths', () => {
    const raw = 'Authorization: Bearer abc123 failed at /home/alice/work err '
      + 'url https://x.test/?token=sekret&api_key=k2 token hunter2';
    const out = summarizeSmokeStderr(raw);
    assert.ok(!out.includes('abc123'), 'bearer value must be gone');
    assert.ok(!out.includes('sekret'), 'url token must be gone');
    assert.ok(!out.includes('k2'), 'url api_key value must be gone');
    assert.ok(!out.includes('hunter2'), 'key=value token must be gone');
    assert.ok(!out.includes('/home/alice'), 'username segment must be gone');
    assert.ok(out.includes('Bearer [redacted]'), 'kind label stays debuggable');
    assert.ok(out.includes('/home/[redacted]/work'), 'sub-path stays debuggable');
  });

  it('truncates to the budget with a marker', () => {
    const out = summarizeSmokeStderr('e'.repeat(2000), 500);
    assert.ok(out.length < 2000);
    assert.ok(out.endsWith('…[truncated]'));
    // Marker counts toward the budget: TOTAL code points <= maxChars.
    assert.equal(Array.from(out).length <= 500, true);
    assert.equal(Array.from(summarizeSmokeStderr('e'.repeat(2000), 20)).length <= 20, true);
  });
});

describe('buildSmokeEvidence verdict + taskPromptMeta', () => {
  it('generic completed call + final is INCONCLUSIVE, never PASS', () => {
    const stdout = [
      JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'skill', input: {} }),
      JSON.stringify({ type: 'tool_result', callId: 'c1', status: 'completed', result: {} }),
      JSON.stringify({ type: 'final', text: 'anything' }),
    ].join('\n');
    const out = buildSmokeEvidence(stdout, '');
    assert.equal(out.verdict, 'INCONCLUSIVE');
    assert.ok(!('pass' in out), 'legacy pass flag must be gone');
    assert.equal(out.parsed.evidence.skillCall, 'unknown');
    assert.equal(out.parsed.evidence.verifyEvent, 'unknown');
    assert.equal(out.parsed.evidence.taskStateDone, 'unknown');
  });

  it('incomplete evidence is BLOCKED', () => {
    assert.equal(buildSmokeEvidence('', '').verdict, 'BLOCKED');
  });

  it('taskPromptMeta keeps char count only, never the text', () => {
    const evil = 'secret hunter2 task at /home/eve/x api_key=k2';
    const meta = taskPromptMeta(evil);
    assert.deepEqual(Object.keys(meta), ['promptChars']);
    assert.equal(meta.promptChars, Array.from(evil).length);
    assert.ok(!JSON.stringify(meta).includes('hunter2'));
    assert.ok(!JSON.stringify(meta).includes('/home/eve'));
  });
});
