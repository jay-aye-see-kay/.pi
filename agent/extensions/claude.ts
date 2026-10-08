// Claude Code as a backend for pi tools.
//
// Some integrations (claude.ai artifacts, company connectors) only exist inside
// Claude Code, not as general-purpose MCPs. This extension wraps narrow, single-
// purpose `claude -p` runs as pi tools with `deferred` exposure: they aren't
// declared to the model or listed by codemode (zero prompt cost); codemode
// scripts call them as `tools.<name>(...)` and find them via `searchTools()`.
// The matching skill tells the model they exist.
//
// SECURITY: tool execute() runs in pi's main process, so `claude` always runs
// OUTSIDE the OS sandbox. It uses the user's real `claude` login (keychain), so
// there's no Claude token in pi's or the sandbox's environment. Therefore:
// - never give it the Bash tool or general file editing. Very limited, scoped
//   file access is fine when a feature requires it (e.g. the Artifact tool can
//   only save a page via an `Edit(<one out dir>/**)` rule);
// - validate every model-supplied input before spawning; never pass free text
//   through to claude's prompt;
// - unrestricted network access is accepted (claude needs it anyway).
// Each run is isolated from the user's personal Claude setup: safe mode (no
// installed plugins, hooks, skills, CLAUDE.md, auto-memory), no user/project/
// local settings, no MCP servers, no session persistence, and pi's other
// secrets are stripped from its env.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 120_000;

// Credential-ish vars pi or its extensions may hold; claude must not inherit them.
const STRIP_ENV = [
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_TOKEN",
  "GH_TOKEN",
  "BUILDKITE_API_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "PI_CLAUDE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CONFIG_DIR", // must use the default dir, where the real login lives
];

const LOGIN_HINT = "Claude Code isn't logged in: run `claude`, then `/login`, in a normal terminal.";

interface ClaudeRun {
  /** Text of the final `result` event, if any. */
  result?: string;
  /** All parsed stream-json events. */
  events: any[];
  exitCode: number | null;
}

/**
 * Run `claude -p` isolated from the user's Claude setup, streaming its
 * stream-json output to `logPath`. Callers choose the tools; keep them minimal.
 */
async function runClaude(opts: {
  prompt: string;
  cwd: string;
  logPath: string;
  tools: string[];
  allowedTools?: string[];
  model?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<ClaudeRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  for (const k of STRIP_ENV) delete env[k];

  const args = [
    "-p", opts.prompt,
    "--model", opts.model ?? "haiku",
    "--tools", opts.tools.join(","),
    ...(opts.allowedTools?.length ? ["--allowedTools", ...opts.allowedTools] : []),
    "--safe-mode", // no installed plugins, hooks, skills, CLAUDE.md, custom agents; auth still works
    "--setting-sources", "", // no user/project/local settings or permission rules
    "--strict-mcp-config", // and no --mcp-config: no MCP servers
    "--disable-slash-commands", // no skills
    "--no-session-persistence",
    "--output-format", "stream-json",
    "--verbose",
  ];

  const log = createWriteStream(opts.logPath);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
      timeout: TIMEOUT_MS,
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("error", (e) => reject(e.name === "AbortError" ? new Error("claude run aborted") : e));
    child.on("close", (code) => resolve(code));
  }).finally(() => new Promise<void>((r) => log.end(r)));

  const events: any[] = [];
  for (const line of readFileSync(opts.logPath, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* stderr noise */
    }
  }
  const result = [...events].reverse().find((e) => e?.type === "result")?.result;
  return { result: typeof result === "string" ? result : undefined, events, exitCode };
}

function failureReason(run: ClaudeRun, logPath: string): string {
  let reason = run.result?.trim();
  if (!reason) {
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    reason = lines.slice(-5).join("\n");
  }
  if (/not logged in|\/login|401|invalid.*(token|api key)|authentication/i.test(reason)) reason += `\n${LOGIN_HINT}`;
  return reason;
}

// ── claude.ai artifacts ──────────────────────────────────────────────────────

const ARTIFACT_BASE = "/tmp/claude-artifact";
const UUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const SHORT_ID_RE = /^[A-Za-z0-9]{10,40}$/;

/** Validate a URL, short ID or UUID; return the canonical URL and the artifact id. */
export function resolveArtifactRef(ref: string): { url: string; id: string } {
  ref = ref.trim();
  let url: URL;
  if (/^https?:\/\//i.test(ref)) {
    try {
      url = new URL(ref);
    } catch {
      throw new Error(`not an artifact URL or ID: ${ref}`);
    }
    if (url.protocol !== "https:" || !(url.hostname === "claude.ai" || url.hostname.endsWith(".claude.ai"))) {
      throw new Error(`not a claude.ai artifact URL: ${ref}`);
    }
  } else if (UUID_RE.test(ref)) {
    url = new URL(`https://claude.ai/code/artifact/${ref}`);
  } else if (SHORT_ID_RE.test(ref)) {
    url = new URL(`https://claude.ai/artifact/${ref}`);
  } else {
    throw new Error(`not an artifact URL or ID: ${ref}`);
  }
  url.hash = "";
  const id = url.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error(`no artifact id in URL: ${ref}`);
  return { url: url.toString(), id };
}

export interface ArtifactFetch {
  html: string;
  md: string;
  log: string;
  /** The Artifact tool's own result text (version, size), if any. */
  info?: string;
  /** Connector (MCP) calls found in the page source, as "<server>: <tool> (<method>)". */
  connectors?: string[];
}

