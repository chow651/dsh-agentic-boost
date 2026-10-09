/**
 * Minimal type declarations for dsh-agentic-boost-mvp.
 * The plugin is plain JavaScript (no build step) for cross-platform install;
 * this file documents the public surface for editors and reviewers.
 */
export declare const name: string;
export declare const inject: string[];
// No `Config` export: Cordis resolves Config via Schemastery `.validate`,
// so a plain object would break activation. Raw row config reaches apply().
export declare function apply(ctx: unknown, config?: Record<string, unknown>): void;
export declare const VERIFY_TOOL_NAME: string;
export declare const TASK_STATE_TOOL_NAME: string;
export declare const TASK_STATE_EVENT_TYPE: string;
export declare const ROUTE_SECTION_NAME: string;
export declare const ROUTE_SECTION_ORDER: number;
export declare const CATEGORIES: readonly string[];
export declare const PHASES: readonly string[];
