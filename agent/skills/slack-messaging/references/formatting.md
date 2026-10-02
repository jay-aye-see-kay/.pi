# Formatting

Standard markdown renders: `# H1`/`## H2`/`### H3`, GFM pipe tables (escape literal `\|`), `**bold**` `_italic_` `~~strike~~`, `` `code` ``, ` ```lang ` fenced blocks (syntax-highlighted + copy), ` ```diff ` (`+`green/`-`red), `> quote` (single level), `- [ ]`/`- [x]`, `-`/`1.` lists (nesting ok), `[text](url)`, `:emoji:`.

## Slack tokens (raw string only)

Mention `<@U010S548P0F>` · usergroup `<!subteam^S123>` · channel `<#C123>` · broadcast `<!here>` / `<!channel>`.

## Custom emoji

`:working_out_loud:` · `:fyii:` · `:done_check:` · `:dogfood:` · `:til2:` · `:thinking_out_loud:` · `:sandbox:` · `:pr-merged:` · `:neat:` · `:learn-out-loud:` · `:fingerscrossed:` · `:awesomeface_shades:`

Gripe about a tool: `:old-man-yells-at-claude:` · `:old-man-yells-at-google:` · `:old_man_yells_at_netskope:` (underscores) · `:old-man-yells-at-datadog:` · `:old-man-yells-at-python:` · `:old-man-yells-at-miro:` · `:old-man-yells-at-aws:` · `:old-man-yells-at-buildkite:`

Verify others (custom only; case-insensitive substring, comma-separated, up to 200): `slack("search_emojis", { query: "old-man-yells,old_man_yells" })` → `results` lists `:name:` (aliases noted).

## Not available

Inline images (`![](url)`), Block Kit (buttons, menus, dividers).
