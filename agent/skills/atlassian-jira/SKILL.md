---
name: atlassian-jira
description: Search, create, and update Jira issues via mcporter CLI. Use when user mentions Jira, issues, tickets, bugs, stories, or tasks.
---

# Jira via mcporter

Default cloudId: `cultureamp.atlassian.net`

## Reducing response size

Jira responses include hundreds of custom fields. Use the `fields` parameter for get/search operations:

```bash
# Default fields to request (covers most use cases)
fields='["key","summary","status","labels","parent","description","assignee","issuetype"]'
```

For create/edit operations (which don't support `fields`), pipe through jq:
```bash
... | jq '{key, summary: .fields.summary}'
```

## Quick reference

```bash
# Search issues with JQL (use key=value syntax for arguments)
mcporter call atlassian.searchJiraIssuesUsingJql \
  cloudId=cultureamp.atlassian.net \
  jql='project = PROJ AND status = "In Progress"' \
  fields='["key","summary","status","labels","parent","assignee","issuetype"]'

# Get issue details
mcporter call atlassian.getJiraIssue \
  cloudId=cultureamp.atlassian.net \
  issueIdOrKey=PROJ-123 \
  fields='["key","summary","status","labels","parent","description","assignee","issuetype"]'

# Create issue
mcporter call atlassian.createJiraIssue \
  cloudId=cultureamp.atlassian.net \
  projectKey=PROJ \
  issueTypeName=Task \
  summary="Issue title" \
  description="Description here" | jq '{key, summary: .fields.summary}'

# Edit issue
mcporter call atlassian.editJiraIssue \
  cloudId=cultureamp.atlassian.net \
  issueIdOrKey=PROJ-123 \
  fields='{"description": "New description"}' | jq '{key, summary: .fields.summary}'

# Add comment
mcporter call atlassian.addCommentToJiraIssue \
  cloudId=cultureamp.atlassian.net \
  issueIdOrKey=PROJ-123 \
  commentBody="Comment text"

# Transition issue (change status)
mcporter call atlassian.getTransitionsForJiraIssue \
  cloudId=cultureamp.atlassian.net \
  issueIdOrKey=PROJ-123
# Then use transitionJiraIssue with the transition id
```

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
# List all Jira tools
mcporter atlassian list | grep -i jira

# See full parameters for any tool
mcporter atlassian list --all-parameters
```
