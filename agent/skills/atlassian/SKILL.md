---
name: atlassian
description: Query and manage Jira and Confluence via the mcporter atlassian MCP. Use when the user mentions Jira (epics, issues, tickets, bugs, stories, tasks, sprints) or Confluence (wiki, pages, docs, spaces).
---

# Atlassian (Jira + Confluence) via mcporter

All access is through the `atlassian` MCP server, called with `mcporter call atlassian.<tool>`.

- `cloudId` is required on every call. Default: `cultureamp.atlassian.net`.
- Arguments are `key=value`. JSON object/array values are quoted, e.g. `fields='{"summary":"New title"}'`.
- Body content defaults to Markdown (`contentFormat=markdown`).
- For less common operations see `references/jira.md` and `references/confluence.md`.

## Jira — common use cases

```bash
# View an issue
mcporter call atlassian.getJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 responseContentFormat=markdown

# Search with JQL
mcporter call atlassian.searchJiraIssuesUsingJql \
  cloudId=cultureamp.atlassian.net \
  jql='project = FEF AND status = "In Progress"'
mcporter call atlassian.searchJiraIssuesUsingJql \
  cloudId=cultureamp.atlassian.net jql='parent = FEF-1234'   # epic children

# Create an issue
mcporter call atlassian.createJiraIssue \
  cloudId=cultureamp.atlassian.net \
  projectKey=FEF issueTypeName=Task \
  summary="Title" description="Body in markdown"

# Edit fields (fields is a JSON object; pass null to clear)
mcporter call atlassian.editJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 \
  fields='{"summary":"New title"}'

# Add a comment
mcporter call atlassian.addCommentToJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 \
  commentBody="Fixed by upgrading dependency"

# Log work
mcporter call atlassian.addWorklogToJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 timeSpent="15m"

# Transition status (get the id first, then apply it)
mcporter call atlassian.getTransitionsForJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611
mcporter call atlassian.transitionJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 transition='{"id":"31"}'
```

Assigning, components, links, wiki markup, and the support-ticket workflow → `references/jira.md`.

## Confluence — common use cases

```bash
# Search with CQL
mcporter call atlassian.searchConfluenceUsingCql \
  cloudId=cultureamp.atlassian.net \
  cql='title ~ "meeting" AND type = page'

# Get a page
mcporter call atlassian.getConfluencePage \
  cloudId=cultureamp.atlassian.net pageId=123456 contentFormat=markdown

# Create a page
mcporter call atlassian.createConfluencePage \
  cloudId=cultureamp.atlassian.net spaceId=12345 \
  title="Page Title" body="Content in markdown" contentFormat=markdown

# Update a page
mcporter call atlassian.updateConfluencePage \
  cloudId=cultureamp.atlassian.net pageId=123456 \
  title="Updated Title" body="New content" contentFormat=markdown
```

Spaces, comments, page trees, and CQL patterns → `references/confluence.md`.

## Discovering tools & parameters

```bash
mcporter atlassian list                    # all tools
mcporter atlassian list | grep -i jira      # filter
mcporter atlassian list --all-parameters    # full parameters
```
