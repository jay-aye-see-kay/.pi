/**
 * Native macOS alerts for sessions you've walked away from.
 *
 * Uses alerter (https://github.com/vjeantet/alerter) to post a persistent
 * notification when pi is waiting on you and you haven't touched the
 * keyboard:
 *
 *   1. the agent settled and nobody came back (IDLE_MS)
 *   2. something is blocking on a prompt — e.g. the sandbox grant dialog —
 *      and nobody answered it (PROMPT_MS)
 *
 * Presence is detected with ctx.ui.onTerminalInput: it sees every raw keystroke
 * before any component gets it (including while a modal dialog owns input), so
 * any keypress means "I'm here" — it cancels pending alerts and dismisses live
 * ones. The handler returns undefined for real input, so it is never consumed.
 *
 * Focusing the terminal counts as being back too, even without a keypress. pi
 * only enables focus reporting in fullscreen tuiMode, so we turn it on
 * ourselves and consume the resulting sequences (see FOCUS_IN/FOCUS_OUT).
 *
 * Case 2 is driven by the shared extension event bus, so any extension can ask
 * for attention without depending on this file:
 *
 *   pi.events.emit("attention:request", { key, message });
 *   pi.events.emit("attention:resolve", { key });
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

// ── Tunables ────────────────────────────────────────────────────────────────
/** Agent finished and nobody came back. */
const IDLE_MS = 30_000;
/** Something is blocking on a prompt and nobody answered it. */
const PROMPT_MS = 10_000;
/** Longest assistant snippet shown in the notification body. */
const SNIPPET_LEN = 120;

const ALERTER_CANDIDATES = ["/opt/homebrew/bin/alerter", "/usr/local/bin/alerter"];

/** DEC mode 1004: the terminal reports FOCUS_IN/FOCUS_OUT when its focus
 *  changes. Unsupported terminals ignore the mode set and simply never send the
 *  sequences, so this degrades to keypress-only presence. */
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

type Payload = { title: string; subtitle: string; message: string };

function alerterBin(): string | undefined {
  return ALERTER_CANDIDATES.find((p) => existsSync(p));
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "Waiting for input";
  return flat.length > SNIPPET_LEN ? `${flat.slice(0, SNIPPET_LEN - 1)}…` : flat;
}

/** Pull the plain text out of an assistant message's content blocks. */
function assistantText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
    .map((b) => b.text)
    .join(" ");
}

