/**
 * dsh-agentic-boost-mvp — Host half (Cordis plugin entry).
 *
 * Standard DSH bundle shape (precedent: `@michengai/dsh-skills-manager`,
 * `@deepseek-ai/dsh-tool-todo` on DSH 0.2.0-rc.2):
 * ESM named exports `name` / `inject` / `apply` (+ optional `Config`).
 * The loader resolves `name: 'dsh-agentic-boost-mvp'` from `cordis.patch.yml`
 * to this package's `main` entry.
 *
 * Behavior:
 * 1. Registers one prompt section (`agentic-boost:task-loop`, order 450):
 *    task-loop guidance (evidence + verify-before-done). Guidance only —
 *    no tools granted, no permissions changed.
 * 2. Registers one model tool (`verify_check`): records a verification
 *    outcome (command/exitCode/passed/summary) as a session event so the
 *    verify step is observable and replayable.
 * 2b. v2 slice: registers one short task-route prompt section
 *    (`agentic-boost:task-route`, order 460) and one `task_state` model tool
 *    (plan/active/verify/done/blocked; done requires verify evidence,
 *    blocked requires failure evidence). Registers a `tools/post-execute`
 *    listener that enriches failed verify/task records with redacted,
 *    length-capped failure summaries — enrichment only, never a completion
 *    claim and never a deny bypass.
 * 3. Listens on `tools/pre-execute`: denies file-writing tool calls that
 *    target protected verify-loop artifacts (test files, fail.log,
 *    ACCEPT.sh). Everything else passes through via `next()` untouched.
 *
 * Safety:
 * - Only this plugin's own handlers are wrapped in try/catch + redacted
 *   JSONL diagnostics. No process-level `uncaughtException` /
 *   `unhandledRejection` handlers are installed; host errors propagate.
 * - A failing handler never reports success: tool execute rethrows,
 *   the guard fails closed with an explicit `{ kind: 'deny' }` on internal
 *   error (fail-closed, logged — never a silent allow), prompt section
 *   registration failure is logged and skips registration.
 * - `disabled` / invalid config: `apply` throws loud so the entry fails
 *   visibly instead of half-loading (matches duplicate-section loud-fail
 *   convention in `ctx.systemPrompt.section`).
 */
import { createRequire } from 'node:module';

import {
  CATEGORIES,
  PHASES,
  PLUGIN_NAME,
  createDiagnosticsLogger,
} from './diagnostics.js';
import { SECTION_NAME, SECTION_ORDER, SECTION_TEXT } from './guidance.js';
import {
  ROUTE_SECTION_NAME as ROUTE_NAME,
  ROUTE_SECTION_ORDER as ROUTE_ORDER,
  ROUTE_SECTION_TEXT,
} from './route-section.js';
import { decidePreExecute } from './guard.js';
import { VERIFY_TOOL_NAME, createVerifyToolDefinition } from './verify-tool.js';
import {
  TASK_STATE_EVENT_TYPE,
  TASK_STATE_TOOL_NAME,
  buildFailureSummary,
  createTaskStateToolDefinition,
  recordVerifySuccess,
  revokeVerifySuccess,
} from './task-state.js';

/** Cordis plugin name. */
export const name = PLUGIN_NAME;

/** Host services this plugin consumes. All optional at runtime (see apply). */
export const inject = ['systemPrompt', 'tools'];

// NOTE: no `Config` export on purpose. Cordis resolves a plugin's Config
// through Schemastery (`.validate`); shipping a plain object breaks
// activation. The `@michengai/dsh-skills-manager` precedent shows Config is
// optional — the raw row config still reaches `apply(ctx, config)`, where it
// is narrowed defensively below.

function readPackageVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json');
    return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function loadDefineTool() {
  try {
    const require = createRequire(import.meta.url);
    const toolsHost = require('@deepseek-ai/dsh-tools');
    if (toolsHost && typeof toolsHost.defineTool === 'function') {
      return toolsHost.defineTool;
    }
    return undefined;
  } catch {
    // Host package not resolvable outside a DSH runtime (e.g. unit tests):
    // fall back to a plain tool definition object.
    return undefined;
  }
}

