import type {
  AgentSessionEvent,
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager, SessionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";

/**
 * subagent — delegate a self-contained task to an isolated `pi` process.
 *
 * The subagent runs in its own context window and returns ONLY its final
 * assistant text to the main agent. All intermediate work (tool calls, tool
 * output, thinking, retries) stays in the subagent's own session and never
 * enters the main agent's context. Live telemetry (turns / tools / cost) is
 * shown to the human via a TUI widget, not fed to the model.
 *
 * Configuration: set `subagentModels` in ~/.pi/agent/settings.json with three
 * tiers (small / standard / reasoning):
 *   "subagentModels": {
 *     "small":     "github-copilot/claude-haiku-4.5",
 *     "standard":  "github-copilot/claude-sonnet-4.6",
 *     "reasoning": "github-copilot/claude-opus-4.8"
 *   }
 * If the key is absent the tool is NOT registered (disabled silently, no
 * fallback). If present but malformed, the tool is disabled and the user is
 * warned at session start. Tool calls default to `standard`.
 *
 * Recursion: subagents are spawned with `--no-extensions`, so this extension
 * never loads inside a subagent. `PI_SUBAGENT=1` is a belt-and-suspenders guard.
 *
 * Sandboxing: the child is spawned directly (bypassing the sandboxed bash
 * tool), so it would otherwise run unsandboxed. We pass `--no-extensions -e
 * <pi-sandbox>` so the child loads ONLY pi-sandbox and sandboxes ITSELF at
 * first level (no nesting problem, since the spawning process is unsandboxed).
 * In --mode json there is no UI, so pi-sandbox is deny-by-default: anything not
 * pre-allowed in sandbox.json is aborted rather than prompted.
 *
 * Resume: every result footer carries the subagent's session id (e.g.
 * `sub-1a2b3c4d`). Passing that id back as the `resume` parameter re-opens
 * that subagent with its full prior context (idempotent `--session-id`). Resume
 * is retrieval-only: ask a finished subagent for information it already holds
 * (a detail from material it loaded, or the reasoning behind its result) rather
 * than to do new work. Prompt-cache hits are a bonus.
 *
 * Layout of this file:
 *   - Config       — read & validate `subagentModels` from settings.json
 *   - Telemetry    — the live/final stats shared with the renderers
 *   - Running      — spawn the child `pi`, parse its JSON event stream
 *   - Rendering    — turn stats into TUI widgets (all theme logic lives here)
 *   - Extension    — wire it together and register the tool
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type SubagentModels = { small: string; standard: string; reasoning: string };
const TIERS = ["small", "standard", "reasoning"] as const;
type Tier = (typeof TIERS)[number];

type ModelsConfig =
  | { status: "disabled" } // key absent / settings unreadable — stay silent
  | { status: "invalid"; message: string } // present but malformed — warn the user
  | { status: "ok"; models: SubagentModels };

function readSubagentModels(): ModelsConfig {
  let parsed: { subagentModels?: unknown };
  try {
    parsed = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
  } catch {
    return { status: "disabled" };
  }
  const raw = parsed.subagentModels;
  if (raw === undefined) return { status: "disabled" }; // no key, no fallback
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      status: "invalid",
      message: "subagentModels must be an object with 'small', 'standard', and 'reasoning' model strings.",
    };
  }
  const obj = raw as Record<string, unknown>;
  const missing = TIERS.filter((t) => typeof obj[t] !== "string" || !(obj[t] as string).trim());
  if (missing.length) {
    return {
      status: "invalid",
      message: `subagentModels is missing a valid model string for: ${missing.join(", ")}.`,
    };
  }
  return {
    status: "ok",
    models: {
      small: (obj.small as string).trim(),
      standard: (obj.standard as string).trim(),
      reasoning: (obj.reasoning as string).trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** One subagent tool call: name + a one-line arg (input) summary. */
interface ToolCall {
  tool: string;
  summary: string;
}

/**
 * Live + final telemetry, attached to every result/update as `details` so the
 * renderers can draw it. `running` is true for in-flight snapshots (onUpdate)
 * and false for the terminal result.
 */
interface SubStats {
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

// ---------------------------------------------------------------------------
// Running a subagent
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^sub-[a-z0-9-]+$/i;

/** Session files are named `<timestamp>_<sessionId>.jsonl`. */
function sessionExists(sessionDir: string, id: string): boolean {
  try {
    return readdirSync(sessionDir).some((f) => f.endsWith(`_${id}.jsonl`));
  } catch {
    return false;
  }
}

function buildPrompt(goal: string, context: string): string {
  return [
    "## Goal",
    goal.trim(),
    "## Context",
    context.trim(),
    "## Environment and Sandbox",
    "You are a resumable subagent running in a sandbox. " +
      "The sandbox has been set up to keep out of your way, but nothing is perfect. " +
      "Stop and describe the problem with your environment if you are blocked, so that " +
      "it can be passed back to the user to be fixed.",
  ].join("\n\n");
}

interface RunOptions {
  sessionId: string;
  resuming: boolean;
  model: string;
  prompt: string;
  sessionDir: string;
  sandboxExt: string;
  cwd: string;
  signal?: AbortSignal;
}

interface SubagentOutcome {
  stats: SubStats; // final snapshot (running: false)
  finalText: string;
  exitCode: number;
  aborted: boolean;
  spawnError?: Error;
  stderr: string;
}

/**
 * Spawn the child `pi`, accumulate telemetry from its JSON event stream, and
 * resolve once it exits. `onStats` receives a live snapshot whenever the stats
 * change; it is the only coupling to the UI and never sees the child directly.
 */
async function runSubagent(
  opts: RunOptions,
  onStats: (stats: SubStats) => void,
): Promise<SubagentOutcome> {
  const child = spawn(
    "pi",
    [
      "--mode", "json",
      "--no-extensions",
      "-e", opts.sandboxExt,
      "--no-skills",
      "--session-dir", opts.sessionDir,
      "--session-id", opts.sessionId,
      "--model", opts.model,
      "-n", `subagent/${opts.sessionId}`,
      "-p", opts.prompt,
    ],
    {
      cwd: opts.cwd,
      env: { ...process.env, PI_SUBAGENT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const onAbort = () => child.kill("SIGTERM");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let finalText = "";
  let totalCost = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let turns = 0;
  const calls: ToolCall[] = [];
  let stderr = "";
  let buf = "";

  const snapshot = (running: boolean): SubStats => ({
    sessionId: opts.sessionId,
    resuming: opts.resuming,
    cost: totalCost,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    turns,
    calls: calls.map((c) => ({ ...c })),
    running,
  });
  const emit = () => onStats(snapshot(true));
  emit();

  // The child's `--mode json` stream is AgentSession.subscribe's event feed.
  const handleEvent = (ev: AgentSessionEvent) => {
    switch (ev.type) {
      case "tool_execution_start":
        calls.push({ tool: ev.toolName, summary: summarizeCall(ev.args) });
        emit();
        break;
      case "message_end":
        if (ev.message.role === "assistant") {
          totalCost += ev.message.usage.cost.total;
          totalTokensIn += ev.message.usage.input;
          totalTokensOut += ev.message.usage.output;
        }
        break;
      case "turn_end":
        turns += 1;
        emit();
        break;
      case "agent_end": {
        for (let i = ev.messages.length - 1; i >= 0; i--) {
          const msg = ev.messages[i];
          if (msg.role === "assistant") {
            finalText = msg.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
            break;
          }
        }
        break;
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handleEvent(JSON.parse(line));
      } catch {
        // ignore non-JSON lines
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let spawnError: Error | undefined;
  const exitCode: number = await new Promise((resolve) => {
    child.on("error", (err) => {
      spawnError = err;
      resolve(-1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });

  opts.signal?.removeEventListener("abort", onAbort);

  return {
    stats: snapshot(false),
    finalText,
    exitCode,
    aborted: Boolean(opts.signal?.aborted),
    spawnError,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// Rendering (all theme/UI logic lives below this line)
// ---------------------------------------------------------------------------

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "\u2026" : s);

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

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
function summarizeCall(args: unknown): string {
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
function footerStatus(t: SessionTotals, running: boolean): string {
  const prefix = running ? "\u25b6 " : "";
  const sub = `${t.count} sub${t.count === 1 ? "" : "s"}`;
  return `${prefix}\u{1f916} ${sub} \u00b7 $${t.cost.toFixed(4)}`;
}

/** Plain-text telemetry for the model-facing onUpdate content (no theme). */
function plainTelemetry(d: SubStats): string {
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

function renderCall(args: { resume?: string; model?: Tier; goal?: string }, theme: Theme): Text {
  let head = theme.fg("toolTitle", theme.bold("subagent"));
  const resume = (args.resume ?? "").trim();
  if (resume) head += " " + theme.fg("accent", `\u21bb ${resume}`);
  const tier = args.model ?? "standard";
  if (tier !== "standard") head += " " + theme.fg("muted", `[${tier}]`);
  const goal = (args.goal ?? "").trim().split("\n")[0];
  if (goal) head += " " + theme.fg("dim", clip(goal, 160));
  return new Text(head, 0, 0);
}

function renderResult(
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

// ---------------------------------------------------------------------------
// Browsing subagent sessions
// ---------------------------------------------------------------------------

/**
 * Open pi's native session picker scoped to the subagent session directory, so
 * the user can browse and resume a subagent session in the normal UI. Subagent
 * sessions live in their own dir (keeping them out of the built-in `/resume`,
 * `pi -r`, and `pi -c`), so this command is the way back in.
 */
async function openSubagentPicker(sessionDir: string, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Subagent sessions can only be browsed in interactive mode.", "warning");
    return;
  }
  // Avoid opening an empty picker when this project has no subagent sessions.
  const existing = await SessionManager.list(ctx.cwd, sessionDir);
  if (existing.length === 0) {
    ctx.ui.notify("No subagent sessions for this project yet.", "info");
    return;
  }

  const chosen = await ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) =>
    new SessionSelectorComponent(
      (onProgress) => SessionManager.list(ctx.cwd, sessionDir, onProgress),
      (onProgress) => SessionManager.listAll(sessionDir, onProgress),
      (sessionPath) => done(sessionPath),
      () => done(undefined),
      () => done(undefined),
      () => tui.requestRender(),
      {
        renameSession: async (sessionFilePath, nextName) => {
          const next = (nextName ?? "").trim();
          if (next) SessionManager.open(sessionFilePath).appendSessionInfo(next);
        },
        showRenameHint: true,
        keybindings,
      },
    ),
  );

  if (!chosen) return;
  try {
    // switchSession() re-roots pi's session dir at the resumed file's parent
    // (here: subagent-sessions/), which would break the built-in /resume.
    // Mirror pi's /import: copy the chosen session into the active session dir,
    // then switch to the copy so the runtime stays anchored to the normal dir.
    // The original stays in subagent-sessions/ so the subagent tool can still
    // resume it by id.
    const destDir = ctx.sessionManager.getSessionDir();
    const destPath = join(destDir, basename(chosen));
    if (resolve(destPath) !== resolve(chosen)) {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(chosen, destPath);
    }
    const result = await ctx.switchSession(destPath);
    if (!result.cancelled) ctx.ui.notify("Resumed subagent session.", "info");
  } catch (err) {
    ctx.ui.notify(`Failed to resume subagent session: ${(err as Error).message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Build a model-facing error result carrying the given telemetry details. */
function failure(text: string, details: Record<string, unknown>): AgentToolResult<unknown> & { isError: true } {
  return { content: [{ type: "text", text }], details, isError: true };
}

// ---------------------------------------------------------------------------
// Session-scoped subagent cost accumulator
// ---------------------------------------------------------------------------

/** Totals accumulated across all subagent calls in the current session. */
interface SessionTotals {
  count: number;
  cost: number;
  turns: number;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Never expose the subagent tool inside a subagent.
  if (process.env.PI_SUBAGENT) return;

  const cfg = readSubagentModels();
  if (cfg.status === "disabled") return; // no subagentModels key — silent, no fallback
  if (cfg.status === "invalid") {
    // Malformed config: disable the tool but tell the user why.
    pi.on("session_start", async (_e, ctx) => {
      ctx.ui.notify(`Subagents disabled: ${cfg.message}`, "error");
    });
    return;
  }
  const models = cfg.models;

  // Reset on each session (new / resume / fork / reload).
  let totals: SessionTotals = { count: 0, cost: 0, turns: 0 };
  pi.on("session_start", () => {
    totals = { count: 0, cost: 0, turns: 0 };
  });

  const sessionDir = join(getAgentDir(), "subagent-sessions");

  // Browse & resume subagent sessions in the normal UI (they live in their own
  // dir, so they never appear in the built-in /resume, pi -r, or pi -c).
  pi.registerCommand("subagents", {
    description: "Browse and resume subagent sessions",
    handler: async (_args, ctx) => {
      await openSubagentPicker(sessionDir, ctx);
    },
  });

  const sandboxExt = join(getAgentDir(), "npm", "node_modules", "pi-sandbox", "index.ts");
  if (!existsSync(sandboxExt)) return; // require pi-sandbox; never run subagents unsandboxed

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate a self-contained task to an isolated subagent (its own context window, its own read/bash/edit/write tools).

Reach for one when work is big or noisy to do but small to report — keep the mess out of your context:
- search & locate (where is X, where's this used)
- explore & explain (how does this flow work)
- summarize a big artifact (long log, huge file, diff, test output)
- web/doc lookup (a signature, a breaking change, a fact + its source)
- scoped grunt work (run tests and triage, apply a rename, build a minimal repro)
- a fresh second opinion (review a diff, argue failure cases)
Run several in parallel for independent subtasks, then merge.

Key rule: the subagent can't see this conversation — state the outcome in \`goal\` and put everything it needs in \`context\`. It finishes with a standalone final report.`,
    parameters: Type.Object({
      goal: Type.String({
        description: `One concise sentence naming the outcome this subagent must deliver.`,
      }),
      context: Type.String({
        description: `All the information to help the subagent achieve its goal.`,
      }),
      model: Type.Optional(
        Type.Union([Type.Literal("small"), Type.Literal("standard"), Type.Literal("reasoning")], {
          description: `Which model tier to use (leave unset for standard unless you have a reason): 'small' for finding things up, 'reasoning' for hard analysis.`,
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: `Optional. Resume a finished subagent by its id (e.g. 'sub-1a2b3c4d', from a prior result footer) to ask it a follow-up; \`goal\` becomes the follow-up question.

Good for: pulling more information out of a subagent that already holds it — a detail from a page/file/search it loaded, or the reasoning behind a result it gave you.
Key rule: resume to get information not to do work.`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Resolve (and validate) the session: resume an existing one or mint a new id.
      const resumeId = params.resume?.trim();
      if (resumeId) {
        if (!SESSION_ID_RE.test(resumeId)) {
          return failure(
            `Invalid subagent id '${resumeId}'. Expected a 'sub-...' id from a prior result footer.`,
            { resume: resumeId },
          );
        }
        if (!sessionExists(sessionDir, resumeId)) {
          return failure(
            `No subagent session '${resumeId}' found to resume. Start a fresh subagent instead (omit 'resume').`,
            { resume: resumeId },
          );
        }
      }
      const sessionId = resumeId ?? `sub-${randomUUID().slice(0, 8)}`;
      const tier: Tier = params.model ?? "standard";

      const outcome = await runSubagent(
        {
          sessionId,
          resuming: Boolean(resumeId),
          model: models[tier],
          prompt: buildPrompt(params.goal, params.context),
          sessionDir,
          sandboxExt,
          cwd: ctx.cwd,
          signal,
        },
        // Live telemetry → inline tool block (drawn by renderResult with isPartial).
        (stats) => {
          onUpdate?.({ content: [{ type: "text", text: plainTelemetry(stats) }], details: stats });
          // Show a live footer indicator while the subagent is running.
          ctx.ui.setStatus("subagents", footerStatus({ ...totals, cost: totals.cost + stats.cost, turns: totals.turns + stats.turns }, true));
        },
      );

      const { stats, finalText, exitCode } = outcome;

      if (outcome.aborted) {
        return failure(`Subagent ${sessionId} aborted.`, { ...stats, error: "aborted" });
      }
      if (outcome.spawnError) {
        return failure(`Failed to launch subagent: ${outcome.spawnError.message}`, {
          ...stats,
          error: outcome.spawnError.message,
        });
      }
      if (exitCode !== 0 && !finalText) {
        return failure(`Subagent ${sessionId} failed (exit ${exitCode}).\n${outcome.stderr.slice(-1500)}`, {
          ...stats,
          error: `exit ${exitCode}`,
          exitCode,
        });
      }

      // Update session-level running totals and footer.
      totals.count += 1;
      totals.cost += stats.cost;
      totals.turns += stats.turns;
      ctx.ui.setStatus("subagents", footerStatus(totals, false));

      const body = finalText || "(subagent produced no final text)";
      const footer = `[subagent ${sessionId} \u00b7 ${plural(stats.turns, "turn")} \u00b7 $${stats.cost.toFixed(4)}]`;
      return {
        content: [{ type: "text", text: `${body}\n\n${footer}` }],
        details: { ...stats, text: body },
      };
    },

    renderCall(args, theme) {
      return renderCall(args, theme);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      return renderResult(
        result.details as SubStats | undefined,
        Boolean(context.isError),
        expanded,
        isPartial,
        theme,
      );
    },
  });
}
