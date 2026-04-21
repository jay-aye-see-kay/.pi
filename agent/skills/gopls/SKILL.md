---
name: gopls
description: Use gopls language server for renames or when exploring a go codebase and grep isn't enough
---

# gopls - Go Language Server

## Location Format

All commands use `<file>:<line>:<column>` format (1-indexed).

## Commands

```sh
# go to definition
gopls definition main.go:16:6

# usages of a symbol
gopls references cmd/root.go:80:6

# types implementing an interface
gopls implementation interface.go:19:6

# list all symbols in a file
gopls symbols cmd/root.go

# search symbols by name across codebase
gopls workspace_symbol "Execute"

# callers and callees of a function
gopls call_hierarchy cmd/root.go:80:6

# check for compile errors (use after edits)
gopls check main.go

# rename symbol
gopls rename -w cmd/root.go:80:6 NewName
```

## Tips

- Use `symbols` to find the right line:column before other commands
- Pipe to `head` for large outputs: `gopls references ... | head -20`
