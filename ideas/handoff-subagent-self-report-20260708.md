# Handoff: Subagent-via-bash + self-reporting spend/liveness meter

Supersedes `handoff-subagent-bash-observer-20260708.md`. The goal is unchanged; the observer
design is replaced by a **self-reporting** design that is strictly better (see "The flip").

## Goal / where this is heading

Move from **subagent-as-tool** (the existing `~/.pi/agent/extensions/subagents/` extension) to
**subagent-as-skill**: a `SKILL.md` that teaches the main agent to spawn subagents by calling the
`pi` CLI directly through the `bash` tool. This gives the agent the *full* pi surface (resume, fork,
clone, compose with other shell tools, loop/concat fan-out) instead of only what a tool exposes.

User-facing visibility (tokens/cost/liveness) is recovered by a single extension that plays two
roles depending on which pi process it wakes up in.

## The flip: don't observe — self-report

Key realisation: **global extensions in `~/.pi/agent/extensions/` load inside every pi process,
including the subagents themselves.** So the subagent doesn't need to be observed from outside
(ps-walking, jsonl-scanning) — it can push its own telemetry.

One extension file, two roles:

**Parent role** (`ctx.mode === "tui"`, no marker env):
- `tool_call` hook on bash: if command mentions `pi `, prepend
  `export PI_CODING_AGENT_SESSION_DIR=<agentdir>/subagent-sessions/<parent-session-id>` and
  `export PI_SUBAGENT_PARENT=<parent-session-id>`. Loose gating on `pi ` is deliberately accepted —
  injecting an unused env var into a `pip install` costs nothing.
- `fs.watch` on `<bucket>/.status/`; on change, re-sum status files and render via
  `ctx.ui.setWidget()` / `setStatus()`.
- Widget shows both liveness and spend: `subagents: 2 running · 5 done · $0.31 ↑12k ↓48k`.

**Child role** (`ctx.mode === "print"` / `hasUI === false`, `PI_SUBAGENT_PARENT` set):
- `session_start`: write `<bucket>/.status/<own-session-id>.json` →
  `{ pid, model, name, state: "running", usage: zeros, startedAt }`.
- `turn_end`: update the file with cumulative usage/cost from `event.message.usage`
  (extensions.md:560, 598–601 — usage incl. `cost` is available on `turn_end` in `-p` mode).
- `agent_end`: set `state: "done"`, final totals.
- Must be cheap and **silently no-op when the marker is absent** — this code now runs in every
  hand-invoked `pi` too (load-bearing caveat).

## Why this beats both ps-walking and jsonl-scanning

1. **Liveness comes back for free.** A status file with a pid and `state: "running"` *is* the
   "N running" display, no `ps`, no polling races. (User's floor: no meaningful subagent finishes
   in <10s, so write-latency windows are irrelevant.)
2. **Push, not poll.** `fs.watch` on the status dir; the meter creeps live during a fan-out.
   This *dissolves* the old open question #1 (refresh trigger).
3. **Env survives `nohup`/`setsid`.** Detached children inherit the marker and still self-report.
   Escapees shrink to `env -i` / `--no-extensions` / explicit `--session-dir` — deliberate
   sabotage, not accident. Meter remains a floor.
4. **No jsonl re-parsing.** Each status file carries its own cumulative totals; the meter is a sum
   over tiny JSON files. Dissolves old open question #4 (perf).
5. **No fork double-counting.** Each *process* reports only its own turns, so forked/cloned session
   history (which copies entries into the new .jsonl) never inflates the meter. This fixes a bug
   the jsonl-summing design had.

## Decisions carried over / still locked

- **Attribution via env injection**, bucket layout `<agentdir>/subagent-sessions/<parent-session-id>/`
  (same as the current extension). SKILL.md asks the agent NOT to pass `--session-dir`.
- **Foreground assumption is soft.** The agent may detach; env inheritance means detached subagents
  still report.
- **Context separation is a skill convention:** prefer `pi -p` (text) over `--mode json`, or
  redirect output to temp files; the agent hands back only a digest.
