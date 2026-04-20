---
name: atlassian-jira
description: Query and manage Jira via CLI. Use when user mentions Jira, epics, issues, tickets, bugs, stories, or tasks.
---

# Jira CLI (jira-cli)

- `jira` is github.com/ankitpokhrel/jira-cli
- jira access via this CLI _only_, confirm with user before trying the API or other methods

## Quick reference

```bash
# View issue
jira issue view KEY --plain

# Search issues
jira issue list -q'project = FEF AND status = "In Progress"' --plain
jira issue list -q'parent = EPIC-KEY' --plain   # Epic children
jira issue list --paginate 20 --plain           # Limit results (not --limit)

# Create issue
jira issue create -pFEF -tTask -s"Title" -b"Description" --no-input

# Edit issue
jira issue edit KEY -s"New title" -b"New description" --no-input
jira issue edit KEY --parent EPIC-KEY --no-input   # Add to epic

# Assign (requires email)
jira issue assign KEY "user@email.com"

# Look up team emails (when user says "assign to <name>")
$SKILL_DIR/bin/jira-team-emails          # Lists emails of recent FEF assignees
$SKILL_DIR/bin/jira-team-emails PROJ     # For other projects

# Components
jira issue edit KEY -C "Component Name" --no-input
jira issue edit KEY -C "One" -C "Two" --no-input   # Multiple
jira issue edit KEY -C "" --no-input               # Clear all

# Status transitions
jira issue move KEY "In Progress"
jira issue move KEY "Done"

# Time tracking
jira issue worklog add KEY "25m" --no-input
jira issue worklog add KEY "1h 30m" --no-input

# Comments
jira issue comment add KEY "Comment text"

# Links (direction: FIRST issue acts on SECOND)
jira issue link BLOCKER-1 BLOCKED-2 "Blocks"    # BLOCKER-1 blocks BLOCKED-2
jira issue unlink KEY1 KEY2
```

## Jira wiki markup (for descriptions)

```
||Column A||Column B||Column C||
|Row 1 A|Row 1 B|Row 1 C|
|Row 2 A|Row 2 B|Row 2 C|
```

## Get help

```bash
jira --help
jira issue --help
jira issue <command> --help
```

## Workflow: Complete a support ticket

For tickets like FEF-2611, ensure before marking done:

```bash
# 1. Assign (default: current user)
jira issue assign KEY "jack.rose@cultureamp.com"

# 2. Set component
jira issue edit KEY -C "LDEs - Local Development Environments" --no-input

# 3. Log time (multiples of 15m)
jira issue worklog add KEY "15m" --no-input

# 4. Optional: add context
jira issue comment add KEY "Fixed by upgrading dependency"

# 5. Mark done
jira issue move KEY "Done"
```

### FEF project components

Use `-C` flag with these exact names:

| Component | Description |
|-----------|-------------|
| AI/Agents | AI and Coding Agent tools |
| Back end tooling | |
| Critical User Journey Tests | CUJ test tools and infra |
| Dependency Updates and CVEs | Renovate Bot or Snyk updates |
| DX Insights | DX Insights (including user provisioning) |
| Front End App Deploy | frontend-app-deploy tool |
| Front End Deploys (Legacy) | Old frontend-build deploy tool |
| Front End Ops infrastructure | CDN, BIFS, roles, Web Gateway |
| Front end tooling | next-config, frontend-build, jest, linting |
| InnerSource and Package Publishing | Package registry and changesets |
| LDEs - Local Development Environments | Devbox, port registry, etc |
| New repo setup | Deploying new apps for the first time |
| Next.js Lambda | @cultureamp/next-lambda package |
| Other | Doesn't fit elsewhere |
| Out of scope | Should not have come to our team |
| Renovate Bot | Renovate and Renovate Presets |
| Snyk Updates | |
| Template tooling | |

