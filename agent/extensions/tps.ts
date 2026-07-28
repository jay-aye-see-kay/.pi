/**
 * tps — one-line tokens/second summary after each agent turn.
 *
 * Based on pi's own .pi/extensions/tps.ts, with three changes:
 *
 *   1. Accumulates across `agent_end` and reports once on `agent_settled`.
 *      `agent_end` fires per *low-level* run, and pi may still auto-retry,
 *      auto-compact-and-retry, or drain queued follow-ups after it — so the
 *      upstream version prints several partial lines per prompt.
 *
 *   2. Divides output tokens by *generation* time (wall clock minus time spent
 *      inside tool executions) rather than raw wall clock. Tool runtime and
 *      permission-dialog waits are unbounded and would otherwise dominate the
 *      number. Total wall clock is still shown for context.
 *
 *   3. Drops the upstream in/cache/total figures. Each request re-sends the
 *      whole context, so summing them over a multi-turn run reports numbers
 *      several times larger than the actual context — misleading next to the
 *      footer. Cost is summed instead, which is additive and meaningful.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let wallMs = 0;
  let toolMs = 0;
  let output = 0;
  let cost = 0;
  let aborted = false;

  let runStart: number | null = null;
  // Tools run in parallel, so track depth and only time the outermost span.
  let toolDepth = 0;
  let toolStart = 0;

  const reset = () => {
    wallMs = 0;
    toolMs = 0;
    output = 0;
    cost = 0;
    aborted = false;
    runStart = null;
    toolDepth = 0;
  };

  pi.on("session_start", reset);

  pi.on("agent_start", () => {
    runStart = Date.now();
  });

  pi.on("tool_execution_start", () => {
    if (toolDepth++ === 0) toolStart = Date.now();
  });

  pi.on("tool_execution_end", () => {
    if (--toolDepth <= 0) {
      toolDepth = 0;
      toolMs += Date.now() - toolStart;
    }
  });

  pi.on("agent_end", (event) => {
    if (runStart !== null) {
      wallMs += Date.now() - runStart;
      runStart = null;
    }

    for (const message of event.messages) {
      if (message.role !== "assistant") continue;
      output += message.usage.output || 0;
      cost += message.usage.cost?.total || 0;
      if (message.stopReason === "aborted" || message.stopReason === "error") aborted = true;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const genMs = Math.max(wallMs - toolMs, 0);
    const report = ctx.hasUI && !aborted && output > 0 && genMs > 0;
    if (!report) {
      reset();
      return;
    }

    const tps = output / (genMs / 1000);
    const parts = [
      `${tps.toFixed(1)} tok/s`,
      `out ${output.toLocaleString()}`,
      `${(genMs / 1000).toFixed(1)}s gen of ${(wallMs / 1000).toFixed(1)}s`,
    ];
    if (cost > 0) parts.push(`$${cost.toFixed(4)}`);

    ctx.ui.notify(parts.join(" · "), "info");
    reset();
  });
}