export async function fetchArtifact(ref: string, outDir?: string, signal?: AbortSignal): Promise<ArtifactFetch> {
  const { url, id } = resolveArtifactRef(ref); // before anything touches disk or spawns
  const dir = outDir ?? join(ARTIFACT_BASE, id);
  mkdirSync(dir, { recursive: true });
  const out = realpathSync(dir); // so the Edit rule matches (/tmp -> /private/tmp)
  const html = join(out, "index.html");
  const md = join(out, "page.md");
  const log = join(out, "claude.jsonl");
  rmSync(html, { force: true });
  rmSync(md, { force: true });

  const call = JSON.stringify({ action: "read", url, path: "index.html", out_dir: out });
  const run = await runClaude({
    prompt: `Call the Artifact tool once with ${call}. Reply with only the tool's result text.`,
    cwd: out,
    logPath: log,
    tools: ["Artifact"],
    // The one scoped file permission: the Artifact tool saves the page via Edit.
    allowedTools: [`Edit(/${out}/**)`],
    env: { CLAUDE_CODE_ARTIFACT: "1" }, // load the Artifact tool in print mode
    signal,
  });

  let size = 0;
  try {
    size = statSync(html).size;
  } catch {
    /* missing */
  }
  if (size === 0) throw new Error(`could not read ${url}:\n${failureReason(run, log)}\nfull log: ${log}`);

  await execFileAsync("pandoc", ["-f", "html", "-t", "gfm-raw_html", "--wrap=none", html, "-o", md], { signal });
  const connectors = findConnectorCalls(readFileSync(html, "utf8"));
  return { html, md, log, info: artifactToolResult(run), ...(connectors.length ? { connectors } : {}) };
}

/**
 * Static scan for connector use: artifacts get an MCP client from
 * `window.claude.use("mcp")` and call e.g. `mcp.watchTool(SERVER, "toolName", ...)`.
 * A server given as an identifier is resolved from a `NAME = "..."` assignment.
 * Best effort: live data is fetched at runtime, so it's never in index.html.
 */
function findConnectorCalls(src: string): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(/\bmcp\??\.(\w+)\(\s*("[^"]*"|'[^']*'|[A-Za-z_$][\w$]*)\s*,\s*["']([^"']+)["']/g)) {
    const [, method, serverExpr, tool] = m;
    let server = serverExpr;
    if (/^["']/.test(serverExpr)) server = serverExpr.slice(1, -1);
    else {
      const def = src.match(new RegExp(`\\b${serverExpr.replace(/\$/g, "\\$")}\\s*=\\s*["']([^"']+)["']`));
      if (def) server = def[1];
    }
    found.add(`${server}: ${tool} (${method})`);
  }
  return [...found];
}

/** Text of the Artifact tool's tool_result, from the stream-json events. */
function artifactToolResult(run: ClaudeRun): string | undefined {
  for (const e of run.events) {
    if (e?.type !== "user") continue;
    for (const c of e.message?.content ?? []) {
      if (c?.type !== "tool_result") continue;
      const text = typeof c.content === "string"
        ? c.content
        : (c.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
      if (text) return text.length > 4000 ? `${text.slice(0, 4000)}\n…(truncated)` : text;
    }
  }
  return run.result;
}

function formatArtifact(r: ArtifactFetch): string {
  const lines = [`html: ${r.html}`, `md:   ${r.md}`, `log:  ${r.log}`];
  if (r.connectors) lines.push("", "Connector calls in the page source:", ...r.connectors.map((c) => `- ${c}`));
  if (r.info) lines.push("", "Artifact tool result:", r.info);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "claude_artifact_fetch",
    label: "claude artifact",
    exposure: "deferred",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description:
      "Fetch a claude.ai artifact (behind claude.ai login) via Claude Code's Artifact tool. Saves the raw page to index.html " +
      "and a pandoc Markdown conversion to page.md, and returns their paths (plus claude's log, the Artifact tool's result text, and " +
      "any connector/MCP calls found in the page source). " +
      "Takes about 10s.",
    parameters: Type.Object({
      url: Type.String({
        description: "Artifact URL (claude.ai/artifact/<id>, claude.ai/code/artifact/<uuid>, *.claude.ai/...), short ID, or UUID.",
      }),
      out_dir: Type.Optional(Type.String({ description: "Output directory. Default: /tmp/claude-artifact/<id>." })),
    }),
    outputSchema: Type.Object({
      html: Type.String(),
      md: Type.String(),
      log: Type.String(),
      info: Type.Optional(Type.String()),
      connectors: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, signal) {
      const r = await fetchArtifact(params.url, params.out_dir, signal);
      return {
        content: [{ type: "text" as const, text: formatArtifact(r) }],
        structuredContent: { ...r },
        details: {},
      };
    },
  });

  pi.registerCommand("artifact", {
    description: "Fetch a claude.ai artifact as Markdown: /artifact <url-or-id>",
    handler: async (args, ctx) => {
      if (!args.trim()) return ctx.ui.notify("usage: /artifact <url-or-id>", "warning");
      ctx.ui.notify("Fetching artifact…", "info");
      try {
        ctx.ui.notify(formatArtifact(await fetchArtifact(args)), "info");
      } catch (e) {
        ctx.ui.notify(String(e instanceof Error ? e.message : e), "error");
      }
    },
  });
}
