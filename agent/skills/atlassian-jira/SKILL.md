---
name: atlassian-jira
description: Search, create, and update Jira issues via jira CLI. Use when user mentions Jira, issues, tickets, bugs, stories, or tasks.
---

# Jira CLI (jira-cli)

Config file: `~/.config/.jira/.config.yml`

## Quick reference

```bash
# Search issues with JQL
jira issue list -q'project = PROJ AND status = "In Progress"' --plain

# Search issues by status/type/assignee (uses configured project)
jira issue list -s"In Progress" -tBug -a"user@example.com" --plain

# Get raw JSON output for programmatic use
jira issue list -q'assignee = currentUser()' --raw

# View issue details
jira issue view PROJ-123 --plain

# Get raw JSON of an issue
jira issue view PROJ-123 --raw

# Create issue
jira issue create -pPROJ -tTask -s"Issue title" -b"Description here" --no-input

# Edit issue
jira issue edit PROJ-123 -s"New summary" -b"New description" --no-input

# Add comment
jira issue comment add PROJ-123 "Comment text"

# Transition issue (change status)
jira issue move PROJ-123 "In Progress"
jira issue move PROJ-123 Done
```

## Common flags

| Flag | Description |
|------|-------------|
| `-p, --project` | Jira project key (overrides config default) |
| `-t, --type` | Issue type (Bug, Task, Story, Epic, etc.) |
| `-s, --summary` | Issue title/summary |
| `-b, --body` | Issue description |
| `-a, --assignee` | Assignee (email or display name) |
| `-l, --label` | Label (can repeat for multiple) |
| `-y, --priority` | Priority level |
| `-q, --jql` | Raw JQL query |
| `--plain` | Plain text output (no interactive mode) |
| `--raw` | JSON output |
| `--no-input` | Disable interactive prompts |

## Common JQL patterns

```
assignee = currentUser()
project = PROJ AND status != Done
created >= -7d
labels in (bug, critical)
text ~ "search term"
```

## Get more info

```bash
# See all commands
jira --help

# See subcommands for issues
jira issue --help

# See options for any command
jira issue list --help
jira issue create --help
jira issue edit --help
jira issue move --help
```

## FEF Project Components

The CLI cannot list available components. Use `-C` flag with these names:

| Component | ID | Description |
|-----------|-----|-------------|
| AI/Agents | 16694 | AI and Coding Agent tools |
| Back end tooling | 16157 | |
| Critical User Journey Tests | 16144 | CUJ test tools and infra |
| Dependency Updates and CVEs | 16628 | Renovate Bot or Snyk updates |
| DX Insights | 16321 | DX Insights (including user provisioning) |
| Front End App Deploy | 16118 | frontend-app-deploy tool |
| Front End Deploys (Legacy) | 16117 | Old `frontend-build` deploy tool |
| Front End Ops infrastructure | 16119 | CDN, BIFS, roles, Web Gateway |
| Front end tooling | 16121 | next-config, frontend-build, jest, linting |
| InnerSource and Package Publishing | 16123 | Package registry and changesets |
| LDEs - Local Development Environments | 16235 | Devbox, port registry, etc |
| New repo setup | 16125 | Deploying new apps for the first time |
| Next.js Lambda | 16120 | `@cultureamp/next-lambda` package |
| Other | 16145 | Doesn't fit elsewhere |
| Out of scope | 16124 | Should not have come to our team |
| Renovate Bot | 16122 | Renovate and Renovate Presets |
| Snyk Updates | 16275 | |
| Template tooling | 16156 | |

Example: `jira issue edit FEF-123 -C "AI/Agents" -C "LDEs - Local Development Environments" --no-input`
