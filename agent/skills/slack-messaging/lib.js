// Slack helpers for codemode. Load with:
//   const slack = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/slack-messaging/lib.js" }))(tools);
// Then: slack.call / search / show / thread / peek / parseLink / ago / triage. Keep this file small: it is read on every load.

const ME = "U010S548P0F";
const BOTS = /Slackbot|Jira|Camper Portal Bot|agent-orchestrator|Atlassian Home|PR thread|GitHub/;

// Any slack tool → parsed JSON (results/messages/result/... + pagination_info). Throws on isError.
const call = async (tool, args = {}) => {
  const r = await tools[`mcp__slack__slack_${tool.replace(/^slack_/, "")}`](args);
  const t = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`slack ${tool}: ${t}`);
  try { return JSON.parse(t); } catch { return t; }
};

// Slack mrkdwn → plain-ish text: <@U|Name> → @Name, <url|label> → label, entities decoded, whitespace collapsed.
const clean = (s = "") => s
  .replace(/<@(\w+)\|([^>]+)>/g, "@$2").replace(/<#(\w+)\|([^>]*)>/g, "#$2").replace(/<!subteam\^\w+(\|[^>]*)?>/g, "@group")
  .replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_, u, l) => (/slack\.com\/archives/.test(u) ? u : l)).replace(/<(https?:[^>]+)>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

// `after`/`before` param value (unix-seconds string) for N days ago; fractions ok (ago(1/24) = last hour).
const ago = (days) => String(Math.floor(Date.now() / 1000 - days * 86400));

const parseLink = (url) => {
  const [, channel_id, p] = url.match(/archives\/(\w+)\/p(\d+)/) ?? [];
  if (!channel_id) throw new Error(`not a Slack permalink: ${url}`);
  const ts = `${p.slice(0, -6)}.${p.slice(-6)}`;
  return { channel_id, ts, thread_ts: url.match(/thread_ts=([\d.]+)/)?.[1] ?? ts };
};

// Detailed search markdown → records. Empty text = file/attachment-only message.
const hits = (md = "") => md.split(/\n### Result \d+ of \d+\n/).slice(1).map((b) => {
  const f = (k) => b.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1].trim() ?? "";
  const link = b.match(/\]\((https:[^)]+)\)/)?.[1] ?? "";
  return {
    ch: f("Channel").replace(/ \(ID: \w+\)/, ""), cid: f("Channel").match(/ID: (\w+)/)?.[1],
    from: f("From").replace(/ <[^>]*>| \(ID: \w+\)/g, ""), uid: f("From").match(/ID: (\w+)/)?.[1],
    time: f("Time").slice(0, 16), ts: f("Message_ts"), link, thread_ts: link.match(/thread_ts=([\d.]+)/)?.[1],
    raw: (b.split(/\nText: ?\n/)[1] ?? "").split(/\nContext (?:before|after):|\n---/)[0].trim(),
  };
}).map((m) => ({ ...m, text: clean(m.raw) || "(no text — file/attachment)" }));

// search_public_and_private → records, following the cursor up to `pages` pages (20/page).
const search = async (args, pages = 1) => {
  const out = []; let cursor;
  for (let i = 0; i < pages; i++) {
    const r = await call("search_public_and_private", { limit: 20, include_context: false, ...args, cursor });
    out.push(...hits(r.results));
    cursor = r.pagination_info?.match(/cursor `([^`]+)`/)?.[1];
    if (!cursor) break;
  }
  return out;
};

// Records → compact lines for returning to the model.
const show = (ms, n = 160) => ms.map((m) => `${m.time} ${m.ch} ${m.from}: ${m.text.slice(0, n)}\n  ${m.link}`).join("\n");

// Whole thread for a permalink (or {channel_id, thread_ts}). Uses the PARENT ts. concise = "> Name: text" lines.
// Slack links inside it (forwards, "see this") get the linked message inlined as "⤷ …" (up to `expand`).
const thread = async (urlOrIds, { format = "concise", expand = 3 } = {}) => {
  const { channel_id, thread_ts } = typeof urlOrIds === "string" ? parseLink(urlOrIds) : urlOrIds;
  let out = clean((await call("read_thread", { channel_id, message_ts: thread_ts, response_format: format })).messages)
    .replace(/ <[^<>\s]+@[^<>\s]+>/g, "").replace(/ > /g, "\n> ");
  const links = [...new Set(out.match(/https:\/\/\S+slack\.com\/archives\/\w+\/p\d+\S*/g) ?? [])]
    .filter((l) => parseLink(l).ts !== thread_ts).slice(0, expand);
  for (const [l, msg] of await Promise.all(links.map(async (l) => [l, await peek(l)]))) if (msg) out = out.replace(l, `${l} ⤷ ${msg}`);
  return out;
};

// First line (≤200 chars) of the exact message at a permalink, or "" if unreadable.
const peek = async (link) => {
  try {
    const { channel_id, ts } = parseLink(link);
    return (await thread({ channel_id, thread_ts: ts }, { expand: 0 })).split("\n")[0].replace(/^THREAD: /, "").slice(0, 200);
  } catch { return ""; }
};

// What needs me in the last `hours`: with:me + <@me> in parallel, grouped per conversation, ranked.
// ❗ tagged me / DM, not answered · ⏳ others replied after me in a convo I'm in · · FYI (in convo, never posted).
// Already-answered convos are only counted. Messages that are just a Slack link get the linked message inlined.
const triage = async ({ hours = 24, pages = 3, expand = 5 } = {}) => {
  const after = ago(hours / 24);
  const all = (await Promise.all([`with:me`, `<@${ME}>`].map((query) => search({ query, after, sort: "timestamp" }, pages)))).flat();
  const convos = {};
  for (const m of all) {
    const key = m.cid?.startsWith("D") ? m.cid : `${m.cid}/${m.thread_ts ?? m.ts}`;
    (convos[key] ??= new Map()).set(m.ts, m);
  }
  const rank = { "❗": 0, "⏳": 1, "·": 2 };
  let answered = 0;
  const rows = Object.values(convos).map((byTs) => {
    const msgs = [...byTs.values()].sort((a, b) => b.ts - a.ts);
    const mine = msgs.find((m) => m.uid === ME);
    const theirs = msgs.filter((m) => m.uid !== ME && !BOTS.test(m.from));
    if (!theirs.length) return null;
    if (mine && +mine.ts > +theirs[0].ts) return void answered++;
    const direct = theirs.some((m) => m.raw.includes(`<@${ME}`)) || theirs[0].cid?.startsWith("D");
    return { mark: direct ? "❗" : mine ? "⏳" : "·", n: theirs.length, ...theirs[0] };
  }).filter(Boolean).sort((a, b) => rank[a.mark] - rank[b.mark] || b.ts - a.ts);
  await Promise.all(rows.filter((r) => r.mark === "❗").slice(0, expand).map(async (r) => {
    const link = r.text.match(/https:\/\/\S+slack\.com\/archives\/\S+/)?.[0];
    if (!link || clean(r.raw.replace(/<@[^>]+>/g, "")).replace(link, "").length > 20) return; // only bare links
    const msg = await peek(link);
    if (msg) r.text += ` ⤷ ${msg}`;
  }));
  return rows.map((r) => `${r.mark} ${r.time.slice(5)} ${r.ch} ${r.from}${r.n > 1 ? ` (+${r.n - 1})` : ""}: ${r.text.slice(0, 220)}\n   ${r.link}`)
    .join("\n") + `\n(${answered} more convos already answered by me)`;
};

return { ME, ago, call, clean, parseLink, hits, search, show, thread, peek, triage };
