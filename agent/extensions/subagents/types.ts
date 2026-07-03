// ---------------------------------------------------------------------------
// Shared types for the subagent extension
// ---------------------------------------------------------------------------

export const TIERS = ["small", "standard", "reasoning"] as const;
export type Tier = (typeof TIERS)[number];

export type SubagentModels = { small: string; standard: string; reasoning: string };

export type ModelsConfig =
  | { status: "disabled" } // key absent / settings unreadable — stay silent
  | { status: "invalid"; message: string } // present but malformed — warn the user
  | { status: "ok"; models: SubagentModels };

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** One subagent tool call: name + a one-line arg (input) summary. */
export interface ToolCall {
  tool: string;
  summary: string;
}

/**
 * Live + final telemetry, attached to every result/update as `details` so the
 * renderers can draw it. `running` is true for in-flight snapshots (onUpdate)
 * and false for the terminal result.
 */
export interface SubStats {
  sessionId: string;
  resuming: boolean;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  calls: ToolCall[];
  running: boolean;
  text?: string;
  error?: string;
  exitCode?: number;
}

/** Totals accumulated across all subagent calls in the current session. */
export interface SessionTotals {
  count: number;
  cost: number;
  turns: number;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface RunOptions {
  sessionId: string;
  resuming: boolean;
  model: string;
  prompt: string;
  sessionDir: string;
  cwd: string;
  signal?: AbortSignal;
}

export interface SubagentOutcome {
  stats: SubStats; // final snapshot (running: false)
  finalText: string;
  exitCode: number;
  aborted: boolean;
  spawnError?: Error;
  stderr: string;
}
