---
name: slack-messaging
description: Send and format Slack messages via mcporter CLI - call syntax, formatting reference, and channel/team directory. Use when sending Slack messages.
---

# Slack via mcporter

## Tools

Call Slack tools with `mcporter call slack.<tool> key=value ...`. Write tools take a single `message` string (standard markdown) plus `channel_id`. There is **no Block Kit** — no `blocks`/`attachments`/unfurl params.

```bash
# Send now (also thread_ts, reply_broadcast)
mcporter call slack.slack_send_message channel_id=C02NUQ65U2C message="Hello :wave:"

# Save a draft for review
mcporter call slack.slack_send_message_draft channel_id=C02NUQ65U2C message="Draft text"

# Send later (post_at = unix ts, >=2 min future)
mcporter call slack.slack_schedule_message channel_id=C02NUQ65U2C message="Later" post_at=1783531964

# Find channel / user IDs
mcporter call slack.slack_search_channels query="team_hotel"
mcporter call slack.slack_search_users query="Shay"

# Read history / threads
mcporter call slack.slack_read_channel channel_id=C02NUQ65U2C
mcporter call slack.slack_read_thread channel_id=C02NUQ65U2C thread_ts=1700000000.000100
```

DM a user by passing their user_id as `channel_id`. My own user_id is `U010S548P0F`.

## Get more info

```bash
mcporter list slack                    # list all Slack tools + signatures
mcporter list slack --all-parameters   # full parameters for every tool
```

## Formatting that works

| Feature | Syntax |
|---|---|
| Headers | `# H1`  `## H2`  `### H3` (render as real headers) |
| Tables | GFM pipe tables — `\| a \| b \|` (escape literal pipes as `\|`) |
| Bold / italic / strike | `**bold**`  `_italic_`  `~~strike~~` |
| Inline code | `` `code` `` |
| Code block (syntax highlighted) | ` ```python ` … ` ``` ` — real highlighting + copy button |
| Diff colors | ` ```diff ` with `+ green` / `- red` lines (`!` does NOT color) |
| Blockquote | `> text` (single level only — `> >` flattens) |
| Task checkboxes | `- [ ] todo`  `- [x] done` |
| Lists | `- bullet` (nesting works) / `1. numbered` |
| Links | `[text](url)` |
| Emoji | `:tada:` or raw unicode |

## Slack tokens (only work in the raw string)

- User mention: `<@U010S548P0F>` (pings, resolves to name)
- Group/team ping: `<!subteam^S123>` (pings the whole usergroup)
- Channel link: `<#C123>`
- Broadcast: `<!here>` / `<!channel>`

## Custom emoji

- Common ones I use - include where they fit:
  - :working_out_loud:
  - :fyii:
  - :done_check:
  - :dogfood:
  - :til2:
  - :thinking_out_loud:
  - :sandbox:
  - :pr-merged:
  - :neat:
  - :learn-out-loud:
  - :fingerscrossed:
  - :awesomeface_shades:

### express frustration with a specific tech

Use when griping about the relevant tool:

`:old-man-yells-at-claude:` · `:old-man-yells-at-google:` · `:old_man_yells_at_netskope:` (underscores, not hyphens) · `:old-man-yells-at-datadog:` · `:old-man-yells-at-python:` · `:old-man-yells-at-miro:` · `:old-man-yells-at-aws:` · `:old-man-yells-at-buildkite:`

Verify any other custom emoji exists first with `mcporter call slack.slack_search_emojis query="name"` (exact-name match only — fuzzy hits ≠ the emoji exists).

## Not available

Inline images (`![](url)`) and all Block Kit interactivity (buttons, menus, dividers)

## Gotchas

- Must be a member of a channel before posting, else `not_in_channel`. Ask user to join channel.
- Find channel IDs with `slack.slack_search_channels`; for **private** channels it often returns nothing — fall back to `slack.slack_search_public_and_private` (searches message content, which reveals the channel ID).

## My channels (all private)

| Channel | ID | What it is |
|---|---|---|
| #wol_devex | `C02NUQ65U2C` | Camp channel — Hotel + Agentic Eng |
| #team_hotel | `C0B97KTKH25` | My team |
| #team_agentic_engineering | `C0BAJEK3HH8` | Sister team |


## People (user IDs for mentions)

**Team Hotel**
- Jack (me) `U010S548P0F`
- Shay `U09UM9ZC6NN`
- Felicity `U0ADQP9DSNS`
- Elliott `UFMU99PCG`

**Across both teams**
- Eric `U01LM3LA4Q5` — camp director
- Jason `U6W5LHSKD` — delivery manager

**Agentic Engineering**
- Will Brennan `U02SKHF1H3M`
- Anderson "Ando" Saunders `U03LZFFA66P`
- Tom Ridge `U62BKKDKK`
- James Telfer `UHKEFHVF1`
- Ellie Foote `U0829QPS4BC`

## Worked example

A happy-path message using the reliable features (table + emoji + mention + blockquote callout), sent via mcporter:

```bash
mcporter call slack.slack_send_message channel_id=C02NUQ65U2C message=":envelope: This is an example message

| Repo | PR |
|------|----|
| my-service | [#1](https://github.com/cultureamp/my-service/pull/1) |

> :eyes: <@U09UM9ZC6NN> could you take a look?"
```
