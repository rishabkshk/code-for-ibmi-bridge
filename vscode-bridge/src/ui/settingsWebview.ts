import * as vscode from 'vscode';
import { BridgeServer } from '../server/httpServer';
import { SecurityConfig } from '../security/guardrail';

export class SettingsWebviewPanel {
  public static currentPanel: SettingsWebviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    bridgeServer: BridgeServer | undefined,
    getSecurityConfig: () => SecurityConfig,
    onResetToken: () => Promise<string>,
    onStartServer: () => Promise<void>,
    onStopServer: () => Promise<void>,
    getEffectiveCliMode: (npmInstalled: boolean) => { mode: string; activeMethod: string },
    checkNpmInstalled: () => Promise<boolean>,
    getFallbackScriptPath: () => string
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SettingsWebviewPanel.currentPanel) {
      SettingsWebviewPanel.currentPanel.panel.reveal(column);
      SettingsWebviewPanel.currentPanel.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'codeForIBMiBridgeSettings',
      'Code for IBM i Bridge Settings',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    SettingsWebviewPanel.currentPanel = new SettingsWebviewPanel(
      panel,
      extensionUri,
      bridgeServer,
      getSecurityConfig,
      onResetToken,
      onStartServer,
      onStopServer,
      getEffectiveCliMode,
      checkNpmInstalled,
      getFallbackScriptPath
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private bridgeServer: BridgeServer | undefined,
    private getSecurityConfig: () => SecurityConfig,
    private onResetToken: () => Promise<string>,
    private onStartServer: () => Promise<void>,
    private onStopServer: () => Promise<void>,
    private getEffectiveCliMode: (npmInstalled: boolean) => { mode: string; activeMethod: string },
    private checkNpmInstalled: () => Promise<boolean>,
    private getFallbackScriptPath: () => string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    // 1. Immediately render HTML synchronously so webview is never blank!
    const initialPayload = this.buildPayloadSync(false);
    this.panel.webview.html = this.getHtmlForWebview(initialPayload);

    // 2. Perform async check and post syncState update
    this.update();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Listen to messages from webview
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'saveAllSettings': {
            if (message.settings && typeof message.settings === 'object') {
              const config = vscode.workspace.getConfiguration();
              for (const [key, value] of Object.entries(message.settings)) {
                await config.update(key, value, vscode.ConfigurationTarget.Global);
              }
            }
            vscode.window.showInformationMessage('Code for IBM i Bridge: Settings saved successfully.');
            this.panel.webview.postMessage({ command: 'savedAll' });
            break;
          }
          case 'startServer': {
            await this.onStartServer();
            this.refresh();
            break;
          }
          case 'stopServer': {
            await this.onStopServer();
            this.refresh();
            break;
          }
          case 'resetToken': {
            const confirm = await vscode.window.showWarningMessage(
              'Are you sure you want to reset the Bridge authentication token? Any active CLI clients will need to be reloaded.',
              { modal: true },
              'Reset Token'
            );
            if (confirm === 'Reset Token') {
              await this.onResetToken();
              vscode.window.showInformationMessage('Code for IBM i Bridge: Authentication token reset successfully.');
              this.refresh();
            }
            break;
          }
          case 'copyText': {
            if (message.text) {
              await vscode.env.clipboard.writeText(message.text);
              vscode.window.showInformationMessage(`${message.label || 'Text'} copied to clipboard.`);
            }
            break;
          }
          case 'installNpmCli': {
            vscode.commands.executeCommand('codeForIBMiBridge.installNpmCli');
            break;
          }
          case 'refresh': {
            this.refresh();
            break;
          }
        }
      },
      null,
      this.disposables
    );

    // Listen for VS Code configuration changes and sync to webview
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration('code-for-ibmi-bridge')) {
          this.refresh();
        }
      },
      null,
      this.disposables
    );
  }

  public async refresh() {
    this.update();
  }

  public dispose() {
    SettingsWebviewPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const x = this.disposables.pop();
      if (x) x.dispose();
    }
  }

  private buildPayloadSync(isNpm: boolean) {
    const isRunning = this.bridgeServer?.isRunning() ?? false;
    const host = this.bridgeServer?.getHost() ?? '127.0.0.1';
    const port = this.bridgeServer?.getPort() ?? 0;
    const token = this.bridgeServer?.getToken() ?? '';
    const secConfig = this.getSecurityConfig();
    const { mode: cliMode, activeMethod } = this.getEffectiveCliMode(isNpm);
    const fallbackScript = this.getFallbackScriptPath();

    const config = vscode.workspace.getConfiguration('code-for-ibmi-bridge');
    const autoStart = config.get<boolean>('autoStart', true);
    const configuredPort = config.get<number>('port', 0);
    const promptOnMissingNpm = config.get<boolean>('promptOnMissingNpm', false);

    return {
      isRunning,
      host,
      port,
      configuredPort,
      token,
      autoStart,
      cliMode,
      activeMethod,
      isNpm,
      fallbackScript,
      promptOnMissingNpm,
      secConfig
    };
  }

  private async update() {
    try {
      const isNpm = await this.checkNpmInstalled();
      const payload = this.buildPayloadSync(isNpm);
      this.panel.webview.postMessage({ command: 'syncState', data: payload });
    } catch {
      // Non-fatal sync fallback
    }
  }

  private getHtmlForWebview(data: {
    isRunning: boolean;
    host: string;
    port: number;
    configuredPort: number;
    token: string;
    autoStart: boolean;
    cliMode: string;
    activeMethod: string;
    isNpm: boolean;
    fallbackScript: string;
    promptOnMissingNpm: boolean;
    secConfig: SecurityConfig;
  }): string {
    const nonce = getNonce();
    const cspSource = this.panel.webview.cspSource;

    const allowedCmds = (data.secConfig.allowedCommands || []).join('\n');
    const blockedCmds = (data.secConfig.customBlockedCommands || []).join('\n');
    const promptCmds = (data.secConfig.customPromptCommands || []).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code for IBM i Bridge Settings</title>
  <style>
    :root {
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      --bg-color: var(--vscode-editor-background, #1e1e1e);
      --text-color: var(--vscode-editor-foreground, #cccccc);
      --muted-color: var(--vscode-descriptionForeground, #888888);
      --border-color: var(--vscode-settings-dropdownBorder, rgba(255, 255, 255, 0.12));
      --dropdown-bg: var(--vscode-settings-dropdownBackground, #252526);
      --dropdown-fg: var(--vscode-settings-dropdownForeground, #cccccc);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --btn-sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-sec-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --btn-sec-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --tab-active-border: var(--vscode-panelTitleActiveBorder, #007acc);
      --badge-success-bg: rgba(78, 201, 176, 0.18);
      --badge-success-fg: #4ec9b0;
      --badge-danger-bg: rgba(241, 76, 76, 0.18);
      --badge-danger-fg: #f14c4c;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font-family);
      background-color: var(--bg-color);
      color: var(--text-color);
      padding: 0;
      font-size: 13px;
      line-height: 1.5;
    }

    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 0 32px 64px 32px;
    }

    header {
      position: sticky;
      top: 0;
      background-color: var(--bg-color);
      z-index: 100;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 0;
      border-bottom: 1px solid var(--border-color);
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .header-title h1 {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.2px;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-badge.running {
      background-color: var(--badge-success-bg);
      color: var(--badge-success-fg);
    }

    .status-badge.stopped {
      background-color: var(--badge-danger-bg);
      color: var(--badge-danger-fg);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: currentColor;
    }

    .btn-save {
      background-color: var(--btn-bg);
      color: var(--btn-fg);
      font-weight: 600;
      padding: 6px 16px;
      font-size: 12.5px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    }

    .btn-save:hover {
      background-color: var(--btn-hover);
    }

    .btn-save.has-changes {
      background-color: #2ea44f;
      color: #ffffff;
    }

    .tabs-nav {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--border-color);
      margin-bottom: 24px;
      overflow-x: auto;
    }

    .tab-btn {
      background: none;
      border: none;
      color: var(--muted-color);
      font-family: inherit;
      font-size: 13px;
      padding: 8px 16px 10px 16px;
      cursor: pointer;
      position: relative;
      font-weight: 500;
      transition: color 0.15s ease;
      white-space: nowrap;
    }

    .tab-btn:hover {
      color: var(--text-color);
    }

    .tab-btn.active {
      color: var(--text-color);
      font-weight: 600;
    }

    .tab-btn.active::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      right: 0;
      height: 2px;
      background-color: var(--tab-active-border);
    }

    .tab-pane {
      display: none;
    }

    .tab-pane.active {
      display: block;
    }

    .section {
      margin-bottom: 32px;
    }

    .section-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--text-color);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .setting-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 16px 20px;
      margin-bottom: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .setting-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
    }

    .setting-info {
      flex: 1;
    }

    .setting-label {
      font-weight: 500;
      font-size: 13px;
      color: var(--text-color);
    }

    .setting-desc {
      color: var(--muted-color);
      font-size: 12px;
      margin-top: 4px;
      line-height: 1.4;
    }

    .setting-control {
      min-width: 200px;
      display: flex;
      justify-content: flex-end;
    }

    select, input[type="text"], input[type="number"], textarea {
      font-family: inherit;
      font-size: 13px;
      background-color: var(--dropdown-bg);
      color: var(--dropdown-fg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 6px 10px;
      outline: none;
    }

    select:focus, input:focus, textarea:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }

    select {
      cursor: pointer;
      min-width: 200px;
    }

    input[type="number"] {
      width: 120px;
    }

    input[type="text"] {
      width: 100%;
    }

    textarea {
      width: 100%;
      min-height: 80px;
      resize: vertical;
    }

    .checkbox-container {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }

    input[type="checkbox"] {
      cursor: pointer;
      width: 16px;
      height: 16px;
      accent-color: var(--btn-bg);
    }

    .btn {
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 14px;
      border-radius: 3px;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background-color: var(--btn-bg);
      color: var(--btn-fg);
      transition: background-color 0.15s ease;
    }

    .btn:hover {
      background-color: var(--btn-hover);
    }

    .btn-secondary {
      background-color: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
    }

    .btn-secondary:hover {
      background-color: var(--btn-sec-hover);
    }

    .btn-group {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      flex-wrap: wrap;
    }

    .info-box {
      background: rgba(255, 255, 255, 0.03);
      border-left: 3px solid var(--tab-active-border);
      padding: 12px 16px;
      border-radius: 0 4px 4px 0;
      margin-bottom: 20px;
      font-size: 12px;
      color: var(--muted-color);
    }

    .info-box strong {
      color: var(--text-color);
    }

    .save-indicator {
      display: inline-block;
      font-size: 11px;
      color: var(--badge-success-fg);
      opacity: 0;
      transition: opacity 0.3s ease;
      margin-left: 8px;
    }

    .save-indicator.visible {
      opacity: 1;
    }

    #header-save-indicator.visible {
      opacity: 1;
      font-weight: 600;
    }

    .code-snippet {
      font-family: var(--vscode-editor-font-family, monospace);
      background: rgba(0, 0, 0, 0.25);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11.5px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-title">
        <h1>Code for IBM i Bridge</h1>
      </div>
      <div class="header-actions">
        <span id="header-save-indicator" class="save-indicator">✓ Settings Saved</span>
        <button id="btn-save-all" class="btn-save">
          💾 Save Settings
        </button>
        <span id="badge-status" class="status-badge ${data.isRunning ? 'running' : 'stopped'}">
          <span class="status-dot"></span>
          <span id="status-text">${data.isRunning ? `Bridge Running (${data.host}:${data.port})` : 'Bridge Stopped'}</span>
        </span>
      </div>
    </header>

    <!-- Top Tab Navigation -->
    <nav class="tabs-nav">
      <button class="tab-btn active" data-tab="server">Server</button>
      <button class="tab-btn" data-tab="cli">CLI Access</button>
      <button class="tab-btn" data-tab="security">Security Policies</button>
      <button class="tab-btn" data-tab="commands">Command Rules</button>
    </nav>

    <!-- TAB 1: BRIDGE SERVER (Active by default) -->
    <div id="tab-server" class="tab-pane active">
      <div class="section">
        <h3 class="section-title">General Server Configuration</h3>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <div class="setting-label">Server Port</div>
              <div class="setting-desc">Port for the HTTP Bridge server (0 for ephemeral dynamic port allocation).</div>
            </div>
            <div class="setting-control">
              <input type="number" id="input-port" min="0" max="65535" value="${data.configuredPort}">
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <label class="checkbox-container">
                <input type="checkbox" id="check-autostart" ${data.autoStart ? 'checked' : ''}>
                <span class="setting-label">Auto-Start Bridge Server</span>
              </label>
              <div class="setting-desc">Automatically start the Bridge HTTP server upon extension activation.</div>
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <h3 class="section-title">Server Controls & Authentication</h3>

        <div class="setting-card">
          <div class="setting-info">
            <div class="setting-label">Server Lifecycle</div>
            <div id="server-lifecycle-desc" class="setting-desc">Status: <strong>${data.isRunning ? `Running at http://${data.host}:${data.port}` : 'Stopped'}</strong></div>
            <div class="btn-group">
              <button id="btn-stop-server" class="btn btn-secondary" style="display: ${data.isRunning ? 'inline-flex' : 'none'};">⏹ Stop Server</button>
              <button id="btn-restart-server" class="btn btn-secondary" style="display: ${data.isRunning ? 'inline-flex' : 'none'};">🔄 Restart Server</button>
              <button id="btn-start-server" class="btn" style="display: ${!data.isRunning ? 'inline-flex' : 'none'};">▶ Start Server</button>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-info">
            <div class="setting-label">Authentication Token</div>
            <div class="setting-desc">Secure bearer token required in <span class="code-snippet">X-CodeForIBMi-Token</span> header for API authentication.</div>
            <div style="display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap: wrap;">
              <input type="text" id="token-display" value="${data.token}" readonly style="max-width: 380px; font-family: monospace;">
              <button id="btn-copy-token" class="btn btn-secondary">📋 Copy Token</button>
              <button id="btn-reset-token" class="btn btn-secondary">🔄 Reset Token</button>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-info">
            <div class="setting-label">Auto-Handshake State File</div>
            <div class="setting-desc">CLI utilities discover this port and token automatically from:</div>
            <div style="margin-top: 6px;">
              <span class="code-snippet">~/.codefori/bridge.json</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 2: CLI ACCESS -->
    <div id="tab-cli" class="tab-pane">
      <div class="section">
        <h3 class="section-title">CLI Configuration</h3>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <div class="setting-label">CLI Interaction Mode</div>
              <div class="setting-desc">
                Select how agents and terminal utilities interact with Code for IBM i Bridge:
                <br>• <strong>auto</strong>: Uses global npm package if installed, otherwise Git Bash / POSIX script (Default).
                <br>• <strong>npm</strong>: Forces global Node.js CLI package (<span class="code-snippet">@rishabkshk/codefori-cli</span>).
                <br>• <strong>curl</strong>: Forces zero-dependency Git Bash / POSIX script (<span class="code-snippet">codefori.sh</span>).
              </div>
            </div>
            <div class="setting-control">
              <select id="select-climode">
                <option value="auto" ${data.cliMode === 'auto' ? 'selected' : ''}>auto (Auto-detect: npm, else Git Bash / POSIX)</option>
                <option value="npm" ${data.cliMode === 'npm' ? 'selected' : ''}>npm (Node.js global package)</option>
                <option value="curl" ${data.cliMode === 'curl' ? 'selected' : ''}>curl (Git Bash / POSIX script)</option>
              </select>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <label class="checkbox-container">
                <input type="checkbox" id="check-prompt-npm" ${data.promptOnMissingNpm ? 'checked' : ''}>
                <span class="setting-label">Prompt for npm Global Package</span>
              </label>
              <div class="setting-desc">Display a prompt offering to install <span class="code-snippet">@rishabkshk/codefori-cli</span> when Node.js is detected.</div>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-info">
            <div class="setting-label">Command Line Access & Status</div>
            <div id="cli-status-desc" class="setting-desc">
              Node.js/npm detected: <strong>${data.isNpm ? 'Yes' : 'No'}</strong> &nbsp;|&nbsp; Active client: <strong>${data.activeMethod === 'npm' ? 'Node.js npm package' : 'Git Bash / POSIX script'}</strong>
              <br><br>
              In restricted enterprise environments without Node.js, run directly through <strong>Git Bash</strong> on Windows or any standard POSIX shell (Linux, macOS, WSL) using the zero-dependency script:
            </div>
            <div style="margin-top: 8px;">
              <span id="script-path-display" class="code-snippet">${data.fallbackScript}</span>
            </div>
            <div class="btn-group">
              <button id="btn-copy-fallback" class="btn">📋 Copy Invocation Command</button>
              <button id="btn-copy-path" class="btn btn-secondary">📋 Copy Add to PATH</button>
              <button id="btn-install-npm" class="btn btn-secondary">📦 Install via npm</button>
              <button id="btn-copy-env" class="btn btn-secondary">📋 Copy Shell Env</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 3: SECURITY POLICIES -->
    <div id="tab-security" class="tab-pane">
      <div class="info-box">
        <strong>Security Guardrails:</strong> Protect your connected IBM i system against unauthorized or unintended commands executed by external AI agents and automation scripts.
      </div>

      <div class="section">
        <h3 class="section-title">Execution Policies</h3>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <div class="setting-label">Destructive Commands Policy</div>
              <div class="setting-desc">Policy for commands matching destructive patterns (DLTLIB, CLRPFM, PWRDWNSYS, SQL DROP, etc.).</div>
            </div>
            <div class="setting-control">
              <select id="select-policy">
                <option value="prompt" ${data.secConfig.policy === 'prompt' ? 'selected' : ''}>prompt (Require in-chat confirmation)</option>
                <option value="block" ${data.secConfig.policy === 'block' ? 'selected' : ''}>block (Strictly reject automatically)</option>
                <option value="modal" ${data.secConfig.policy === 'modal' ? 'selected' : ''}>modal (Interactive VS Code dialog)</option>
                <option value="allow" ${data.secConfig.policy === 'allow' ? 'selected' : ''}>allow (Permit execution)</option>
              </select>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <div class="setting-label">QSH Execution Policy</div>
              <div class="setting-desc">Governs execution of QSH shell commands, STRQSH invocations, and QSH environment actions.</div>
            </div>
            <div class="setting-control">
              <select id="select-qsh">
                <option value="block" ${data.secConfig.qshPolicy === 'block' ? 'selected' : ''}>block (Strictly disabled - Default)</option>
                <option value="prompt" ${data.secConfig.qshPolicy === 'prompt' ? 'selected' : ''}>prompt (Require in-chat confirmation)</option>
                <option value="modal" ${data.secConfig.qshPolicy === 'modal' ? 'selected' : ''}>modal (Interactive VS Code dialog)</option>
                <option value="allow" ${data.secConfig.qshPolicy === 'allow' ? 'selected' : ''}>allow (Permit execution)</option>
              </select>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <div class="setting-label">PASE Execution Policy</div>
              <div class="setting-desc">Governs direct PASE shell execution (/run-command -Env pase) and PASE actions. Prevents bypassing QSH via PASE.</div>
            </div>
            <div class="setting-control">
              <select id="select-pase">
                <option value="block" ${data.secConfig.pasePolicy === 'block' ? 'selected' : ''}>block (Strictly disabled - Default)</option>
                <option value="prompt" ${data.secConfig.pasePolicy === 'prompt' ? 'selected' : ''}>prompt (Require in-chat confirmation)</option>
                <option value="modal" ${data.secConfig.pasePolicy === 'modal' ? 'selected' : ''}>modal (Interactive VS Code dialog)</option>
                <option value="allow" ${data.secConfig.pasePolicy === 'allow' ? 'selected' : ''}>allow (Permit execution)</option>
              </select>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <div class="setting-label">IBM i CL Commands Policy</div>
              <div class="setting-desc">Governs direct IBM i CL commands (/run-cl). Predefined workspace actions are exempted.</div>
            </div>
            <div class="setting-control">
              <select id="select-cl">
                <option value="prompt" ${data.secConfig.clPolicy === 'prompt' ? 'selected' : ''}>prompt (Require in-chat confirmation - Default)</option>
                <option value="block" ${data.secConfig.clPolicy === 'block' ? 'selected' : ''}>block (Strictly reject direct CL)</option>
                <option value="modal" ${data.secConfig.clPolicy === 'modal' ? 'selected' : ''}>modal (Interactive VS Code dialog)</option>
                <option value="allow" ${data.secConfig.clPolicy === 'allow' ? 'selected' : ''}>allow (Permit execution)</option>
              </select>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <div class="setting-label">Workspace Deploy Policy</div>
              <div class="setting-desc">Governs workspace deployments to IBM i IFS. Prioritizes explicit file selection (select method); prompts for unselected deploys.</div>
            </div>
            <div class="setting-control">
              <select id="select-deploy">
                <option value="prompt" ${data.secConfig.deployPolicy === 'prompt' ? 'selected' : ''}>prompt (Require file selection or confirmation - Default)</option>
                <option value="modal" ${data.secConfig.deployPolicy === 'modal' ? 'selected' : ''}>modal (Interactive VS Code dialog with change list)</option>
                <option value="block" ${data.secConfig.deployPolicy === 'block' ? 'selected' : ''}>block (Strictly prohibit blanket deploys)</option>
                <option value="allow" ${data.secConfig.deployPolicy === 'allow' ? 'selected' : ''}>allow (Permit deployments)</option>
              </select>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <div class="setting-label">Prompt Timeout (Seconds)</div>
              <div class="setting-desc">Timeout to wait for user confirmation before automatically rejecting the command.</div>
            </div>
            <div class="setting-control">
              <input type="number" id="input-timeout" min="5" max="600" value="${data.secConfig.promptTimeoutSeconds ?? 60}">
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-header">
            <div class="setting-info">
              <label class="checkbox-container">
                <input type="checkbox" id="check-actioninsp" ${data.secConfig.enableActionInspection ? 'checked' : ''}>
                <span class="setting-label">Enable Action Inspection</span>
              </label>
              <div class="setting-desc">Inspect commands defined in workspace actions (.vscode/actions.json) for destructive patterns before running.</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 4: CUSTOM COMMAND RULES -->
    <div id="tab-commands" class="tab-pane">
      <div class="section">
        <h3 class="section-title">Command Filters & Whitelist</h3>

        <div class="setting-card">
          <div class="setting-info">
            <div class="setting-label">Allowed Commands Whitelist</div>
            <div class="setting-desc">List of commands exempt from destructive checks (one command or prefix per line):</div>
            <div style="margin-top: 8px;">
              <textarea id="textarea-allowed" placeholder="e.g. DLTSPLF *SELECT">${allowedCmds}</textarea>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-info">
            <div class="setting-label">Custom Blocked Commands</div>
            <div class="setting-desc">List of command names, prefixes, or regex patterns that are unconditionally blocked (one per line):</div>
            <div style="margin-top: 8px;">
              <textarea id="textarea-blocked" placeholder="e.g. PWRDWNSYS">${blockedCmds}</textarea>
            </div>
          </div>
        </div>

        <div class="setting-card">
          <div class="setting-info">
            <div class="setting-label">Custom Prompt Commands</div>
            <div class="setting-desc">List of additional command names, prefixes, or regex patterns that require interactive confirmation (one per line):</div>
            <div style="margin-top: 8px;">
              <textarea id="textarea-promptcmds" placeholder="e.g. ENDJOB">${promptCmds}</textarea>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Persistent Tab State Management with Safe Fallback
    const validTabs = ['server', 'cli', 'security', 'commands'];
    const savedState = vscode.getState() || {};
    let currentTab = (savedState.activeTab && validTabs.includes(savedState.activeTab)) ? savedState.activeTab : 'server';
    let hasUnsavedChanges = false;

    function openTab(tabId) {
      if (!validTabs.includes(tabId)) {
        tabId = 'server';
      }
      currentTab = tabId;
      try {
        const s = vscode.getState() || {};
        vscode.setState({ ...s, activeTab: tabId });
      } catch (e) {}

      document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

      const target = document.getElementById('tab-' + tabId);
      if (target) {
        target.classList.add('active');
      }

      const targetBtn = document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
      if (targetBtn) {
        targetBtn.classList.add('active');
      }
    }

    // Attach Tab Button Listeners
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openTab(btn.getAttribute('data-tab'));
      });
    });

    // Initialize with active tab
    openTab(currentTab);

    function markChanged() {
      hasUnsavedChanges = true;
      const saveBtn = document.getElementById('btn-save-all');
      if (saveBtn) {
        saveBtn.classList.add('has-changes');
        saveBtn.innerHTML = '💾 Save Settings *';
      }
    }

    // Attach change/input listeners to all controls
    document.querySelectorAll('input, select, textarea').forEach(input => {
      input.addEventListener('input', markChanged);
      input.addEventListener('change', markChanged);
    });

    function saveAllSettings() {
      const saveBtn = document.getElementById('btn-save-all');
      if (saveBtn) {
        saveBtn.innerHTML = '💾 Saving...';
      }

      const settings = {
        'code-for-ibmi-bridge.port': parseInt(document.getElementById('input-port').value, 10) || 0,
        'code-for-ibmi-bridge.autoStart': document.getElementById('check-autostart').checked,
        'code-for-ibmi-bridge.cliMode': document.getElementById('select-climode').value,
        'code-for-ibmi-bridge.promptOnMissingNpm': document.getElementById('check-prompt-npm').checked,
        'code-for-ibmi-bridge.security.policy': document.getElementById('select-policy').value,
        'code-for-ibmi-bridge.security.qshPolicy': document.getElementById('select-qsh').value,
        'code-for-ibmi-bridge.security.pasePolicy': document.getElementById('select-pase').value,
        'code-for-ibmi-bridge.security.clPolicy': document.getElementById('select-cl').value,
        'code-for-ibmi-bridge.security.deployPolicy': document.getElementById('select-deploy').value,
        'code-for-ibmi-bridge.security.promptTimeoutSeconds': parseInt(document.getElementById('input-timeout').value, 10) || 60,
        'code-for-ibmi-bridge.security.enableActionInspection': document.getElementById('check-actioninsp').checked,
        'code-for-ibmi-bridge.security.allowedCommands': document.getElementById('textarea-allowed').value.split('\\n').map(s => s.trim()).filter(Boolean),
        'code-for-ibmi-bridge.security.customBlockedCommands': document.getElementById('textarea-blocked').value.split('\\n').map(s => s.trim()).filter(Boolean),
        'code-for-ibmi-bridge.security.customPromptCommands': document.getElementById('textarea-promptcmds').value.split('\\n').map(s => s.trim()).filter(Boolean)
      };

      vscode.postMessage({ command: 'saveAllSettings', settings });
    }

    const saveBtn = document.getElementById('btn-save-all');
    if (saveBtn) {
      saveBtn.addEventListener('click', saveAllSettings);
    }

    // Shortcut: Ctrl+S / Cmd+S saves settings
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveAllSettings();
      }
    });

    function showSaved(indicatorId) {
      if (!indicatorId) return;
      const el = document.getElementById('save-' + indicatorId) || document.getElementById(indicatorId);
      if (el) {
        el.classList.add('visible');
        setTimeout(() => el.classList.remove('visible'), 2500);
      }
    }

    function sendMessage(command, data = {}) {
      vscode.postMessage({ command, ...data });
    }

    // Attach Server Lifecycle Button Listeners
    const btnStop = document.getElementById('btn-stop-server');
    if (btnStop) btnStop.addEventListener('click', () => sendMessage('stopServer'));
    const btnRestart = document.getElementById('btn-restart-server');
    if (btnRestart) btnRestart.addEventListener('click', () => sendMessage('startServer'));
    const btnStart = document.getElementById('btn-start-server');
    if (btnStart) btnStart.addEventListener('click', () => sendMessage('startServer'));

    // Attach Token Button Listeners
    const btnCopyToken = document.getElementById('btn-copy-token');
    if (btnCopyToken) {
      btnCopyToken.addEventListener('click', () => {
        const token = document.getElementById('token-display').value;
        vscode.postMessage({ command: 'copyText', text: token, label: 'Authentication Token' });
      });
    }

    const btnResetToken = document.getElementById('btn-reset-token');
    if (btnResetToken) {
      btnResetToken.addEventListener('click', () => sendMessage('resetToken'));
    }

    // Attach CLI Button Listeners
    const btnCopyFallback = document.getElementById('btn-copy-fallback');
    if (btnCopyFallback) {
      btnCopyFallback.addEventListener('click', () => {
        const script = "${escapeJs(data.fallbackScript)}".replace(/\\\\/g, '/');
        const cmd = 'sh "' + script + '" status';
        vscode.postMessage({ command: 'copyText', text: cmd, label: 'CLI Invocation Command' });
      });
    }

    const btnCopyPath = document.getElementById('btn-copy-path');
    if (btnCopyPath) {
      btnCopyPath.addEventListener('click', () => {
        const cmd = 'export PATH="$HOME/.codefori/bin:$PATH"';
        vscode.postMessage({ command: 'copyText', text: cmd, label: 'Add to PATH (Git Bash / POSIX)' });
      });
    }

    const btnInstallNpm = document.getElementById('btn-install-npm');
    if (btnInstallNpm) {
      btnInstallNpm.addEventListener('click', () => sendMessage('installNpmCli'));
    }

    const btnCopyEnv = document.getElementById('btn-copy-env');
    if (btnCopyEnv) {
      btnCopyEnv.addEventListener('click', () => {
        const cmd = "export CODEFORI_HOST=${data.host} CODEFORI_PORT=${data.port} CODEFORI_TOKEN=${data.token}";
        vscode.postMessage({ command: 'copyText', text: cmd, label: 'CLI Environment Export' });
      });
    }

    // Listen to messages from extension without re-rendering HTML
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'savedAll') {
        hasUnsavedChanges = false;
        showSaved('header-save-indicator');
        const saveBtn = document.getElementById('btn-save-all');
        if (saveBtn) {
          saveBtn.classList.remove('has-changes');
          saveBtn.innerHTML = '✓ Settings Saved';
          setTimeout(() => {
            if (!hasUnsavedChanges) {
              saveBtn.innerHTML = '💾 Save Settings';
            }
          }, 2500);
        }
      } else if (msg.command === 'syncState' && msg.data) {
        const d = msg.data;
        if (!hasUnsavedChanges) {
          const setVal = (id, val) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = val; };
          const setCheck = (id, val) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.checked = Boolean(val); };

          setVal('input-port', d.configuredPort);
          setCheck('check-autostart', d.autoStart);
          setVal('select-climode', d.cliMode);
          setCheck('check-prompt-npm', d.promptOnMissingNpm);
          setVal('select-policy', d.secConfig?.policy || 'prompt');
          setVal('select-qsh', d.secConfig?.qshPolicy || 'block');
          setVal('select-pase', d.secConfig?.pasePolicy || 'block');
          setVal('select-cl', d.secConfig?.clPolicy || 'prompt');
          setVal('select-deploy', d.secConfig?.deployPolicy || 'prompt');
          setVal('input-timeout', d.secConfig?.promptTimeoutSeconds ?? 60);
          setCheck('check-actioninsp', d.secConfig?.enableActionInspection);
        }

        // Status badge & token always update
        const badge = document.getElementById('badge-status');
        const statusText = document.getElementById('status-text');
        if (badge && statusText) {
          badge.className = 'status-badge ' + (d.isRunning ? 'running' : 'stopped');
          statusText.textContent = d.isRunning ? ('Bridge Running (' + d.host + ':' + d.port + ')') : 'Bridge Stopped';
        }

        const lifecycleDesc = document.getElementById('server-lifecycle-desc');
        if (lifecycleDesc) {
          lifecycleDesc.innerHTML = 'Status: <strong>' + (d.isRunning ? ('Running at http://' + d.host + ':' + d.port) : 'Stopped') + '</strong>';
        }

        const btnStop = document.getElementById('btn-stop-server');
        if (btnStop) btnStop.style.display = d.isRunning ? 'inline-flex' : 'none';
        const btnRestart = document.getElementById('btn-restart-server');
        if (btnRestart) btnRestart.style.display = d.isRunning ? 'inline-flex' : 'none';
        const btnStart = document.getElementById('btn-start-server');
        if (btnStart) btnStart.style.display = !d.isRunning ? 'inline-flex' : 'none';

        // Token display
        const tokenDisplay = document.getElementById('token-display');
        if (tokenDisplay) tokenDisplay.value = d.token || '';
      }
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function escapeJs(str: string): string {
  return (str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
}
