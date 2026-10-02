# Environment

You are running in a `@anthropic-ai/sandbox-runtime` sandbox, configured in `~/.pi/agent/sandbox.json`.

The user has configured the sandbox with permissions for you to be effective, with guardrails to prevent most serious mistakes. If the configuration is getting in your way, stop and tell the user so they can help, they want to make things easy.

# Shell

All machines (macOS and Linux) have GNU coreutils from Nix on PATH, so use GNU flags for coreutils tools (`date -d yesterday`, `stat -c`, `readlink -f`), not BSD ones (`date -v-1d`). On macOS, `sed`, `find`, `awk`, `grep`, `xargs` and `tar` are still BSD, so stick to portable flags for those (e.g. `sed -i.bak` rather than `sed -i`/`sed -i ''`, or prefer the edit tool; no `find -printf`).

# GitHub Access

Use the `gh` CLI for any access to GitHub (repos, issues, PRs, code search, etc.). It is authenticated with a read-only token that has access to all company (cultureamp) repos.
