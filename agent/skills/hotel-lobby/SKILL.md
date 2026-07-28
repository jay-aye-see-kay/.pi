---
name: hotel-lobby
description: Read, upload, and update HTML/Markdown pages on the private lobby GitHub Pages site via the hotel CLI. Use for any turbo-dollop-1qzvw1v.pages.github.io URL (these pages are private, so fetch them with `hotel lobby get`, not a web fetch), and when the user wants to upload or share a file to the lobby.
only-on-hosts: ["jrose-04LCLG"]
---

# Hotel Lobby

Share files on a private (CultureAmp org only) GitHub Pages site.
- HTML is uploaded verbatim
- Markdown is converted to HTML after upload, mermaid and d2 diagrams are supported
- Browse all pages at https://turbo-dollop-1qzvw1v.pages.github.io

Page URLs look like `https://turbo-dollop-1qzvw1v.pages.github.io/f/<id>`.

## Read a page

The site is private, so web fetch tools cannot read it. Use:

```bash
hotel lobby get rvQujya > report.md   # redirect to a file
hotel lobby get https://turbo-dollop-1qzvw1v.pages.github.io/f/rvQujya | head 10 # full url also works
```

## Upload a page

```bash
hotel lobby add <filename> [flags]
```

Flags:
- `-d, --description "..."` — why this file exists
- `-t, --tag` / `--tags` — comma-separated tags for grouping (e.g. `--tags="TIK-123,health"`)

```bash
hotel lobby add report.html
hotel lobby add plan.md --description "plan for implementing ABC-456"
hotel lobby add plan.md --description="draft 2" --tags="TIK-123,health"
```

## Update a page

Keeps the same URL. The new file must be the same type (`.html` cannot replace `.md`).
Description and tags stay the same unless you pass `--description` or `--tag`.

```bash
hotel lobby update <pageId> <filename> [flags]
hotel lobby update Uk1a8nd plan.md --description "draft 2"
```

## List your pages

```bash
hotel lobby list
```

Shows only pages you added or last updated, from your 100 most recent commits.
Use it to find a page id when you have only the file name.

## Notes

- After an upload, give the returned URL to the user.
