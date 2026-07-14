/**
 * Intent Extension
 *
 * Lightweight "intent metadata" for a session: how you want the agent to work
 * (mode) and what you're driving at (goal). When either is set, a short
 * system-looking reminder is injected before each agent turn (via
 * before_agent_start). No tool restrictions - purely a prompt nudge.
 *
 * Metadata:
 *   mode - none | investigate | brainstorm | plan | build (how to work)
 *   goal - free-text north star for the session (what we're after)
 *
 * Each mode also nudges the thinking level (on models that support it;
 * no-op otherwise): investigate/plan -> high, none/brainstorm/build -> medium.
 *
 * Usage:
 *   /mode              - open a selector
 *   /mode plan         - set directly (also: build, investigate, brainstorm, none)
 *   shift+tab          - cycle none -> investigate -> brainstorm -> plan -> build -> none
 *   /goal              - prompt for a goal (empty clears it)
 *   /goal ship the CLI - set directly
 *   /goal clear        - clear the goal
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "none" | "investigate" | "plan" | "build";
type ThinkingLevel = "medium" | "high";

const MODES: Mode[] = ["none", "investigate", "plan", "build"];

const MODE_TEXT: Record<Exclude<Mode, "none">, string> = {
  investigate:
    "INVESTIGATE: Focus on understanding, not solutions. Even if asked to fix, build, or plan - only investigate.",
  plan:
    "PLAN: Think through approach and tradeoffs. Do NOT write or edit code this turn, even if the request sounds like a build instruction.",
  build:
    "BUILD: Bias for action. If you have a clear understanding of the task, just do it.",
};

// Thinking level to apply per mode (on models that support it; no-op otherwise).
const MODE_THINKING: Record<Mode, ThinkingLevel> = {
  none: "medium",
  investigate: "high",
  plan: "high",
  build: "medium",
};

// A level is supported unless the model can't reason, or explicitly maps it to null.
function supportsThinkingLevel(
  model: ExtensionContext["model"],
  level: ThinkingLevel,
): boolean {
  if (!model?.reasoning) return false;
  if (model.thinkingLevelMap?.[level] === null) return false;
  return true;
}

export default function intentExtension(pi: ExtensionAPI): void {
  let mode: Mode = "none";
  let goal = "";

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus("mode", mode === "none" ? undefined : mode.toUpperCase());
    ctx.ui.setStatus("goal", goal ? "🎯" : undefined);
  }

  function persist(): void {
    pi.appendEntry("intent", { mode, goal });
  }

  function setMode(next: Mode, ctx: ExtensionContext): void {
    mode = next;
    updateStatus(ctx);
    persist();
    const level = MODE_THINKING[next];
    if (supportsThinkingLevel(ctx.model, level)) pi.setThinkingLevel(level);
    ctx.ui.notify(mode === "none" ? "Mode: none" : `Mode: ${mode}`, "info");
  }

  function setGoal(next: string, ctx: ExtensionContext): void {
    goal = next.trim();
    updateStatus(ctx);
    persist();
    ctx.ui.notify(goal ? `Goal: ${goal}` : "Goal cleared", "info");
  }

  pi.registerCommand("mode", {
    description: "Set or cycle mode (none/investigate/brainstorm/plan/build)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = MODES.map((m) => ({ value: m, label: m }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) {
        if (!ctx.hasUI) return;
        const choice = await ctx.ui.select("Mode:", MODES);
        if (choice) setMode(choice as Mode, ctx);
        return;
      }
      if (!MODES.includes(arg as Mode)) {
        ctx.ui.notify(`Unknown mode "${arg}". Options: ${MODES.join(", ")}`, "warning");
        return;
      }
      setMode(arg as Mode, ctx);
    },
  });

  pi.registerCommand("goal", {
    description: "Set a session goal shown to the agent (empty or 'clear' to unset)",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg) {
        setGoal(arg.toLowerCase() === "clear" ? "" : arg, ctx);
        return;
      }
      if (!ctx.hasUI) return;
      const next = await ctx.ui.input("Goal:", goal);
      if (next === undefined) return;
      setGoal(next, ctx);
    },
  });

  pi.registerShortcut("shift+tab", {
    description: "Cycle mode (none/investigate/brainstorm/plan/build)",
    handler: async (ctx) => {
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length] ?? "none";
      setMode(next, ctx);
    },
  });

  pi.on("before_agent_start", async () => {
    const lines: string[] = [];
    if (mode !== "none") lines.push(`Mode: ${MODE_TEXT[mode]}`);
    if (goal) lines.push(`Goal: ${goal}`);
    if (lines.length === 0) return undefined;
    return {
      message: {
        customType: "intent-tag",
        content: `<system-message>\n${lines.map((l) => `  ${l}`).join("\n")}\n</system-message>`,
        display: false,
      },
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as {
        type: string;
        customType?: string;
        data?: { mode?: Mode; goal?: string };
      };
      if (entry.type === "custom" && entry.customType === "intent") {
        mode = entry.data?.mode ?? "none";
        goal = entry.data?.goal ?? "";
        break;
      }
    }
    updateStatus(ctx);
  });
}
