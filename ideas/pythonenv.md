---
title: Python code-execution tool for pi — environment & library decisions
kind: decision-notes
created: 2026-07-05
tags: [pi, python, tools, sandbox, nix]
---

# Python code-execution tool for pi — environment decisions

Design notes for a dedicated **code-execution tool** on pi, sitting alongside the
sandboxed bash tool. Fills the gap where bash is awkward: inline logic, structured
data, parsing, analysis, and charts. This doc captures the **interpreter choice**
and the **library surface**. (Tool *shape*/implementation is a separate, later step.)

## Interpreter: Python (not bash, nushell, Bun/TS)

The candidates were bash-alternatives (nushell), TS runtimes (Bun/Deno/Node), and
Python. Decision axes and why Python won:

- **Training-density is the currency**, not raw capability. A tool is only reliable
  where *both* the language *and* the specific API are well-represented in training
  data. This sank: nushell (low density + pre-1.0 churn), nodejs-polars (capability
  exists, API under-trained → models confabulate the Python API), and TS backtick
  templating (collides with markdown/code-sample content).
- **Readability for me** — I read the code to check it; Python is what I read most
  fluently. Rules out bash (escaping-heavy, hard to verify) and nushell.
- **Data + charts** — polars/altair are both capable *and* maximally-trained. The one
  quadrant JS genuinely can't match (numeric heavy-lift).
- **The tiebreaker: `nix python.withPackages`.** Builds a "fat" system python where
  `import polars` works from *any* cwd, no venv, reproducible, offline, sandbox-native
  (libs in `/nix/store`, already in `allowRead`). Node's per-directory `node_modules`
  resolution has no clean equivalent; Bun/Deno lean on runtime URL/registry fetches
  that fight the deny-by-default sandbox network. This is *structural* to how each
  ecosystem resolves libraries and aligns exactly with an inline tool's need for
  ambient libraries. My `python3` is *already* a `withPackages` env.

Mirror-image weakness accepted: Python's subprocess ergonomics and its
two-concurrency-models ambiguity — both mitigated below (argv-exec; standardize on
asyncio).

## Philosophy: "one way to do things, the modern way"

Pick the modern, opinionated, one-obvious-way lib per domain and **don't even mention
the legacy alternative** (e.g. httpx, never requests). Where modern ≠ most-trained,
carry a small nudge. Deliberately exclude density-magnets that create "more than one
way" (pandas, requests, anyio…).

## Two-tier model: installed ≠ mentioned

- **Bundled (importable)** — can be generous. Installed-but-unmentioned libs are a
  *safety net* for reflexive imports at zero prompt cost (e.g. numpy).
- **Mentioned (tool description)** — must be lean. Every mention spends agent
  attention; too many nudges dilutes all of them.

"Capability present" and "capability advertised" are decoupled: install freely,
advertise sparingly. Future plain/dense/one-way libs land in "install, don't mention."
The nudge count only rises for a genuinely new footgun or overlap-lane.

## Bundled packages (nixpkgs `python.withPackages`)

| Package (nix attr)                 | Domain                     | Lane / note                                  |
|------------------------------------|----------------------------|----------------------------------------------|
| polars                             | dataframes                 | default for reading + manipulation           |
| duckdb                             | SQL over files             | only for SQL / cross-file joins / `.db`      |
| numpy                              | arrays/numerics            | **installed, NOT mentioned** (reflexive-import net) |
| altair + vl-convert-python         | charts                     | vl-convert = headless PNG/SVG export         |
| fastexcel                          | xlsx read                  | via `polars.read_excel`                      |
| httpx                              | HTTP (sync+async)          | replaces requests entirely                   |
| pydantic                           | structured data/validation | nudge: "v2 idioms"                           |
| jinja2                             | templating                 | prompt/string building                       |
| python-dateutil                    | date *parsing*             | pairs with stdlib datetime/zoneinfo          |
| ruamel-yaml                        | YAML 1.2                   | replaces PyYAML                              |
| lxml                               | XML (XPath, robust)        | stdlib ET for trivial cases                  |
| json5                              | JSONC + JSON5              | one parser covers both                       |
| selectolax                         | HTML                       | fast/modern                                  |
| boto3                              | AWS                        | nudge: "paginators + ThreadPoolExecutor"     |

