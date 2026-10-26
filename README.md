# Code for IBM i Bridge & CLI (`codefori`)

A lightweight, secure bridge system consisting of a Visual Studio Code extension (`vscode-bridge`) and a companion command-line interface (`cli`). The system empowers external automation tools, CI/CD shell scripts, and AI coding agents to programmatically invoke actions, manage remote IFS deployment targets, and execute builds via the **Code for IBM i** (`halcyontechltd.code-for-ibmi`) extension without manual UI interaction.

---

## 1. Project Architecture

The repository is structured as a TypeScript-first monorepo using npm workspaces:

```
code-for-ibmi-bridge/
├── package.json               # Root workspace manifest & orchestrator scripts
├── tsconfig.base.json         # Shared TypeScript compiler options (Node 18+)
├── README.md                  # Comprehensive setup, run, and API documentation
├── .gitignore                 # Unified ignore rules (node_modules, out, bin, .vscode-test)
├── scripts/
│   └── test-runner.js         # End-to-end integration test suite
├── vscode-bridge/             # VS Code Extension Host process
│   ├── package.json           # Extension manifest (activationEvents, config, publisher)
│   ├── tsconfig.json
│   └── src/
│       ├── extension.ts       # Extension lifecycle, server manager, token generation
│       ├── security/
│       │   └── guardrail.ts   # Destructive command detection & interactive prompts
│       ├── server/
│       │   ├── httpServer.ts  # Zero-dependency loopback HTTP server (127.0.0.1)
│       │   ├── routes.ts      # REST-like request routing & body dispatch
│       │   └── auth.ts        # Constant-time header token validation
│       └── ibmi/
│           ├── adapter.ts     # Wrapper around halcyontechltd.code-for-ibmi API & commands
│           └── types.ts       # Type definitions for Code for IBM i
└── cli/                       # Standalone Node.js CLI tool (`codefori`)
    ├── package.json           # Executable definition ("bin": { "codefori": "bin/index.js" })
    ├── tsconfig.json
    └── src/
        ├── index.ts           # Commander entry point, subcommands & flag parsing
        ├── client.ts          # HTTP transport client with auto-discovery
        └── formatters.ts      # Human-readable ANSI & machine-parsable JSON formatters
```

### Architecture Diagram

```
+-------------------------------------------------------------+
|    AI Agent / Shell Script / CI Tool / Terminal User        |
+-------------------------------------------------------------+
                               |
                               | CLI Execution / HTTP Requests
                               v
+-------------------------------------------------------------+
|                     codefori (CLI)                          |
|  - Flags: --host, -p/--port, -t/--token, --json             |
|  - Environment: CODEFORI_HOST, CODEFORI_PORT, CODEFORI_TOKEN|
|  - Auto-discovery via ~/.codefori/bridge.json               |
+-------------------------------------------------------------+
                              |
                              | Loopback HTTP (127.0.0.1:port)
                              | Header: X-CodeForIBMi-Token
                              v
+-------------------------------------------------------------+
|              VS Code Extension: vscode-bridge               |
|  - Server: Strict loopback 127.0.0.1 (Ephemeral/Fixed port) |
|  - Auth: 32-byte crypto hex token + timing-safe validation  |
|  - Adapter: Direct API & vscode.commands fallbacks          |
+-------------------------------------------------------------+
                              |
                              | Direct API / vscode.commands
                              v
+-------------------------------------------------------------+
|        Code for IBM i (halcyontechltd.code-for-ibmi)        |
|  - ActionTools / DeployTools / ConnectionManager            |
|  - Active SSH / IBM i Sessions (ILE, PASE, QSH)             |
+-------------------------------------------------------------+
```

---

## 2. Security Model & AI Agent Guardrails

1. **Strict Loopback Binding**: The HTTP server strictly binds to `127.0.0.1`. It never binds to `0.0.0.0` or external network adapters. Incoming requests are verified to originate from the loopback interface (`127.0.0.1`, `::1`).
2. **Cryptographically Secure Tokens**:
   - On first startup, `vscode-bridge` generates a secure 32-byte hex token (`crypto.randomBytes(32).toString('hex')`) and persists it in `context.globalState` (`codefori.bridge.token`).
   - All requests require the `X-CodeForIBMi-Token` header.
   - Missing or mismatched tokens are rejected with `401 Unauthorized` (`{ "error": "Invalid or missing bridge token" }`).
   - Token comparison uses `crypto.timingSafeEqual` to safeguard against timing side-channel attacks.
