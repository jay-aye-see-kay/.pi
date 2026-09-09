---
name: datadog-pup
description: Query Datadog logs via the `pup` CLI. Use for Datadog log
  searches — e.g. logs for a service, or a service filtered by user.
---

# Datadog via pup

`pup` is Datadog's API CLI. It's self-documenting — run `pup <cmd> --help`
for structured JSON (flags, defaults, examples, anti-patterns) before
guessing. Covers logs, metrics, monitors, traces, and more.

## Conventions

- **Always pass `--from`** on time queries (default is `1h`). Formats:
  `1h`, `30m`, `7d`, RFC3339, or `now`.
- Every query prints a `Flex log storage is unavailable…` warning to
  stderr — ignore it, or filter with `2>/dev/null`.
- `pup` auto-detects agent mode and wraps output in a `status/data/metadata`
  envelope. Add `--no-agent` when writing a script the user runs themselves.

## Searching logs

```
pup logs search --query="service:hotel @system.username:jack.rose" --from="1h" --output csv
```

- **`--output csv`** — compact for flat, uniform logs (like hotel). One row
  per log, columns auto-derived from the fields present.
- **`--output json`** — use when you want only a few fields; pipe through
  `jq` to select them (`pup` has no server-side field selection).
- Other flags: `--limit` (default 50, max 1000), `--sort asc|desc`, `--to`.

## Counting / breakdowns

Don't fetch raw logs to count them. Use aggregate (JSON output, not CSV):

```
pup logs aggregate --query="service:hotel" --from="24h" --compute="count" --group-by="status" --output json
```
