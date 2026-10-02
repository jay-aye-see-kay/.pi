# Searching & reading

Snippets assume the `slack()` helper from [SKILL.md](../SKILL.md).

Use `search_public_and_private` (public + private + DMs); `search_public` is public-only. **No semantic search, no boolean** — terms are AND'd. Run several small keyword searches in parallel; narrow with modifiers; broaden on 0 results.

Params: `query` (Slack syntax, simplest) — or split into `keywords: ["word", "\"exact phrase\""]` + `filters: "from:<@U…> in:<#C…>"`. `sort: "timestamp"` (newest first; `sort_dir: "asc"` to flip), `limit` (max 20), `include_context`, `response_format`, `cursor`, `content_types: "files"`, `include_bots` (default false), `only_my_channels`, `after`/`before` (**Unix-seconds strings**, e.g. `String(Math.floor(Date.now()/1000) - 86400)`).

## Gotchas

- **`from:<display name>` returns nothing** (`from:shay`, `from:@shay`). Use `from:me`, `from:<@U123>`, or `from:@<username>` (the handle, e.g. `from:@shay.qian2`). Resolve IDs via [directory](directory.md) or `search_users`.
- **Concise drops `Message_ts`, permalinks and channel IDs** (times now render fine). Scan with it, act on detailed.
- **`read_thread` needs the parent ts.** Passing a reply's ts doesn't error — it returns that message + "No thread messsages". Use the URL's `thread_ts`.
- Text is Slack mrkdwn: `&amp;`, `<url|label>`, `<@U…|Name>` — search results keep HTML entities, `read_thread` concise decodes them.
- `with:me` doesn't cover every @mention (e.g. a tag in a thread you've not replied to) — triage runs a `<@me>` pass too.

## Parse search results

Detailed `results` is markdown: `### Result N of M` blocks with `Channel: #name (ID: C…)` (DMs: `Channel: DM (ID: D…)` + `Participants:`), `From: Name <email> (ID: U…)`, `Time: YYYY-MM-DD HH:MM:SS AEST`, `Message_ts:`, `Permalink: [link](…)`, `Text:`, and optional `Context before:/after:`. Next page: `` cursor `…` `` inside `pagination_info`.

```js
const hits = (md = "") => md.split(/\n### Result \d+ of \d+\n/).slice(1).map((b) => {
  const f = (k) => b.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1].trim() ?? "";
  const link = b.match(/\]\((https:[^)]+)\)/)?.[1] ?? "";
  return {
    ch: f("Channel").replace(/ \(ID: \w+\)/, ""), cid: f("Channel").match(/ID: (\w+)/)?.[1],
    from: f("From").replace(/ <[^>]*>| \(ID: \w+\)/g, ""), uid: f("From").match(/ID: (\w+)/)?.[1],
    time: f("Time"), ts: f("Message_ts"), link, thread_ts: link.match(/thread_ts=([\d.]+)/)?.[1],
    text: (b.split(/\nText: ?\n/)[1] ?? "").split(/\nContext (?:before|after):|\n---/)[0].trim(),
  };
});
const search = async (args, pages = 1) => {          // follows the cursor up to `pages` pages
  const out = []; let cursor;
  for (let i = 0; i < pages; i++) {
    const r = await slack("search_public_and_private", { limit: 20, include_context: false, ...args, cursor });
    out.push(...hits(r.results));
    cursor = r.pagination_info?.match(/cursor `([^`]+)`/)?.[1];
    if (!cursor) break;
  }
  return out;
};
// e.g. parallel keyword variants, compact output
const res = (await Promise.all(["rollback", "revert"].map((k) => search({ query: `from:me ${k}`, sort: "timestamp" })))).flat();
return res.map((m) => `${m.time.slice(0, 16)} ${m.ch}: ${m.text.slice(0, 150)}\n  ${m.link}`).join("\n");
```

Refine queries rather than paging endlessly.

## Daily triage

"What's happened today relevant to me?" — `with:me` (everything in convos you're part of, incl. replies that don't tag you) + `<@me>` (tags, incl. channels you haven't replied in), in parallel, grouped per conversation. ⏳ = latest non-me message is newer than my latest one there (i.e. probably waiting on me). Needs `hits`/`search` above.

```js
const ME = "U010S548P0F";
const BOTS = /Slackbot|Jira|Camper Portal Bot|agent-orchestrator|Atlassian Home/;
const after = String(Math.floor(Date.now() / 1000) - 24 * 3600);
const all = (await Promise.all([
  search({ query: "with:me", after, sort: "timestamp" }, 3),
  search({ query: `<@${ME}>`, after, sort: "timestamp" }, 3),
])).flat();
const convos = {};
for (const m of all) (convos[`${m.cid}/${m.thread_ts ?? ""}`] ??= new Map()).set(m.ts, m);
return Object.values(convos).map((byTs) => {
  const msgs = [...byTs.values()].sort((a, b) => b.ts - a.ts);
  const mine = msgs.find((m) => m.uid === ME);
  const theirs = msgs.filter((m) => m.uid !== ME && !BOTS.test(m.from));
  return theirs.length && { waiting: !mine || +theirs[0].ts > +mine.ts, n: theirs.length, ...theirs[0] };
}).filter(Boolean).sort((a, b) => b.waiting - a.waiting || b.ts - a.ts)
  .map((r) => `${r.waiting ? "⏳" : "✓"} ${r.time.slice(5, 16)} ${r.ch} ${r.from} (+${r.n}): ${r.text.replace(/\s+/g, " ").slice(0, 120)}\n   ${r.link}`)
  .join("\n");