3. **Dynamic Ephemeral Ports**: Defaults to port `0`, allowing the operating system to dynamically assign an unused ephemeral port. Configurable via VS Code settings (`code-for-ibmi-bridge.port`).
4. **Destructive Command Guardrail (AI Agent Safeguard)**:
   - External automation tools and AI coding agents can execute commands on the connected IBM i system via `/run-cl` or `/run-command`. To prevent unintended system destruction or data loss, the bridge features an integrated **Security Guardrail**.
   - **Pattern Detection**: Automatically classifies and intercepts destructive operations:
     - **IBM i CL**: Any deletion verb (`DLTLIB`, `DLTOBJ`, `DLTF`, `DLTUSRPRF`, `DLTMSGF`, `DLTPGM`, `DLTSRVPGM`, `DLTDIR`, `DLTSPLF`, etc.), file clears (`CLRPFM`, `CLRLIB`), disruptive system controls (`PWRDWNSYS`, `ENDSBS`, `ENDSYS`, `ENDJOB`, `RCLSTG`, `INZSYS`), destructive SQL (`RUNSQL/RUNSQLSTM` containing `DROP`, `TRUNCATE`, `DELETE FROM`), and authority changes (`CHGUSRPRF`, `RVKOBJAUT`).
     - **PASE / QSH**: Recursive/forced file removals (`rm -rf`, `rm -r`, `rmdir`, `unlink`), process kills (`kill -9`, `killall`, `pkill`), system restarts/halts (`shutdown`, `reboot`, `halt`), low-level disk tools (`dd`, `mkfs`), and mass permission alterations (`chmod -R 000/777`).
     - **Actions Inspection**: Commands defined in workspace actions (`/run-action`) are pre-screened before execution.
   - **Configurable Policies (`code-for-ibmi-bridge.security.policy`)**:
     - `"prompt"` (Default): When a destructive command is requested, VS Code displays an interactive modal dialog to the user (`[Allow Execution] | [Reject]`). Execution halts until the user approves or the timeout expires.
     - `"block"`: All destructive commands are automatically rejected with `403 Forbidden` without prompting.
     - `"allow"`: Permissive mode allowing execution without prompt (with warning logged in the Output Channel).
   - **Whitelist & Custom Blocklists**: Configure `code-for-ibmi-bridge.security.allowedCommands` to exempt specific patterns, or `code-for-ibmi-bridge.security.customBlockedCommands` to block custom patterns unconditionally.
   - **Timeout Protection**: If the user does not respond within `code-for-ibmi-bridge.security.promptTimeoutSeconds` (default: 60s), the request times out and fails safely with `403 Forbidden`.
5. **QSH Execution Policy (`code-for-ibmi-bridge.security.qshPolicy`)**:
   - External AI agents and automation scripts are strictly blocked from executing QSH commands by default (`"block"`).
   - Any attempt to run commands in the `qsh` environment, execute workspace actions with `environment: "qsh"`, or invoke QSH through CL (`STRQSH`, `QSH CMD(...)`) is immediately intercepted and rejected with `403 Forbidden`.
   - Four policy modes are available via dropdown in VS Code Settings:
     - `"block"` (Default): Strictly blocks all QSH commands and QSH actions.
     - `"prompt"`: Requires explicit agent/client confirmation (`--confirm` flag or `{ "confirm": true }`).
     - `"modal"`: Shows an interactive VS Code popup dialog requesting approval.
     - `"allow"`: Permits QSH execution (subject to destructive command guardrails).
