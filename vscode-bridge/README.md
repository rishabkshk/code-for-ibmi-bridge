# Code for IBM i Bridge

A lightweight, secure loopback bridge enabling external automation tools, CLI scripts, and AI coding agents to programmatically invoke actions, manage IFS deployments, inspect EVFEVENT compile diagnostics, and execute remote CL/PASE commands via the **Code for IBM i** extension without manual UI interaction.

## Features
- **Local Loopback REST API**: Binds strictly to `127.0.0.1` on an ephemeral or configured port.
- **Cryptographic Authentication**: Generates a 32-byte hex token validated with constant-time equality checks (`X-CodeForIBMi-Token`).
- **Destructive Command Guardrail**: Protects IBM i systems from unauthorized destructive operations with interactive user confirmation modals.
- **Code for IBM i Integration**: Directly hooks into `halcyontechltd.code-for-ibmi` APIs (`actionTools`, `deployTools`, `connectionManager`, `vscode.commands`).
- **Compiler Diagnostics**: Exposes EVFEVENT compiler diagnostics directly to automated agents.
- **Remote CL/PASE Execution**: Run CL commands and PASE scripts directly on the connected system.

## Extension Settings
- `codeForIBMiBridge.port`: Port to listen on (default `0` for dynamic ephemeral port allocation).
- `codeForIBMiBridge.autoStart`: Automatically start the Bridge server on activation (default `true`).
- `codeForIBMiBridge.security.policy`: Security policy for destructive commands (`prompt` [default], `block`, `allow`).
- `codeForIBMiBridge.security.promptTimeoutSeconds`: Seconds to wait for user confirmation before timeout (default `60`).

## Companion CLI
Install and use the companion command-line interface:
```bash
npm install -g @rishabkshk/codefori-cli
codefori status
```

## License
MIT
