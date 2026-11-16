/**
 * Session Title Extension
 *
 * Auto-names sessions with a small LLM call. The name shows in /resume and in
 * the terminal title (pi sets it to "π - <name> - <cwd>"), so terminal tabs
 * get a useful label.
 *
 *   - First prompt: generate a title from it right away (no waiting for the turn).
 *   - After the 3rd prompt's turn settles: ask whether the conversation's goal
 *     has drifted; keep the title or replace it.
 *
 * A name set any other way (/name, --name, other extensions) is never touched:
 * auto titles are recorded as custom entries, and if the current name differs
 * from the last one we set, it's treated as manual.
 *
 * Config (per-host settings.json):
 *   "sessionTitle": { "model": "github-copilot/claude-haiku-5.5" }
 * No key = disabled. Skipped when there's no UI (print/json mode, subagents).
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENTRY_TYPE = "session-title";
const RETITLE_AT_USER_MESSAGE = 3;

const STYLE = `Title style: 3-6 words, under 50 characters, sentence case, plain text. No quotes, no trailing punctuation, no prefixes like "Title:".`;

const FIRST_TITLE_PROMPT = `You name coding-agent sessions so the user can tell their terminal tabs apart.
Write a short title for the session that starts with the user's message below. Name the task or goal, not the tools.
${STYLE}
Reply with the title only.`;

const RETITLE_PROMPT = `You name coding-agent sessions so the user can tell their terminal tabs apart.
Below is the session's current title and the conversation so far. Decide whether the title still describes the main goal of the conversation.
Only change it if the main goal has changed or the title is clearly misleading - not because a new detail, subtask or tool came up.
If the title still fits, reply with exactly: KEEP
Otherwise reply with the new title only.
${STYLE}`;

function readModelSetting(): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
    const model = settings?.sessionTitle?.model;
    return typeof model === "string" && model.includes("/") ? model : undefined;
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function cleanTitle(raw: string): string {
  const line = raw.trim().split("\n")[0] ?? "";
  return clip(line.replace(/^title:\s*/i, "").replace(/^["'`*]+|["'`*.]+$/g, "").trim(), 60);
}

export default function (pi: ExtensionAPI) {
  const modelSetting = readModelSetting();
  if (!modelSetting) return;

  let inFlight: AbortController | undefined;

  function branch(ctx: ExtensionContext) {
    return ctx.sessionManager.getBranch();
  }

  function userMessageCount(ctx: ExtensionContext): number {
    return branch(ctx).filter((e) => e.type === "message" && e.message.role === "user").length;
  }

  /** Name was set by something other than us (or there is none and we may set one). */
  function isManuallyNamed(ctx: ExtensionContext): boolean {
    const name = pi.getSessionName();
    if (!name) return false;
    const lastAuto = ctx.sessionManager
      .getEntries()
      .filter((e) => e.type === "custom" && e.customType === ENTRY_TYPE)
      .map((e) => (e.type === "custom" ? (e.data as { name?: string })?.name : undefined))
      .pop();
    return name !== lastAuto;
  }

  function transcript(ctx: ExtensionContext): string {
    const parts: string[] = [];
    for (const e of branch(ctx)) {
      if (e.type !== "message") continue;
      const { role, content } = e.message as { role: string; content: unknown };
      if (role === "user") parts.push(`User: ${clip(textOf(content), 1500)}`);
      else if (role === "assistant") {
        const text = textOf(content);
        if (text.trim()) parts.push(`Assistant: ${clip(text, 500)}`);
      }
    }
    return parts.join("\n\n").slice(-8000);
  }

  async function ask(ctx: ExtensionContext, systemPrompt: string, input: string): Promise<string | undefined> {
    const [provider, ...rest] = modelSetting!.split("/");
    const model = ctx.modelRegistry.find(provider!, rest.join("/"));
    if (!model) {
      ctx.ui.notify(`session-title: model not found: ${modelSetting}`, "warning");
      return undefined;
    }
    inFlight?.abort();
    const controller = (inFlight = new AbortController());
    try {
      const result = await ctx.modelRegistry
        .streamSimple(
          model,
          { systemPrompt, messages: [{ role: "user", content: input, timestamp: Date.now() }] },
          // Headroom: if the model reasons by default, thinking spends output tokens before the title.
          { signal: controller.signal, maxTokens: 1024 },
        )
        .result();
      if (controller.signal.aborted || result.stopReason === "aborted") return undefined;
      if (result.stopReason !== "stop") {
        ctx.ui.notify(`session-title: no title (${result.stopReason}${result.errorMessage ? `: ${result.errorMessage}` : ""})`, "warning");
        return undefined;
      }
      return textOf(result.content).trim() || undefined;
    } catch {
      return undefined;
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
  }

  function apply(ctx: ExtensionContext, raw: string | undefined) {
    if (!raw || cleanTitle(raw).toUpperCase() === "KEEP") return;
    try {
      if (isManuallyNamed(ctx)) return; // user named it while we were waiting
      const title = cleanTitle(raw);
      if (!title || title === pi.getSessionName()) return;
      pi.appendEntry(ENTRY_TYPE, { name: title });
      pi.setSessionName(title);
    } catch {
      // ctx went stale (session switched/closed mid-call): drop the title
    }
  }

  pi.on("session_shutdown", () => inFlight?.abort());

  // First prompt: title from the raw input, in the background.
  pi.on("input", (event, ctx) => {
    if (!ctx.hasUI || pi.getSessionName() || userMessageCount(ctx) > 0) return;
    const text = clip(event.text, 2000);
    if (!text) return;
    void ask(ctx, FIRST_TITLE_PROMPT, text).then((raw) => apply(ctx, raw));
  });

  // Third prompt settled: drift check (or a first title, if the first call failed).
  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.hasUI || isManuallyNamed(ctx) || userMessageCount(ctx) !== RETITLE_AT_USER_MESSAGE) return;
    const current = pi.getSessionName();
    const input = current
      ? `Current title: ${current}\n\n<conversation>\n${transcript(ctx)}\n</conversation>`
      : transcript(ctx);
    void ask(ctx, current ? RETITLE_PROMPT : FIRST_TITLE_PROMPT, input).then((raw) => apply(ctx, raw));
  });
}
