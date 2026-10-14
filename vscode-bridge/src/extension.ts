import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeForIBMiAdapter } from './ibmi/adapter';
import { BridgeServer } from './server/httpServer';
import { SecurityGuardrail, SecurityConfig, SecurityPolicy } from './security/guardrail';

const TOKEN_KEY = 'codeForIBMiBridge.token';
const LEGACY_TOKEN_KEY = 'codefori.bridge.token';
let bridgeServer: BridgeServer | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Code for IBM i Bridge');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('[Bridge] Activating Code for IBM i Bridge Extension...');

  // 1. Token Management
  let token = context.globalState.get<string>(TOKEN_KEY) || context.globalState.get<string>(LEGACY_TOKEN_KEY);
  if (!token) {
    token = generateSecureToken();
    await context.globalState.update(TOKEN_KEY, token);
    outputChannel.appendLine('[Bridge] Generated new secure bridge authentication token.');
  } else {
    // Migrate to new key if needed
    if (!context.globalState.get<string>(TOKEN_KEY)) {
      await context.globalState.update(TOKEN_KEY, token);
    }
    outputChannel.appendLine('[Bridge] Loaded existing authentication token from globalState.');
  }

  // 2. Initialize Adapter
  const adapter = new CodeForIBMiAdapter();

  // Helper for token reset
  const handleTokenReset = async (): Promise<string> => {
    const newToken = generateSecureToken();
    await context.globalState.update(TOKEN_KEY, newToken);
    if (bridgeServer) {
      bridgeServer.updateToken(newToken);
      writeBridgeStateFile(bridgeServer.getHost(), bridgeServer.getPort(), newToken);
    }
    outputChannel?.appendLine(`[Bridge] Token was reset: ${newToken}`);
    vscode.window.showInformationMessage('Code for IBM i Bridge: Authentication token has been reset.');
    return newToken;
  };

  // 3. Security Guardrail Configuration & UI Prompter
  const getSecurityConfig = (): SecurityConfig => {
    const config = vscode.workspace.getConfiguration('codeForIBMiBridge.security');
    const legacyConfig = vscode.workspace.getConfiguration('codefori.security');
    return {
      policy: config.get<SecurityPolicy>('policy') || legacyConfig.get<SecurityPolicy>('policy', 'prompt'),
      promptTimeoutSeconds: config.get<number>('promptTimeoutSeconds') ?? legacyConfig.get<number>('promptTimeoutSeconds', 60),
      customBlockedCommands: config.get<string[]>('customBlockedCommands') || legacyConfig.get<string[]>('customBlockedCommands', []),
      customPromptCommands: config.get<string[]>('customPromptCommands') || legacyConfig.get<string[]>('customPromptCommands', []),
      allowedCommands: config.get<string[]>('allowedCommands') || legacyConfig.get<string[]>('allowedCommands', []),
      enableActionInspection: config.get<boolean>('enableActionInspection') ?? legacyConfig.get<boolean>('enableActionInspection', true)
    };
  };

  const handlePromptUser = async (details: {
    command: string;
    environment: string;
    reason: string;
    matchedPattern?: string;
  }): Promise<boolean> => {
    outputChannel?.appendLine(`[Security Guardrail] Intercepted potentially destructive command:`);
    outputChannel?.appendLine(`  Environment: ${details.environment}`);
    outputChannel?.appendLine(`  Command: ${details.command}`);
    outputChannel?.appendLine(`  Reason: ${details.reason}`);

    const allowOption = 'Allow Execution';
    const blockOption = 'Reject';

    const choice = await vscode.window.showWarningMessage(
      `[Security Guardrail Alert]\n\n` +
      `An external AI agent or automation script is requesting to execute a potentially destructive command on the connected IBM i system:\n\n` +
      `Command: ${details.command}\n` +
      `Environment: ${details.environment.toUpperCase()}\n` +
      `Trigger: ${details.reason}\n\n` +
      `Do you want to allow this command to execute?`,
      { modal: true },
      allowOption,
      blockOption
    );

    const approved = choice === allowOption;
    outputChannel?.appendLine(`[Security Guardrail] User decision: ${approved ? 'APPROVED' : 'REJECTED'}`);
    return approved;
  };

  const guardrail = new SecurityGuardrail(getSecurityConfig, handlePromptUser);

  // 4. Initialize HTTP Server
  bridgeServer = new BridgeServer(token, adapter, handleTokenReset, guardrail);

  // Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
  statusBarItem.command = 'codeForIBMiBridge.showStatus';
  context.subscriptions.push(statusBarItem);

  // 5. Command Implementations
  const startCmd = async () => {
    const port = vscode.workspace.getConfiguration('codeForIBMiBridge').get<number>('port')
      ?? vscode.workspace.getConfiguration('codefori.bridge').get<number>('port', 0);
    try {
      await startBridgeServer(port, context);
      vscode.window.showInformationMessage(`Bridge server started on 127.0.0.1:${bridgeServer?.getPort()}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to start bridge: ${err.message}`);
    }
  };

  const stopCmd = async () => {
    await stopBridgeServer();
    vscode.window.showInformationMessage('Bridge server stopped.');
  };

  const resetTokenCmd = async () => {
    await handleTokenReset();
  };

  const configureSecurityCmd = async () => {
    const currentPolicy = getSecurityConfig().policy;
    const choices = [
      {
        label: 'prompt',
        description: 'Agent confirmation: Agent asks user in chat, then re-runs with confirm flag (Default)',
        picked: currentPolicy === 'prompt'
      },
      {
        label: 'block',
        description: 'Strictly block all destructive commands automatically',
        picked: currentPolicy === 'block'
      },
      {
        label: 'modal',
        description: 'Show blocking modal dialog in VS Code for confirmation',
        picked: currentPolicy === 'modal'
      },
      {
        label: 'allow',
        description: 'Allow all commands without prompt or restriction (Permissive)',
        picked: currentPolicy === 'allow'
      }
    ];

    const selected = await vscode.window.showQuickPick(choices, {
      placeHolder: `Select Security Guardrail Policy (Current: ${currentPolicy})`
    });

    if (selected) {
      const secConfig = vscode.workspace.getConfiguration('codeForIBMiBridge.security');
      await secConfig.update('policy', selected.label, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Code for IBM i Bridge: Security policy updated to '${selected.label}'.`);
      outputChannel?.appendLine(`[Security Guardrail] Policy updated to '${selected.label}'.`);
    }
  };

  const showStatusCmd = async () => {
    if (!bridgeServer || !bridgeServer.isRunning()) {
      const startOption = 'Start Server';
      const choice = await vscode.window.showWarningMessage('Code for IBM i Bridge is currently stopped.', startOption);
      if (choice === startOption) {
        startCmd();
      }
      return;
    }

    const host = bridgeServer.getHost();
    const port = bridgeServer.getPort();
    const currentToken = bridgeServer.getToken();
    const extActive = adapter.isActive();
    const secPolicy = getSecurityConfig().policy;

    const items = [
      `Host: ${host}`,
      `Port: ${port}`,
      `Token: ${currentToken}`,
      `Extension Active: ${extActive ? 'Yes' : 'No'}`,
      `Security Policy: ${secPolicy} (Click 'Configure Security Policy' to change)`,
      'Configure Security Policy',
      'Copy Token to Clipboard',
      'Copy CLI Environment Export Command'
    ];

    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: `Code for IBM i Bridge running at http://${host}:${port} [Security: ${secPolicy}]`
    });

    if (choice === 'Configure Security Policy') {
      configureSecurityCmd();
    } else if (choice === 'Copy Token to Clipboard') {
      await vscode.env.clipboard.writeText(currentToken);
      vscode.window.showInformationMessage('Bridge token copied to clipboard.');
    } else if (choice === 'Copy CLI Environment Export Command') {
      const cmd = `export CODEFORI_HOST=${host} CODEFORI_PORT=${port} CODEFORI_TOKEN=${currentToken}`;
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.showInformationMessage('CLI environment export command copied to clipboard.');
    }
  };

  // 6. Register VS Code Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codeForIBMiBridge.start', startCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.stop', stopCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.resetToken', resetTokenCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.configureSecurity', configureSecurityCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.showStatus', showStatusCmd)
  );

  // 7. Auto-start Server if configured
  const bridgeConfig = vscode.workspace.getConfiguration('codeForIBMiBridge');
  const legacyBridgeConfig = vscode.workspace.getConfiguration('codefori.bridge');
  const autoStart = bridgeConfig.get<boolean>('autoStart', legacyBridgeConfig.get<boolean>('autoStart', true));
  const configuredPort = bridgeConfig.get<number>('port', legacyBridgeConfig.get<number>('port', 0));

  if (autoStart) {
    try {
      await startBridgeServer(configuredPort, context);
    } catch (err: any) {
      outputChannel.appendLine(`[Bridge] Failed to start server on activation: ${err.message}`);
      vscode.window.showErrorMessage(`Code for IBM i Bridge failed to start: ${err.message}`);
    }
  }

  outputChannel.appendLine('[Bridge] Activation complete.');
}

