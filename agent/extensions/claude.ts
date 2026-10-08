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
//   only save a page via an `Edit(<one out dir>/**)` rule, and only publishes
//   a file it may `Read`, so publishing gets `Read(<one staged dir>/**)`);
// - anything that sends local content out (publishing) is confirmed by the
//   user first and refused without a UI;
// - validate every model-supplied input before spawning; never pass free text
//   through to claude's prompt;
// - unrestricted network access is accepted (claude needs it anyway).
// Each run is isolated from the user's personal Claude setup: safe mode (no
// installed plugins, hooks, skills, CLAUDE.md, auto-memory), no user/project/
// local settings, no MCP servers, no session persistence, and pi's other
// secrets are stripped from its env.
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type JsonValue = NonNullable<ToolResultEvent["structuredContent"]> | null;

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
  /** With `metadata`: the plain (no-path) read's result, minus the raw HTML. */
  metadata?: string;
  /** With `metadata`: the full plain-read result, saved to disk. */
  metadata_file?: string;
  /** With `metadata`: the stored declaration, e.g. {"mcp":{"servers":[{"server","tools"}]}}. */
  declaration?: JsonValue;
}

export async function fetchArtifact(
  ref: string,
  outDir?: string,
  signal?: AbortSignal,
  metadata = false,
): Promise<ArtifactFetch> {
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
  const result: ArtifactFetch = { html, md, log, info: artifactToolResult(run), ...(connectors.length ? { connectors } : {}) };
  if (metadata) Object.assign(result, await readArtifactMetadata(url, out, signal));
  return result;
}

/**
 * A plain read (url only, no path): what Claude Code's TUI gets. It returns a
 * header plus the live page's raw HTML, so the whole page enters Haiku's
 * context (costs tokens). Saves the full tool result; returns it without the HTML.
 */
