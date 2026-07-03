import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIERS, type ModelsConfig } from "./types";

/**
 * Read & validate `subagentModels` from ~/.pi/agent/settings.json.
 *
 * Three tiers (small / standard / reasoning):
 *   "subagentModels": {
 *     "small":     "github-copilot/claude-haiku-4.5",
 *     "standard":  "github-copilot/claude-sonnet-4.6",
 *     "reasoning": "github-copilot/claude-opus-4.8"
 *   }
 * If the key is absent the tool is NOT registered (disabled silently, no
 * fallback). If present but malformed, the tool is disabled and the user is
 * warned at session start. Tool calls default to `standard`.
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
      message: "subagentModels must be an object with 'small', 'standard', and 'reasoning' model strings.",
    };
  }
  const obj = raw as Record<string, unknown>;
  const missing = TIERS.filter((t) => typeof obj[t] !== "string" || !(obj[t] as string).trim());
  if (missing.length) {
    return {
      status: "invalid",
      message: `subagentModels is missing a valid model string for: ${missing.join(", ")}.`,
    };
  }
  return {
    status: "ok",
    models: {
      small: (obj.small as string).trim(),
      standard: (obj.standard as string).trim(),
      reasoning: (obj.reasoning as string).trim(),
    },
  };
}
