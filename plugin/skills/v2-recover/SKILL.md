---
name: v2-recover
description: Failure recovery for multi-step tasks. Use when a verify step fails to drive locate-fix-retest or a clean BLOCKED record.
version: 0.1.0
applies-when:
  - multi-step task with a failed verification gate
output-contract: retest verify_check record or BLOCKED task_state with failure evidence
---

# v2-recover

Turn a failure into evidence, then into a retest or a clean stop.

1. Keep the raw failure output; redact secrets and cap at 1000 chars
   (see `buildFailureSummary` semantics: redact first, then truncate).
2. Locate: point at the implementation cause with `path:line`. Never blame
   the test without evidence, never edit the test to pass.
3. Fix the implementation, then re-run the SAME check (定向复验) and record
   via `verify_check`.
4. Still red, out of budget, or cause unknown: record `task_state`
   phase=blocked with the failure note and the next dependency. A prompt
   sentence claiming done is not a completion.