async function readArtifactMetadata(url: string, out: string, signal?: AbortSignal) {
  const log = join(out, "claude-metadata.jsonl");
  const file = join(out, "read.txt");
  const call = JSON.stringify({ action: "read", url });
  const run = await runClaude({
    prompt: `Call the Artifact tool once with ${call}. Then reply with only the word done.`,
    cwd: out,
    logPath: log,
    tools: ["Artifact"],
    env: { CLAUDE_CODE_ARTIFACT: "1" },
    signal,
  });
  const text = toolResultTexts(run).join("\n\n");
  if (!text) throw new Error(`metadata read of ${url} failed:\n${failureReason(run, log)}\nfull log: ${log}`);
  writeFileSync(file, text);
  // Drop the raw HTML, wrapped in e.g. <cowritten-artifact-html>…</cowritten-artifact-html>.
  const head = text.replace(/^(<([\w-]*html)>)$[\s\S]*?^(<\/\2>)$/gm, "$1\n…(raw HTML omitted; same as index.html)\n$3");
  // The connector/capability declaration the page was published with, if any.
  let declaration: JsonValue | undefined;
  const decl = text.match(/^<artifact-stored-declaration>$\s*([\s\S]*?)\s*^<\/artifact-stored-declaration>$/m);
  if (decl) {
    try {
      declaration = JSON.parse(decl[1]);
    } catch {
      /* leave it in the text */
    }
  }
  return {
    metadata: head.length > 8000 ? `${head.slice(0, 8000)}\n…(truncated)` : head,
    metadata_file: file,
    ...(declaration !== undefined ? { declaration } : {}),
  };
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

/** Texts of all tool_results, from the stream-json events. */
function toolResultTexts(run: ClaudeRun): string[] {
  const texts: string[] = [];
  for (const e of run.events) {
    if (e?.type !== "user") continue;
    for (const c of e.message?.content ?? []) {
      if (c?.type !== "tool_result") continue;
      const text = typeof c.content === "string"
        ? c.content
        : (c.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
      if (text) texts.push(text);
    }
  }
  return texts;
}

/** Text of the Artifact tool's tool_result. */
function artifactToolResult(run: ClaudeRun): string | undefined {
  const text = toolResultTexts(run)[0] ?? run.result;
  return text && text.length > 4000 ? `${text.slice(0, 4000)}\n…(truncated)` : text;
}

// ── publishing ───────────────────────────────────────────────────────────────

const PUBLISH_BASE = "/tmp/claude-artifact-publish";
const PUBLISH_EXTS = new Set([".html", ".htm", ".md"]);
const PUBLISH_MAX_BYTES = 2 * 1024 * 1024;
const VERSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// Token shapes that must never be published, beyond the exact values of STRIP_ENV vars.
const SECRET_PATTERNS: [string, RegExp][] = [
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{40,})/],
  ["Anthropic key", /\bsk-ant-[\w-]{20,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[\w-]{10,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Names of secrets found in `text` (never their values). */
function findSecrets(text: string): string[] {
  const found = STRIP_ENV.filter((k) => (process.env[k]?.length ?? 0) >= 12 && text.includes(process.env[k]!));
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) found.push(name);
  return found;
}

/** Short, single-line free text (title, label) that goes into claude's tool-call JSON. */
function checkShortText(name: string, value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  value = value.trim();
  if (!value || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${name} must be 1-${max} characters on one line`);
  }
  return value;
}

export interface PublishOptions {
  /** Existing artifact to overwrite; omit to create a new (private) one. */
  url?: string;
  /** HTML: used only if the page has no <title>. Markdown: becomes the file name, which is its title. */
  title?: string;
  /** Short name for this version. */
  label?: string;
  /** With `url`: only overwrite if the live version id is this one. */
  expectVersion?: string;
  /** Base for a relative `file`. */
  cwd?: string;
  /** Asked before anything is uploaded; publishing is refused without it. */
  confirm?: (title: string, message: string) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface ArtifactPublish {
  url: string;
  version: number;
  version_id: string;
  /** With `url`: the version that was overwritten. */
  previous_version_id?: string;
  /** The staged copy that was uploaded. */
  file: string;
  log: string;
  info?: string;
}

/**
 * Publish a local .html or .md file as a claude.ai artifact (new and private,
 * or a new version of `url`). The file is copied into a fresh staged dir,
 * which is claude's cwd and the only place it may Read.
 */
export async function publishArtifact(file: string, opts: PublishOptions = {}): Promise<ArtifactPublish> {
  // Validate everything before asking, staging or spawning.
  const src = resolve(opts.cwd ?? process.cwd(), file);
  const ext = extname(src).toLowerCase();
  if (!PUBLISH_EXTS.has(ext)) throw new Error(`can only publish .html or .md files: ${file}`);
  const st = statSync(src); // throws if missing
  if (!st.isFile() || st.size === 0) throw new Error(`not a non-empty file: ${file}`);
  if (st.size > PUBLISH_MAX_BYTES) throw new Error(`file is over ${PUBLISH_MAX_BYTES / 1024 / 1024} MB: ${file}`);
  const target = opts.url ? resolveArtifactRef(opts.url).url : undefined;
  const title = checkShortText("title", opts.title, 100);
  const label = checkShortText("label", opts.label, 40);
  const expectVersion = opts.expectVersion?.trim();
  if (expectVersion !== undefined) {
    if (!target) throw new Error("expect_version needs url");
    if (!VERSION_ID_RE.test(expectVersion)) throw new Error(`not a version id: ${expectVersion}`);
  }
  const secrets = findSecrets(readFileSync(src, "utf8"));
  if (secrets.length) throw new Error(`refusing to publish ${file}: it contains a secret (${[...new Set(secrets)].join(", ")})`);

  const size = st.size < 1024 ? `${st.size} B` : `${(st.size / 1024).toFixed(1)} KB`;
  const what = target
    ? `Overwrite ${target}${expectVersion ? ` (if still version ${expectVersion})` : ""} with ${src} (${size})?`
    : `Publish ${src} (${size}) to claude.ai as a new private artifact?`;
  if (!opts.confirm) throw new Error("publishing needs the user's confirmation, and there's no UI to ask in");
  if (!(await opts.confirm("Publish claude.ai artifact", what))) throw new Error("the user declined to publish");

  // Stage. The basename becomes the title of a Markdown page.
  mkdirSync(PUBLISH_BASE, { recursive: true });
  const dir = realpathSync(mkdtempSync(`${PUBLISH_BASE}/`)); // realpath so the Read rule matches
  const stem = (ext === ".md" && title ? title : basename(src, extname(src)))
    .replace(/[^\p{L}\p{N} ._-]+/gu, "-").replace(/^[-. ]+|[-. ]+$/g, "").slice(0, 100) || "page";
  const staged = join(dir, stem + ext);
  copyFileSync(src, staged);
  const log = join(dir, "claude.jsonl");

  const publish = JSON.stringify({
    file_path: staged,
    ...(target ? { url: target } : {}),
    ...(title && ext !== ".md" ? { title } : {}),
    ...(label ? { label } : {}),
  });
  const noRetry = "If a call is refused or errors, do not retry, merge, edit or publish anything else: reply with the tool result text verbatim.";
  // Overwriting needs a plain read in the same session (a saved copy doesn't count).
  const prompt = target
    ? `Call the Artifact tool at most twice, in order. First ${JSON.stringify({ action: "read", url: target })}. ` +
      (expectVersion
        ? `If the version id in its header is not exactly ${expectVersion}, stop and reply with only "VERSION_MISMATCH <the version id>". Otherwise, `
        : "Then, ") +
      `call it with ${publish}, publishing the file unchanged. ${noRetry} Otherwise reply with only the second tool result text.`
    : `Call the Artifact tool exactly once with ${publish}. ${noRetry} Otherwise reply with only the tool's result text.`;

  const run = await runClaude({
    prompt,
    cwd: dir,
    logPath: log,
    tools: ["Artifact", "Read"], // --tools denies unlisted tools, and publishing checks Read
    allowedTools: ["Artifact", `Read(/${dir}/**)`],
    env: { CLAUDE_CODE_ARTIFACT: "1" },
    signal: opts.signal,
  });

  const texts = toolResultTexts(run);
  const previous = target ? texts[0]?.match(/^\[Artifact \S+ \(version ([\w-]+)\)/)?.[1] : undefined;
  for (const text of texts) {
    const m = text.match(/^Published .* at (https:\/\/\S+) \(Version (\d+), version id ([\w-]+)\)/m);
    if (!m) continue;
    const result: ArtifactPublish = {
      url: m[1],
      version: Number(m[2]),
      version_id: m[3],
      ...(previous ? { previous_version_id: previous } : {}),
      file: staged,
      log,
      info: text.length > 4000 ? `${text.slice(0, 4000)}\n…(truncated)` : text,
    };
    if (expectVersion && previous !== expectVersion) {
      throw new Error(`published ${result.url} version ${result.version} over version ${previous ?? "?"}, not ${expectVersion} as expected; log: ${log}`);
    }
    return result;
  }

  // Failed: report the reason without any page HTML a refusal carries.
  let reason = run.result?.trim() ?? "";
  const mismatch = reason.match(/VERSION_MISMATCH\s+([\w-]+)/);
  if (mismatch) reason = `the live version is ${mismatch[1]}, not ${expectVersion}; nothing was published`;
  else if (texts.length) reason = texts[texts.length - 1].split(/\n\[Artifact |\n<[\w-]*html>/)[0].slice(0, 1000);
  else reason = failureReason(run, log);
  throw new Error(`could not publish ${file}:\n${reason}\nfull log: ${log}`);
}

function formatPublish(r: ArtifactPublish): string {
  return [
    `Published ${r.url} (version ${r.version}, version id ${r.version_id})`,
    ...(r.previous_version_id ? [`Overwrote version id ${r.previous_version_id}.`] : []),
    "It's private: only its owner and people given access can open it. Share it from the page's Share menu.",
    `staged file: ${r.file}`,
    `log: ${r.log}`,
  ].join("\n");
}

function formatArtifact(r: ArtifactFetch): string {
  const lines = [`html: ${r.html}`, `md:   ${r.md}`, `log:  ${r.log}`];
  if (r.connectors) lines.push("", "Connector calls in the page source:", ...r.connectors.map((c) => `- ${c}`));
  if (r.info) lines.push("", "Artifact tool result:", r.info);
  if (r.metadata) lines.push("", `Plain read (full: ${r.metadata_file}):`, r.metadata);
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
      metadata: Type.Optional(
        Type.Boolean({ description: "Also do a plain read (as Claude Code's TUI does): returns its header, incl. the page's declared connectors (owner, sharing, version). Adds ~10s and ~$0.03." }),
      ),
    }),
    outputSchema: Type.Object({
      html: Type.String(),
      md: Type.String(),
      log: Type.String(),
      info: Type.Optional(Type.String()),
      connectors: Type.Optional(Type.Array(Type.String())),
      metadata: Type.Optional(Type.String()),
      metadata_file: Type.Optional(Type.String()),
      declaration: Type.Optional(Type.Unknown()),
    }),
    async execute(_id, params, signal) {
      const r = await fetchArtifact(params.url, params.out_dir, signal, params.metadata);
      return {
        content: [{ type: "text" as const, text: formatArtifact(r) }],
        structuredContent: { ...r },
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "claude_artifact_publish",
    label: "publish claude artifact",
    exposure: "deferred",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description:
      "Publish a local .html or .md file to claude.ai as an artifact via Claude Code's Artifact tool. Without `url` it creates a " +
      "new private artifact; with `url` it overwrites that artifact with a new version (anything saved there since is lost). " +
      "Asks the user to confirm, and refuses files containing secrets. Sharing is only possible from the page's Share menu. " +
      "Takes about 10s.",
    parameters: Type.Object({
      file: Type.String({ description: "Local .html or .md file (max 2 MB). Markdown is published as-is; its file name becomes the title." }),
      url: Type.Optional(Type.String({ description: "Existing artifact URL or ID to overwrite. Omit to create a new artifact." })),
      title: Type.Optional(Type.String({ description: "HTML: title used only when the page has no <title>. Markdown: the page title (file name)." })),
      label: Type.Optional(Type.String({ description: "Short name for this version, max 40 characters." })),
      expect_version: Type.Optional(Type.String({ description: "With url: only overwrite if the live version id is this (from a previous publish or read)." })),
    }),
    outputSchema: Type.Object({
      url: Type.String(),
      version: Type.Number(),
      version_id: Type.String(),
      previous_version_id: Type.Optional(Type.String()),
      file: Type.String(),
      log: Type.String(),
      info: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const r = await publishArtifact(params.file, {
        url: params.url,
        title: params.title,
        label: params.label,
        expectVersion: params.expect_version,
        cwd: ctx.cwd,
        confirm: ctx.hasUI ? (t, m) => ctx.ui.confirm(t, m) : undefined,
        signal,
      });
      return {
        content: [{ type: "text" as const, text: formatPublish(r) }],
        structuredContent: { ...r },
        details: {},
      };
    },
  });

  pi.registerCommand("artifact", {
    description: "claude.ai artifacts: /artifact <url-or-id> fetches as Markdown; /artifact publish <file> [url] publishes",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      if (sub === "publish") {
        const [file, url] = rest;
        if (!file || rest.length > 2) return ctx.ui.notify("usage: /artifact publish <file> [url-to-overwrite]", "warning");
        try {
          const r = await publishArtifact(file, { url, cwd: ctx.cwd, confirm: (t, m) => ctx.ui.confirm(t, m) });
          ctx.ui.notify(formatPublish(r), "info");
        } catch (e) {
          ctx.ui.notify(String(e instanceof Error ? e.message : e), "error");
        }
        return;
      }
      if (!sub) return ctx.ui.notify("usage: /artifact <url-or-id> | /artifact publish <file> [url]", "warning");
      ctx.ui.notify("Fetching artifact…", "info");
      try {
        ctx.ui.notify(formatArtifact(await fetchArtifact(args)), "info");
      } catch (e) {
        ctx.ui.notify(String(e instanceof Error ? e.message : e), "error");
      }
    },
  });
}
