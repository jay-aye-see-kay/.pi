// Inject secrets into the agent's environment at startup.
//
// Pi's main process runs OUTSIDE the sandbox, so it can read the macOS
// keychain even though the sandboxed bash tool cannot (we deny-read
// ~/Library/Keychains). We pull scoped tokens here and set them on
// process.env; every later sandboxed bash inherits them via getShellEnv().
//
// To generate a token
//   visit https://github.com/settings/personal-access-tokens/new
//   select the right org (can only pick one)
//   org policy might be 366 days or less for a token, or it won't work
//   select all repo+org permissions, then remove the ones that say read+write
//
// Store then token (will ask interactively)
//   security add-generic-password -U -a "$USER" -s pi-github-token -w
//
// For BUILDKITE_API_TOKEN: create a read-only Buildkite API access token at
//   https://buildkite.com/user/api-access-tokens (scope to culture-amp, pick
//   only read REST/GraphQL scopes), then store it:
//   security add-generic-password -U -a "$USER" -s pi-buildkite-token -w
// bk reads BUILDKITE_API_TOKEN directly (highest precedence), so this works
// even though the sandbox can't reach bk's own keyring credential store.
//
// No Claude token lives here: claude-backed tools (extensions/claude.ts) run
// `claude` outside the sandbox with its own keychain login.
//
// Every loaded value is redacted from tool results (see below), so an
// accidental `env` doesn't put a token in a session transcript.
//
// Map: env var name -> keychain generic-password service name.
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

type JsonValue = NonNullable<ToolResultEvent["structuredContent"]> | null;

const SECRETS: Record<string, string> = {
  GITHUB_TOKEN: "pi-github-token",
  // Personal-account PAT (jay-aye-see-kay repos, e.g. this ~/.pi repo). Kept in
  // its own var, NOT GH_TOKEN/GITHUB_TOKEN, so it only surfaces via the
  // path-scoped git credential helper in agent/gitconfig for
  // github.com/jay-aye-see-kay/* remotes. gh's default stays the cultureamp token.
  GITHUB_PERSONAL_TOKEN: "pi-github-personal-token",
  BUILDKITE_API_TOKEN: "pi-buildkite-token",
};

function readKeychain(service: string): string | undefined {
  try {
    const out = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined; // item not found / locked
  }
}

export default function (pi: ExtensionAPI) {
  for (const [envVar, service] of Object.entries(SECRETS)) {
    if (process.env[envVar]) continue; // a launch-time value wins
    const value = readKeychain(service);
    if (value) process.env[envVar] = value;
  }

  // Redact secret values from tool results (defense in depth: stops accidental
  // leaks like `env`, not deliberate exfiltration). Nested calls (codemode ->
  // bash) pass through here too, as does the outer codemode result.
  const redactions = Object.keys(SECRETS)
    .map((name) => ({ name, value: process.env[name] ?? "" }))
    .filter((r) => r.value.length >= 12);
  const redact = (s: string) => {
    for (const r of redactions) if (s.includes(r.value)) s = s.split(r.value).join(`<redacted:${r.name}>`);
    return s;
  };
  const redactDeep = (v: JsonValue): JsonValue => {
    if (typeof v === "string") return redact(v);
    if (Array.isArray(v)) return v.map(redactDeep);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
    return v;
  };
  pi.on("tool_result", (event) => {
    if (redactions.length === 0) return;
    let changed = false;
    const content = event.content.map((c) => {
      if (c.type !== "text") return c;
      const text = redact(c.text);
      if (text === c.text) return c;
      changed = true;
      return { ...c, text };
    });
    let structuredContent = event.structuredContent;
    if (structuredContent !== undefined) {
      const before = JSON.stringify(structuredContent);
      const after = redactDeep(structuredContent);
      if (JSON.stringify(after) !== before) {
        structuredContent = after;
        changed = true;
      }
    }
    if (changed) return { content, structuredContent };
  });

  // Point git at a standalone sandbox config (https + gh credential helper, no
  // ~/.ssh needed) and attribute commits to the agent as committer while the
  // human above stays the author. `??=` so launch-time overrides win.
  process.env.GIT_CONFIG_GLOBAL ??= join(import.meta.dirname, "../gitconfig");
  process.env.GIT_COMMITTER_NAME ??= "pi";
  process.env.GIT_COMMITTER_EMAIL ??= "pi-agent@jackrose.co.nz";
}
