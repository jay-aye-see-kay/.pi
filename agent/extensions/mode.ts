/**
 * Mode Extension
 *
 * Adds a lightweight "mode" concept: none | plan | build | investigate.
 * When a mode is active, a short system-looking reminder is appended after
 * each user message (via before_agent_start) telling the LLM what mode
 * it's in. No tool restrictions - purely a prompt nudge.
 *
 * Usage:
 *   /mode              - open a selector
 *   /mode plan         - set directly (also: build, investigate, none)
 *   shift+tab          - cycle none -> plan -> build -> investigate -> none
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "none" | "plan" | "build" | "investigate";

const MODES: Mode[] = ["none", "plan", "build", "investigate"];

const MODE_TEXT: Record<Exclude<Mode, "none">, string> = {
  plan: "PLAN: think through approach and tradeoffs, don't write or edit code yet",
  build: "BUILD: bias for action, if you have a clear understanding of the task, just do it",
  investigate: "INVESTIGATE: focus on understanding not solutions",
};

export default function modeExtension(pi: ExtensionAPI): void {
  let mode: Mode = "none";

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus("mode", mode === "none" ? undefined : mode.toUpperCase());
  }

  function persist(): void {
    pi.appendEntry("mode", { mode });
  }

  function setMode(next: Mode, ctx: ExtensionContext): void {
    mode = next;
    updateStatus(ctx);
    persist();
    ctx.ui.notify(mode === "none" ? "Mode: none" : `Mode: ${mode}`, "info");
  }

  pi.registerCommand("mode", {
    description: "Set or cycle mode (none/plan/build/investigate)",
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

  pi.registerShortcut("shift+tab", {
    description: "Cycle mode (none/plan/build/investigate)",
    handler: async (ctx) => {
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length] ?? "none";
      setMode(next, ctx);
    },
  });

  pi.on("before_agent_start", async () => {
    if (mode === "none") return undefined;
    return {
      message: {
        customType: "mode-tag",
        content: `<mode>${MODE_TEXT[mode]}</mode>`,
        display: false,
      },
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as { type: string; customType?: string; data?: { mode?: Mode } };
      if (entry.type === "custom" && entry.customType === "mode") {
        mode = entry.data?.mode ?? "none";
        break;
      }
    }
    updateStatus(ctx);
  });
}