export async function deactivate() {
  await stopBridgeServer();
  outputChannel?.appendLine('[Bridge] Deactivated.');
}

function generateSecureToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function startBridgeServer(port: number, context: vscode.ExtensionContext): Promise<void> {
  if (!bridgeServer) return;

  const { host, port: activePort } = await bridgeServer.start(port);
  const token = bridgeServer.getToken();

  // Print active port and token to OutputChannel and Debug Console
  outputChannel?.appendLine('========================================================');
  outputChannel?.appendLine(`[Bridge Server] Active at http://${host}:${activePort}`);
  outputChannel?.appendLine(`[Bridge Server] Authentication Token: ${token}`);
  outputChannel?.appendLine('========================================================');

  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    console.log(`[Bridge Server] Active at http://${host}:${activePort}`);
    console.log(`[Bridge Server] Token: ${token}`);
  }

  // Update Status Bar
  if (statusBarItem) {
    statusBarItem.text = `$(radio-tower) Bridge:${activePort}`;
    statusBarItem.tooltip = `Code for IBM i Bridge running on 127.0.0.1:${activePort}`;
    statusBarItem.show();
  }

  // Write discoverable bridge state for CLI auto-handshake
  writeBridgeStateFile(host, activePort, token);
}

async function stopBridgeServer(): Promise<void> {
  if (bridgeServer && bridgeServer.isRunning()) {
    await bridgeServer.stop();
  }
  if (statusBarItem) {
    statusBarItem.hide();
  }
  removeBridgeStateFile();
  outputChannel?.appendLine('[Bridge Server] Stopped.');
}

function getBridgeStatePaths(): string[] {
  return [
    path.join(os.homedir(), '.code-for-ibmi-bridge', 'bridge.json'),
    path.join(os.homedir(), '.codefori', 'bridge.json')
  ];
}

function writeBridgeStateFile(host: string, port: number, token: string): void {
  const paths = getBridgeStatePaths();
  const data = JSON.stringify({ host, port, token, pid: process.pid, updatedAt: new Date().toISOString() }, null, 2);

  for (const filePath of paths) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, data, 'utf-8');
    } catch (err) {
      outputChannel?.appendLine(`[Bridge] Notice: Could not write state file ${filePath}: ${err}`);
    }
  }
}

function removeBridgeStateFile(): void {
  const paths = getBridgeStatePaths();
  for (const filePath of paths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore
    }
  }
}

