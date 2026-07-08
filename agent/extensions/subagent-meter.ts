import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

/**
 * subagent-meter — visibility for subagents spawned by calling the `pi` CLI
 * through the `bash` tool (see the `subagents` skill).
 *
 * Global extensions load inside *every* pi process, including the subagents
 * themselves, so this one file plays two roles depending on which process it
 * wakes up in:
 *
 *   Parent role (no PI_SUBAGENT_PARENT in env — a normal top-level pi):
 *     - `tool_call` on bash: if the command runs `pi`, inject env so the child
 *       lands in this session's bucket and knows its parent
 *       (PI_CODING_AGENT_SESSION_DIR + PI_SUBAGENT_PARENT).
 *     - watches the bucket's `.status/` dir; on change, re-sums the tiny status
 *       files each subagent writes and renders a live footer meter.
 *     - stamps `branchedFrom` into finished children so agentsview nests them.
 *
 *   Child role (PI_SUBAGENT_PARENT set — this pi is a subagent):
 *     - writes/updates `<bucket>/.status/<own-session-id>.json` with cumulative
 *       usage/cost on session_start / turn_end / agent_end.
 *     - silently no-ops if the marker is absent (this path runs in every
 *       hand-invoked `pi` too, so it must stay cheap and quiet).
 *
 * Bucket layout matches the existing `subagents/` tool:
 *   <agentDir>/subagent-sessions/<parent-session-id>/
 *     <ts>_<child>.jsonl        (child session, written by pi)
 *     .status/<child>.json      (telemetry, written by this extension)
 */

const MARKER = "PI_SUBAGENT_PARENT";
const TOOLCALL_MARKER = "PI_SUBAGENT_TOOLCALL";
const PANEL_TYPE = "subagent-run";

// Set by the parent role at session_start so the (long-lived) inline panel
// component can re-read the current session's status dir on every repaint.
let currentStatusDir: string | undefined;

interface Status {
  sessionId: string;
  pid: number;
  model: string;
  state: "running" | "done";
  cost: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  startedAt: string;
  updatedAt: string;
  toolCallId?: string;
}

export default function (pi: ExtensionAPI) {
  if (process.env[MARKER]) {
    childRole(pi);
  } else {
    parentRole(pi);
  }
}

// ---------------------------------------------------------------------------
// Child role — self-report telemetry into the bucket's .status/ dir.
// ---------------------------------------------------------------------------

