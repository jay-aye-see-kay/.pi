/// <reference path="/Users/jack/Library/pnpm/global/5/node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts" />
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SNIPPETS: Record<string, string> = {
  tdd: "use red/green TDD: write a failing test first, then the minimal code to make it pass, then refactor",
  fix: "identify the root cause, explain it, then provide the fix with a brief justification",
  review: "review this code for correctness, performance, and readability; suggest specific improvements",
  todo: "find all TODO and FIXME comments and address them one by one",
  doc: "add clear, concise documentation comments to the following code",
};

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+j", {
    description: "Expand snippet trigger (e.g. `tdd` → full instruction)",
    handler: async (ctx) => {
      const text = ctx.ui.getEditorText();

      // Find the last word (the trigger candidate)
      const match = text.match(/(\S+)$/);
      if (!match) return;

      const trigger = match[1];
      const expansion = SNIPPETS[trigger];
      if (!expansion) return;

      // Replace the trigger with the expanded text
      const before = text.slice(0, text.length - trigger.length);
      ctx.ui.setEditorText(before + expansion);
    },
  });
}
