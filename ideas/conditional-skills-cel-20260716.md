# Idea: generalise `skill-host-filter` → conditional skills via CEL

Turn the single-purpose host gate (`~/.pi/agent/extensions/skill-host-filter.ts`) into a general
**conditional skills** extension: a skill's frontmatter carries a boolean expression; if it
evaluates false, the skill is stripped from the system prompt.

## Why / where this is heading

Today the extension only understands `only-on-hosts: [...]`. We want richer, still-safe gating:

```yaml
condition: hostname == "laptop.local"
condition: hostname in ["a", "b"] && !hasEnv("PI_SUBAGENT")
condition: platform == "darwin"
```

Key case that motivated this: disable a skill inside subagents with `!hasEnv("PI_SUBAGENT")`.

We want a real, tested grammar — not `eval`/`new Function` — hence CEL.

## Library: `@marcbachmann/cel-js` (v8)

Chosen over alternatives (see `investigate` notes): **zero runtime deps**, ESM, ~227 KB unpacked,
and the API fits our needs exactly:

- `parse(expr)` — validate the frontmatter expression once, cache the AST (slots into the existing
  mtime cache).
- `Environment` + `registerFunction(sig, handler)` — expose `hasEnv()` cleanly.
- `evaluate(ast, context)` — supports `== != in && || !` and CEL macros.
- **Gotcha:** integer literals evaluate to `BigInt` (`7n`). Irrelevant for our boolean/string
  comparisons, but don't mix int math with JS numbers.

### Dependency wiring (the one real cost)

Extensions in `~/.pi/agent/extensions/` currently have **no `node_modules`**. Per `extensions.md`:
"npm dependencies work too. Add a `package.json` next to your extension … run `npm install`, and
imports from `node_modules/` are resolved automatically."

So: add `extensions/package.json` with `@marcbachmann/cel-js` in `dependencies`, run `npm install`.
The extension **file** stays a single file (satisfies the AGENTS.md "file not a dir" idiom for the
extension itself), but the dir gains `package.json` + `node_modules`. Accept that trade-off, or
fall back to a hand-rolled zero-dep mini-evaluator if keeping the dir clean wins.

## Design

Rename frontmatter key `only-on-hosts` → `condition` (a CEL expression returning bool).

Semantics:
- **absent** → enabled (unchanged default).
- **present** → evaluate; truthy = enabled, falsy = disabled.
- parse error / non-bool result → **log once and leave enabled** (fail-open, matches current
  "unreadable → enabled" behaviour; don't silently hide skills on a typo).

Evaluation context (build once at module load, values are process-static):
- `hostname` — `os.hostname()`
- `platform` — `process.platform`
- `env` — a map view of `process.env` (for `env.FOO == "x"` if wanted)
- `hasEnv(name)` — registered function, `name in process.env`

Everything else in `skill-host-filter.ts` stays: mtime-keyed cache (now caches
`{ mtimeMs, enabled }`), the `before_agent_start` hook, and the `formatSkillsForPrompt` splice that
only replaces the skills block so other extensions' prompt edits survive.

### Sketch

```ts
import { Environment } from "@marcbachmann/cel-js";
import { hostname } from "node:os";

const env = new Environment();
env.registerFunction("hasEnv(string): bool", (name: string) => name in process.env);
const CTX = { hostname: hostname(), platform: process.platform, env: { ...process.env } };

// per-file cache: parse once, evaluate against static CTX
function isEnabled(filePath: string): boolean {
  // ...statSync mtime cache...
  const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf-8"));
  const expr = frontmatter?.condition;
  if (expr == null) return true;               // absent → enabled
  try {
    const ast = env.parse(String(expr));       // validate + cache AST
    return env.evaluate(ast, CTX) === true;    // strict bool
  } catch (e) {
    warnOnce(filePath, e);                      // fail-open
    return true;
  }
}
```

## Migration

- Keep back-compat for `only-on-hosts` for one step (translate to
  `hostname in [...]`), or do a clean cutover and update the one/two skills that use it. Grep
  `~/.pi/agent/skills` + project skills for `only-on-hosts` first.

## Open questions

- Expose `env` map, `hasEnv()`, or both? (`hasEnv` reads best for the subagent case.)
- Async: `env.evaluate` returns a Promise if any async function participates. We register only sync
  functions, so keep it sync — but guard against accidentally awaiting.
- Validate expressions at skill-load time (surface bad `condition:` early) vs. lazily on first use.

## Fallback

If the `node_modules`-in-extensions-dir cost isn't worth it, a ~50–80 line hand-rolled
tokeniser + Pratt parser over the same fixed context keeps it single-file / zero-dep. Same
frontmatter surface, so the design above is unchanged — only `isEnabled`'s internals differ.