export default function alerter(pi: ExtensionAPI) {
  if (process.platform !== "darwin") return;

  const bin = alerterBin();
  let enabled = bin !== undefined;

  const pending = new Map<string, NodeJS.Timeout>();
  let live: { group: string; child: ChildProcess } | undefined;
  /** Why the last alert didn't show, surfaced by /alert status. */
  let lastError: string | undefined = bin ? undefined : "alerter binary not found";
  let lastFired: string | undefined;
  let lastAssistantText = "";
  let offInput: (() => void) | undefined;
  let focusReporting = false;
  let ctxRef: ExtensionContext | undefined;

  const group = (key: string) => `pi-${process.pid}-${key}`;
  const active = (ctx: ExtensionContext) => enabled && ctx.mode === "tui";

  /** `quiet` is for housekeeping spawns (--remove) whose failure is not worth
   *  interrupting anyone over: removing an already-gone notification exits
   *  non-zero, and that warning would be pure noise. */
  function run(args: string[], quiet = false): ChildProcess | undefined {
    if (!bin) return undefined;
    // Keep stderr: a silently-failing alerter is the whole reason alerts "vanish".
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.unref();
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (err) => {
      enabled = false;
      report(`spawn failed: ${err.message}`);
    });
    child.once("exit", (code) => {
      // --timeout 0 means alerter lives until dismissed, so exit 0 / null is normal.
      if (code && !quiet) report(`alerter exited ${code}${stderr ? `: ${snippet(stderr)}` : ""}`);
    });
    return child;
  }

  /** Record a failure and, if we can, tell the human right now. */
  function report(message: string): void {
    lastError = message;
    ctxRef?.ui.notify(`alerter: ${message}`, "warning");
  }

  function fire(key: string, payload: Payload): void {
    dismiss();
    // Never pass --sender. It used to impersonate the terminal's bundle id so
    // clicking the alert would focus it, but alerter still speaks the legacy
    // NSUserNotificationCenter API and macOS 26 refuses notifications from a
    // spoofed bundle id: alerter hangs forever and exits 1, with
    // "NSNotificationCenter connection invalid" on stderr. See
    // https://github.com/vjeantet/alerter/issues/59 (#61 is the
    // UNUserNotificationCenter migration that would let us have both).
    const child = run([
      "--title", payload.title,
      "--subtitle", payload.subtitle,
      "--message", payload.message,
      "--group", group(key),
      "--timeout", "0",
    ]);
    if (child) {
      live = { group: group(key), child };
      lastFired = `${key} at ${new Date().toLocaleTimeString()}`;
      lastError = undefined;
    }
  }

  /** Take down the live notification: kill the owning process, and ask alerter
   *  to remove it too in case it outlived the child. */
  function dismiss(): void {
    if (!live) return;
    const { group: g, child } = live;
    live = undefined;
    child.kill();
    run(["--remove", g], true);
  }

  function cancel(key: string): void {
    const timer = pending.get(key);
    if (!timer) return;
    clearTimeout(timer);
    pending.delete(key);
  }

  function cancelAll(): void {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  }

  function schedule(key: string, delayMs: number, build: () => Payload | undefined): void {
    cancel(key);
    const timer = setTimeout(() => {
      pending.delete(key);
      if (!enabled) return;
      const payload = build();
      if (payload) fire(key, payload);
    }, delayMs);
    timer.unref(); // never keep pi alive for a pending alert
    pending.set(key, timer);
  }

  const sessionTitle = (ctx: ExtensionContext) => pi.getSessionName() || basename(ctx.cwd) || "pi";

  /** Terminal *replies* (cell-size report, cursor position) arrive on stdin
   *  exactly like keystrokes. Treating them as presence would silently cancel
   *  every pending alert, so filter them out. Focus reports are handled
   *  separately — they are presence. */
  const TERMINAL_REPLY = /^\x1b\[[?\d;]*[tRn]$/;
  const isHuman = (data: string) => data.length > 0 && !TERMINAL_REPLY.test(data);

  /** You're back at the terminal: nothing pending is worth alerting about. */
  function present(): void {
    if (pending.size > 0) cancelAll();
    if (live) dismiss();
  }

  function setFocusReporting(on: boolean): void {
    if (on === focusReporting || !process.stdout.isTTY) return;
    focusReporting = on;
    process.stdout.write(on ? ENABLE_FOCUS_REPORTING : DISABLE_FOCUS_REPORTING);
  }

  // ── Presence ──────────────────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    ctxRef = ctx;
    if (!active(ctx)) {
      if (!bin && ctx.hasUI) ctx.ui.notify("alerter: binary not found, alerts disabled", "warning");
      return;
    }
    offInput?.();
    offInput = ctx.ui.onTerminalInput((data) => {
      // Switching to this terminal means you're back, even without typing. We
      // asked for these sequences, so we consume them: in regular tuiMode
      // nothing else knows what they are, and they'd land in the editor.
      // (In fullscreen the TUI's own listener is registered first and consumes
      // them before us, so this quietly does nothing there.)
      if (data === FOCUS_IN) {
        present();
        return { consume: true };
      }
      if (data === FOCUS_OUT) return { consume: true };
      // Any keypress means you're back at the terminal.
      if (isHuman(data)) present();
      return undefined; // observer only — never consume real input
    });
    setFocusReporting(true);
  });

  pi.on("session_shutdown", async () => {
    cancelAll();
    dismiss();
    setFocusReporting(false);
    offInput?.();
    offInput = undefined;
  });

  // ── Trigger 1: agent settled, nobody came back ────────────────────────────
  pi.on("message_end", async (event) => {
    if (event.message.role === "assistant") lastAssistantText = assistantText(event.message);
  });

  pi.on("agent_start", async () => cancel("idle"));

  pi.on("agent_settled", async (_e, ctx) => {
    if (!active(ctx)) return;
    schedule("idle", IDLE_MS, () => {
      // pi may have picked work back up (retry, queued follow-up, another ext).
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return undefined;
      return { title: sessionTitle(ctx), subtitle: "waiting for you", message: snippet(lastAssistantText) };
    });
  });

  // ── Trigger 2: something is blocking on a prompt ──────────────────────────
  pi.events.on("attention:request", (data) => {
    const { key, message } = (data ?? {}) as { key?: string; message?: string };
    const ctx = ctxRef;
    if (!key || !ctx || !active(ctx)) return;
    schedule(key, PROMPT_MS, () => ({
      title: sessionTitle(ctx),
      subtitle: "needs your answer",
      message: snippet(message ?? "A prompt is waiting"),
    }));
  });

  pi.events.on("attention:resolve", (data) => {
    const { key } = (data ?? {}) as { key?: string };
    if (!key) return;
    cancel(key);
    if (live?.group === group(key)) dismiss();
  });

  // ── /alert ────────────────────────────────────────────────────────────────
  pi.registerCommand("alert", {
    description: "Forgotten-session alerts: /alert [status|test|on|off]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = [
        { value: "status", label: "status", description: "Show alerter state" },
        { value: "test", label: "test", description: "Fire a test alert now" },
        { value: "on", label: "on", description: "Enable alerts" },
        { value: "off", label: "off", description: "Disable alerts" },
      ].filter((i) => i.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim() || "status";
      if (sub === "on" || sub === "off") {
        enabled = sub === "on" && bin !== undefined;
        if (!enabled) {
          cancelAll();
          dismiss();
        }
        ctx.ui.notify(`alerter: ${enabled ? "on" : "off"}`, "info");
        return;
      }
      if (sub === "test") {
        if (!bin) {
          ctx.ui.notify("alerter: binary not found", "warning");
          return;
        }
        fire("test", { title: sessionTitle(ctx), subtitle: "test alert", message: "If you can see this, alerts work." });
        ctx.ui.notify("alerter: test alert sent", "info");
        return;
      }
      ctx.ui.notify(
        [
          `alerter: ${enabled ? "on" : "off"} (${bin ?? "not found"})`,
          `idle ${IDLE_MS / 1000}s • prompt ${PROMPT_MS / 1000}s • focus reporting ${focusReporting ? "on" : "off"}`,
          `pending: ${pending.size ? [...pending.keys()].join(", ") : "none"}${live ? " • alert live" : ""}`,
          `last fired: ${lastFired ?? "never"}`,
          `last error: ${lastError ?? "none"}`,
        ].join("\n"),
        lastError ? "warning" : "info",
      );
    },
  });
}
