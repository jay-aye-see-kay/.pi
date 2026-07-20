// Quiet noisy runtime warnings to save agent context.
//
// Covers: Node + Bun (NODE_NO_WARNINGS, same var for both), Python
// (PYTHONWARNINGS), Ruby (RUBYOPT -W0). Deno has no env-var equivalent
// (suppression is CLI-flag only), so it's intentionally not covered.
//
// Enabled by default; toggle for the session with /quiet-warnings.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Snapshot of each key's original state so /quiet-warnings can restore it.
const originals = new Map<string, string | undefined>();

function remember(key: string) {
  if (!originals.has(key)) originals.set(key, process.env[key]);
}

function apply() {
  // Node + Bun. Boolean flag; respect a launch-time value.
  remember("NODE_NO_WARNINGS");
  process.env.NODE_NO_WARNINGS ??= "1";
  // Python. Respect a project's own warning filter list.
  remember("PYTHONWARNINGS");
  process.env.PYTHONWARNINGS ??= "ignore";
  // Ruby. Append so we don't clobber existing RUBYOPT flags.
  remember("RUBYOPT");
  process.env.RUBYOPT = `${process.env.RUBYOPT ?? ""} -W0`.trim();
}

function restore() {
  for (const [key, value] of originals) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export default function quietWarnings(pi: ExtensionAPI) {
  let enabled = true;
  apply();

  pi.registerCommand("quiet-warnings", {
    description: "Toggle suppression of runtime warnings in bash calls (Node/Bun, Python, Ruby)",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) apply();
      else restore();
      ctx.ui.notify(`quiet-warnings: ${enabled ? "on" : "off"}`, "info");
    },
  });
}