/**
 * Register the MVP behavior on the host context.
 * @param {object} ctx Cordis registrant context (`systemPrompt`, `tools`, `on`, `effect`).
 * @param {object} [config] row config from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const enabled = config?.enabled ?? true;
  if (enabled === false) {
    throw new Error(`${PLUGIN_NAME} is disabled by config (enabled:false); refusing to half-load`);
  }
  const logMaxBytes =
    Number.isFinite(config?.logMaxBytes) && config.logMaxBytes > 0
      ? Math.floor(config.logMaxBytes)
      : 65536;
  const logMaxFiles =
    Number.isFinite(config?.logMaxFiles) && config.logMaxFiles >= 1
      ? Math.floor(config.logMaxFiles)
      : 3;

  const diagnostics = createDiagnosticsLogger({
    dir: process.env.DSH_AGENTIC_BOOST_LOG_DIR,
    pluginVersion: readPackageVersion(),
    maxBytes: logMaxBytes,
    maxFiles: logMaxFiles,
  });

  const effect =
    ctx && typeof ctx.effect === 'function' ? (fn, label) => ctx.effect(fn, label) : (fn) => fn();

  // 1. Prompt section: task-loop guidance.
  if (ctx && ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    effect(() => {
      try {
        return ctx.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: SECTION_TEXT,
        });
      } catch (error) {
        void diagnostics.log('prompt-section', error);
        throw error;
      }
    }, `${PLUGIN_NAME}: task-loop prompt section`);
  }

  // 1b. Prompt section (v2 slice): short task-route constraints.
  if (ctx && ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    effect(() => {
      try {
        return ctx.systemPrompt.section({
          name: ROUTE_NAME,
          order: ROUTE_ORDER,
          text: ROUTE_SECTION_TEXT,
        });
      } catch (error) {
        void diagnostics.log('prompt-section', error);
        throw error;
      }
    }, `${PLUGIN_NAME}: task-route prompt section`);
  }

  // 2. Model tool: verify_check. The registered `execute` is wrapped so
  // plugin-owned execution failures are recorded in redacted diagnostics
  // and then rethrown — never reported as success. On a passed success the
  // canonical command is fed to the session-bound verify registry (H2);
  // on a real failure for the same command the proof is revoked so a stale
  // verifyRef cannot authorize done (no tree-state claim).
  if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
    effect(() => {
      const definition = createVerifyToolDefinition(loadDefineTool());
      const innerExecute = definition.execute;
      const wrapped = {
        ...definition,
        async execute(args, exec) {
          try {
            const value = await innerExecute(args, exec);
            if (value && typeof value === 'object' && typeof value.command === 'string') {
              try {
                if (value.passed === true) {
                  recordVerifySuccess(exec?.agent?.session, value.command);
                } else if (value.passed === false) {
                  // Stale-proof invalidation: a later real failure for the
                  // SAME command revokes the session's earlier success proof,
                  // so a stale verifyRef cannot authorize done. Limited to
                  // observed verify outcomes — no tree-state claim.
                  revokeVerifySuccess(exec?.agent?.session, value.command);
                }
              } catch {
                // Registry feed is best-effort; the recorded event is the evidence.
              }
            }
            return value;
          } catch (error) {
            await diagnostics.log('tool-execute', error);
            throw error;
          }
        },
      };
      try {
        return ctx.tools.register(wrapped);
      } catch (error) {
        void diagnostics.log('tool-execute', error);
        throw error;
      }
    }, `${PLUGIN_NAME}: ${VERIFY_TOOL_NAME} tool`);
  }

  // 2b. Model tool (v2 slice): task_state. Same wrapper semantics as
  // verify_check: plugin-owned failures are logged redacted, then rethrown.
  if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
    effect(() => {
      const definition = createTaskStateToolDefinition(loadDefineTool());
      const innerExecute = definition.execute;
      const wrapped = {
        ...definition,
        async execute(args, exec) {
          try {
            return await innerExecute(args, exec);
          } catch (error) {
            await diagnostics.log('tool-execute', error);
            throw error;
          }
        },
      };
      try {
        return ctx.tools.register(wrapped);
      } catch (error) {
        void diagnostics.log('tool-execute', error);
        throw error;
      }
    }, `${PLUGIN_NAME}: ${TASK_STATE_TOOL_NAME} tool`);
  }

  // 2c. Post-execute enrichment (v2 slice): for failed verify/task outcomes,
  // return a `PostToolDecision` carrying `additionalContexts` with a
  // redacted, length-capped failure summary (H3: evidence read from the
  // REAL second `result` argument — isError error.message/content or the
  // success value's summary — never from `exec.arguments`. H4: contexts ride
  // the RETURNED decision; `next()` is Cordis zero-arg — nothing is ever
  // passed to it). Enrichment only: inner accept gains additionalContexts,
  // a non-accept inner decision (e.g. block/feedback) is returned verbatim,
  // never converts a failure into success, never bypasses the pre-execute
  // deny, never touches calls from other tools. Listener errors are contained (logged, then
  // plain `next()`) so a broken enricher cannot mask the real result.
  //
  // Contract: dsh-tools/lib/types/index.d.ts:70
  // `(exec, result, next: () => Promise<PostToolDecision>)`,
  // ToolExecutionResult union :413-435, PostToolDecision :465-479,
  // postExecute consumes the RETURN value :lib/index.js:3503-3505,3516-3531;
  // Cordis waterfall `const next = () => ...` :cordis/lib/index.js:317-325.
  if (ctx && typeof ctx.on === 'function') {
    const postListener = async (exec, result, next) => {
      try {
        const name = String(exec?.name ?? '');
        if (name !== VERIFY_TOOL_NAME && name !== TASK_STATE_TOOL_NAME) {
          return next();
        }
        const failed =
          result !== null &&
          typeof result === 'object' &&
          (('isError' in result && result.isError === true) ||
            ('value' in result &&
              result.value !== null &&
              typeof result.value === 'object' &&
              'passed' in result.value &&
              result.value.passed === false));
        if (!failed) {
          return next();
        }
        // H3: evidence from the failed RESULT only. Collect error.message,
        // content text blocks, and the canonical value's summary — the exact
        // surfaces ToolExecutionFailure (:425-432) and ToolExecutionSuccess
        // (:414-423) carry. exec.arguments is never read here.
        const parts = [];
        try {
          const message = result?.error?.message;
          if (typeof message === 'string' && message.length > 0) parts.push(message);
        } catch {
          // Non-cooperative result shape — fall through to content/value.
        }
        try {
          const blocks = result?.content;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
                parts.push(block.text);
              }
            }
          }
        } catch {
          // Ignore and continue with whatever was collected.
        }
        try {
          const summary = result?.value?.summary;
          if (typeof summary === 'string' && summary.length > 0) parts.push(summary);
        } catch {
          // Ignore and continue with whatever was collected.
        }
        const evidence = buildFailureSummary(parts.join('\n').slice(0, 2000));
        // Waterfall: inner first (Cordis zero-arg `next()`), outer returns.
        // Preserve a non-accept inner decision verbatim (block/feedback must
        // survive); only an inner accept is enriched with additionalContexts.
        const inner = await next();
        if (!inner || typeof inner !== 'object' || inner.kind !== 'accept') {
          return inner;
        }
        return {
          ...inner,
          additionalContexts: [
            ...(Array.isArray(inner.additionalContexts) ? inner.additionalContexts : []),
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    `agentic-boost v2: ${name} recorded a failure. ` +
                    `Locate the cause (path:line), fix the implementation, re-run the same check. ` +
                    `Evidence: ${evidence}`,
                },
              ],
            },
          ],
        };
      } catch (error) {
        await diagnostics.log('tool-execute', error);
        return next();
      }
    };
    if (typeof ctx.effect === 'function') {
      ctx.effect(
        () => ctx.on('tools/post-execute', postListener),
        `${PLUGIN_NAME}: post-execute failure enrichment`,
      );
    } else {
      ctx.on('tools/post-execute', postListener);
    }
  }

  // 3. Pre-execute guard: deny test/log modification, allow everything else.
  // Fail-closed on internal error (C): the DSH 0.2.0-rc.2 `tools/pre-execute`
  // waterfall returns the listener's `PreToolDecision`; a throw would travel
  // to `prepareExecution`'s catch and surface as a `final-result` error, but
  // the plugin must not rely on that implicit mapping. Returning an explicit
  // `{ kind: 'deny' }` keeps the call blocked with an auditable reason, and
  // the failure is recorded in plugin diagnostics (never silent).
  if (ctx && typeof ctx.on === 'function') {
    const listener = async (exec, next) => {
      let decision;
      try {
        decision = decidePreExecute(exec?.name, exec?.arguments);
      } catch (error) {
        await diagnostics.log('pre-execute-guard', error);
        return {
          kind: 'deny',
          reason:
            'agentic-boost-mvp: guard internal failure — call blocked pending inspection. ' +
            'See plugin diagnostics (phase pre-execute-guard).',
        };
      }
      if (decision.verdict === 'deny') {
        await diagnostics.log(
          'pre-execute-guard',
          new Error(`denied ${String(exec?.name)} targeting ${decision.match ?? 'protected artifact'}`),
        );
        return { kind: 'deny', reason: decision.reason };
      }
      return next();
    };
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => ctx.on('tools/pre-execute', listener), `${PLUGIN_NAME}: pre-execute guard`);
    } else {
      ctx.on('tools/pre-execute', listener);
    }
  }
}

export {
  CATEGORIES,
  PHASES,
  ROUTE_NAME as ROUTE_SECTION_NAME,
  ROUTE_ORDER as ROUTE_SECTION_ORDER,
  TASK_STATE_EVENT_TYPE,
  TASK_STATE_TOOL_NAME,
  VERIFY_TOOL_NAME,
};
