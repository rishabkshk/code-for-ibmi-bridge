# `@rishabkshk/codefori-cli`

Command-line interface to programmatically interact with the **Code for IBM i Bridge** VS Code extension.

## Installation
```bash
npm install -g @rishabkshk/codefori-cli
```
Or use directly without installing:
```bash
npx @rishabkshk/codefori-cli status
```

## Quick Start
Ensure VS Code is running with the `Code for IBM i Bridge` extension active.

```bash
# Check status
codefori status

# Discover actions
codefori list-actions

# Trigger compilation
codefori run-action --name "Create Bound RPG Program (CRTBNDRPG)"

# View compiler diagnostics & errors
codefori diagnostics

# Run safe CL command
codefori run-cl --command "WRKSYSSTS"

# Run destructive command (requires confirmation)
codefori run-cl --command "DLTLIB MYLIB" --confirm
```

## Security Guardrail
Destructive commands (`DLTLIB`, `PWRDWNSYS`, `CLRPFM`, `rm -rf`, SQL `DROP`, etc.) are intercepted by the Bridge guardrail. External AI agents and automation scripts must supply `--confirm` to authorize execution.

## License
MIT
