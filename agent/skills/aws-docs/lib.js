// AWS Knowledge MCP helpers for codemode. Load with:
//   const aws = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/aws-docs/lib.js" }))(tools);
// Then: aws.search / read / avail / regions / skill / show / call. Keep small: read on every load.

// Any tool → parsed `content` object. Results are JSON in content[0].text, wrapped as { content: {...} }.
// Errors come back with isError:false and { errorMessage }, so detect both and throw (messages include "did you mean").
const call = async (tool, args = {}) => {
  const r = await tools[`mcp__aws_knowledge__aws___${tool}`](args);
  const t = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  let j; try { j = JSON.parse(t); } catch { j = undefined; }
  if (r.isError || !j || j.errorMessage) throw new Error(`aws ${tool}: ${j?.errorMessage ?? t}`.slice(0, 800));
  return j.content ?? j;
};

// Search → [{ title, url, text }] (text = verbatim page chunk, ~1-2KB, usually enough to answer from).
// topics: ONE of reference_documentation | current_awareness | troubleshooting | cdk_docs | cdk_constructs |
// cloudformation | amplify_docs | strands_docs | agent_skills | general (default). agent_skills hits carry `skill`.
const search = async (query, { n = 4, topics } = {}) => {
  const c = await call("search_documentation", { search_phrase: query, limit: n, ...(topics && { topics: [topics].flat() }) });
  return (c.result ?? []).map((h) => ({ title: h.title, url: h.url, text: h.context ?? h.skill_description ?? "",
    ...(h.skill_name && { skill: h.skill_name }) }));
};

// Read page(s) → [{ url, text, total, end, truncated } | { url, error }]. One batched call; max = chars per page.
// Continue a truncated page with { start: prev.end }; truncated pages start with a TOC giving char ranges to jump to.
const read = async (urls, { max = 10000, start = 0 } = {}) => {
  const c = await call("read_documentation", { requests: [urls].flat().map((url) => ({ url, max_length: max, start_index: start })) });
  return (c.result ?? []).map((p) => p.status === "SUCCESS"
    ? { url: p.redirected_url ?? p.url, text: p.content, total: p.total_length, end: p.end_index, truncated: p.truncated }
    : { url: p.url, error: `${p.error_code}: ${p.content}` });
};

// Regional availability → { name: { region: status } } (status shortened to available | no | planned | ?).
// type: product | api ('SdkServiceId+Operation', e.g. 'EC2+RunInstances') | cfn ('AWS::Lambda::Function').
// Names must match the catalog exactly; a bad name throws with suggestions. Without filters (single region only),
// pass `match` (regex/string) to grep the full catalog for exact names instead of dumping it.
const avail = async (regions, type, filters, { match } = {}) => {
  regions = [regions].flat();
  const short = (s) => ({ isAvailableIn: "available", isNotAvailableIn: "no", isPlannedIn: "planned" })[s] ?? s ?? "?";
  if (!filters) {
    if (regions.length !== 1) throw new Error("avail: multi-region needs filters");
    const out = {}; let next_token;
    do {
      const c = await call("get_regional_availability", { regions, resource_type: type, ...(next_token && { next_token }) });
      const m = c.result?.products ?? c.result?.service_apis ?? c.result?.cfn_resources ?? {};
      for (const [k, v] of Object.entries(m)) if (!match || new RegExp(match, "i").test(k)) out[k] = { [regions[0]]: short(v?.status ?? v) };
      next_token = c.result?.next_token;
    } while (next_token);
    return out;
  }
  const c = await call("get_regional_availability", { regions, resource_type: type, filters: [filters].flat() });
  const m = c.result?.products ?? c.result?.service_apis ?? c.result?.cfn_resources ?? {};
  const out = {};
  for (const [k, v] of Object.entries(m)) out[k] = typeof v === "string" ? { [regions[0]]: short(v) }
    : Object.fromEntries(Object.entries(v).map(([r, s]) => [r, short(s?.status ?? s)]));
  if (c.result?.failed_regions?.length) out._failed = c.result.failed_regions;
  return out;
};

// All regions → [{ id, name }].
const regions = async () => ((await call("list_regions")).result ?? []).map((r) => ({ id: r.region_id, name: r.region_long_name }));

// AWS guided skill (from search(..., { topics: "agent_skills" }) → hit.skill) → markdown. `file` as cited in the SKILL.md.
const skill = async (name, file) => {
  const c = await call("retrieve_skill", { skill_name: name, ...(file && { file }) });
  return c.skill_content ?? c.file_content ?? c.content ?? JSON.stringify(c);
};

// Search hits → compact lines. n = chunk chars per hit (0 = titles only).
const show = (hits, n = 600) => hits.map((h) => `${h.title}${h.skill ? ` [skill: ${h.skill}]` : ""}\n  ${h.url ?? ""}` +
  (n ? `\n  ${h.text.replace(/\s+/g, " ").slice(0, n)}` : "")).join("\n");

return { call, search, read, avail, regions, skill, show };
