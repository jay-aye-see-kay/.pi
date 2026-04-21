import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync } from "fs";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!process.env.PI_SESSION_TEMP) {
      const baseDir = process.env.TMPDIR || "/tmp";
      const dir = `${baseDir}/pi-session/${ctx.sessionManager.getSessionId()}`;
      mkdirSync(dir, { recursive: true });
      process.env.PI_SESSION_TEMP = dir;
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const additionalInstructions = `\nIMPORTANT: Use $PI_SESSION_TEMP for ALL temp files, cloning, downloads — never /tmp. Use http:// for git clone.`;

    return {
      systemPrompt: event.systemPrompt + additionalInstructions,
    };
  });
}