## Free via stdlib — emphasize so the agent doesn't reach for a lib

- **Formats:** `json`, `tomllib` (TOML read), `plistlib` (plist xml+binary),
  `sqlite3`, `configparser` (INI), `csv`, `gzip`/`zipfile`/`tarfile`, `dbm`
- **Concurrency:** `asyncio` (nudge: "TaskGroup + `Semaphore(N)`"),
  `concurrent.futures.ThreadPoolExecutor` (the *documented exception* — for sync
  blocking libs like boto3)
- **Core:** `pathlib`, `zoneinfo`, `datetime`, `subprocess` (argv-list = byte-perfect,
  no shell escaping), `string.Template`, `xml.etree` (basic; lxml for real work)

## Concurrency model: standardized on asyncio

- Structured concurrency via `asyncio.TaskGroup` (3.11+); **bounded** fan-out via
  `asyncio.Semaphore(N)` — asyncio has *no* built-in concurrency cap (unlike TS
  `p-map`), so the Semaphore is the highest-value thing to nudge.
- Subprocess fan-out (e.g. spawning `pi` subagents) via
  `asyncio.create_subprocess_exec` — argv list, no shell parsing, byte-perfect.
- HTTP fan-out via `httpx.AsyncClient` under the same TaskGroup+Semaphore.
- `ThreadPoolExecutor` is the *one exception*, for blocking libs with no async API
  (boto3). Do **not** add anyio/trio/aioboto3 (second async framework = breaks one-way).
- TaskGroup is modern but newest/least-trained → give it the strongest scaffolding
  (a copyable snippet). gather+Semaphore is denser if less structured.

## The reliability primitive: argv-list exec

Bash is uniquely broken for string-heavy work because it can't separate the string
from the command line — a prompt with code samples (quotes, `$`, backticks, `{}`)
gets word-split/reparsed. **Any real language sidesteps this** by passing the payload
as one opaque argv element (`subprocess.run(["pi","-p",prompt])`) — verified
byte-perfect round-trip. Combined with `string.Template`/jinja2 (collision-safe vs
code-sample content), this is why string-templating + fan-out (UC3) rejoins the
Python tool rather than a shell.

## Deliberately excluded (to protect one-way)

`pandas` (→polars) · `requests` (→httpx) · explicit `pyarrow` (→let
polars/duckdb/fastexcel carry it; add on-demand) · `PyYAML` (→ruamel) ·
`anyio`/`trio` (→stdlib asyncio) · `aioboto3`/`aiobotocore` (→boto3+threads) ·
`pytz`/`os.path`/`orjson`/`ujson` (→stdlib) · `python-frontmatter` (→would reintroduce
a parallel markdown + PyYAML path) · `sh`/`plumbum`/`xonsh` (→stdlib subprocess) ·
`click`/`argparse`/`typer` (no use case for an inline tool)

## Dropped after being considered

- **markdown-it-py + mdit-py-plugins** — GFM/frontmatter *parsing*. Dropped to narrow
  surface. Cost: frontmatter/heading/code-block extraction falls back to brittle
  regex. Revisit if md-*mining* (not authoring) becomes common. Authoring md needs no
  lib (jinja2 + strings).
- **tenacity** — retries now hand-rolled (loop + `asyncio.sleep` backoff). httpx only
  has connection-level retries, not retry-on-5xx.
- **rich, pytest** — optional; add only if pretty-output / TDD workflows are real.
- **IPython** — orthogonally installed for other purposes; not part of this tool's env.

