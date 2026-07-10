---
name: atlassian
description: Query and manage Jira and Confluence via the mcporter atlassian MCP. Use when the user mentions Jira (epics, issues, tickets, bugs, stories, tasks, sprints) or Confluence (wiki, pages, docs, spaces).
only-on-hosts: ["jrose-04LCLG"]
---

# Atlassian (Jira + Confluence) via mcporter

All access is through the `atlassian` MCP server, called with `mcporter call atlassian.<tool>`.

- `cloudId` is required on every call. Default: `cultureamp.atlassian.net`.
- Arguments are `key=value`. JSON object/array values are quoted, e.g. `fields='{"summary":"New title"}'`.
- Body content defaults to Markdown (`contentFormat=markdown`).
- For less common operations see `references/jira.md` and `references/confluence.md`.

## Keeping output readable

These tools return large JSON blobs — always trim them:

- **Server-side:** on Jira reads pass `fields=[...]` and `maxResults`/`limit` to shrink the payload (~5× smaller) before it reaches you.
- **Client-side:** pipe through `jq` — TSV tables for lists, a compact render for single items. Recipes are shown inline below.
- Don't use mcporter's `--output` flag; the content is JSON regardless, so it doesn't help (and `raw` is bigger).
- For large page/description bodies on create/update, read them from a file: `body=@page.md`.

## Jira — common use cases

```bash
# View an issue (trim fields, render key + status + summary + description)
mcporter call atlassian.getJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 responseContentFormat=markdown \
  fields='["summary","status","assignee","issuetype","description"]' \
  | jq -r '"\(.key) [\(.fields.status.name)] \(.fields.summary)\n\n\(.fields.description)"'

# Search with JQL (trim fields + cap rows, render a compact table)
mcporter call atlassian.searchJiraIssuesUsingJql \
  cloudId=cultureamp.atlassian.net \
  jql='project = FEF AND status = "In Progress"' \
  fields='["summary","status","assignee"]' maxResults=20 \
  | jq -r '.issues[] | [.key, .fields.status.name, (.fields.assignee.displayName // "-"), .fields.summary] | @tsv'
mcporter call atlassian.searchJiraIssuesUsingJql \
  cloudId=cultureamp.atlassian.net jql='parent = FEF-1234' \
  fields='["summary","status"]' \
  | jq -r '.issues[] | [.key, .fields.status.name, .fields.summary] | @tsv'   # epic children

# Create an issue (echo just the new key)
mcporter call atlassian.createJiraIssue \
  cloudId=cultureamp.atlassian.net \
  projectKey=FEF issueTypeName=Task \
  summary="Title" description="Body in markdown" | jq -r '.key'

# Edit fields (fields is a JSON object; pass null to clear)
mcporter call atlassian.editJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 \
  fields='{"summary":"New title"}' | jq -r '.key'

# Add a comment
mcporter call atlassian.addCommentToJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 \
  commentBody="Fixed by upgrading dependency" | jq -r '.id'

# Log work
mcporter call atlassian.addWorklogToJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 timeSpent="15m" | jq -r '.timeSpent'

# Transition status (get the id first, then apply it)
mcporter call atlassian.getTransitionsForJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 \
  | jq -r '.transitions[] | [.id, .name] | @tsv'
mcporter call atlassian.transitionJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 transition='{"id":"31"}' | jq '.success'
```

Assigning, components, links, wiki markup, and the support-ticket workflow → `references/jira.md`.

## Confluence — common use cases

```bash
# Search with CQL (cap rows, render id + title)
mcporter call atlassian.searchConfluenceUsingCql \
  cloudId=cultureamp.atlassian.net \
  cql='title ~ "meeting" AND type = page' limit=20 \
  | jq -r '.results[]? | [.content.id, .title] | @tsv'

# Get a page (body is a plain string in markdown mode)
mcporter call atlassian.getConfluencePage \
  cloudId=cultureamp.atlassian.net pageId=123456 contentFormat=markdown \
  | jq -r '.title, "", .body'

# Create a page (large bodies: body=@page.md)
mcporter call atlassian.createConfluencePage \
  cloudId=cultureamp.atlassian.net spaceId=12345 \
  title="Page Title" body="Content in markdown" contentFormat=markdown | jq -r '.id'

# Update a page
mcporter call atlassian.updateConfluencePage \
  cloudId=cultureamp.atlassian.net pageId=123456 \
  title="Updated Title" body="New content" contentFormat=markdown | jq -r '.id'
```

Spaces, comments, page trees, and CQL patterns → `references/confluence.md`.

## Discovering tools & parameters

```bash
mcporter atlassian list                    # all tools
mcporter atlassian list | grep -i jira      # filter
mcporter atlassian list --all-parameters    # full parameters
```
