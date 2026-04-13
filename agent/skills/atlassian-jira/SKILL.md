---
name: atlassian-jira
description: Search, create, and update Jira issues via mcporter CLI. Use when user mentions Jira, issues, tickets, bugs, stories, or tasks.
---

# Jira via mcporter

Default cloudId: `cultureamp.atlassian.net`

## Quick reference

```bash
# Search issues with JQL (use key=value syntax for arguments)
mcporter call atlassian.searchJiraIssuesUsingJql \
  cloudId=cultureamp.atlassian.net \
  jql='project = PROJ AND status = "In Progress"'

# Get issue details
mcporter call atlassian.getJiraIssue \
  cloudId=cultureamp.atlassian.net \
  issueIdOrKey=PROJ-123

# Create issue
mcporter call atlassian.createJiraIssue \
  cloudId=cultureamp.atlassian.net \
  projectKey=PROJ \
  issueTypeName=Task \
  summary="Issue title" \
  description="Description here"

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
