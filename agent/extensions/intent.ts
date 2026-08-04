/**
 * Intent Extension
 *
 * Lightweight "intent metadata" for a session: how you want the agent to work
 * (mode). When set, a short system-looking reminder is injected before each
 * agent turn (via before_agent_start). No tool restrictions - purely a prompt
 * nudge.
 *
 * Metadata:
 *   mode  - none | investigate | plan | act (how to work)
 *   style - none | ASD-STE100 | caveman (how to talk)
 *
 * Each mode also nudges the thinking level (on models that support it;
 * no-op otherwise): investigate/plan -> high, none/act -> medium.
 *
 * Style defaults to none; set it with /style.
 *
 * Usage:
 *   /mode              - open a selector
 *   /mode plan         - set directly (also: act, investigate, none)
 *   shift+tab          - cycle none -> investigate -> plan -> act -> none
 *   /style             - open a selector
 *   /style caveman     - set directly (also: ASD-STE100, none)
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "none" | "investigate" | "plan" | "act";
type Style = "none" | "ASD-STE100" | "caveman";
type ThinkingLevel = "medium" | "high";

const MODES: Mode[] = ["none", "investigate", "plan", "act"];
const STYLES: Style[] = ["none", "ASD-STE100", "caveman"];

const doNotEditInstruction = "Do NOT edit code or mutate state - even if asked to (exception: temp scripts/files for understanding)."

const MODE_TEXT: Record<Exclude<Mode, "none">, string> = {
  investigate:
    `INVESTIGATE: Focus on understanding, not solutions. Discover facts before asking. ${doNotEditInstruction}`,
  plan:
    `PLAN: Think through approach and tradeoffs; aim for a plan another agent or engineer could execute. ${doNotEditInstruction}`,
  act:
    "ACT: Bias for action. You have approval to make changes - edit, run, refactor. If the task is clear, just do it.",
};

// One line each - both styles are well known; remind, don't restate the spec.
const STYLE_TEXT: Record<Exclude<Style, "none">, string> = {
  "ASD-STE100":
    "ASD-STE100 (Simplified Technical English) for prose. Code, commands, paths and errors stay verbatim.",
  caveman:
    "Caveman-speak: drop articles, filler and hedging; fragments fine. Code, commands, paths and errors stay verbatim.",
};

// Thinking level to apply per mode (on models that support it; no-op otherwise).
const MODE_THINKING: Record<Mode, ThinkingLevel> = {
  none: "medium",
  investigate: "high",
  plan: "high",
  act: "medium",
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
  let style: Style = "none";

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus("mode", mode === "none" ? undefined : mode.toUpperCase());
  }

  function persist(): void {
    pi.appendEntry("intent", { mode, style });
  }

  function setMode(next: Mode, ctx: ExtensionContext): void {
    mode = next;
    updateStatus(ctx);
    persist();
    const level = MODE_THINKING[next];
    if (supportsThinkingLevel(ctx.model, level)) pi.setThinkingLevel(level);
    ctx.ui.notify(mode === "none" ? "Mode: none" : `Mode: ${mode}`, "info");
  }

  function setStyle(next: Style, ctx: ExtensionContext): void {
    style = next;
    persist();
    ctx.ui.notify(`Style: ${style}`, "info");
  }

  pi.registerCommand("mode", {
    description: "Set or cycle mode (none/investigate/plan/act)",
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

  pi.registerCommand("style", {
    description: `Set communication style (${STYLES.join("/")})`,
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const lower = prefix.toLowerCase();
      const items = STYLES.filter((s) => s.toLowerCase().startsWith(lower)).map((s) => ({
        value: s,
        label: s,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (!arg) {
        if (!ctx.hasUI) return;
        const choice = await ctx.ui.select("Style:", STYLES);
        if (choice) setStyle(choice as Style, ctx);
        return;
      }
      const match = STYLES.find((s) => s.toLowerCase() === arg.toLowerCase());
      if (!match) {
        ctx.ui.notify(`Unknown style "${arg}". Options: ${STYLES.join(", ")}`, "warning");
        return;
      }
      setStyle(match, ctx);
    },
  });

  pi.registerShortcut("shift+tab", {
    description: "Cycle mode (none/investigate/plan/act)",
    handler: async (ctx) => {
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length] ?? "none";
      setMode(next, ctx);
    },
  });

  pi.on("before_agent_start", async () => {
    const lines: string[] = [];
    if (mode !== "none") lines.push(`  Mode: ${MODE_TEXT[mode]}`);
    if (style !== "none") lines.push(`  Communication Style: ${STYLE_TEXT[style]}`);
    if (lines.length === 0) return undefined;
    return {
      message: {
        customType: "intent-tag",
        content: `<system-message>\n${lines.join("\n")}\n</system-message>`,
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
        data?: { mode?: Mode; style?: Style };
      };
      if (entry.type === "custom" && entry.customType === "intent") {
        mode = entry.data?.mode ?? "none";
        style = entry.data?.style ?? "none";
        break;
      }
    }
    updateStatus(ctx);
  });
}
