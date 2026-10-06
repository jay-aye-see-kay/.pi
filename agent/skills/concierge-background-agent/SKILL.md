---
name: concierge-background-agent
description: Dispatch and follow up on Concierge (Pip) background agents via the `mcp__concierge` MCP — an autonomous coding agent that works on GitHub repos in a sandbox and opens PRs, comments, and Jira updates. Read this BEFORE every `run_background_agent` call. Use it when the user wants to hand off, delegate, parallelise, or "send to concierge/pip" a coding task, fan work out across repos, have a PR fixed/rebased/finished in the background, or check how a dispatched background agent or its Buildkite build is going.
only-on-hosts: ["jrose-04LCLG"]
---

# Concierge background agent

`mcp__concierge` (codemode) has one tool: `run_background_agent({ repos, task })`. Read its description with `describeTool("mcp__concierge__run_background_agent")`; it covers args, capabilities, and limits. This skill only adds what the tool description doesn't.

**We're early adopters.** The MCP belongs to a sibling team, the agent-workflows / Concierge maintainers. If you got confused, or got it right only because of something in this file, the tool description has a gap. See [Upstream it](#upstream-it).

## Before dispatching

- **Confirm first.** It opens PRs and comments, and updates Jira as the user. Dispatch without asking only when the user asked for it outright. If you wrote the brief yourself, show it and get a yes.
- **Brief it like a teammate who can't see this chat.** Include the goal, acceptance criteria, the constraints/decisions you already reached, and the full Jira, Confluence, Buildkite, or Datadog links. Context is fetched *before* the run, so it only sees links that are in `task`. Say what you want back: a PR, a draft PR, or a comment only.
- **Plan locally, implement remotely.** For anything non-trivial, do the exploration and plan here (or do the bare minimum and push a branch), then hand off with `{ repo, branch }` or `{ repo, pr_number }` so it continues that work rather than starting fresh from main.
- **One task per call, and multi-repo work in one call** (≤5 repos, primary first). Fan out separate tasks as separate calls.
- The repo needs a working devbox setup (`devbox run verify`). The sandbox can't run Docker, so repos that rely on it won't verify.

## Gotchas (these have bitten us)

- **Don't tell the user to add `background-agent` to `teams.json`/`enabledWorkflows`.** It's on by default. Agents have invented this requirement from the "must have the workflow enabled" line in the tool description.
- `not_found` for a repo is deliberately vague. It may mean the Concierge GitHub App isn't installed on the repo, or the user lacks write access. It doesn't necessarily mean the repo doesn't exist.
- `already_dispatched` means the same task + repos + PR head was dispatched within 30 minutes. That's not an error, so don't reword the task just to get around it.

## After dispatching: checking in

The call returns a Buildkite build URL, and the user gets a Slack DM when the run starts and another when it finishes. A run takes minutes. **Don't poll in a loop.** Surface the URL and move on unless the user asks you to wait.

The MCP has **no status, list, cancel, or follow-up tool** (yet). To check in:

- **Build state, logs, and artifacts** use the `buildkite` skill. The pipeline is `agent-workflows`, and the build number is the last path segment of the URL:
  `bk build view <n> -p agent-workflows --json | jq '{state, jobs: [.jobs[] | {name, state, id}]}'`
- **Outcome:** read the finish DM (`slack-messaging` skill) or the PR it opened (`gh pr view`).
- **Change course:** the MCP can't message a running run. Wait for it to finish, then dispatch a new task against `{ repo, pr_number }`. Cancelling only works from a Slack-triggered run's thread, so for an MCP run, tell the user.

## Upstream it

When you hit a gap, add a short note to your final reply, something like: *"Upstream candidate: the tool description should say X"* or *"missing tool: Y"*. Don't silently work around it. Useful targets:

- **Tool description:** `apps/frontdoor/src/actions/background-agent-tool.ts` in `cultureamp/agent-workflows`. Candidates: the `enabledWorkflows` wording above, the `not_found` meaning, and how to check progress (pipeline slug and `bk`).
- **Missing tools** worth asking for: `get_background_agent_status(build)`, `list_my_background_agents`, `cancel_background_agent` (the Slack thin agent already has one), and a way to send follow-up context to a running run.
- **How:** post feedback in `#help_devex`, or dispatch a background agent on `cultureamp/agent-workflows` to make the change. That's a supported use, and the tool description says so. Confirm with the user first.

When upstream fixes land, delete the matching lines here. The goal is for this skill to shrink to nothing.
