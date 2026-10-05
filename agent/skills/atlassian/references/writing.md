# Writing to Jira / Confluence

Only write when asked. Confirm the exact change with the user first unless they already gave it. Afterwards, echo back the key or id and a link.

`atl.call(name, args)` runs primary tools directly. For any other write operation, pass the tier from `discover`: `atl.call(name, inputs, "Write")`, or `"Destructive"` for deletes and other irreversible changes. Use `atl.discover("…")` when unsure of an operation's name or inputs, and never guess. When a write is rejected, the error usually includes a `repairHint` and/or `allowedValues`; fix the input and retry once.

## Jira

```js
// Create. labels/priority/parent/assignee are top-level; other fields go in additional_fields (by name or customfield_* id)
const { key } = await atl.call("createJiraIssue", {
  projectKey: "FEF", issueType: "Task", summary: "Title", description: "Body in **markdown**",
  assignee: "5e7ad7871e65980c42a8c01e", parent: "FEF-1234", labels: ["bug"], priority: "High",
  additional_fields: { components: [{ name: "Other" }] },   // also e.g. { "Story Points": 3 }
  // assignToSprint: "active",
});

// Edit sets fields rather than appending to them: send the full list for labels/components. null clears a field (e.g. resolution on a reopened issue)
await atl.call("editJiraIssue", { issueIdOrKey: "FEF-2611", fields: { summary: "New title", assignee: { id: "ACCOUNT_ID" }, parent: { key: "FEF-1234" }, components: [{ name: "LDEs - Local Development Environments" }] } });

await atl.call("addOrEditJiraIssueComment", { issueIdOrKey: "FEF-2611", commentBody: "Fixed by upgrading dependency" });   // + commentId to edit
await atl.call("addOrEditJiraIssueWorklog", { issueIdOrKey: "FEF-2611", timeSpent: "15m" }, "Write");
await atl.transition("FEF-2611", "Done");   // matches the transition name or the target status; the error lists valid ones

// Links are directional: "FEF-1 blocks FEF-2" → inwardIssue FEF-1, outwardIssue FEF-2 (type names: listJiraIssueLinkTypes)
await atl.call("createJiraIssueLink", { linkType: "Blocks", inwardIssue: "FEF-1", outwardIssue: "FEF-2" }, "Write");
// Web link to a URL or Confluence page: createJiraIssueRemoteIssueLink { issueIdOrKey, url, title } (Write)
```

If an issue's description holds panels, mentions or media, read it with `responseContentFormat: "html"` and write it back with `contentFormat: "html"`. Markdown drops those nodes.

### New ticket for work already done (create → log → Done)

```js
const { key } = await atl.call("createJiraIssue", {
  projectKey: "FEF", issueType: "Task", summary: "Fix devbox PATH bug for murmur",   // "Support" type for support requests if asked
  assignee: "5e7ad7871e65980c42a8c01e",
  additional_fields: { components: [{ name: "LDEs - Local Development Environments" }] },
});
await atl.call("addOrEditJiraIssueWorklog", { issueIdOrKey: key, timeSpent: "30m" }, "Write");   // multiples of 15m
await atl.transition(key, "Done");
```

For an existing support ticket: one `editJiraIssue` (assignee + component) → worklog → optional comment → `transition(key, "Done")`.

### FEF components

Use these exact `name` values. A wrong name fails, or silently matches nothing in JQL.

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

The server asks for two steps before authoring:

- **Space instructions**: if `getConfluenceContent` metadata shows `hasSpaceInstructions` as true or unknown, read them once per space with `atl.call("getConfluenceSpace", { spaceIdOrKey: "DE" })` and follow its `spaceInstructions`.
- **Format guide**: for HTML bodies, read `atl.call("getContentFormatGuide", { toolName: "createConfluencePage" })` (or `"updateConfluencePage"`). Plain markdown is fine for simple text.

```js
// Create. Use the numeric spaceId (getConfluenceContent returns it; getConfluenceSpace resolves a key)
const p = await atl.call("createConfluenceContent", {
  contentType: "page", title: "Title",
  parent: { spaceId: "886931521", parentContentId: "2928902693" },   // or { parentContentUrl: "…" }
  body: { format: "markdown", value: "…" },   // draft: true / private: true are optional
});

// Update replaces the whole body and needs the snapshotToken from a full read.
// For pages with macros/panels, read as html and write html back (or use granular `edits`; dryRun: true previews)
const cur = await atl.call("getConfluenceContent", { content_id: "123", content_format: "html", detail: "full" });
await atl.call("updateConfluenceContent", { contentId: "123", snapshotToken: cur.snapshotToken, body: { format: "html", value: newHtml }, versionMessage: "why" });

// Footer comment (max 4096 chars). Reply with { parentCommentId, body }; inline comments need inlineSelection
await atl.call("createConfluenceComment", { contentId: "123", commentType: "footer", body: { format: "markdown", value: "Thanks, updated." } }, "Write");
```
