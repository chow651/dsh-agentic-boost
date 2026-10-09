---
name: v2-verify-loop
description: Verify-before-done loop for code-change and multi-step tasks. Use after implementing a fix and before claiming done.
version: 0.1.0
applies-when:
  - code-change or multi-step task with an automated check available
output-contract: verify_check record (command, exitCode, passed, summary) or BLOCKED task_state with failure evidence
---

# v2-verify-loop

Run the repair loop. Never edit tests or logs to make them pass.

1. Run the target check (tests, build, or lint). Quote the exact command.
2. On pass: record via `verify_check` with command, exitCode, passed=true, short summary.
3. On fail: capture the failure output, redact secrets, keep ≤1000 chars.
   Locate the cause in implementation code (cite `path:line`), fix the
   implementation, then re-run the SAME check (定向复验).
4. If the check stays red: record `task_state` phase=blocked with the
   failure evidence. Do not claim done. Prompt text alone never completes.
