/**
 * Copilot Usage Extension
 *
 * Shows your GitHub Copilot monthly usage / quota via GitHub's own endpoint
 * (https://api.github.com/copilot_internal/user), which pi never surfaces.
 *
 * pi stores a durable GitHub OAuth token (ghu_...) in auth.json under
 * `github-copilot.refresh`. That token (NOT the short-lived Copilot bearer)
 * unlocks the usage endpoint. The interesting numbers live in
 * `quota_snapshots` (premium_interactions is the metered monthly bucket for
 * business/enterprise seats; chat/completions are usually unlimited).
 *
 * Usage:
 *   /copilot-usage   - fetch and display current usage in a box
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "copilot-usage";

const COPILOT_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

interface QuotaSnapshot {
  entitlement?: number;
  remaining?: number;
  percent_remaining?: number;
  unlimited?: boolean;
  overage_permitted?: boolean;
  overage_count?: number;
}

interface CopilotUser {
  login?: string;
  copilot_plan?: string;
  access_type_sku?: string;
  quota_reset_date?: string;
  quota_snapshots?: Record<string, QuotaSnapshot>;
}

async function readGitHubToken(): Promise<string | null> {
  try {
    const raw = await readFile(join(getAgentDir(), "auth.json"), "utf8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const cop = auth["github-copilot"];
    if (cop && typeof cop === "object" && "refresh" in cop) {
      const refresh = (cop as { refresh?: unknown }).refresh;
      if (typeof refresh === "string" && refresh) return refresh;
    }
  } catch {
    // fall through
  }
  return null;
}

function fmt(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

function bar(percentRemaining: number | undefined, width = 20): string {
  if (typeof percentRemaining !== "number") return "";
  const used = Math.max(0, Math.min(100, 100 - percentRemaining));
  const filled = Math.round((used / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function renderQuota(name: string, q: QuotaSnapshot): string {
  const label = name.padEnd(20);
  if (q.unlimited) {
    return `  ${label}unlimited`;
  }
  const entitlement = q.entitlement ?? 0;
  const remaining = q.remaining ?? 0;
  const used = entitlement - remaining;
  const pct = q.percent_remaining;
  const overage =
    q.overage_permitted && q.overage_count && q.overage_count > 0
      ? `  (+${fmt(q.overage_count)} overage)`
      : "";
  return `  ${label}${bar(pct)} ${fmt(used)} / ${fmt(entitlement)} used${overage}`;
}

function buildSummary(user: CopilotUser): string {
  const lines: string[] = [];
  const who = user.login ? ` — ${user.login}` : "";
  const plan = user.copilot_plan ? ` (${user.copilot_plan})` : "";
  lines.push(`GitHub Copilot usage${who}${plan}`);

  const snaps = user.quota_snapshots ?? {};
  // Show the metered bucket(s) first, then unlimited ones.
  const entries = Object.entries(snaps).sort(([, a], [, b]) => {
    const au = a.unlimited ? 1 : 0;
    const bu = b.unlimited ? 1 : 0;
    return au - bu;
  });
  if (entries.length === 0) {
    lines.push("  no quota snapshots reported for this seat");
  } else {
    for (const [name, q] of entries) {
      lines.push(renderQuota(name, q));
    }
  }

  if (user.quota_reset_date) {
    lines.push("");
    lines.push(`  resets ${user.quota_reset_date}`);
  }
  return lines.join("\n");
}

/** The default custom-message "purple box", minus the [customType] title. */
function makeBox(theme: Theme, content: string) {
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  for (const line of content.split("\n")) {
    if (line.length === 0) {
      box.addChild(new Spacer(1));
    } else {
      box.addChild(new Text(theme.fg("customMessageText", line), 0, 0));
    }
  }
  return box;
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    return makeBox(theme, content);
  });

  // Keep display-only usage messages out of the LLM context.
  pi.on("context", async (event) => {
    const messages = event.messages.filter(
      (m) => !(m.role === "custom" && m.customType === CUSTOM_TYPE),
    );
    if (messages.length !== event.messages.length) {
      return { messages };
    }
  });

  pi.registerCommand("copilot-usage", {
    description: "Show GitHub Copilot monthly usage / quota",
    handler: async (_args, ctx) => {
      const token = await readGitHubToken();
      if (!token) {
        ctx.ui.notify(
          "No GitHub Copilot token found in auth.json. Log in with the github-copilot provider first.",
          "error",
        );
        return;
      }

      ctx.ui.setWidget(CUSTOM_TYPE, (_tui, theme) => makeBox(theme, "Fetching Copilot usage…"));
      try {
        const res = await fetch("https://api.github.com/copilot_internal/user", {
          headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${token}` },
          signal: ctx.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          ctx.ui.notify(`Copilot usage request failed: ${res.status} ${res.statusText} ${text}`, "error");
          return;
        }
        const user = (await res.json()) as CopilotUser;
        pi.sendMessage({ customType: CUSTOM_TYPE, content: buildSummary(user), display: true });
      } catch (err) {
        ctx.ui.notify(
          `Copilot usage request errored: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } finally {
        ctx.ui.setWidget(CUSTOM_TYPE, undefined);
      }
    },
  });
}
