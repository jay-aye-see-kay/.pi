---
name: concierge-background-agent
description: Dispatch and follow up on Concierge (Pip) background agents via the `mcp__concierge` MCP — an autonomous coding agent that works on GitHub repos in a sandbox and opens PRs, comments, and Jira updates. Read this BEFORE every `run_background_agent` call. Use it when the user wants to hand off, delegate, parallelise, or "send to concierge/pip" a coding task, fan work out across repos, have a PR fixed/rebased/finished in the background, or check how a dispatched background agent or its Buildkite build is going.
only-on-hosts: ["jrose-04LCLG"]
---

# Concierge background agent

The `mcp__concierge` tool descriptions are the main docs (`describeNamespace("mcp__concierge")`, then `describeTool` on each). This skill only adds what they leave out.

- **Confirm first.** Concierge opens PRs and comments, and updates Jira as the user. Dispatch without asking only when the user asked for it outright. If you wrote the brief yourself, show it and get a yes.
- **For non-trivial work, plan here and implement there.** Explore and plan locally, or push a starting branch. Then dispatch with `{repo, branch}` or `{repo, pr_number}`.
- **No Docker in the sandbox.** Repos that need Docker to pass `devbox run verify` won't verify.
- **Ignore the "workflow enabled" line.** Don't tell the user to add `background-agent` to `teams.json` or `enabledWorkflows`. It's on by default.
- **`not_found` is vague.** It may mean the Concierge GitHub App isn't installed on the repo, or the user lacks write access. It doesn't necessarily mean the repo doesn't exist.
- **Uploading files:** codemode can't make HTTP requests. Whether `curl` in the bash sandbox can reach the upload URLs is untested. Use `bg_agent_upload_inline` unless you've confirmed the PUT works, because you can't switch a declared path to inline later.

## Checking in

`bg_agent_get_job` reports on the upload bundle, not the run. There's no tool for run status, listing runs, cancelling, or follow-ups. Give the user the Buildkite URL and move on. Don't poll in a loop.

- Build state, logs and artifacts: use the `buildkite` skill. The pipeline is `agent-workflows`, and the build number is the last path segment of the URL:
  `bk build view <n> -p agent-workflows --json | jq '{state, jobs: [.jobs[] | {name, state, id}]}'`
- Outcome: read the finish DM (`slack-messaging` skill) or the PR (`gh pr view`).
- Change course: wait for the run to finish, then dispatch again against `{repo, pr_number}`. MCP runs can't be cancelled from here, so tell the user.

## Gaps

If something trips you up that the tool descriptions should have covered, mention it briefly in your reply as an upstream candidate. The descriptions live in `cultureamp/agent-workflows`, `apps/frontdoor/src/actions/background-agent-tool.ts`. Delete lines here once upstream covers them.
