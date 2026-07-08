---
name: hotel-lobby
description: Upload an HTML or Markdown file to a private GitHub Pages site via the hotel CLI. Use when user wants to upload/share a file to the lobby.
---

# Hotel Lobby Upload

Upload an HTML or Markdown file to a private (to CultureAmp org) GitHub Pages site.
- HTML is uploaded verbatim
- Markdown is converted to HTML on upload, mermaid and d2 diagrams are supported

## Usage

```bash
hotel lobby add <filename> [flags]
```

Flags:
- `-d, --description "..."` — why this file exists
- `-t, --tag` / `--tags` — comma-separated tags for grouping (e.g. `--tags="TIK-123,health"`)

## Examples

```bash
hotel lobby add report.html
hotel lobby add plan.md --description "plan for implementing ABC-456"
hotel lobby add plan.md --description="draft 2" --tags="TIK-123,health"
```

## Notes

- After uploading, share the returned URL with the user.
