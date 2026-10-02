---
name: slack-messaging
description: Search, read, and send Slack messages. Use for "find when I said X on slack", "any conversation about X", "message <person/team> about X", "send to #channel" (a leading # usually means a Slack channel), "respond to this thread <link>", or getting context from a Slack link.
only-on-hosts: ["jrose-04LCLG"]
---

# Slack via codemode

The `slack` MCP server's tools are called from a `codemode` script: `await tools.mcp__slack__slack_<tool>({...})` (e.g. `tools.mcp__slack__slack_search_public_and_private`). Args are JSON-typed (`limit: 20`, `include_context: false`). Exact schema: `describeTool("mcp__slack__slack_<tool>")`.

Every call resolves to a `CallToolResult` whose `content[0].text` is a **JSON string** holding one markdown blob — `results` (search), `messages` (read_thread/read_channel), `result` (profile, list_user_channels), `members` — plus `pagination_info`. Errors resolve (don't throw) with `isError: true` and plain text `execution_failed: channel_not_found …`; missing required args throw. Paste this helper at the top of scripts:

```js
const slack = async (tool, args) => {
  const r = await tools[`mcp__slack__slack_${tool}`](args);
  const t = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${tool}: ${t}`);
  try { return JSON.parse(t); } catch { return t; }
};
const r = await slack("search_public_and_private", { query: "from:me rollback", limit: 10, include_context: false });
return r.results;
```

| You want to… | Move |
|---|---|
| Find when **I** said X | `slack("search_public_and_private", { query: "from:me X" })` |
| **What's waiting on me** today | [daily triage](references/searching.md#daily-triage) script |
| Any conversation about X | `slack("search_public_and_private", { query: "X" })` |
| Context from a Slack **link** | [`parseLink`](references/searching.md#permalinks) → `slack("read_thread", { channel_id, message_ts: thread_ts })` (the **parent** ts — a reply's ts silently returns "No thread messages") |
| Message a person/team | resolve ID → `send_message_draft` |
| Send to **#channel** (leading # = channel name) | resolve channel ID → `send_message_draft` |
| Reply to a thread **link** | `parseLink` → `send_message({ channel_id, thread_ts, message })` |
| Find a **channel ID** by name | `slack("search_channels", { query: "name", channel_types: "public_channel,private_channel", response_format: "concise" })` |

Details: [searching](references/searching.md) · [sending](references/sending.md) · [formatting](references/formatting.md) · [directory](references/directory.md).

## Token discipline (search is a hog)

- **Filter inside the script, return only what's needed** — the script sees the full result, the model only sees what you `return`. Use the [`hits()` parser](references/searching.md#parse-search-results) and return compact lines (time, channel, sender, trimmed text, permalink).
- Run independent searches in parallel: `await Promise.all([...])`.
- `include_context: false`, `limit: 20`; expand only real hits (`read_thread`).
- `response_format: "concise"` is fine for eyeballing keywords but drops `Message_ts`, permalinks and channel IDs — use the default detailed format whenever you need to act on a hit.
- Delegate broad sweeps to a subagent that returns only the answer + permalinks.

## Common IDs

Me (Jack): `U010S548P0F`. Ignore bot senders when triaging: Camper Portal Bot, Jira, Slackbot, Atlassian Home, agent-orchestrator (`U0B52APG03E`). Channels (private): #wol_devex `C02NUQ65U2C` · #team_hotel `C0B97KTKH25` · #team_agentic_engineering `C0BAJEK3HH8`. Shay `U09UM9ZC6NN` · Felicity `U0ADQP9DSNS` · Elliott `UFMU99PCG`. Others → [directory](references/directory.md).

Send: `slack("send_message_draft", { channel_id: "C…", message: "…" })` (DM = user_id as `channel_id`). **Draft first** unless the user approved the exact text. No Block Kit. All tools: `(await describeNamespace("mcp__slack")).tools`.