function childRole(pi: ExtensionAPI) {
  let statusFile: string | undefined;
  const s: Status = {
    sessionId: "",
    pid: process.pid,
    model: "unknown",
    state: "running",
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
    turns: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const flush = () => {
    if (!statusFile) return;
    s.updatedAt = new Date().toISOString();
    try {
      writeFileSync(statusFile, JSON.stringify(s));
    } catch {
      // best-effort telemetry; never disturb the subagent's real work
    }
  };

  pi.on("session_start", async (_e, ctx) => {
    try {
      s.sessionId = ctx.sessionManager.getSessionId();
      s.model = modelId(ctx) ?? s.model;
      s.toolCallId = process.env[TOOLCALL_MARKER] || undefined;
      const statusDir = join(ctx.sessionManager.getSessionDir(), ".status");
      mkdirSync(statusDir, { recursive: true });
      statusFile = join(statusDir, `${s.sessionId}.json`);
      flush();
    } catch {
      statusFile = undefined; // give up quietly
    }
  });

  pi.on("turn_end", async (event) => {
    const u = (event as { message?: { usage?: Usage } }).message?.usage;
    if (u) {
      s.cost += u.cost?.total ?? 0;
      s.tokensIn += u.input ?? 0;
      s.tokensOut += u.output ?? 0;
    }
    s.turns += 1;
    flush();
  });

  pi.on("agent_end", async () => {
    s.state = "done";
    flush();
  });

  pi.on("session_shutdown", async () => {
    s.state = "done";
    flush();
  });
}

// ---------------------------------------------------------------------------
// Parent role — inject env, watch .status/, render the meter.
// ---------------------------------------------------------------------------

function parentRole(pi: ExtensionAPI) {
  let bucket: string | undefined;
  let statusDir: string | undefined;
  let parentId: string | undefined;
  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  const stamped = new Set<string>();
  // toolCallIds we've already dropped an inline panel for (dedupe).
  const paneled = new Set<string>();

  // The inline block is a custom_message rendered by a live component that
  // re-reads the status files on each repaint. content is empty (so the agent
  // sees nothing — only `details` carries data, which is excluded from LLM
  // context); all telemetry is read live from disk keyed by toolCallId.
  pi.registerMessageRenderer<{ toolCallId?: string }>(PANEL_TYPE, (message, _opts, theme) => {
    const tcid = message.details?.toolCallId;
    if (!tcid) return undefined;
    return new SubagentPanel(tcid, theme);
  });

  pi.on("session_start", async (_e, ctx) => {
    // (Re)bind to the current session's bucket on new/resume/fork/reload.
    if (watcher) {
      watcher.close();
      watcher = undefined;
    }
    stamped.clear();
    paneled.clear();
    parentId = ctx.sessionManager.getSessionId();
    bucket = join(getAgentDir(), "subagent-sessions", parentId);
    statusDir = join(bucket, ".status");
    currentStatusDir = statusDir;
    try {
      mkdirSync(statusDir, { recursive: true });
      // Pre-seed dedupe with toolCallIds already on disk: their inline panels
      // are already persisted in the session and re-render themselves on
      // reload, so we must not re-inject duplicates for them.
      for (const st of readStatuses(statusDir)) {
        if (st.toolCallId) paneled.add(st.toolCallId);
      }
      watcher = watch(statusDir, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => render(ctx), 150);
      });
    } catch {
      // no watcher — meter simply won't update live
    }
    render(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (watcher) watcher.close();
    watcher = undefined;
    clearTimeout(debounce);
    currentStatusDir = undefined;
  });

  // Inject attribution env into any bash command that runs `pi`.
  pi.on("tool_call", async (event) => {
    if (!bucket || !parentId) return;
    if (!isToolCallEventType("bash", event)) return;
    const cmd = event.input.command;
    if (!/(^|[\s;&|(])pi(\s|$)/.test(cmd)) return; // loose gate: `pi ` somewhere
    const prelude =
      `export ${MARKER}=${shellQuote(parentId)}\n` +
      `export PI_CODING_AGENT_SESSION_DIR=${shellQuote(bucket)}\n` +
      `export ${TOOLCALL_MARKER}=${shellQuote(event.toolCallId)}\n`;
    event.input.command = prelude + cmd;
  });

  function render(ctx: RenderCtx) {
    if (!statusDir) return;
    const statuses = readStatuses(statusDir);
    // Drop an inline panel (once) for each bash command that has spawned
    // subagents. Delivered via steer, so it lands right after that bash block
    // and persists. Empty content keeps it out of the model's context.
    for (const st of statuses) {
      const tcid = st.toolCallId;
      if (tcid && !paneled.has(tcid)) {
        paneled.add(tcid);
        try {
          pi.sendMessage({
            customType: PANEL_TYPE,
            content: "",
            display: true,
            details: { toolCallId: tcid },
          });
        } catch {
          // best-effort; the footer meter still covers liveness
        }
      }
    }
    if (statuses.length === 0) {
      ctx.ui.setStatus("subagents", undefined);
      return;
    }
    let running = 0;
    let cost = 0;
    let tin = 0;
    let tout = 0;
    for (const st of statuses) {
      cost += st.cost;
      tin += st.tokensIn;
      tout += st.tokensOut;
      if (st.state === "running" && pidAlive(st.pid)) running += 1;
      else stampDone(st);
    }
    const done = statuses.length - running;
    const total = statuses.length;
    const countStr = running > 0 ? `${running}\u25b6 ${done}` : `${total}`;
    ctx.ui.setStatus("subagents", `\u{1f916} ${countStr} $${cost.toFixed(2)}`);
  }

  // Stamp `branchedFrom` into a finished child's session header (once) so
  // agentsview nests it under this parent. Race-free: the child has exited.
  function stampDone(st: Status) {
    if (!bucket || !parentId || stamped.has(st.sessionId)) return;
    stamped.add(st.sessionId);
    stampBranchedFrom(bucket, st.sessionId, parentId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Usage {
  cost?: { total?: number };
  input?: number;
  output?: number;
}

interface RenderCtx {
  ui: { setStatus: (id: string, text: string | undefined) => void };
}

/**
 * Inline block rendered under a bash command that spawned subagents. It is a
 * long-lived component: the TUI calls `render()` on every repaint, and we
 * re-read the status files live each time, so it auto-updates while subagents
 * run and settles to final totals when they finish. Repaints are driven by the
 * parent role's fs.watch -> setStatus. Filters by toolCallId so each block
 * shows only its own command's subagents.
 */
class SubagentPanel implements Component {
  constructor(
    private readonly toolCallId: string,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const dir = currentStatusDir;
    if (!dir) return [];
    const mine = readStatuses(dir).filter((s) => s.toolCallId === this.toolCallId);
    if (mine.length === 0) return [];
    const t = this.theme;
    const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "\u2026" : s);

    let running = 0;
    let cost = 0;
    let tin = 0;
    let tout = 0;
    const rows: string[] = [];
    for (const s of mine) {
      const live = s.state === "running" && pidAlive(s.pid);
      if (live) running += 1;
      cost += s.cost;
      tin += s.tokensIn;
      tout += s.tokensOut;
      const mark = live ? t.fg("accent", "\u25b6") : t.fg("success", "\u2713");
      const id = t.fg("dim", s.sessionId.slice(0, 8));
      const model = t.fg("muted", s.model);
      const spend = t.fg("dim", `$${s.cost.toFixed(4)} \u2191${fmtTokens(s.tokensIn)} \u2193${fmtTokens(s.tokensOut)}`);
      rows.push(clip(`  ${mark} ${id} ${model} \u00b7 ${spend}`, width));
    }
    const done = mine.length - running;
    const head =
      t.fg("toolTitle", "\u{1f916} subagents") +
      " " +
      t.fg("dim", `${running > 0 ? `${running} running \u00b7 ` : ""}${done} done \u00b7 $${cost.toFixed(4)} \u2191${fmtTokens(tin)} \u2193${fmtTokens(tout)}`);
    return [clip(head, width), ...rows];
  }
}

function modelId(ctx: unknown): string | undefined {
  const m = (ctx as { model?: { id?: string } }).model;
  if (m?.id) return shortModel(m.id);
  // fall back to the --model flag this process was spawned with
  const argv = process.argv;
  const i = argv.indexOf("--model");
  if (i >= 0 && argv[i + 1]) return shortModel(argv[i + 1]);
  return undefined;
}

const shortModel = (id: string): string => id.split("/").pop() ?? id;

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readStatuses(statusDir: string): Status[] {
  let files: string[];
  try {
    files = readdirSync(statusDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Status[] = [];
  for (const f of files) {
    try {
      const st = JSON.parse(readFileSync(join(statusDir, f), "utf8")) as Status;
      if (st && typeof st.sessionId === "string") out.push(st);
    } catch {
      // half-written file mid-flush; skip this tick
    }
  }
  return out;
}

/**
 * Rewrite line 1 of the child's session file to add `branchedFrom: <parentId>`.
 * agentsview reads the legacy `branchedFrom` key (pi writes `parentSession`,
 * which agentsview ignores). Idempotent and best-effort.
 */
function stampBranchedFrom(bucket: string, sessionId: string, parentId: string): void {
  try {
    if (!existsSync(bucket)) return;
    const file = readdirSync(bucket).find((f) => f.endsWith(`_${sessionId}.jsonl`));
    if (!file) return;
    const path = join(bucket, file);
    if (!statSync(path).isFile()) return;
    const content = readFileSync(path, "utf8");
    const nl = content.indexOf("\n");
    if (nl < 0) return;
    const header = JSON.parse(content.slice(0, nl));
    if (header.type !== "session" || header.branchedFrom) return;
    header.branchedFrom = parentId;
    writeFileSync(path, JSON.stringify(header) + content.slice(nl));
  } catch {
    // lineage is a nicety, not worth failing over
  }
}
