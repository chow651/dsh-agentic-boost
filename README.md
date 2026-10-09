# DSH Agentic Boost

**DSH Agentic Boost is an experimental plugin for DeepSeek Harness (DSH) that adds explicit task routing, focused Skills, session-bound verification records, task-state gates, and redacted failure-recovery guidance for AI coding agents.** It is intended for developers who want a coding agent to make its work phase visible and report verification evidence more carefully. It does not modify model weights or establish a measured improvement in model quality.

## What does DSH Agentic Boost add?

- **Task routing:** maps `qa`, `code-change`, `investigation`, and `multi-step` work to task-specific context, Skills, tool posture, and completion gates.
- **Bundled Skills:** `v2-answer`, `v2-investigate`, `v2-recover`, and `v2-verify-loop` provide focused procedures for answering, research, recovery, and verification loops.
- **Verification records:** `verify_check` records a command, a reported exit code and pass/fail value, and a redacted summary in the current session.
- **Task-state tracking:** `task_state` records `plan`, `active`, `verify`, `done`, or `blocked` transitions. A `done` transition requires a successful, session-bound verification record.
- **Failure recovery:** DSH hooks can attach a bounded, redacted summary of a relevant tool failure and guide a locate → fix → rerun-the-check cycle.
- **Evidence-aware smoke diagnostics:** local scripts parse structured DSH events and return `INCONCLUSIVE` or `BLOCKED` when required evidence is unknown, rather than treating generic response text as proof of success.

## What does `verify_check` prove?

`verify_check` **records what the DSH agent reports; it does not execute the command or independently attest that a process ran**. The exit code and pass/fail value are supplied by the agent. The session-bound record is a workflow gate for task-state transitions, not independent test evidence. Likewise, the smoke parser only reasons about the structured events it receives and does not authenticate their origin.

## Run the included tests

The repository contains the plugin source and its automated tests; it is not published as an npm package. The tests use Node.js built-ins and require Node.js `22.19.0` or later.

```bash
git clone https://github.com/chow651/dsh-agentic-boost.git
cd dsh-agentic-boost/plugin
npm test
```

The 24-file public source snapshot passed **47/47 automated tests** on Linux with Node.js `24.19.0`. This result covers the included test cases only; it is not a live-model or production-readiness claim.

## Compatibility and current limits

- The plugin targets the DSH `0.2.0-rc.2` host contract. Automated contract tests are included, but a live end-to-end run in a booted DSH agent has **not** been verified.
- Windows has not been tested, and runtime visibility of the bundled Skills has not been confirmed in a booted agent.
- No benchmark has measured model-quality or coding-performance improvements.
- The `smoke-v2.mjs` live runner requires a DSH installation and a model-provider package. Supply its model directory, package name, provider name, and model ID with command-line options or the corresponding `DSH_MODEL_*` environment variables; no local profile or model route is included in this repository. A live-model run has not been performed for this release.
- This is experimental software, not a production-ready or official DSH component.

## Does the plugin change permissions or run tests for the agent?

No. The plugin is additive and does not change DSH core, grant tools, or replace the host's approval and sandbox policies. Its scoped pre-execution guard denies selected file-writing calls that target protected test or log artifacts; it does not block shell commands generally. The DSH agent runs checks with its normal tools and then reports results through `verify_check`.

## Privacy and safe use

The smoke runner is intended for synthetic, non-sensitive tasks. With `--keep-tmp`, its temporary task file is retained, and custom task text is briefly present in the child process arguments. Diagnostics redact and bound common secret and path patterns, but redaction cannot guarantee detection of every sensitive value. Do not include credentials, private prompts, or personal data in task text or logs.

## FAQ

### Does DSH Agentic Boost make an AI model smarter?

It does not change model weights. The plugin adds workflow guidance and evidence-recording gates; no measured improvement in model quality has been established.

### Does `verify_check` run tests?

No. The DSH agent runs a check using its existing tools and reports the result. The plugin records that report and uses it as a workflow gate, but it does not independently verify process execution.

### Is this an official DSH plugin or production release?

No. It is an independent experimental plugin. Live runtime behavior, Windows compatibility, and production readiness have not been established.
