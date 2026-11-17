import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNamedShortcut } from "./lib/named-shortcut";

const STATUS_KEY = "prompt-stash";
const PREVIEW_LENGTH = 30;

/** Swap the editor text with a single in-memory stash slot. Nothing is ever dropped. */
export default function promptStashExtension(pi: ExtensionAPI): void {
  let stash = "";

  registerNamedShortcut(pi, "ext.stash.swap", {
    description: "Swap the prompt with the stash",
    handler: async (ctx) => {
      const current = ctx.ui.getEditorText();
      if (!current && !stash) {
        ctx.ui.notify("Nothing to stash", "info");
        return;
      }

      ctx.ui.setEditorText(stash);
      stash = current;

      const firstLine = stash.trim().split("\n")[0] ?? "";
      const preview = firstLine.length > PREVIEW_LENGTH ? `${firstLine.slice(0, PREVIEW_LENGTH)}…` : firstLine;
      ctx.ui.setStatus(STATUS_KEY, stash ? ctx.ui.theme.fg("dim", `stash: ${preview}`) : undefined);
    },
  });
}
