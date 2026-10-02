#!/usr/bin/env node
// Daily-review helper: reads pi session JSONL straight off disk (no agentsview).
//   node digest.mjs [YYYY-MM-DD]   compact digest of one local calendar day (default: yesterday)
//   node digest.mjs show <id>      one session condensed: user + assistant text, tool calls as one-liners
// Top-level sessions live in ~/.pi/agent/sessions/<cwd-slug>/; subagent sessions live in
// ~/.pi/agent/subagent-sessions/<parent-id>/ and are only counted against their parent.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT = path.join(os.homedir(), ".pi/agent");
const SESSIONS = path.join(AGENT, "sessions");
const SUBAGENTS = path.join(AGENT, "subagent-sessions");

const clip = (s, n) => ((s = (s ?? "").replace(/\s+/g, " ").trim()).length > n ? s.slice(0, n) + "…" : s);
const text = (c) => (typeof c === "string" ? c : (c ?? []).filter((p) => p.type === "text").map((p) => p.text).join(" "));
const hhmm = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const home = (p) => (p ?? "").replace(os.homedir(), "~");
const jsonl = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)) : [];
const read = (f) =>
  fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });

function show(id) {
  const f = [...jsonl(SESSIONS), ...jsonl(SUBAGENTS)].find((f) => path.basename(f).includes(id));
  if (!f) throw new Error(`no session file matching ${id}`);
  const es = read(f);
  console.log(`# ${home(es[0]?.cwd)} ${es[0]?.timestamp ?? ""}\n${home(f)}`);
  let prev;
  for (const e of es) {
    if (e.type === "session_info") console.log(`[name] ${e.name}`);
    if (e.type === "branch_summary") console.log(`[branch summary] ${clip(e.summary, 300)}`);
    if (e.type === "compaction") console.log(`[compaction]`);
    if (e.type !== "message") continue;
    if (prev && e.parentId !== prev) console.log(`[↳ branch: continues from ${e.parentId}]`);
    prev = e.id;
    const m = e.message;
    if (m.role === "user") console.log(`\n## USER ${hhmm(e.timestamp)}\n${clip(text(m.content), 1500)}`);
    if (m.role === "assistant") {
      const t = text(m.content);
      if (t) console.log(`\n## ASSISTANT\n${clip(t, 600)}`);
      for (const p of m.content ?? []) if (p.type === "toolCall") console.log(`→ ${p.name}: ${clip(JSON.stringify(p.arguments), 160)}`);
      if (m.stopReason === "error" || m.stopReason === "aborted") console.log(`[${m.stopReason}] ${clip(m.errorMessage, 160)}`);
    }
    if (m.role === "toolResult" && m.isError) console.log(`  ! ${m.toolName}: ${clip(text(m.content), 160)}`);
  }
}

function digest(day) {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const inDay = (ts) => ts && new Date(ts) >= start && new Date(ts) < end;
  // cheap prefilter: file created on/before the day (name prefix, UTC) and modified on/after it
  const touched = (f) => fs.statSync(f).mtime >= start && path.basename(f).slice(0, 10) <= day;

  let cost = 0;
  const subs = {}; // parent session id -> subagent count
  for (const f of jsonl(SUBAGENTS).filter(touched)) {
    const es = read(f).filter((e) => inDay(e.timestamp));
    if (!es.length) continue;
    const parent = path.relative(SUBAGENTS, f).split(path.sep)[0];
    subs[parent] = (subs[parent] ?? 0) + 1;
    for (const e of es) cost += e.message?.usage?.cost?.total ?? 0;
  }

  const hours = new Set();
  const out = [];
  const sessions = jsonl(SESSIONS).filter(touched)
    .map((f) => { const es = read(f); return { head: es[0], es: es.filter((e) => inDay(e.timestamp)) }; })
    .filter((s) => s.es.length)
    .sort((a, b) => a.es[0].timestamp.localeCompare(b.es[0].timestamp));

  for (const { head, es } of sessions) {
    let name = "", tools = 0;
    const users = [], errs = [], stops = {};
    for (const e of es) {
      if (e.type === "session_info") name = e.name;
      if (e.type !== "message") continue;
      const m = e.message;
      if (m.role === "user") {
        users.push(`${hhmm(e.timestamp)} ${clip(text(m.content), 240)}`);
        hours.add(new Date(e.timestamp).getHours());
      }
      if (m.role === "assistant") {
        cost += m.usage?.cost?.total ?? 0;
        tools += (m.content ?? []).filter((p) => p.type === "toolCall").length;
        if (m.stopReason === "error" || m.stopReason === "aborted") stops[m.stopReason] = (stops[m.stopReason] ?? 0) + 1;
        if (m.stopReason === "error") errs.push(`provider: ${clip(m.errorMessage, 120)}`);
      }
      if (m.role === "toolResult" && m.isError) errs.push(`${m.toolName}: ${clip(text(m.content), 120)}`);
    }
    const flags = [`tools=${tools}`, `toolErrors=${errs.length}`, ...Object.entries(stops).map(([k, v]) => `${k}=${v}`)];
    if (subs[head.id]) flags.push(`subagents=${subs[head.id]}`);
    out.push(
      `\n## ${hhmm(es[0].timestamp)}–${hhmm(es.at(-1).timestamp)} ${home(head.cwd)}${name ? ` "${name}"` : ""}`,
      `id=${head.id} ${flags.join(" ")}`,
      ...users.map((u) => `- ${u}`),
      ...errs.slice(0, 5).map((e) => `  ! ${e}`),
    );
  }

  const hrs = [...hours].sort((a, b) => a - b).join(",");
  console.log(`# pi digest ${day}: ${sessions.length} sessions, active hours ${hrs || "-"}, ~$${cost.toFixed(2)}`);
  console.log(out.join("\n"));

  // Harness changes that day. Explicit midnights: a bare date in git's --since/--until means "that date at the current time".
  const next = end.toLocaleDateString("sv");
  const git = (...a) => { try { return execFileSync("git", ["-C", path.join(os.homedir(), ".pi"), ...a], { encoding: "utf8" }).trim(); } catch { return ""; } };
  const log = git("log", `--since=${day} 00:00`, `--until=${next} 00:00`, "--format=%h %ad %s", "--date=format:%H:%M", "--name-only");
  const tidy = log.split("\n").filter(Boolean).map((l) => (/^[0-9a-f]{7,} \d\d:\d\d /.test(l) ? l : `    ${l}`)).join("\n");
  console.log(`\n# ~/.pi commits ${day}\n${tidy || "(none)"}`);

  const reports = path.join(os.homedir(), ".pi/daily-reviews");
  const prev = fs.existsSync(reports) ? fs.readdirSync(reports).filter((f) => f.endsWith(".md") && f < `${day}.md`).sort().slice(-3) : [];
  console.log(`\n# Previous reports\n${prev.map((f) => home(path.join(reports, f))).join("\n") || "(none)"}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "show") show(arg);
else digest(cmd ?? new Date(Date.now() - 864e5).toLocaleDateString("sv")); // "sv" locale = YYYY-MM-DD, local tz
