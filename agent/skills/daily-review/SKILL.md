---
name: daily-review
description: Review a day of pi sessions (default yesterday) for patterns, inefficiencies and harness improvements, plus a short summary and coaching on how the time was spent. Writes a report to ~/.pi/daily-reviews/.
argument-hint: "[YYYY-MM-DD] (default: yesterday)"
disable-model-invocation: true
---

# Daily review

Do a cheap, high-level sweep of one local calendar day of pi sessions. Find what to change in the harness (`~/.pi`: AGENTS.md, APPEND_SYSTEM.md, skills, extensions, snippets, keybindings) and how the user spent their time. Read the session files directly with `digest.mjs`. Don't use agentsview, because its signals misread pi (see Caveats).

## Steps

1. **Digest:** run `node ~/.pi/agent/skills/daily-review/digest.mjs [YYYY-MM-DD]`. It prints:
   - each session's time range, cwd, name, tool/error/abort counts, subagent count, the user's messages (clipped) and its first few errors (subagent sessions only show up as a count on their parent)
   - that day's `~/.pi` commits with the files they touched (correct local-midnight bounds, so don't re-run `git log` yourself)
   - the paths of up to 3 previous reports
2. **Context:** read the previous reports listed, so you don't repeat suggestions and can check whether earlier ones were taken up. Later commits can also show a problem is already fixed: `git -C ~/.pi log --oneline --since="<day+1> 00:00"`.
3. **Drill down:** run `node …/digest.mjs show <id>` on **at most 3** sessions that look worth it. That prints user and assistant text, one line per tool call, errors and branch points, without tool output. Don't read the raw JSONL unless `show` isn't enough.
4. **Write** `~/.pi/daily-reviews/<day>.md` using the template below, then give the user a 3–5 line summary in chat.

Stay within roughly 50k tokens. Make **no edits** to the harness. Suggestions go in the report, and the user applies them in a follow-up ("apply 2").

## Report template

```md
# Daily review <day>

## At a glance
<sessions, projects, active hours, rough cost — one or two lines>

## What you did
<grouped by project/theme, not per session; outcomes not activity>

## Friction
<each: what happened, evidence (session id + short quote), likely cause>

## Harness suggestions
<max 3, numbered; each names the exact file and the change (AGENTS.md line, snippet, skill tweak, extension idea)>

## Coaching
<1–3 bullets on time and attention: context switching, where the hours went, prompting habits, working hours>

## Review the review
<one proposed change to this skill, or "none">
```

## What to look for

- The same ask, explanation or correction coming up in different sessions. That's a candidate for AGENTS.md, a snippet or a skill.
- The user correcting or redirecting the agent ("off track", "don't do that", "I already said…").
- Environment friction: VPN, auth, sandbox, MCP servers down, BSD vs GNU flags.
- Provider or tool errors the user had to work around by hand.
- Long sessions with lots of back-and-forth on something a skill or script could do.
- Time: harness tinkering compared with project work, and how fragmented the day was.

## Caveats

- **Branching and aborting are deliberate.** The user steers context with pi's `/tree` (branches) and Esc (aborts). Don't treat them as friction unless the user's messages show frustration. A branch right after a provider error usually means a retry.
- **Don't coach on compactions.** They're rare and not something the user wants help with.
- **Cost is a footnote.** The cost figure is the usage `cost` pi records on each message, and work pays for it. Mention it in "At a glance" and nowhere else.
- **Judge tool errors by their text, not their count.** For example, `grep` exiting with code 1 just means nothing matched.
- **agentsview:** its health grade, compaction count and duplicate-prompt signals misread pi sessions. It flattens the tree and counts context drops at branch points and aborts as "compactions". Don't use it here.
- **Old sessions describe old state.** System prompts, skill paths, tool versions and error messages may have changed since. Check current state only when a suggestion depends on it, and do it in one cheap command, not a chase.
- **Known patterns are current state**, and may have been added after the day you're reviewing.
- **Reports are gitignored and may hold work content.** Never copy secrets, tokens or credentials into them.

## Known patterns

Recurring findings. Update this list when the user approves a "Review the review" change.

- `find /` hanging for minutes. Fixed by the `no-find-root.ts` extension (`7ca98f3`).
- dx-insights / hotel MCP failing off the VPN, and the user having to say "I'm on the VPN, restart…". Probably fixed by the mcporter removal (`7cd91ca`, 2026-10-02); watch for it coming back.
- Provider 400 `invalid base64 data` on an image tool result, which the user worked around by branching and re-sending (2026-10-01, Miro session).
