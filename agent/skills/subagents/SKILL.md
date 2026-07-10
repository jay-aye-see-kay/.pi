---
name: subagents
description: Delegate self-contained work to isolated `pi` subagents by calling the pi CLI through bash. Use to keep big/noisy work out of your context — search & locate, explore & explain, summarize a large artifact, scoped grunt work, or a fresh second opinion. Run several in parallel and merge.
---

# Subagents via the `pi` CLI

A subagent is just another `pi` process you launch from the `bash` tool. It runs
in its own context window with its own read/bash/edit/write tools, does the
noisy work, and hands back only its final text. All the intermediate mess (tool
calls, file dumps, retries, thinking) stays in *its* context, never yours.

Because you drive the real CLI, you get the full pi surface — parallel fan-out,
resume, redirect-to-file, compose with other shell tools — not a fixed tool
signature.

Spend/liveness is shown to the human automatically (a footer meter); you don't
manage it.

## When to reach for one

- **search & locate** — "where is X", "where is this used"
- **explore & explain** — "how does this flow work"
- **summarize a big artifact** — a long log, huge file, diff, test output
- **web/doc lookup** — a signature, a breaking change, a fact + its source
- **scoped grunt work** — run tests and triage, apply a rename, build a repro
- **a fresh second opinion** — review a diff, argue failure cases

The subagent **cannot see this conversation**. State the outcome plainly and put
everything it needs into the prompt.

## How to spawn one

Always run non-interactive (`-p`) and **pin a cheap model**:

```sh
pi -p "PROMPT" --model github-copilot/claude-haiku-4.5
```

- `-p` prints the final assistant text to stdout and exits.
- **`--model` is the highest-leverage cost lever.** Default to
  `github-copilot/claude-haiku-4.5` for search/locate/summarize/grunt work.
  Escalate to `github-copilot/claude-sonnet-4.6` for real reasoning or writing
  code, and only reach for `github-copilot/claude-opus-4.8` on genuinely hard
  problems. A trivial task on opus costs ~10× a haiku one for the same answer.
- **Do NOT pass `--session-dir`.** The environment already routes the subagent
  into the right bucket and links it to this session; overriding it breaks the
  meter and the agentsview nesting.

Write the prompt as a self-contained brief: the goal in one line, then the
context.

```sh
pi -p "Find every call site of \`stampBranchedFrom\` in this repo and list
file:line with a one-line note on what each does. Report only the list." \
  --model github-copilot/claude-haiku-4.5
```

## Keep output out of your context

The whole point is context hygiene. Prefer, in order:

1. **Ask for a digest.** Tell the subagent to report *only* the answer, not its
   working. End prompts with e.g. "Report only the final list / the answer / a
   3-bullet summary."
2. **Redirect bulky output to a file** and read back just what you need:
   ```sh
   pi -p "Summarize test failures" --model github-copilot/claude-haiku-4.5 \
     > /tmp/sub-triage.txt
   ```
   Then `read` the file (with offset/limit) instead of piping megabytes through
   your own turn.

Avoid `--mode json` — it emits the full event stream, which is exactly the noise
you're trying to avoid. Use plain `-p` text.

## Fan-out (parallel subagents)

Independent subtasks should run concurrently, then you merge the results:

```sh
for area in auth billing search; do
  pi -p "Summarize the $area module: entry points, key files, gotchas.
Report only a 4-bullet summary." \
    --model github-copilot/claude-haiku-4.5 > "/tmp/sub-$area.md" &
done
wait
```

Then read the three files and synthesize. The footer meter creeps up live as
each one runs and finishes.

## Resume a finished subagent

Each subagent persists its session. To pull more out of one *without* redoing
work, resume it by id (retrieval, not new work). Give it a stable id up front if
you know you'll want to follow up:

```sh
pi -p "..." --model github-copilot/claude-haiku-4.5 --session-id sub-triage
# later:
pi -p "Which of those failures are flaky vs real?" \
  --model github-copilot/claude-haiku-4.5 --session-id sub-triage
```

`--session-id` is idempotent: same id reuses the same session (with its prior
context and a prompt-cache bonus). Keep resume for *asking*, not new tasks.

## Guidance

- One clear outcome per subagent. If a task has independent parts, split and
  fan out rather than writing one sprawling prompt.
- Give enough context to succeed standalone — paths, constraints, what "done"
  looks like — but no more.
- Don't nest deeply: a subagent spawning its own subagents isn't tracked by the
  meter. Keep it one level.
- Trust the digest. Don't re-read everything the subagent read; that defeats the
  purpose.
