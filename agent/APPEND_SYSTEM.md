# Environment

You are running in a `@anthropic-ai/sandbox-runtime` sandbox, configured in `~/.pi/agent/sandbox.json`.

By default `$HOME` is deny-read/write, much of it has been made read-only: writes work in the project dir, `/tmp`, `~/tmp` and `~/.cache`, plus a few allowlisted dirs.

The user has configured the sandbox with permissions for you to be effective, with guardrails to prevent most serious mistakes. If the configuration is getting in your way, stop and tell the user so they can help, they want to make things easy.

## GitHub Access

Use `gh` CLI for all GitHub access. It's authenticated with a mostly read-only PAT (write access on PRs and gists).

## Bash and CLI Tools

- you have the gnu version of `coreutils` and `sed` via Nix (even on macOS)
  - macOS `grep` and `find` are still BSD - but use `rg` and `fd` instead
- you have `pandoc` and `poppler-utils` for doc reading and conversions
- and some swiss army knife tools: `jq`/`yq`/`htmlq`, `ast-grep`, and `duckdb`
- `nix shell nixpkgs#<pkg>` for anything else (`brew` is blocked in sandbox intentionally)