6. **CL Commands Policy (`code-for-ibmi-bridge.security.clPolicy`)**:
   - By default (`"prompt"`), direct IBM i CL commands submitted via `/run-cl` or `/run-command` require explicit confirmation (`--confirm` flag or `{ "confirm": true }` payload) before executing.
   - Predefined compilation and build actions (defined in `.vscode/actions.json` or Code for IBM i actions) are exempt from this requirement, ensuring regular build workflows remain streamlined while preventing unreviewed ad-hoc CL commands on the system.
   - Four policy modes are available via dropdown in VS Code Settings:
     - `"prompt"` (Default): Requires explicit confirmation (`--confirm`).
     - `"block"`: Strictly blocks direct CL commands automatically.
     - `"modal"`: Shows an interactive VS Code popup dialog requesting approval.
     - `"allow"`: Permits direct CL execution without confirmation.
7. **Git Bash & POSIX curl Script (`code-for-ibmi-bridge.cliMode`)**:
   - The Bridge bundles a lightweight, zero-dependency POSIX shell script (`codefori.sh` / `codefori`) using standard `curl`.
   - **Zero External Dependencies**: Operates completely out of the box without requiring Node.js, npm, or admin permissions on the host system.
   - **Enterprise Security Friendly**: In locked-down enterprise environments where running custom Node wrappers or scripts triggers EDR/AppLocker blocks, Git Bash (`bash.exe` / `sh.exe`) and `curl.exe` are standard pre-approved binaries.
   - The extension automatically mirrors `codefori` and `codefori.sh` to `~/.codefori/bin` on startup.
   - Settings:
     - `code-for-ibmi-bridge.cliMode`: `'auto'` (default, uses npm if installed, otherwise Git Bash / POSIX curl script), `'npm'` (forces global npm package), or `'curl'` (forces Git Bash / POSIX curl script).

---

## 3. Quick Start

