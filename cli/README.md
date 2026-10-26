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

> **Systems without Node.js / npm**:
> If you are on an IBM i PASE shell, minimal Linux container, or machine without Node/npm, you can use the zero-dependency curl script:
> ```bash
> ./vscode-bridge/bin/codefori.sh status
> ./vscode-bridge/bin/codefori.sh run-action -n "Create Bound RPG Program (CRTBNDRPG)"
> ```

## Quick Start
Ensure VS Code is running with the `Code for IBM i Bridge` extension active.

```bash
# Check status
codefori status

# Discover actions
codefori list-actions

# Inspect or set IFS deploy directory
codefori get-deploy-location
codefori set-deploy-location --remote "/home/USER/myproject"

# Deploy workspace changes to IFS
codefori deploy --method changes

# Trigger compilation (prioritizes .vscode/actions.json)
codefori run-action --name "Create Bound RPG Program (CRTBNDRPG)" --file "src/myprog.rpgle"

# View compiler diagnostics & errors
codefori diagnostics

# Read EVFEVENT errors for an object via Code for IBM i
codefori read-eventf --object "MYLIB/MYPGM"

# Run CL command (direct CL commands require confirmation by default)
codefori run-cl --command "WRKSYSSTS" --confirm

# Run destructive command (always requires confirmation)
codefori run-cl --command "DLTLIB MYLIB" --confirm
```

## Security Guardrail
- **QSH Execution Policy**: External AI agents and automation scripts cannot execute QSH commands or actions (`code-for-ibmi-bridge.security.qshPolicy: "block"` by default, configurable to `prompt`, `modal`, `allow`).
- **CL Command Policy**: Direct CL command execution requires `--confirm` by default (`code-for-ibmi-bridge.security.clPolicy: "prompt"`, configurable to `block`, `modal`, `allow`).
- **Destructive Command Protection**: Destructive commands (`DLTLIB`, `PWRDWNSYS`, `CLRPFM`, `rm -rf`, SQL `DROP`, etc.) are intercepted by the Bridge guardrail (`code-for-ibmi-bridge.security.policy`).


## License
MIT
