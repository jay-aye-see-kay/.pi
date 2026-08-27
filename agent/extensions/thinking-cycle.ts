import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function thinkingCycleExtension(pi: ExtensionAPI): void {
  pi.registerShortcut("ctrl+shift+u", {
    description: "Cycle thinking level backward",
    handler: async (ctx) => {
      if (!ctx.model?.reasoning) {
        ctx.ui.notify("Current model does not support thinking", "info");
        return;
      }

      const levels = getSupportedThinkingLevels(ctx.model);
      const currentIndex = levels.indexOf(pi.getThinkingLevel());
      const previousIndex = currentIndex > 0 ? currentIndex - 1 : levels.length - 1;
      const previousLevel = levels[previousIndex];

      if (previousLevel) pi.setThinkingLevel(previousLevel);
    },
  });
}