```

Only messages inside the window count, so a reply I made before it won't mark a thread ✓. `to:me` = DMs to you + @mentions (a subset). For a DM's full back-and-forth: `slack("read_channel", { channel_id: "U…" /* or D… */, limit: 20, response_format: "concise" })`.

## Modifiers (inside `query` / `filters`)

`from:me` / `from:<@U123>` / `from:@username` · `to:me` · `with:me` · `in:#channel` / `in:<#C123>` / `-in:channel` · `in:<@U123>` (a DM) · `is:dm` · `before:`/`after:`/`on:YYYY-MM-DD` · `during:month` · `is:thread` `has:link` `has:file` `has:pin` `has:reaction` `has::emoji:` · `"exact phrase"` · `-word` · `foo*` (3+ chars). Same modifier repeated = OR (except `with`/`has` = AND).

Files: `{ query: "in:#team_hotel", content_types: "files" }` → `File ID: F…` for `read_file`.

## Permalinks

`…/archives/C02NUQ65U2C/p1751932800001900` → `channel_id: "C02NUQ65U2C"`, ts = dot before the last 6 digits → `"1751932800.001900"`. Reply links also carry `?thread_ts=…&cid=…`.

```js
const parseLink = (url) => {
  const [, channel_id, p] = url.match(/archives\/(\w+)\/p(\d+)/);
  const ts = `${p.slice(0, -6)}.${p.slice(-6)}`;
  return { channel_id, ts, thread_ts: url.match(/thread_ts=([\d.]+)/)?.[1] ?? ts };
};
const { channel_id, thread_ts } = parseLink(url);
return (await slack("read_thread", { channel_id, message_ts: thread_ts, response_format: "concise" })).messages;
```

`read_thread` detailed gives `Message TS:` per reply (needed to react/reply); concise is just `> Name: text` lines. Leave `limit` unset (default 100) — a small `limit` returned the *last* replies, not the first.

## Other read tools

`read_channel({ channel_id, limit: 30, response_format: "concise", oldest?, latest? })` (newest first; user_id works for DMs) · `read_user_profile({ user_id })` · `list_channel_members({ channel_id, response_format: "ids_only" })` · `list_user_channels({ name_prefix: "team_", format: "names_only", types: "public_channel,private_channel,im,mpim" })` · `get_reactions({ channel_id, message_ts })` · `read_file({ file_id })` · `search_users({ query: "Name", response_format: "concise" })` · `search_channels({ query, channel_types: "public_channel,private_channel" })`.
