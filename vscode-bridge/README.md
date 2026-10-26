# Code for IBM i CLI & Bridge

A lightweight, secure loopback bridge and companion CLI enabling external automation tools, terminal scripts, and AI coding agents to programmatically invoke actions, manage IFS deployments, inspect EVFEVENT compile diagnostics, and execute remote commands via the **Code for IBM i** extension without manual UI interaction.

---

## Key Features

- **Local Loopback REST API**: Binds strictly to `127.0.0.1` on an ephemeral or configured port.
- **Cryptographic Authentication**: Generates a 32-byte hex token validated with constant-time equality checks (`X-CodeForIBMi-Token`). Auto-handshakes via `~/.codefori/bridge.json`.
- **Flexible Command-Line Interface (`codefori`)**:
  - **Git Bash & POSIX curl Script (`codefori.sh` / `codefori`)**: Zero-dependency POSIX shell script using standard `curl`. Ideal for locked-down enterprise Windows machines via Git Bash, as well as Linux, macOS, WSL, and IBM i PASE (`/QOpenSys/usr/bin/sh`). Requires no Node.js, npm, or administrator privileges.
  - **Node.js CLI Package**: Optional global npm package (`@rishabkshk/codefori-cli`) for environments with Node.js.
- **Granular Security Guardrails**:
  - **Destructive Command Guardrail**: Protects IBM i systems from unauthorized destructive operations (`DLTLIB`, `CLRPFM`, `PWRDWNSYS`, SQL `DROP`, etc.).
  - **QSH & PASE Isolation Policies**: Strictly block, prompt, or allow shell environments (prevents bypasses).
  - **CL Command Guardrail**: Requires confirmation for direct CL command execution (`/run-cl`) while permitting safe workspace actions.
  - **Deployment Guardrail**: Requires explicit target file selection or confirmation before deploying changes to IFS.
  - **Action Inspection**: Inspects pre-configured workspace actions (`.vscode/actions.json`) before execution.
- **Visual Settings UI**:
  - Dedicated configuration webview accessible from the Activity Bar and Status Bar.
  - Organized tabs for **Server**, **CLI Access**, **Security Policies**, and **Command Rules**.
  - One-click top **Save Settings** button with instant state persistence.
- **Compiler Diagnostics**: Exposes EVFEVENT compiler diagnostics directly to automated agents.

---

## Getting Started

### 1. Using the Command-Line Interface (`codefori`)

#### Zero-Dependency Git Bash / POSIX Script (Recommended for Enterprise / No Node.js):
The extension automatically mirrors the script to `~/.codefori/bin/` on activation:
- **Windows (Git Bash)**:
  ```bash
  # Run directly via Git Bash
  sh ~/.codefori/bin/codefori.sh status

  # Or add to PATH in your ~/.bashrc: export PATH="$HOME/.codefori/bin:$PATH"
  codefori status
  ```
- **Linux / macOS / WSL**:
  ```bash
  codefori status
  # or invoke directly:
  ~/.codefori/bin/codefori status
  ```

#### Global npm Package (When Node.js is available):
```bash
npm install -g @rishabkshk/codefori-cli
codefori status
```

---

## Common CLI Commands

| Command | Description |
| :--- | :--- |
| `codefori status` | Display Bridge server health, port, and IBM i connection state |
| `codefori list-actions` | List all available Code for IBM i actions for the workspace |
| `codefori run-action --name "CRTBNDRPG"` | Execute an action by name |
| `codefori deploy --files "src/prog.rpgle"` | Deploy selected files to remote IFS |
| `codefori diagnostics` | Retrieve compiler errors and diagnostics |
| `codefori run-cl --command "WRKSYSSTS"` | Run an IBM i CL command (prompts or requires `--confirm`) |

---

## Extension Settings

All settings can be configured via the visual **Code for IBM i Bridge Settings** page or in VS Code Settings (`Ctrl+,`):

| Setting | Default | Description |
| :--- | :--- | :--- |
| `code-for-ibmi-bridge.port` | `0` | Port for the HTTP Bridge server (0 for ephemeral dynamic allocation) |
| `code-for-ibmi-bridge.autoStart` | `true` | Automatically start the Bridge HTTP server on activation |
| `code-for-ibmi-bridge.cliMode` | `"auto"` | CLI interaction mode (`auto`, `npm`, `curl`) |
| `code-for-ibmi-bridge.promptOnMissingNpm` | `false` | Prompt regarding npm package installation if Node.js is detected |
| `code-for-ibmi-bridge.security.policy` | `"prompt"` | Policy for destructive commands (`prompt`, `block`, `modal`, `allow`) |
| `code-for-ibmi-bridge.security.qshPolicy` | `"block"` | Policy for QSH shell execution (`block`, `prompt`, `modal`, `allow`) |
| `code-for-ibmi-bridge.security.pasePolicy` | `"block"` | Policy for PASE shell execution (`block`, `prompt`, `modal`, `allow`) |
| `code-for-ibmi-bridge.security.clPolicy` | `"prompt"` | Policy for direct CL commands (`prompt`, `block`, `modal`, `allow`) |
| `code-for-ibmi-bridge.security.deployPolicy` | `"prompt"` | Policy for workspace IFS deployments (`prompt`, `modal`, `block`, `allow`) |
| `code-for-ibmi-bridge.security.promptTimeoutSeconds` | `60` | Timeout in seconds for interactive user confirmation |

---

## License
MIT
