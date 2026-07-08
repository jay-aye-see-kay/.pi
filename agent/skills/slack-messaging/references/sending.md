# Sending

`message` = standard markdown (**no Block Kit**) + `channel_id` (DM = `user_id` as `channel_id`). **Draft first** unless the user approved the exact text. `send_message` returns a permalink — surface it.

```bash
mcporter call slack.slack_send_message_draft channel_id=C… message="Draft text"   # recommended
mcporter call slack.slack_send_message channel_id=C… message="Hello :wave:"        # send now
```

## Threads

`thread_ts` = parent message ts; `reply_broadcast=true` also echoes to channel. Get ids from a link → [searching.md#permalinks](searching.md#permalinks).

```bash
mcporter call slack.slack_send_message channel_id=C… thread_ts=1751932800.001900 message="On it :done_check:"
```

## Schedule / react

```bash
# post_at = unix ts, ≥2 min future, ≤120 days; not editable via API after
mcporter call slack.slack_schedule_message channel_id=C… post_at=1783531964 message="Standup"
mcporter call slack.slack_add_reaction channel_id=C… message_ts=1751932800.001900 emoji=eyes
```

## Worked example

```bash
mcporter call slack.slack_send_message channel_id=C02NUQ65U2C message=":envelope: Example

| Repo | PR |
|------|----|
| my-service | [#1](https://github.com/cultureamp/my-service/pull/1) |

> :eyes: <@U09UM9ZC6NN> could you take a look?"
```

## Gotchas

- Must be a channel **member** or you get `not_in_channel` — ask the user to join.
- No Slack Connect (externally shared) channels. Max 5000 chars/element.

Markdown, emoji, mentions → [formatting.md](formatting.md).
