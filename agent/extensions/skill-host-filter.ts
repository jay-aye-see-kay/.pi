// Per-host skill gating via an `only-on-hosts` frontmatter key.
//
//   only-on-hosts absent            -> always enabled
//   only-on-hosts: []  (or empty)   -> always disabled
//   only-on-hosts: ["hostA", ...]   -> enabled only when os.hostname() matches
//
// Disabled skills are removed from the model's system prompt.
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";

const FRONTMATTER_KEY = "only-on-hosts";
const CURRENT_HOST = hostname();

// Cache frontmatter parsing by filePath + mtime.
const cache = new Map<string, { mtimeMs: number; disabled: boolean }>();

function normalizeHosts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return []; // present but null/other -> treat as empty -> disabled
}

function isDisabledFile(filePath: string): boolean {
  try {
    const mtimeMs = statSync(filePath).mtimeMs;
    const hit = cache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) return hit.disabled;

    const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    let disabled = false;
    if (frontmatter && FRONTMATTER_KEY in frontmatter) {
      const hosts = normalizeHosts((frontmatter as Record<string, unknown>)[FRONTMATTER_KEY]);
      disabled = hosts.length === 0 ? true : !hosts.includes(CURRENT_HOST);
    }
    cache.set(filePath, { mtimeMs, disabled });
    return disabled;
  } catch {
    return false; // unreadable -> leave enabled
  }
}

export default function (pi: ExtensionAPI) {
  // Filter disabled skills out of the system prompt each turn.
  // Replace only the skills block so other extensions' prompt edits survive.
  pi.on("before_agent_start", (event) => {
    const all: Skill[] = event.systemPromptOptions.skills ?? [];
    const enabled = all.filter((skill) => !isDisabledFile(skill.filePath));
    if (enabled.length === all.length) return;
    const oldBlock = formatSkillsForPrompt(all);
    if (!oldBlock || !event.systemPrompt.includes(oldBlock)) return;
    return { systemPrompt: event.systemPrompt.replace(oldBlock, formatSkillsForPrompt(enabled)) };
  });
}
