---
name: slack-messaging
description: Search, read, and send Slack messages. Use for "find when I said X on slack", "any conversation about X", "message <person/team> about X", "send to #channel" (a leading # usually means a Slack channel), "respond to this thread <link>", "what's waiting on me", or getting context from a Slack link.
only-on-hosts: ["jrose-04LCLG"]
---

# Slack

Slack is the `mcp__slack` MCP server, called from `codemode`. Its tool descriptions are good (search modifiers, `keywords`/`filters` split, examples): `describeTool("mcp__slack__slack_<tool>")`. Results are a JSON string wrapping one markdown blob, so use the helpers in [lib.js](lib.js) — load it first in every script:

```js
const slack = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/slack-messaging/lib.js" }))(tools);
```

| You want to… | Script |
|---|---|
| What's **waiting on me** | `return slack.triage()` (`{ hours: 72 }` after a weekend) — ❗ tagged/DM unanswered · ⏳ replies after mine · · FYI. Judge the list; don't just relay it. |
| Find when **I** said X | `return slack.show(await slack.search({ query: "from:me X", sort: "timestamp" }))` |
| Conversation about X / by someone | `slack.search({ query: "from:<@U…> X", after: slack.ago(30) }, pages)`; several variants via `Promise.all` |
| Context from a **link** | `return slack.thread(url)` (handles reply links, inlines linked messages; `{ format: "detailed" }` for per-reply `Message TS`) |
| Any other tool | `await slack.call("read_channel", { channel_id, limit: 20, response_format: "concise" })` → parsed JSON; throws on `isError` |
| Send / reply / react | see [Sending](#sending) |

`search()` returns records `{ ch, cid, from, uid, time, ts, link, thread_ts, text }` — filter/aggregate in the script and return only compact lines (`slack.show`). Delegate broad sweeps to a subagent that returns the answer + permalinks.

## Gotchas

- People in queries: `from:<@U…>` or `from:me` — display names (`from:shay`) silently return nothing. IDs → [directory](references/directory.md) or `call("search_users", { query: "Name" })`.
- `read_thread` needs the **parent** ts (`slack.thread` does this). "No thread messsages" = you passed a reply ts, *or* the post has no replies.
- `with:me` misses some @mentions; `triage()` also searches `<@me>`.
- `response_format: "concise"` drops `Message_ts`, permalinks and channel IDs — don't use it with `search()`.
- `search_channels` is public-only unless `channel_types: "public_channel,private_channel"`; or `call("list_user_channels", { name_prefix: "team_" })`.
- Text `(no text — file/attachment)` = file-only message; search with `content_types: "files"` for `File ID`, then `read_file`.

## Sending

**Draft first** (`send_message_draft`, shows in my Slack drafts) unless I gave/approved the exact text — if you reworded it, draft. DM = user ID as `channel_id`. Must be a channel member (`not_in_channel`); one draft per channel (`draft_already_exists`). `send_message` returns the permalink — surface it. Markdown, mentions, emoji → [formatting](references/formatting.md).

```js
await slack.call("send_message_draft", { channel_id: "C0B97KTKH25", message: `Multi-line *markdown* :done_check:` });
const { channel_id, thread_ts } = slack.parseLink(url);           // reply in thread (reply_broadcast: true to echo)
await slack.call("send_message", { channel_id, thread_ts, message: "On it" });
await slack.call("add_reaction", { channel_id, message_ts: slack.parseLink(url).ts, emoji: "eyes" });
// schedule_message: post_at = unix seconds NUMBER, ≥2 min ahead
```

## Common IDs

Me `U010S548P0F` · Shay `U09UM9ZC6NN` · Felicity `U0ADQP9DSNS` · Elliott `UFMU99PCG` · #team_hotel `C0B97KTKH25` · #wol_devex `C02NUQ65U2C` · #team_agentic_engineering `C0BAJEK3HH8`. More → [directory](references/directory.md).