- **Process-tree walking (ps/lsof from `process.pid`) was evaluated and rejected** — it *is*
  feasible (extensions run unsandboxed in-process; `lsof -p` can even map pid→session file), but it
  only yields liveness + a file pointer, and self-reporting provides both plus spend, push-based.
  Note: the bash tool's sandbox denies `ps` anyway, but extensions run outside the sandbox.
- **`process.title` mutation** ("spend in the process table") was considered: works mechanically but
  is argv-length-truncated, flaky on macOS, and puts the parent back on `ps` polling. At most a
  cosmetic ps-label, not the data channel.

## Key findings confirmed live (from previous session's PoC)

- 3 subagents via a bash loop with the env var set → all landed in the bucket, stdout captured to
  files, spend summed from `.jsonl` usage entries: 3 turns, ↑6 ↓79, $0.0121. Mechanics proven.
  (Test bucket `~/.pi/agent/subagent-sessions/exp-32991/` may still exist — safe to delete.)
- **`parentSession` is `null`** for plain `pi -p` children. The current extension stamps
  `branchedFrom` post-hoc (`subagents/sessions.ts::stampBranchedFrom`) so agentsview nests
  subagents under the parent. In the new design the **child role can stamp its own header** (it
  knows the parent id from `PI_SUBAGENT_PARENT`) — cleaner than post-hoc.
- **Fixed per-subagent overhead is model-dominated:** ~16.7k cached system-prompt tokens, ~$0.004
  per trivial task on inherited-default `claude-opus-4.8`. → **SKILL.md must pin a cheap model**
  (e.g. `--model claude-haiku-4.5`) with explicit escalation guidance. Highest-leverage cost item;
  arguably ship this before the meter.
- **No API to override a built-in tool's renderer** — meter lives in footer/widget
  (`ctx.ui.setStatus()` / `setWidget()`), never inside the bash block.
- Env precedence: `--session-dir` flag > `PI_CODING_AGENT_SESSION_DIR` env > setting (README:661).

## Open questions for next session

1. **Status dir hygiene:** stale `running` entries from killed subagents (SIGKILL skips
   `agent_end`). Cheap fix: parent checks pid liveness (`process.kill(pid, 0)`) when rendering, or
   treats mtime-stale running entries as dead.
2. **Meter scope:** cumulative-per-session recommended (sum whole `.status/` dir, monotonic).
3. **Existing `subagents/` tool extension:** deprecate, delete, or coexist during transition? If
   both run, tool-spawned subagents write to the same bucket — decide whether the child role should
   also report when spawned by the tool (probably yes, it's free).
4. **Parent fork:** new parent session id → new bucket → meter resets. Accepted? (One line in
   SKILL.md/README either way.)
5. **process.title as cosmetic label** ("pi-sub: <name>") for humans running `ps` — nice-to-have,
   test macOS truncation behaviour first.

## Relevant files

- Existing tool implementation to mine for reuse: `~/.pi/agent/extensions/subagents/`
  (`runner.ts`, `sessions.ts` — bucket layout + `stampBranchedFrom`, `render.ts`, `index.ts`,
  `config.ts`, `types.ts::SubStats`)
- Reference example: `.../pi-coding-agent/examples/extensions/subagent/`
- Docs: `extensions.md` — mode detection (`ctx.mode`, `ctx.hasUI`, lines ~912, 2603), lifecycle
  events (`session_start` :389, `turn_end` :560 with usage/cost :598, `agent_end` :548,
  `tool_call` :719), `ctx.ui` (:166). Also `session-format.md`, `json.md`.
- Extension constraints (`~/.pi/AGENTS.md`): start simple, follow pi idioms, must pass
  `cd ~/.pi/agent/extensions/ && tsc --noEmit`, prefer a single file over a dir where practical.
  A single file suits this design well (one file, two roles).

## Suggested build order

1. SKILL.md with model pinning + digest conventions (value even with zero extension code).
2. Parent role: env injection only.
3. Child role: status file writes (+ self-stamped `branchedFrom`).
4. Parent role: fs.watch + widget.
5. Retire/repurpose the old `subagents/` tool extension.

## Suggested skills

- `agentsview-history` — to pull earlier context on the existing `subagents` extension if needed.
