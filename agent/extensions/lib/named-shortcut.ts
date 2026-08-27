import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
type ShortcutOptions = Parameters<ExtensionAPI["registerShortcut"]>[1];
type ExtensionAction = `ext.${string}`;

/** Register an extension action using keys assigned in the global keybindings.json. */
export function registerNamedShortcut(
  pi: ExtensionAPI,
  action: ExtensionAction,
  options: ShortcutOptions,
): void {
  const configPath = join(getAgentDir(), "keybindings.json");
  if (!existsSync(configPath)) {
    throw new Error(`Cannot register ${action}: ${configPath} does not exist`);
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot register ${action}: failed to read ${configPath}`, { cause: error });
  }

  const configured = config[action];
  if (configured === undefined) {
    throw new Error(`Cannot register ${action}: no binding in ${configPath}`);
  }

  const keys = typeof configured === "string" ? [configured] : configured;
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
    throw new Error(`Cannot register ${action}: binding must be a string or string array`);
  }

  for (const key of new Set(keys)) {
    pi.registerShortcut(key as ShortcutKey, options);
  }
}
