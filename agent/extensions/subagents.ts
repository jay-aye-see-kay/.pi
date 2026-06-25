import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
 * Configuration: set `subagentModel` in ~/.pi/agent/settings.json
 *   "subagentModel": "github-copilot/claude-sonnet-4.6"
 * If unset/empty, the tool is NOT registered (subagents disabled, no fallback).
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

function readSubagentModel(): string | undefined {
  try {
    const raw = readFileSync(join(getAgentDir(), "settings.json"), "utf8");
    const model = (JSON.parse(raw) as { subagentModel?: unknown }).subagentModel;
    return typeof model === "string" && model.trim() ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  // Never expose the subagent tool inside a subagent.
  if (process.env.PI_SUBAGENT) return;

  const model = readSubagentModel();
  if (!model) return; // disabled when subagentModel is unset/falsy — no fallback

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

Key rule: the subagent can't see this conversation — give it one clear task with all the context it needs, and have it finish with a standalone final report.`,
    parameters: Type.Object({
      prompt: Type.String({
        description: `One clear task with all context the subagent needs to complete it standalone (paths, constraints, goal).`,
      }),
      resume: Type.Optional(
        Type.String({
          description: `Optional. Resume a finished subagent by its id (e.g. 'sub-1a2b3c4d', from a prior result footer) to ask it a follow-up; \`prompt\` becomes the follow-up message.

Good for: pulling more information out of a subagent that already holds it — a detail from a page/file/search it loaded, or the reasoning behind a result it gave you.
Key rule: resume to get information not to do work.`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
      const widgetKey = `subagent:${sessionId}`;

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
          "-p", params.prompt,
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
      const toolCounts: Record<string, number> = {};
      let stderr = "";
      let buf = "";

      const renderWidget = () => {
        const tools =
          Object.entries(toolCounts)
            .map(([name, count]) => `${name}\u00d7${count}`)
            .join(" ") || "no tools yet";
        const tag = resuming ? "\u21bb " : "";
        ctx.ui.setWidget(widgetKey, [
          `\u{1f916} ${tag}${sessionId} \u00b7 ${turns} turn${turns === 1 ? "" : "s"} \u00b7 ${tools} \u00b7 $${totalCost.toFixed(4)}`,
        ]);
      };
      renderWidget();

      const handleEvent = (ev: any) => {
        switch (ev?.type) {
          case "tool_execution_end":
            toolCounts[ev.toolName] = (toolCounts[ev.toolName] ?? 0) + 1;
            renderWidget();
            break;
          case "message_end":
            if (ev.message?.role === "assistant") {
              const cost = ev.message?.usage?.cost?.total;
              if (typeof cost === "number") totalCost += cost;
            }
            break;
          case "turn_end":
            turns += 1;
            renderWidget();
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
      ctx.ui.setWidget(widgetKey, []); // clear telemetry widget

      const stats = { sessionId, cost: totalCost, turns, tools: toolCounts };

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: `Subagent ${sessionId} aborted.` }],
          isError: true,
          details: stats,
        };
      }
      if (spawnError) {
        return {
          content: [{ type: "text", text: `Failed to launch subagent: ${spawnError.message}` }],
          isError: true,
          details: stats,
        };
      }
      if (exitCode !== 0 && !finalText) {
        return {
          content: [
            { type: "text", text: `Subagent ${sessionId} failed (exit ${exitCode}).\n${stderr.slice(-1500)}` },
          ],
          isError: true,
          details: { ...stats, exitCode },
        };
      }

      const footer = `[subagent ${sessionId} \u00b7 ${turns} turns \u00b7 $${totalCost.toFixed(4)}]`;
      const body = finalText || "(subagent produced no final text)";
      return {
        content: [{ type: "text", text: `${body}\n\n${footer}` }],
        details: stats,
      };
    },
  });
}
