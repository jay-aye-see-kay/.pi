# Writing to Jira / Confluence

Only when asked. All via `atl.call(tool, args)` (cloudId filled in). Confirm the exact change with the user first unless they gave it. Echo back the key/id and a link.

## Jira

```js
// Create (non-standard fields → additional_fields; assignee needs an account id)
const { key } = await atl.call("createJiraIssue", {
  projectKey: "FEF", issueTypeName: "Task", summary: "Title", description: "Body in **markdown**",
  assignee_account_id: "5e7ad7871e65980c42a8c01e", parent: "FEF-1234",
  additional_fields: { labels: ["bug"], priority: { name: "High" }, components: [{ name: "Other" }] },
});

// Edit any field; null clears (e.g. resolution on a reopened issue that won't transition)
await atl.call("editJiraIssue", { issueIdOrKey: "FEF-2611", fields: { summary: "New title", assignee: { id: "ACCOUNT_ID" }, parent: { key: "FEF-1234" }, components: [{ name: "LDEs - Local Development Environments" }] } });

await atl.call("addCommentToJiraIssue", { issueIdOrKey: "FEF-2611", commentBody: "Fixed by upgrading dependency" });
await atl.call("addWorklogToJiraIssue", { issueIdOrKey: "FEF-2611", timeSpent: "15m" });
await atl.transition("FEF-2611", "Done");               // by transition name (FEF: = status); error lists valid ones

// Links are directional: "FEF-1 blocks FEF-2" → inwardIssue FEF-1, outwardIssue FEF-2 (types: getIssueLinkTypes)
await atl.call("createIssueLink", { type: "Blocks", inwardIssue: "FEF-1", outwardIssue: "FEF-2" });
```

### New ticket for work already done (create → log → Done)

```js
const { key } = await atl.call("createJiraIssue", {
  projectKey: "FEF", issueTypeName: "Task", summary: "Fix devbox PATH bug for murmur",   // "Support" type for support requests if asked
  assignee_account_id: "5e7ad7871e65980c42a8c01e",
  additional_fields: { components: [{ name: "LDEs - Local Development Environments" }] },
});
await atl.call("addWorklogToJiraIssue", { issueIdOrKey: key, timeSpent: "30m" });   // multiples of 15m
await atl.transition(key, "Done");
```

Existing support ticket: one `editJiraIssue` (assignee + component) → worklog → optional comment → `transition(key, "Done")`.

### FEF components

Exact `name` values (a wrong name fails or silently matches nothing in JQL):

| name | covers |
|---|---|
| `AI/Agents` | AI and coding agent tools |
| `Back end tooling` | |
| `Critical User Journey Tests` | CUJ test tools and infra |
| `Dependency Updates and CVEs` | Renovate/Snyk updates |
| `DX Insights` | incl. user provisioning |
| `Front End App Deploy` | frontend-app-deploy |
| `Front End Deploys (Legacy)` | old frontend-build deploy |
| `Front End Ops infrastructure` | CDN, BIFS, roles, Web Gateway |
| `Front end tooling` | next-config, frontend-build, jest, linting |
| `InnerSource and Package Publishing` | package registry, changesets |
| `LDEs - Local Development Environments` | devbox, port registry |
| `New repo setup` | first deploys of new apps |
| `Next.js Lambda` | @cultureamp/next-lambda |
| `Other` · `Out of scope` · `Renovate Bot` · `Snyk Updates` · `Template tooling` | |

## Confluence

```js
// spaceId is numeric (getConfluencePage returns it; getConfluenceSpaces lists them)
const p = await atl.call("createConfluencePage", { spaceId: "886931521", parentId: "2928902693", title: "Title", body: "markdown", contentFormat: "markdown" });
// Update replaces the whole body. For pages with macros/panels, read with contentFormat "html" and write html back.
await atl.call("updateConfluencePage", { pageId: "123", title: "Same or new title", body, contentFormat: "markdown", versionMessage: "why" });
await atl.call("createConfluenceFooterComment", { pageId: "123", body: "Thanks, updated.", contentFormat: "markdown" });
```
