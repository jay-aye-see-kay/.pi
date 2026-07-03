import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableModel, ModelsConfig } from "./types";

/**
 * Read & validate `subagentModels` from ~/.pi/agent/settings.json.
 *
 * A map of model id → human description; order matters, the first entry is the
 * default used when a tool call omits `model`:
 *   "subagentModels": {
 *     "github-copilot/claude-sonnet-4.6": "good all-round model, the default choice",
 *     "github-copilot/claude-haiku-4.5":  "fast and cheap, use for finding things",
 *     "github-copilot/claude-opus-4.8":   "slower/pricier, great for hard reasoning"
 *   }
 * If the key is absent the tool is NOT registered (disabled silently, no
 * fallback). If present but malformed, the tool is disabled and the user is
 * warned at session start.
 */
export function readSubagentModels(): ModelsConfig {
  let parsed: { subagentModels?: unknown };
  try {
    parsed = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
  } catch {
    return { status: "disabled" };
  }
  const raw = parsed.subagentModels;
  if (raw === undefined) return { status: "disabled" }; // no key, no fallback
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      status: "invalid",
      message: "subagentModels must be an object mapping model ids to descriptions.",
    };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    return { status: "invalid", message: "subagentModels must list at least one model." };
  }
  const bad = entries.filter(([, desc]) => typeof desc !== "string" || !desc.trim());
  if (bad.length) {
    return {
      status: "invalid",
      message: `subagentModels needs a non-empty description for: ${bad.map(([id]) => id).join(", ")}.`,
    };
  }
  const models: AvailableModel[] = entries.map(([id, desc]) => ({
    id: id.trim(),
    description: (desc as string).trim(),
  }));
  return { status: "ok", models };
}
