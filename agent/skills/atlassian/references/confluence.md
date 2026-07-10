# Confluence reference (less common operations)

All calls go through `mcporter call atlassian.<tool>` with `cloudId=cultureamp.atlassian.net`.
Common operations (search, get, create, update) live in the main `SKILL.md`.

## Spaces

```bash
# List spaces
mcporter call atlassian.getConfluenceSpaces cloudId=cultureamp.atlassian.net \
  | jq -r '.results[] | [.key, .id, .name] | @tsv'

# Pages in a space
mcporter call atlassian.getPagesInConfluenceSpace \
  cloudId=cultureamp.atlassian.net spaceId=12345 \
  | jq -r '.results[]? | [.id, .title] | @tsv'
```

## Page trees

```bash
# Direct child pages of a page
mcporter call atlassian.getConfluencePageDescendants \
  cloudId=cultureamp.atlassian.net pageId=123456 \
  | jq -r '.results[]? | [.id, .title] | @tsv'
```

## Comments

```bash
# Read footer comments
mcporter call atlassian.getConfluencePageFooterComments \
  cloudId=cultureamp.atlassian.net pageId=123456 \
  | jq -r '.results[]? | {id, body}'

# Read inline comments
mcporter call atlassian.getConfluencePageInlineComments \
  cloudId=cultureamp.atlassian.net pageId=123456 \
  | jq -r '.results[]? | {id, body}'

# Read replies to a comment
mcporter call atlassian.getConfluenceCommentChildren \
  cloudId=cultureamp.atlassian.net commentId=789012

# Create a footer comment
mcporter call atlassian.createConfluenceFooterComment \
  cloudId=cultureamp.atlassian.net pageId=123456 body="Thanks, updated." contentFormat=markdown | jq -r '.id'

# Create an inline comment anchored to specific text
mcporter call atlassian.createConfluenceInlineComment \
  cloudId=cultureamp.atlassian.net pageId=123456 \
  body="Is this still accurate?" contentFormat=markdown
```

## CQL patterns

```
title ~ "keyword"
space = SPACEKEY
type = page
type = blogpost
creator = currentUser()
lastModified >= now("-7d")
title ~ "keyword" AND space = SPACEKEY AND type = page
```

## Cross-product search

```bash
# Rovo search across both Jira and Confluence
mcporter call atlassian.search cloudId=cultureamp.atlassian.net query="deploy rollback" \
  | jq -r '.results[]? | [.id, .title] | @tsv'

# Fetch a Jira issue or Confluence page by URL/ID
mcporter call atlassian.fetch cloudId=cultureamp.atlassian.net id="https://cultureamp.atlassian.net/wiki/..."
```
