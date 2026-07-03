import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SessionTotals, SubStats, ToolCall } from "./types";

// All theme/UI logic lives in this module.

/** Strip the provider prefix from a model id: "github-copilot/claude-sonnet-4.6" → "claude-sonnet-4.6". */
export const shortModel = (id: string): string => id.split("/").pop() ?? id;

export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "\u2026" : s);

export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Format a token count compactly: 1234 → "1.2k", 12345 → "12k", <1000 → "834" */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/** Format in/out token pair: "1.1k/15k" */
function fmtTokenPair(input: number, output: number): string {
  return `${fmtTokens(input)}/${fmtTokens(output)}`;
}

/** Best-effort one-line summary of a tool call's args (command / path / query / etc.). */
export function summarizeCall(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick =
    a.command ?? a.path ?? a.file_path ?? a.filePath ?? a.query ?? a.pattern ?? a.url ?? a.prompt;
  if (typeof pick === "string") return pick.replace(/\s+/g, " ").trim();
  try {
    return JSON.stringify(a);
  } catch {
    return "";
  }
}

/**
 * Footer status string shown in the pi status bar.
 * Shown while a subagent is running (with a spinner prefix) and after
 * each call completes (with cumulative session totals).
 */
export function footerStatus(t: SessionTotals, running: boolean): string {
  const prefix = running ? "\u25b6 " : "";
  const sub = `${t.count} sub${t.count === 1 ? "" : "s"}`;
  return `${prefix}\u{1f916} ${sub} \u00b7 $${t.cost.toFixed(4)}`;
}

/** Plain-text telemetry for the model-facing onUpdate content (no theme). */
export function plainTelemetry(d: SubStats): string {
  const tag = d.resuming ? "\u21bb " : "";
  const tok = fmtTokenPair(d.tokensIn, d.tokensOut);
  return `${tag}${d.sessionId} \u00b7 ${plural(d.turns, "turn")} \u00b7 ${plural(d.calls.length, "tool call")} \u00b7 ${tok} \u00b7 $${d.cost.toFixed(4)}`;
}

/** Themed one-line header: 🤖 session · turns · tokens · cost. */
function themedHeader(theme: Theme, d: SubStats): string {
  const dot = ` ${theme.fg("dim", "\u00b7")} `;
  const tag = d.resuming ? "\u21bb " : "";
  const tok = theme.fg("muted", fmtTokenPair(d.tokensIn, d.tokensOut));
  return [
    `\u{1f916} ${tag}${theme.fg("accent", d.sessionId)}`,
    plural(d.turns, "turn"),
    tok,
    theme.fg("muted", `$${d.cost.toFixed(4)}`),
  ].join(dot);
}

/** One indented line per tool call: tool name + arg (input) summary. */
function callLines(theme: Theme, calls: ToolCall[]): string[] {
  return calls.map((c) => {
    const name = theme.fg("accent", c.tool);
    const summary = c.summary ? " " + theme.fg("toolOutput", clip(c.summary, 100)) : "";
    return `  ${theme.fg("dim", "\u203a")} ${name}${summary}`;
  });
}

export function renderCall(
  args: { resume?: string; model?: string; goal?: string },
  defaultModel: string,
  theme: Theme,
): Text {
  let head = theme.fg("toolTitle", theme.bold("subagent"));
  const resume = (args.resume ?? "").trim();
  if (resume) head += " " + theme.fg("accent", `\u21bb ${resume}`);
  const model = (args.model ?? "").trim() || defaultModel;
  head += " " + theme.fg("muted", shortModel(model));
  const goal = (args.goal ?? "").trim().split("\n")[0];
  if (goal) head += " " + theme.fg("dim", clip(goal, 160));
  return new Text(head, 0, 0);
}

export function renderResult(
  d: SubStats | undefined,
  isError: boolean,
  expanded: boolean,
  isPartial: boolean,
  theme: Theme,
): Text {
  const calls = d ? callLines(theme, d.calls) : [];

  if (isPartial) {
    const head = d ? themedHeader(theme, d) : theme.fg("dim", "starting\u2026");
    return new Text([head, ...calls].join("\n"), 0, 0);
  }

  if (isError || d?.error) {
    const head = theme.fg("error", `\u2716 ${d?.sessionId ?? "subagent"} \u00b7 ${d?.error ?? "failed"}`);
    return new Text([head, ...calls].join("\n"), 0, 0);
  }

  const out = [d ? themedHeader(theme, d) : "", ...calls];
  const body = (d?.text ?? "").trim();
  if (body) {
    const lines = body.split("\n");
    const shown = expanded ? lines : lines.slice(0, 3);
    out.push("", ...shown.map((l) => theme.fg("toolOutput", l)));
    if (!expanded && lines.length > shown.length) {
      out.push(theme.fg("dim", `\u2026 ${lines.length - shown.length} more lines`));
    }
  }
  return new Text(out.join("\n"), 0, 0);
}

/** Build a model-facing error result carrying the given telemetry details. */
export function failure(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<unknown> & { isError: true } {
  return { content: [{ type: "text", text }], details, isError: true };
}
