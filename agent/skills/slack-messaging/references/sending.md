# Sending

Snippets assume the `slack()` helper from [SKILL.md](../SKILL.md). `message` = standard markdown (**no Block Kit**) + `channel_id` (DM = `user_id` as `channel_id`). **Draft first** unless the user approved the exact text. `send_message` returns a message link — surface it; `send_message_draft` returns a `channel_link` to the channel holding the draft.

```js
return await slack("send_message_draft", { channel_id: "C…", message: "Draft text" });   // recommended
return await slack("send_message", { channel_id: "C…", message: "Hello :wave:" });       // send now
```

Optional `send_message` args: `thread_ts`, `reply_broadcast: true` (also post to channel), `unfurl_app_links: true` (GitHub/Jira previews), `draft_id` (delete that draft after sending).

## Threads

`thread_ts` = parent message ts (works on drafts too). Get ids from a link → [`parseLink`](searching.md#permalinks).

```js
const { channel_id, thread_ts } = parseLink(url);
return await slack("send_message", { channel_id, thread_ts, message: "On it :done_check:" });
```

## Schedule / react

```js
// post_at = unix seconds as a NUMBER, ≥2 min future, ≤120 days; not editable via API after
await slack("schedule_message", { channel_id: "C…", post_at: Math.floor(Date.now() / 1000) + 3600, message: "Standup" });
// emoji without colons; message_ts = that message's own ts (string)
await slack("add_reaction", { channel_id: "C…", message_ts: "1751932800.001900", emoji: "eyes" });
```

## Worked example

Template literals keep multi-line markdown readable (escape literal backticks as `` \` ``):

```js
return await slack("send_message", { channel_id: "C02NUQ65U2C", message: `:envelope: Example

| Repo | PR |
|------|----|
| my-service | [#1](https://github.com/cultureamp/my-service/pull/1) |

> :eyes: <@U09UM9ZC6NN> could you take a look?` });
```

## Gotchas

- Must be a channel **member** or you get `not_in_channel` — ask the user to join.
- `send_message_draft`: one draft per channel — `draft_already_exists` if there's one already.
- Failures come back as `isError` (the helper throws `send_message: execution_failed: …`), not as a rejected call — check before reporting success.
- No Slack Connect (externally shared) channels. Max 5000 chars/element.

Markdown, emoji, mentions → [formatting.md](formatting.md).
