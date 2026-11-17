import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerNamedShortcut } from "./lib/named-shortcut";

const STATUS_KEY = "prompt-stash";
const PREVIEW_LENGTH = 30;

// Extensions are re-imported on /reload, /new, /resume and /fork, so the stash
// lives on globalThis to survive those; it's still lost when pi exits.
const STASH_KEY = Symbol.for("pi.prompt-stash");
const store = globalThis as typeof globalThis & { [STASH_KEY]?: string };

function updateStatus(ctx: ExtensionContext, stash: string): void {
  if (!stash) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const firstLine = stash.trim().split("\n")[0] ?? "";
  const preview = firstLine.length > PREVIEW_LENGTH ? `${firstLine.slice(0, PREVIEW_LENGTH)}…` : firstLine;
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `stash: ${preview}`));
}

/** Swap the editor text with a single in-memory stash slot. Nothing is ever dropped. */
export default function promptStashExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx, store[STASH_KEY] ?? "");
  });

  registerNamedShortcut(pi, "ext.stash.swap", {
    description: "Swap the prompt with the stash",
    handler: async (ctx) => {
      const current = ctx.ui.getEditorText();
      const stash = store[STASH_KEY] ?? "";
      if (!current && !stash) {
        ctx.ui.notify("Nothing to stash", "info");
        return;
      }

      ctx.ui.setEditorText(stash);
      store[STASH_KEY] = current;
      updateStatus(ctx, current);
    },
  });
}
