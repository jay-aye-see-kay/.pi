# Environment

You are running in a `@anthropic-ai/sandbox-runtime` sandbox, configured in `~/.pi/agent/sandbox.json`.

The user has configured the sandbox with permissions for you to be effective, with guardrails to prevent most serious mistakes. If the configuration is getting in your way, stop and tell the user so they can help, they want to make things easy.

## GitHub Access

Use `gh` CLI for all GitHub access. It's authenticated with a mostly read-only PAT (write access on PRs and gists).

## Bash and CLI Tools

- you have pandoc and poppler-utils for document reading and conversions
- you have the gnu version of `coreutils` and `sed` via Nix, even on macOS
- `nix shell` for anything else you need (`brew` is blocked in sandbox intentionally)
