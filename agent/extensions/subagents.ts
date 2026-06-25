import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a self-contained task to an isolated subagent that runs in its own context window. " +
      "The subagent has its own read/bash/edit/write tools and returns ONLY its final answer; its " +
      "intermediate work never enters this conversation. Use it for context-heavy subtasks (searching, " +
      "exploring, summarizing, multi-step grunt work) whose intermediate output you do not need to see. " +
      "The subagent CANNOT see this conversation, so the task must be complete and self-contained, and " +
      "should ask the subagent to end with a clear, standalone final report.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "Complete, self-contained instructions for the subagent. Include all context it needs " +
          "(paths, constraints, what to return). It cannot see this conversation. Tell it to finish " +
          "with a clear final report, since only its final message is returned to you.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = `sub-${randomUUID().slice(0, 8)}`;
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
          "-p", params.task,
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
        ctx.ui.setWidget(widgetKey, [
          `\u{1f916} ${sessionId} \u00b7 ${turns} turn${turns === 1 ? "" : "s"} \u00b7 ${tools} \u00b7 $${totalCost.toFixed(4)}`,
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
