---
name: google
description: Read and manage my Google Calendar (today's/upcoming events, meetings, RSVP accept/decline, scheduling) and read Google Drive (Docs, Sheets, Slides, files). Use whenever I mention my calendar, meetings, events, invites, Google Drive/Docs, or "meeting notes" (these are Gemini notes stored in Drive).
only-on-hosts: ["jrose-04LCLG"]
---

# Google Calendar & Drive

MCP servers `mcp__google_calendar` (read/write) and `mcp__google_drive` (read-only), called from `codemode`. Tool descriptions are good: `describeNamespace(...)`, `describeTool(...)`. Results are in `r.structuredContent`.

## Calendar

- `list_events` defaults to *now → +7 days*: for "today" set `startTime`/`endTime` to local midnight with offset (`date +%z`), plus `orderBy: "startTime"`.
- My response is `attendees.find(a => a.self).responseStatus` (`needsAction` = not responded).
- Recurring events: occurrence IDs look like `<seriesId>_20261008T020000Z` (`recurringEventId` is the series). `respond_to_event` on the occurrence ID changes only that day — the default; say so.
- RSVP: `respond_to_event({ eventId, responseStatus: "accepted" | "declined" | "tentative" })`. Point out clashes.

```js
const r = await tools.mcp__google_calendar__list_events({ startTime: "2026-10-08T00:00:00+11:00", endTime: "2026-10-09T00:00:00+11:00", orderBy: "startTime" });
return r.structuredContent.events.map(e => [e.id, e.start.dateTime ?? e.start.date, e.summary, e.attendees?.find(a => a.self)?.responseStatus].join(" | "));
```

## Drive

- `search_files({ query, excludeContentSnippets: true })` — query syntax in its description (`title contains '…'`, `fullText contains`, `mimeType =`, `modifiedTime > 'RFC3339'`, `owner = 'me'`).
- `read_file_content({ fileId })` → `{ fileContent, title, viewUrl }` as markdown.
- Write tools are hidden; treat Drive as read-only.

### Meeting notes

Gemini notes are titled `<meeting> - YYYY/MM/DD HH:MM TZ - Notes by Gemini`, owned by the organiser. My Drive also holds a `shortcut` to each, so filter to Docs to avoid duplicates:

```js
const r = await tools.mcp__google_drive__search_files({ excludeContentSnippets: true, pageSize: 10,
  query: "title contains 'Notes by Gemini' and title contains 'Roadmap' and mimeType = 'application/vnd.google-apps.document'" });
```

Notes are long (~70k chars). The top "Quick notes" section (summary, topics, next steps) is usually enough — slice before `Full notes`; the full notes and transcript follow.

## Errors

- Auth failure mentioning `claude-ai-auth` / expired token → ask me to run `claude` once, then retry.
- `Request had insufficient authentication scopes` → Google permission missing; ask me to reconnect the Google connector in claude.ai.
