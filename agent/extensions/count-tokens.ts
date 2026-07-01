import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, dirname, basename } from "node:path";

const CUSTOM_TYPE = "count-tokens";
const ANTHROPIC_VERSION = "2023-06-01";

interface FileCount {
  path: string;
  tokens?: number;
  error?: string;
  estimated?: boolean;
}

/** Anthropic OAuth (Claude Pro/Max) tokens use Bearer auth. */
function isOAuthToken(key: string): boolean {
  return key.startsWith("sk-ant-oat");
}

/** Rough local fallback estimate when the endpoint is unavailable (e.g. Copilot). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function countTokensForText(
  headers: Record<string, string>,
  baseUrl: string,
  modelId: string,
  text: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages/count_tokens`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { input_tokens?: number };
  if (typeof data.input_tokens !== "number") {
    throw new Error("response missing input_tokens");
  }
  return data.input_tokens;
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

const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Expand an input path into concrete files, recursing into directories. */
async function collectFiles(
  input: string,
  cwd: string,
): Promise<{ label: string; abs: string }[] | { error: string }> {
  const abs = isAbsolute(input) ? input : resolve(cwd, input);
  let s;
  try {
    s = await stat(abs);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!s.isDirectory()) {
    return [{ label: input, abs }];
  }
  const out: { label: string; abs: string }[] = [];
  async function walk(dirAbs: string, dirLabel: string) {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    for (const e of entries) {
      const childAbs = join(dirAbs, e.name);
      const childLabel = `${dirLabel.replace(/\/$/, "")}/${e.name}`;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(childAbs, childLabel);
      } else if (e.isFile()) {
        out.push({ label: childLabel, abs: childAbs });
      }
    }
  }
  try {
    await walk(abs, input);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  // Render our result messages in the purple box without the default title.
  pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    return makeBox(theme, content);
  });

  // Keep our display-only result messages out of the LLM context.
  pi.on("context", async (event) => {
    const messages = event.messages.filter(
      (m) => !(m.role === "custom" && m.customType === CUSTOM_TYPE),
    );
    if (messages.length !== event.messages.length) {
      return { messages };
    }
  });

  pi.registerCommand("count", {
    description: "Count tokens of @file(s) using the current Anthropic model",
    getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
      // Complete the last @token in the argument string.
      const lastAt = prefix.lastIndexOf("@");
      if (lastAt === -1) return null;
      const partial = prefix.slice(lastAt + 1);
      const dir = partial.includes("/") ? dirname(partial) : ".";
      const base = partial.includes("/") ? basename(partial) : partial;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const items = entries
          .filter((e) => e.name.startsWith(base))
          .map((e) => {
            const full = (dir === "." ? e.name : join(dir, e.name)) + (e.isDirectory() ? "/" : "");
            return { value: `@${full}`, label: full };
          });
        return items.length > 0 ? items : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No model selected.", "error");
        return;
      }
      if (model.api !== "anthropic-messages") {
        ctx.ui.notify(
          `/count only supports Anthropic models. Current model is ${model.provider}/${model.id}.`,
          "error",
        );
        return;
      }

      // Parse @file tokens from the raw argument string.
      const paths = (args ?? "")
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => (t.startsWith("@") ? t.slice(1) : t));

      if (paths.length === 0) {
        ctx.ui.notify("Usage: /count @file.foo @file2.md", "warning");
        return;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        ctx.ui.notify(`No auth for ${model.provider}/${model.id}: ${auth.error}`, "error");
        return;
      }

      // Instant feedback in the same purple box while the network request runs.
      ctx.ui.setWidget(CUSTOM_TYPE, (_tui, theme) => makeBox(theme, "Counting tokens…"));

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...(model.headers ?? {}),
        ...(auth.headers ?? {}),
      };
      if (auth.apiKey) {
        if (model.provider === "github-copilot" || isOAuthToken(auth.apiKey)) {
          headers["authorization"] = `Bearer ${auth.apiKey}`;
        } else {
          headers["x-api-key"] = auth.apiKey;
        }
      }

      const results: FileCount[] = [];
      let done = 0;
      try {
        for (const p of paths) {
          const collected = await collectFiles(p, ctx.cwd);
          if ("error" in collected) {
            results.push({ path: p, error: collected.error });
            continue;
          }
          if (collected.length === 0) {
            results.push({ path: p, error: "no files found" });
            continue;
          }
          for (const file of collected) {
            done++;
            ctx.ui.setWidget(CUSTOM_TYPE, (_tui, theme) =>
              makeBox(theme, `Counting tokens\u2026 (${done})`),
            );
            let text: string;
            try {
              text = await readFile(file.abs, "utf8");
            } catch (err) {
              results.push({
                path: file.label,
                error: err instanceof Error ? err.message : String(err),
              });
              continue;
            }

            try {
              const tokens = await countTokensForText(
                headers,
                model.baseUrl,
                model.id,
                text,
                ctx.signal,
              );
              results.push({ path: file.label, tokens });
            } catch (err) {
              // Best-effort fallback: Copilot / proxies may not expose count_tokens.
              results.push({
                path: file.label,
                tokens: estimateTokens(text),
                estimated: true,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      } finally {
        ctx.ui.setWidget(CUSTOM_TYPE, undefined);
      }

      // Build a user-only summary message.
      const lines: string[] = [];
      let total = 0;
      let anyEstimated = false;
      let anyError = false;
      const width = Math.max(...results.map((r) => r.path.length));
      for (const r of results) {
        const name = r.path.padEnd(width);
        if (r.tokens === undefined) {
          anyError = true;
          lines.push(`  ${name}  —  error: ${r.error}`);
          continue;
        }
        total += r.tokens;
        if (r.estimated) {
          anyEstimated = true;
          lines.push(`  ${name}  ~${r.tokens.toLocaleString()} tokens (estimated)`);
        } else {
          lines.push(`  ${name}  ${r.tokens.toLocaleString()} tokens`);
        }
      }

      const counted = results.filter((r) => r.tokens !== undefined).length;
      const header = `Token count (${model.provider}/${model.id})`;
      const totalLine =
        counted > 1
          ? `  ${"TOTAL".padEnd(width)}  ${anyEstimated ? "~" : ""}${total.toLocaleString()} tokens`
          : undefined;

      const content = [header, ...lines, ...(totalLine ? ["", totalLine] : [])].join("\n");

      pi.sendMessage({
        customType: CUSTOM_TYPE,
        content,
        display: true,
      });

      if (anyEstimated) {
        ctx.ui.notify(
          "Some counts are local estimates (count_tokens unavailable for this provider).",
          "warning",
        );
      } else if (anyError) {
        ctx.ui.notify("Some files could not be counted.", "warning");
      }
    },
  });
}
