import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import type { RunOptions, SubagentOutcome, SubStats, ToolCall } from "./types";
import { summarizeCall } from "./render";

export const SESSION_ID_RE = /^sub-[a-z0-9-]+$/i;

export function buildPrompt(goal: string, context: string): string {
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

/**
 * Spawn the child `pi`, accumulate telemetry from its JSON event stream, and
 * resolve once it exits. `onStats` receives a live snapshot whenever the stats
 * change; it is the only coupling to the UI and never sees the child directly.
 *
 * The child runs in its own context window and returns ONLY its final assistant
 * text to the caller. It is spawned with `PI_SUBAGENT=1` so the subagent tool is
 * never registered inside a subagent (no recursion). It runs in `--mode json`
 * with the standard global config, which loads pi-sandbox automatically so the
 * child sandboxes itself (deny-by-default: no UI to prompt).
 */
export async function runSubagent(
  opts: RunOptions,
  onStats: (stats: SubStats) => void,
): Promise<SubagentOutcome> {
  const child = spawn(
    "pi",
    [
      "--mode", "json",
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
