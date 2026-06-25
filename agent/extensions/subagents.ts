import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

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
 */

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

/** One subagent tool call: name + a one-line arg (input) summary. */
interface ToolCall {
  tool: string;
  summary: string;
}

/** Live + final telemetry shared between execute() and the inline renderers via result.details. */
interface SubStats {
  sessionId: string;
  resuming: boolean;
  cost: number;
  turns: number;
  calls: ToolCall[];
  running: boolean;
  text?: string;
  error?: string;
  exitCode?: number;
}

/** Best-effort one-line summary of a tool call's args (command / path / query / etc.). */
const summarizeCall = (args: unknown): string => {
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
};

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "\u2026" : s);

const plainTelemetry = (d: SubStats): string => {
  const tag = d.resuming ? "\u21bb " : "";
  return `${tag}${d.sessionId} \u00b7 ${d.turns} turn${d.turns === 1 ? "" : "s"} \u00b7 ${d.calls.length} tool call${d.calls.length === 1 ? "" : "s"} \u00b7 $${d.cost.toFixed(4)}`;
};

const themedHeader = (theme: Theme, d: SubStats): string => {
  const dot = ` ${theme.fg("dim", "\u00b7")} `;
  const tag = d.resuming ? "\u21bb " : "";
  return [
    `\u{1f916} ${tag}${theme.fg("accent", d.sessionId)}`,
    `${d.turns} turn${d.turns === 1 ? "" : "s"}`,
    theme.fg("muted", `$${d.cost.toFixed(4)}`),
  ].join(dot);
};

/** One indented line per tool call: tool name + arg (input) summary. */
const callLines = (theme: Theme, calls: ToolCall[]): string[] =>
  calls.map((c) => {
    const name = theme.fg("accent", c.tool);
    const summary = c.summary ? " " + theme.fg("toolOutput", clip(c.summary, 100)) : "";
    return `  ${theme.fg("dim", "\u203a")} ${name}${summary}`;
  });

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

  const sessionDir = join(getAgentDir(), "subagent-sessions");
  const sandboxExt = join(getAgentDir(), "npm", "node_modules", "pi-sandbox", "index.ts");
  if (!existsSync(sandboxExt)) return; // require pi-sandbox; never run subagents unsandboxed

  const SESSION_ID_RE = /^sub-[a-z0-9-]+$/i;
  // Session files are named `<timestamp>_<sessionId>.jsonl`.
  const sessionExists = (id: string): boolean => {
    try {
      return readdirSync(sessionDir).some((f) => f.endsWith(`_${id}.jsonl`));
    } catch {
      return false;
    }
  };

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
      const resumeId = params.resume?.trim();
      if (resumeId) {
        if (!SESSION_ID_RE.test(resumeId)) {
          return {
            content: [{ type: "text", text: `Invalid subagent id '${resumeId}'. Expected a 'sub-...' id from a prior result footer.` }],
            isError: true,
            details: { resume: resumeId },
          };
        }
        if (!sessionExists(resumeId)) {
          return {
            content: [{ type: "text", text: `No subagent session '${resumeId}' found to resume. Start a fresh subagent instead (omit 'resume').` }],
            isError: true,
            details: { resume: resumeId },
          };
        }
      }
      const sessionId = resumeId ?? `sub-${randomUUID().slice(0, 8)}`;
      const resuming = Boolean(resumeId);

      const tier: Tier = params.model ?? "standard";
      const model = models[tier];

      const promptParts = [
        "## Goal",
        params.goal.trim(),
        "## Context",
        params.context.trim(),
        "## Envronment and Sandbox",
        "You are a resumable subagent running in a sandbox. " +
        "The sandbox has been setup to keep out of your way, but nothing is perfect. " +
        "Stop and describe the issue with your envronment if you are blocked so that " +
        "information this can be passed back to the user to be fixed."
      ];

      const child = spawn(
        "pi",
        [
          "--mode", "json",
          "--no-extensions",
          "-e", sandboxExt,
          "--no-skills",
          "--session-dir", sessionDir,
          "--session-id", sessionId,
          "--model", model,
          "-n", `subagent/${sessionId}`,
          "-p", promptParts.join("\n\n"),
        ],
        {
          cwd: ctx.cwd,
          env: { ...process.env, PI_SUBAGENT: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const onAbort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", onAbort, { once: true });

      let finalText = "";
      let totalCost = 0;
      let turns = 0;
      const calls: ToolCall[] = [];
      let stderr = "";
      let buf = "";

      const snapshot = (extra: Partial<SubStats> = {}): SubStats => ({
        sessionId,
        resuming,
        cost: totalCost,
        turns,
        calls: calls.map((c) => ({ ...c })),
        running: true,
        ...extra,
      });
      // Push live telemetry into the inline tool block (rendered by renderResult with isPartial).
      const pushUpdate = () => {
        const d = snapshot();
        onUpdate?.({ content: [{ type: "text", text: plainTelemetry(d) }], details: d });
      };
      pushUpdate();

      const handleEvent = (ev: any) => {
        switch (ev?.type) {
          case "tool_execution_start": {
            calls.push({ tool: ev.toolName, summary: summarizeCall(ev.args) });
            pushUpdate();
            break;
          }
          case "message_end":
            if (ev.message?.role === "assistant") {
              const cost = ev.message?.usage?.cost?.total;
              if (typeof cost === "number") totalCost += cost;
            }
            break;
          case "turn_end":
            turns += 1;
            pushUpdate();
            break;
          case "agent_end": {
            const msgs: any[] = ev.messages ?? [];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i]?.role === "assistant") {
                finalText = (msgs[i].content ?? [])
                  .filter((b: any) => b?.type === "text")
                  .map((b: any) => b.text)
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

      signal?.removeEventListener("abort", onAbort);

      const stats = snapshot({ running: false });

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: `Subagent ${sessionId} aborted.` }],
          isError: true,
          details: { ...stats, error: "aborted" },
        };
      }
      if (spawnError) {
        return {
          content: [{ type: "text", text: `Failed to launch subagent: ${spawnError.message}` }],
          isError: true,
          details: { ...stats, error: spawnError.message },
        };
      }
      if (exitCode !== 0 && !finalText) {
        return {
          content: [
            { type: "text", text: `Subagent ${sessionId} failed (exit ${exitCode}).\n${stderr.slice(-1500)}` },
          ],
          isError: true,
          details: { ...stats, error: `exit ${exitCode}`, exitCode },
        };
      }

      const footer = `[subagent ${sessionId} \u00b7 ${turns} turns \u00b7 $${totalCost.toFixed(4)}]`;
      const body = finalText || "(subagent produced no final text)";
      return {
        content: [{ type: "text", text: `${body}\n\n${footer}` }],
        details: { ...stats, text: body },
      };
    },

    renderCall(args, theme) {
      let head = theme.fg("toolTitle", theme.bold("subagent"));
      const resume = (args.resume ?? "").trim();
      if (resume) head += " " + theme.fg("accent", `\u21bb ${resume}`);
      const tier = args.model ?? "standard";
      if (tier !== "standard") head += " " + theme.fg("muted", `[${tier}]`);
      const goal = (args.goal ?? "").trim().split("\n")[0];
      if (goal) head += " " + theme.fg("dim", clip(goal, 160));
      return new Text(head, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const d = result.details as SubStats | undefined;
      const calls = d ? callLines(theme, d.calls) : [];
      if (isPartial) {
        const head = d ? themedHeader(theme, d) : theme.fg("dim", "starting\u2026");
        return new Text([head, ...calls].join("\n"), 0, 0);
      }
      if (context.isError || d?.error) {
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
    },
  });
}
