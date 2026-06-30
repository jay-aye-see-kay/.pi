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
// Store then token
//   security add-generic-password -U -a "$USER" -s pi-github-token -w '<scoped PAT>'
// 
// Map: env var name -> keychain generic-password service name.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

const SECRETS: Record<string, string> = {
  GITHUB_TOKEN: "pi-github-token",
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

export default function (_pi: ExtensionAPI) {
  for (const [envVar, service] of Object.entries(SECRETS)) {
    if (process.env[envVar]) continue; // a launch-time value wins
    const value = readKeychain(service);
    if (value) process.env[envVar] = value;
  }
}