### Prerequisites
- Node.js 18.0+ (Tested on Node 20 / 22)
- VS Code 1.90.0+
- [Code for IBM i](https://marketplace.visualstudio.com/items?itemName=halcyontechltd.code-for-ibmi) extension installed in VS Code

### Installation & Build
```bash
# 1. Clone repository and install dependencies
git clone <repo-url> code-for-ibmi-bridge
cd code-for-ibmi-bridge
npm install

# 2. Compile all packages
npm run build

# 3. (Optional) Link CLI globally for system-wide access
npm link --workspace=cli
```

### Running the Bridge Extension in VS Code
1. Open this repository folder in VS Code.
2. Press `F5` (or click **Run and Debug** -> **Launch Extension**).
3. The Extension Development Host window will launch.
4. The bridge server automatically binds to `127.0.0.1:<port>` on startup.
5. The active port and authentication token are printed in the **Code for IBM i Bridge** Output Channel and Debug Console, and displayed in the VS Code status bar: `$(radio-tower) Bridge:<port>`.

---

## 4. HTTP API Contract

Every request must include the header:
```http
X-CodeForIBMi-Token: <pre-shared-or-generated-token>
```

Requests lacking or providing an invalid token return:
```json
HTTP/1.1 401 Unauthorized
{
  "error": "Invalid or missing bridge token"
}
```

### API Endpoints Summary

| Endpoint | Method | Request Body | Success Response (200 OK) | Error Responses |
| :--- | :--- | :--- | :--- | :--- |
| `/status` | `GET` | *None* | `{ "ready": boolean, "extensionFound": boolean, "extensionActive": boolean, "tokenConfigured": boolean, "connected"?: boolean, "port"?: number, "securityPolicy"?: string }` | `500 Internal Error` |
| `/security` | `GET` | *None* | `{ "policy": string, "promptTimeoutSeconds": number, "allowedCommands": string[], "customBlockedCommands": string[] }` | `500 Internal Error` |
| `/activate` | `POST` | `{}` | `{ "activated": boolean, "exportedKeys": string[] }` | `404 Not Found` (Extension missing), `500` (Activation failed) |
| `/actions` | `GET` | *None* (`?workspaceIndex=0`) | `{ "actions": Array<{ name: string, type: string, command: string, deployFirst?: boolean, source?: string }> }` | `503 Service Unavailable` |
| `/run-action` | `POST` | `{ "actionName": string, "workspaceIndex"?: number, "file"?: string, "deployMethod"?: string, "confirm"?: boolean }` | `{ "success": boolean, "message"?: string, "output"?: any }` | `400 Bad Request`, `403 Forbidden` (Destructive action blocked) |
| `/deploy` | `POST` | `{ "workspaceIndex"?: number, "method"?: "all" \| "staged" \| "changes", "selectedFiles"?: string[] }` | `{ "success": boolean, "filesDeployed": number, "logs"?: string[] }` | `500 Internal Error` |
| `/set-deploy-location`| `POST` | `{ "workspaceIndex"?: number, "remotePath": string }` | `{ "success": boolean, "path": string }` | `400 Bad Request` (Missing `remotePath`) |
| `/deploy-location` | `GET` | *None* (`?workspace=0`) | `{ "success": boolean, "workspaceIndex": number, "workspaceName": string, "localPath": string, "remotePath"?: string, "configured": boolean }` | `400 Bad Request`, `500` |
| `/connect` | `POST` | `{ "connectionName"?: string }` | `{ "success": boolean, "connectedTo": string }` | `500 Internal Error` |
| `/disconnect` | `POST` | `{}` | `{ "success": boolean }` | `500 Internal Error` |
| `/diagnostics` | `GET` | *None* (`?file=<path>&severity=<level>`) | `{ "count": number, "errorCount": number, "warningCount": number, "diagnostics": Array<{ file: string, line: number, column: number, severity: string, code: string, message: string }> }` | `500` |
| `/read-eventf` | `POST` | `{ "object": string }` | `{ "count": number, "errorCount": number, "diagnostics": Array<...> }` | `400 Bad Request`, `500` |
| `/diagnostics/clear` | `POST` | `{}` | `{ "success": boolean }` | `500` |
| `/run-command` / `/run-cl` | `POST` | `{ "command": string, "environment"?: "ile" \| "pase" \| "qsh" }` | `{ "success": boolean, "code": number, "stdout": string, "stderr": string }` | `400 Bad Request`, `403 Forbidden` (Destructive command rejected/timeout), `500` |
| `/exec-command` | `POST` | `{ "commandId": string, "args"?: any[] }` | `{ "success": boolean, "result": any }` | `404 Not Found` (Unknown command ID), `500` |
| `/token/reset` | `POST` | `{}` | `{ "newToken": string }` | `401 Unauthorized` |

---

## 5. CLI (`codefori`) Reference

The companion CLI provides human-readable formatted stdout by default and clean, machine-parsable JSON when `--json` is supplied.

### Zero-Dependency Git Bash & POSIX curl Scripts
For environments where Node.js or npm is not installed (e.g. enterprise Windows developer machines restricted by application control policies, lightweight containers, CI/CD runners, or IBM i PASE shell), zero-dependency standalone scripts are bundled in `vscode-bridge/bin/` (and automatically mirrored to `~/.codefori/bin/` on extension activation):
- **`vscode-bridge/bin/codefori.sh`**: Portable POSIX shell script using standard `curl`. Works directly on Windows via **Git Bash**, Linux, macOS, WSL, and IBM i PASE (`/QOpenSys/usr/bin/sh`).
- **`vscode-bridge/bin/codefori`**: Direct executable alias for POSIX shells.

All tools support the exact same subcommands, flags, parameters, and auto-discovery from `~/.codefori/bridge.json`:
```bash
# Using Git Bash on Windows or POSIX shell on Linux/macOS
sh ~/.codefori/bin/codefori.sh status
sh ~/.codefori/bin/codefori.sh list-actions
sh ~/.codefori/bin/codefori.sh run-action -n "Create Bound RPG Program (CRTBNDRPG)" -f "src/myprog.rpgle"
sh ~/.codefori/bin/codefori.sh run-cl -c "WRKSYSSTS" --confirm

# Or after adding ~/.codefori/bin to PATH:
codefori status
codefori list-actions
codefori run-cl -c "WRKSYSSTS" --confirm
```

### Configuration Precedence
The CLI resolves connection options in strict order:
1. **Command-line flags**: `--host <host>`, `-p, --port <port>`, `-t, --token <token>`
2. **Environment variables**: `CODEFORI_HOST`, `CODEFORI_PORT`, `CODEFORI_TOKEN`
3. **Bridge handshake state file**: `~/.codefori/bridge.json` (auto-populated by extension on start)
4. **Fallback defaults**: `127.0.0.1:5588`

### Global Options
- `--host <host>`: Bridge server hostname (default: `127.0.0.1`)
- `-p, --port <port>`: Bridge server port
- `-t, --token <token>`: Authentication token (`X-CodeForIBMi-Token`)
- `--json`: Output machine-parsable JSON to stdout
- `-h, --help`: Display help and command usage

### Commands & Examples

#### 1. Extension Health & Connection Status
```bash
# Formatted summary
codefori status

# Machine-parsable JSON
codefori status --json
```
*Output (`--json`):*
```json
{
  "ready": true,
  "extensionFound": true,
  "extensionActive": true,
  "tokenConfigured": true,
  "connected": true,
  "connectionName": "PUB400",
  "host": "pub400.com",
  "port": 58460
}
```

#### 2. Discover Available Actions
```bash
codefori list-actions
codefori list-actions --workspace 0 --json
```

#### 3. Trigger Compilation & Custom Actions
```bash
# Execute compilation action (prioritizes .vscode/actions.json)
codefori run-action --name "Create Bound RPG Program (CRTBNDRPG)"

# Target a specific source file with auto-deployment
codefori run-action --name "Create Bound RPG Program (CRTBNDRPG)" --file "src/myprog.rpgle" --deploy-method changes
```
Actions defined in `.vscode/actions.json` take absolute precedence over connection actions. If an action requires deployment first (`deployFirst: true`), Code for IBM i automatically executes deployment before running the compile command.

#### 4. Deploy Workspace Source to IFS
```bash
# Deploy detected changes
codefori deploy --workspace 0 --method changes

# Deploy all files
codefori deploy --workspace 0 --method all

# Deploy specific files
codefori deploy --workspace 0 --method selected --files src/FILE1.rpgle src/FILE2.rpgle
```

#### 5. Inspect & Configure Target IFS Directory
```bash
# Query active deployment location
codefori get-deploy-location
codefori get-deploy-location --workspace 0 --json

# Configure target IFS deployment directory
codefori set-deploy-location --workspace 0 --remote "/home/USER/builds/project1"
```


#### 6. Connect & Disconnect Sessions
```bash
# Connect to configured profile
codefori connect --profile "PUB400"

# Connect to last used connection
codefori connect

# Disconnect active session
codefori disconnect
```

#### 7. Inspect Compiler Diagnostics (EVFEVENT)
```bash
# View all compiler errors and warnings parsed from EVFEVENT
codefori diagnostics

# Read and parse EVFEVENT errors for a specific object via Code for IBM i
codefori read-eventf --object "MYLIB/MYPGM"

# Filter diagnostics by file
codefori diagnostics --file infoin0.sqlrpgle --json

# Clear active diagnostics
codefori diagnostics --clear
```

#### 8. Execute Direct Remote CL / PASE Commands
```bash
# Execute any CL command on the connected system
codefori run-cl --command "WRKSYSSTS"
codefori run-cl --command "DSPOBJD OBJ(MYLIB/*ALL) OBJTYPE(*PGM)"

# Execute PASE shell commands
codefori run-command --command "uname -a" --env pase
```

#### 9. Execute Arbitrary VS Code Commands
```bash
# Simple command
codefori exec-command --command "code-for-ibmi.refreshObjectBrowser"

# With positional argument (PowerShell friendly!)
codefori exec-command -c "code-for-ibmi.openErrors" "MYLIB/MYPGM"

# With JSON arguments
codefori exec-command -c "code-for-ibmi.openErrors" --args '{"qualifiedObject":"MYLIB/MYPGM"}'
```

#### 10. Rotate Authentication Token
```bash
codefori reset-token
```

---

## 6. Testing & Verification

A comprehensive end-to-end test suite validates:
- Loopback binding and network security
- Constant-time token authentication & 401 rejection
- Complete contract compliance for all 10 HTTP endpoints
- Token rotation and instant invalidation of expired credentials
- CLI parameter precedence and standard exit codes (0 for success, 1 for failure)
- Machine-parsable `--json` formatting integrity

Run the verification test suite:
```bash
npm test
```

---

## 7. License

MIT
