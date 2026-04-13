---
name: atlassian-confluence
description: Search, read, and create Confluence pages via mcporter CLI. Use when user mentions Confluence, wiki, pages, docs, or documentation.
---

# Confluence via mcporter

Default cloudId: `cultureamp.atlassian.net`

## Quick reference

```bash
# Search with CQL (use key=value syntax for arguments)
mcporter call atlassian.searchConfluenceUsingCql \
  cloudId=cultureamp.atlassian.net \
  cql='title ~ "meeting" AND type = page'

# Get page content
mcporter call atlassian.getConfluencePage \
  cloudId=cultureamp.atlassian.net \
  pageId=123456 \
  contentFormat=markdown

# List spaces
mcporter call atlassian.getConfluenceSpaces \
  cloudId=cultureamp.atlassian.net

# Get pages in a space
mcporter call atlassian.getPagesInConfluenceSpace \
  cloudId=cultureamp.atlassian.net \
  spaceId=12345 \
  contentFormat=markdown

# Create page
mcporter call atlassian.createConfluencePage \
  cloudId=cultureamp.atlassian.net \
  spaceId=12345 \
  title="Page Title" \
  body="Page content in markdown" \
  contentFormat=markdown

# Update page
mcporter call atlassian.updateConfluencePage \
  cloudId=cultureamp.atlassian.net \
  pageId=123456 \
  title="Updated Title" \
  body="New content" \
  contentFormat=markdown
```

## Common CQL patterns

```
title ~ "keyword"
space = SPACEKEY
type = page
type = blogpost
creator = currentUser()
lastModified >= now("-7d")
```

## Get more info

```bash
# List all Confluence tools
mcporter atlassian list | grep -i confluence

# See full parameters for any tool
mcporter atlassian list --all-parameters
```
