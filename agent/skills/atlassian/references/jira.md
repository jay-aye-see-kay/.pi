# Jira reference (less common operations)

All calls go through `mcporter call atlassian.<tool>` with `cloudId=cultureamp.atlassian.net`.
Common operations (view, search, create, edit, comment, worklog, transition) live in the main `SKILL.md`.

## Assigning issues

`editJiraIssue` and `createJiraIssue` take an account ID, not an email. Look it up first:

```bash
mcporter call atlassian.lookupJiraAccountId \
  cloudId=cultureamp.atlassian.net searchString="Jack Rose"

# Then assign via editJiraIssue
mcporter call atlassian.editJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 \
  fields='{"assignee":{"id":"ACCOUNT_ID"}}'

# Or at creation time
mcporter call atlassian.createJiraIssue \
  cloudId=cultureamp.atlassian.net projectKey=FEF issueTypeName=Task \
  summary="Title" assignee_account_id=ACCOUNT_ID
```

## Components, labels, priority & other fields

`editJiraIssue.fields` (and `createJiraIssue.additional_fields`) take any Jira field as JSON:

```bash
# Set components
mcporter call atlassian.editJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 \
  fields='{"components":[{"name":"LDEs - Local Development Environments"}]}'

# Clear a field with null (e.g. resolution on a reopened issue)
mcporter call atlassian.editJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 \
  fields='{"resolution":null}'

# On create, non-standard fields go in additional_fields
mcporter call atlassian.createJiraIssue \
  cloudId=cultureamp.atlassian.net projectKey=FEF issueTypeName=Task \
  summary="Title" \
  additional_fields='{"labels":["bug"],"priority":{"name":"High"},"components":[{"name":"Other"}]}'

# Add to an epic / set parent
mcporter call atlassian.editJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 \
  fields='{"parent":{"key":"FEF-1234"}}'
```

## Issue links

```bash
mcporter call atlassian.getIssueLinkTypes cloudId=cultureamp.atlassian.net

# Directional: inwardIssue is the blocker, outwardIssue is the blocked one
# "FEF-1 blocks FEF-2" → inwardIssue=FEF-1, outwardIssue=FEF-2
mcporter call atlassian.createIssueLink \
  cloudId=cultureamp.atlassian.net \
  type=Blocks inwardIssue=FEF-1 outwardIssue=FEF-2
```

## Fetching more / custom fields

```bash
# All fields including custom fields
mcporter call atlassian.getJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 fields='["*all"]'

# Include comments in a search/get
mcporter call atlassian.getJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 fields='["comment"]'

# Limit search results / paginate
mcporter call atlassian.searchJiraIssuesUsingJql \
  cloudId=cultureamp.atlassian.net jql='project = FEF' maxResults=20
# The response includes nextPageToken; pass it back as nextPageToken=... for the next page.
```

## Useful JQL patterns

```
project = FEF AND status = "In Progress"
parent = FEF-1234                                            # epic children
project = FEF AND type = Support AND status NOT IN (Done, "Won't Do")
assignee = currentUser() AND resolution = Unresolved
project = FEF ORDER BY updated DESC
```

## Workflow: complete a support ticket

For tickets like FEF-2611, before marking done:

```bash
# 1. Assign (look up account id, then set assignee)
mcporter call atlassian.lookupJiraAccountId \
  cloudId=cultureamp.atlassian.net searchString="jack.rose@cultureamp.com"
mcporter call atlassian.editJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 \
  fields='{"assignee":{"id":"ACCOUNT_ID"},"components":[{"name":"LDEs - Local Development Environments"}]}'

# 2. Log time (multiples of 15m)
mcporter call atlassian.addWorklogToJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 timeSpent="15m"

# 3. Optional context
mcporter call atlassian.addCommentToJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 commentBody="Fixed by upgrading dependency"

# 4. Transition to Done
mcporter call atlassian.getTransitionsForJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611
mcporter call atlassian.transitionJiraIssue \
  cloudId=cultureamp.atlassian.net issueIdOrKey=FEF-2611 transition='{"id":"DONE_ID"}'
```

### FEF project components

Use exact names in `{"components":[{"name":"..."}]}`:

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