## Nudges (the entire prompt "steering" budget)

Steering (modern ≠ most-trained):
1. **asyncio** → "TaskGroup + `Semaphore(N)`"
2. **pydantic** → "v2 idioms"
3. **boto3** → "paginators; `ThreadPoolExecutor` for parallel"

Lanes (overlap → dithering):
- **polars** (default) ⟂ **duckdb** (only for SQL / cross-file joins)
- **boto3** (analytical compute-over-AWS-data) ⟂ **aws CLI** (quick lookups, if on PATH)

Plus one terse inventory line so the agent knows the env is "fat" (lists the bundled
libs above; numpy omitted).

## Use cases driving this (UC1–3)

1. **File analysis** — "shape of these files", "how often does Z happen", "chart X over
   time". Was python-or-bash; bash is hard to read/verify and slow (many process
   spawns). → polars/duckdb, single readable efficient pass.
2. **Analysis + graphs** — polars + altair (+vl-convert for headless export). Current
   pain is *heredoc escaping* — dissolved by the tool taking the script as a parameter
   (no heredoc at all).
3. **Subagent fan-out** — string-templating (shared code samples + variation) → loop →
   shell out to `pi`. Slow today because context is re-emitted per subagent as LLM
   output tokens. A single script builds prompts once (jinja2/`string.Template`) and
   fans out under `TaskGroup`+`Semaphore` via `create_subprocess_exec` — reusing
   context, argv-safe, capped concurrency.

## AWS auth (via Granted `assume`)

Normal workflow: `assume account/role-readonly && pi`. `assume` exports temporary
creds as **env vars** into the shell; pi inherits them. So creds come from
`process.env`, **not** `~/.aws/sso/cache` — the sandbox `allowRead` gap (only
`~/.aws/config`) does **not** bite this workflow. Network allowlist already has
`*.amazonaws.com` + `*.awsapps.com`.

- **Design requirement:** the code-exec tool's subprocess must be spawned with
  `env: process.env` (or at least the `AWS_*` subset) so the assumed creds reach
  boto3. (pi-sandbox's bash exec already threads env through; replicate that.)
- Caveat (affects boto3 and CLI equally): temporary creds expire mid-session; env is
  fixed at launch → re-`assume` and relaunch.
- Safety boundary is the **readonly IAM role**, identical for boto3 and CLI.

## Sandbox integration (how it stays inside the boundary)

The pi-sandbox extension wraps *arbitrary shell command strings* at the OS level via
`SandboxManager.wrapWithSandbox(command)` (from `@carderne/sandbox-runtime`;
sandbox-exec on macOS). The boundary is **not** bash-specific. Three integration
options, cleanest-middle preferred:

1. Shim over the bash *tool* — build script, call sandboxed bash. Double-layered.
2. **Shim over the sandbox *primitive*** — import the same `@carderne/sandbox-runtime`
   (shared singleton, already initialized by pi-sandbox), call `wrapWithSandbox` on
   the `python …` command, spawn directly. Cleanest *if* the singleton state is shared
   across extension module graphs — the one unverified integration unknown.
3. Fork pi-sandbox — most control, most maintenance.

Also mirror pi-sandbox's `enabled`/`initialized` gates and `--no-sandbox` flag, or the
tool could run unwrapped when the user believes the sandbox is on.

## Open threads (for the tool-shape step)

- Verify the singleton-sharing assumption for option 2 (or fall back to shim-over-bash).
- Confirm `env: process.env` propagation end-to-end (AWS creds).
- Verify GFM-enable idiom if markdown ever returns; confirm `vl-convert-python` /
  `fastexcel` / `selectolax` / `json5` nix attr names in the pinned nixpkgs.
- Write the terse inventory line + the 3 steers + 2 lanes as the tool description.
- Decide script *delivery*: script-as-JSON-parameter → temp file / stdin (kills heredoc).
