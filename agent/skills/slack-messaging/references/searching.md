# Searching & reading

Use `slack_search_public_and_private` (public + private + DMs). `slack_search_public` is public-only. Returns JSON with a markdown `results` string. **No semantic search, no boolean** — terms are AND'd. Run several small keyword searches; narrow with modifiers; broaden on 0 results.

## Token discipline

- Scan with `response_format=concise include_context=false limit=20`; only expand real hits (`include_context=true` or `read_thread`).
- Save & grep instead of dumping:
  ```bash
  mcporter call slack.slack_search_public_and_private query="from:me incident rollback" limit=20 include_context=false > /tmp/s.json
  jq -r '.results' /tmp/s.json | grep -i -B1 -A3 rollback
  ```
- `limit` max 20; next-page `cursor` is in `pagination_info` — refine rather than page endlessly.
- Delegate broad searches to a subagent; have it return only the answer, key quotes, and permalinks.

## Modifiers (inside `query`)

`from:me` / `from:<@U123>` · `to:me` · `in:#channel` / `in:<#C123>` / `-in:channel` · `in:<@U123>` (a DM) · `before:`/`after:`/`on:YYYY-MM-DD` · `during:month` · `is:thread` `has:link` `has:file` `has:pin` · `"exact phrase"` · `-word` · `foo*` (wildcard, 3+ chars).

Top-level params: `sort=timestamp` (newest first), `content_types=files` with a `type:` filter (images, pdfs, documents, spreadsheets, canvases…).

```bash
mcporter call slack.slack_search_public_and_private query='from:me "feature flag" in:#team_hotel' sort=timestamp limit=20
```

## Permalinks

`https://cultureamp.slack.com/archives/C02NUQ65U2C/p1751932800001900` → `channel_id=C02NUQ65U2C`, `ts` = insert a dot before the last 6 digits → `1751932800.001900`. Reply links carry `?thread_ts=…&cid=…` directly.

```bash
url='…/archives/C02NUQ65U2C/p1751932800001900'
cid=$(sed -E 's#.*/archives/([^/]+)/.*#\1#' <<<"$url")
ts=$(sed -E 's#.*/p([0-9]+).*#\1#' <<<"$url" | sed -E 's/([0-9]{6})$/.\1/')
mcporter call slack.slack_read_thread channel_id="$cid" message_ts="$ts"
```

## Other read tools

`read_channel channel_id=C… limit=30 response_format=concise` · `read_thread channel_id=C… message_ts=…` · `read_user_profile user_id=U…` · `list_channel_members channel_id=C… response_format=ids_only` · `read_file file_id=F…` · `search_channels query=…` · `search_users query=…`.

`search_channels` often returns nothing for **private** channels — fall back to `search_public_and_private` (message content reveals the channel ID).
