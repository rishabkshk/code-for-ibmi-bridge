<!-- CODEFORI_GUIDE_START -->
# Code for IBM i Bridge — AI Coding Agent Guidelines

This repository uses the **Code for IBM i Bridge** extension. The intended development model is **local development** in VS Code, followed by **deploying, compiling, and testing on the remote IBM i system** through the bridge CLI (`codefori`).

## Prerequisites
- **Git Bash (Windows)**: When running on Windows, all CLI commands **MUST** be executed within Git Bash (`bash.exe` / `sh.exe`). Do NOT execute the curl runner script in PowerShell or CMD.
- **VS Code & Bridge**: Visual Studio Code must be running with the Code for IBM i connection active and the Bridge server running.

## Workspace Actions & `.vscode/actions.json`
Workspace compilation and build actions are configured in **`.vscode/actions.json`**:
- Always inspect `.vscode/actions.json` or run `codefori list-actions` to discover the exact action names (e.g. `Create Bound RPG Program (CRTBNDRPG)`, `Create SQL ILE RPG Object (CRTSQLRPGI)`) and file associations for this project.
- Actions configured in `.vscode/actions.json` take top priority and are pre-screened, allowing seamless non-interactive compilation without prompt blocks.
- If an action in `.vscode/actions.json` has `deployFirst: true`, the Code for IBM i extension will automatically deploy the file before compiling.

## Standard Development & Test Lifecycle
1. **Local Edit**: Modify source files locally in the workspace (e.g., `qrpglesrc/myprog.rpgle`).
2. **Check Actions**: Review `.vscode/actions.json` or execute `codefori list-actions`.
3. **Deploy & Compile**: Execute the matching compilation action:
   ```bash
   codefori run-action -n "<Action Name>" -f "path/to/source.rpgle"
   ```
4. **Diagnose on Failure**: If compilation fails, immediately inspect compiler errors and EVFEVENT diagnostics:
   ```bash
   codefori diagnostics
   codefori read-eventf -o "MYLIB/MYPGM"
   ```
5. **Test on IBM i**: Run verification programs or check system status safely:
   ```bash
   codefori run-cl -c "CALL PGM(MYLIB/MYPGM)" --confirm
   ```

## Critical Rules & Guardrails
1. **DO NOT use raw `curl`**: Direct HTTP/curl requests to the bridge server loopback port are blocked (`requireCliClient: true`). Always use `codefori`.
2. **DO NOT use QSH or PASE**: Direct QSH and PASE shell execution is strictly disabled by default security policies (`qshPolicy: block`, `pasePolicy: block`). Do NOT run `STRQSH`, `QSH`, or PASE shell scripts.
3. **Destructive Operations Require User Confirmation**: Any command that deletes or clears objects (`DLTLIB`, `DLTOBJ`, `DLTF`, `CLRPFM`, etc.) requires explicit confirmation. Prompt the user in chat first, and once confirmed, pass `--confirm`.
4. **Targeted Deployment**: When deploying files, prioritize targeting specific modified files using `--files "path/to/file"` rather than blanket deploys. Blanket deploys require `--confirm`.
5. **Inspect Compiler Messages**: Never speculate on why a build failed. Always inspect the compiler listing via `codefori diagnostics` or `codefori read-eventf`.

## Quick Reference
```bash
# Check connection and active library
codefori status

# List actions from .vscode/actions.json
codefori list-actions

# Compile a source file
codefori run-action -n "Create Bound RPG Program (CRTBNDRPG)" -f "qrpglesrc/myprog.rpgle"

# View compiler errors
codefori diagnostics
codefori read-eventf -o "MYLIB/MYPGM"

# Deploy targeted changed files to IFS
codefori deploy -m changes --files "qrpglesrc/myprog.rpgle"

# Run CL command (requires --confirm)
codefori run-cl -c "DSPOBJD OBJ(MYLIB/*ALL) OBJTYPE(*PGM)" --confirm
```
<!-- CODEFORI_GUIDE_END -->
