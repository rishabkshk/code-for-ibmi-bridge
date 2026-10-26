import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { CodeForIBMiAdapter } from './ibmi/adapter';
import { BridgeServer } from './server/httpServer';
import { SecurityGuardrail, SecurityConfig, SecurityPolicy } from './security/guardrail';
import { SettingsWebviewPanel } from './ui/settingsWebview';
import { BridgeSidebarProvider } from './ui/sidebarProvider';

const TOKEN_KEY = 'codeForIBMiBridge.token';
const LEGACY_TOKEN_KEY = 'codefori.bridge.token';
let bridgeServer: BridgeServer | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let sidebarProvider: BridgeSidebarProvider | undefined;

function checkNpmInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('npm --version', { timeout: 3000 }, (err, stdout) => {
      resolve(!err && Boolean(stdout && stdout.trim()));
    });
  });
}

function checkCodeforiGlobalInstalled(extensionPath?: string): Promise<boolean> {
  const isWin = process.platform === 'win32';
  const homeBin = path.join(os.homedir(), '.codefori', 'bin').toLowerCase();
  const extBin = extensionPath ? path.join(extensionPath, 'bin').toLowerCase() : '';

  return new Promise((resolve) => {
    // 1. On Windows, npm global install ALWAYS creates codefori.cmd / codefori-cli.cmd
    if (isWin) {
      exec('where.exe codefori.cmd codefori-cli.cmd', { timeout: 3000 }, (err, stdout) => {
        if (!err && stdout && stdout.trim()) {
          const paths = stdout.trim().split(/\r?\n/).map(p => p.trim());
          const hasNpm = paths.some(p => {
            const low = p.toLowerCase();
            return !low.startsWith(homeBin) && (!extBin || !low.startsWith(extBin));
          });
          if (hasNpm) {
            return resolve(true);
          }
        }
        // Fallback: check via npm list
        exec('npm list -g @rishabkshk/codefori-cli --depth=0', { timeout: 4000 }, (npmErr, npmStdout) => {
          resolve(!npmErr && Boolean(npmStdout && npmStdout.includes('@rishabkshk/codefori-cli')));
        });
      });
      return;
    }

    // 2. POSIX: check which codefori excluding our homeBin and extBin
    exec('which codefori 2>/dev/null || which codefori-cli 2>/dev/null', { timeout: 3000 }, (err, stdout) => {
      if (!err && stdout && stdout.trim()) {
        const resolved = stdout.trim().split(/\r?\n/)[0].trim();
        const low = resolved.toLowerCase();
        if (!low.startsWith(homeBin) && (!extBin || !low.startsWith(extBin))) {
          try {
            const real = fs.realpathSync(resolved);
            if (real.includes('node_modules') || real.endsWith('.js')) {
              return resolve(true);
            }
          } catch {}
        }
      }
      // Fallback: check via npm list
      exec('npm list -g @rishabkshk/codefori-cli --depth=0', { timeout: 4000 }, (npmErr, npmStdout) => {
        resolve(!npmErr && Boolean(npmStdout && npmStdout.includes('@rishabkshk/codefori-cli')));
      });
    });
  });
}

function runNpmInstallCliTerminal(): vscode.Terminal {
  const termName = 'Install Code for IBM i CLI';
  let term = vscode.window.terminals.find(t => t.name === termName);
  if (!term) {
    term = vscode.window.createTerminal({ name: termName });
  }
  term.show();
  term.sendText('npm install -g @rishabkshk/codefori-cli');
  return term;
}

function syncCliScripts(extensionPath: string, activeMethod: 'npm' | 'curl' = 'npm'): { homeBinDir: string; extBinDir: string } {
  const homeBinDir = path.join(os.homedir(), '.codefori', 'bin');
  const extBinDir = path.join(extensionPath, 'bin');

  try {
    if (!fs.existsSync(homeBinDir)) {
      fs.mkdirSync(homeBinDir, { recursive: true });
    }

    // Clean up legacy SEA binaries, powershell scripts, cmd files, and bundle artifacts
    const obsoleteFiles = ['codefori.exe', 'codefori-bin', 'codefori.ps1', 'codefori.cmd', 'cli.bundle.js'];
    for (const obs of obsoleteFiles) {
      const obsPath = path.join(homeBinDir, obs);
      if (fs.existsSync(obsPath)) {
        try { fs.unlinkSync(obsPath); } catch {}
      }
    }

    // Mirror portable POSIX / Git Bash curl scripts
    const runnerFiles = ['codefori', 'codefori.sh'];
    for (const file of runnerFiles) {
      const srcFile = path.join(extBinDir, file);
      const destFile = path.join(homeBinDir, file);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, destFile);
        try { fs.chmodSync(destFile, 0o755); } catch {}
      }
    }
  } catch (err) {
    // Non-fatal sync
  }

  return { homeBinDir, extBinDir };
}

function updateTerminalPath(context: vscode.ExtensionContext, activeMethod: 'npm' | 'curl', homeBinDir: string, extBinDir: string) {
  if (!context.environmentVariableCollection) return;

  if (activeMethod !== 'npm') {
    context.environmentVariableCollection.prepend('PATH', `${homeBinDir}${path.delimiter}${extBinDir}${path.delimiter}`);
    context.environmentVariableCollection.description = 'Code for IBM i CLI (Git Bash / POSIX curl script)';
  } else {
    context.environmentVariableCollection.clear();
  }
}

function getCliBinaryPath(extensionPath: string, activeMethod?: 'npm' | 'curl'): string {
  const scriptName = 'codefori.sh';

  // 1. Stable ~/.codefori/bin/
  const inHome = path.join(os.homedir(), '.codefori', 'bin', scriptName);
  if (fs.existsSync(inHome)) return inHome;

  // 2. Inside extension bin/
  const inExt = path.join(extensionPath, 'bin', scriptName);
  if (fs.existsSync(inExt)) return inExt;

  return inExt;
}

function getCliInvocationCommand(binaryPath: string): string {
  return `"${binaryPath}"`;
}

function getEffectiveCliMode(npmInstalled: boolean, extensionPath?: string): { mode: 'auto' | 'npm' | 'curl'; activeMethod: 'npm' | 'curl' } {
  const config = vscode.workspace.getConfiguration('code-for-ibmi-bridge');
  const configuredMode = config.get<'auto' | 'npm' | 'curl'>('cliMode', 'auto');

  if (configuredMode === 'curl') {
    return { mode: 'curl', activeMethod: 'curl' };
  }
  if (configuredMode === 'npm') {
    return { mode: 'npm', activeMethod: 'npm' };
  }

  // 'auto' mode: prefer npm if globally installed; otherwise Git Bash / POSIX curl script
  if (npmInstalled) {
    return { mode: 'auto', activeMethod: 'npm' };
  }
  return { mode: 'auto', activeMethod: 'curl' };
}

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
    const kebabConfig = vscode.workspace.getConfiguration('code-for-ibmi-bridge.security');
    const camelConfig = vscode.workspace.getConfiguration('codeForIBMiBridge.security');
    const legacyConfig = vscode.workspace.getConfiguration('codefori.security');

    const getVal = <T>(key: string, defVal: T): T => {
      const k = kebabConfig.get<T>(key);
      if (k !== undefined) return k;
      const c = camelConfig.get<T>(key);
      if (c !== undefined) return c;
      return legacyConfig.get<T>(key, defVal);
    };

    const policy = getVal<SecurityPolicy>('policy', 'prompt');

    // QSH policy (default: 'block')
    let qshPolicy = getVal<SecurityPolicy | undefined>('qshPolicy', undefined);
    if (!qshPolicy) {
      const qshKebab = kebabConfig.get<SecurityPolicy>('qsh-policy') || kebabConfig.get<SecurityPolicy>('qsh');
      if (qshKebab) {
        qshPolicy = qshKebab;
      } else {
        const allowQsh = getVal<boolean | undefined>('allowQsh', undefined);
        if (allowQsh !== undefined) {
          qshPolicy = allowQsh ? 'allow' : 'block';
        }
      }
    }
    if (!qshPolicy) qshPolicy = 'block';

    // CL policy (default: 'prompt')
    let clPolicy = getVal<SecurityPolicy | undefined>('clPolicy', undefined);
    if (!clPolicy) {
      const clKebab = kebabConfig.get<SecurityPolicy>('cl-policy') || kebabConfig.get<SecurityPolicy>('cl');
      if (clKebab) {
        clPolicy = clKebab;
      } else {
        const promptAllCl = getVal<boolean | undefined>('promptAllClCommands', undefined);
        if (promptAllCl !== undefined) {
          clPolicy = promptAllCl ? 'prompt' : 'allow';
        }
      }
    }
    if (!clPolicy) clPolicy = 'prompt';

    // PASE policy (default: 'block')
    let pasePolicy = getVal<SecurityPolicy | undefined>('pasePolicy', undefined);
    if (!pasePolicy) {
      const paseKebab = kebabConfig.get<SecurityPolicy>('pase-policy') || kebabConfig.get<SecurityPolicy>('pase');
      if (paseKebab) {
        pasePolicy = paseKebab;
      }
    }
    if (!pasePolicy) pasePolicy = 'block';

    // Deploy policy (default: 'prompt')
    let deployPolicy = getVal<SecurityPolicy | undefined>('deployPolicy', undefined);
    if (!deployPolicy) {
      const deployKebab = kebabConfig.get<SecurityPolicy>('deploy-policy') || kebabConfig.get<SecurityPolicy>('deploy');
      if (deployKebab) {
        deployPolicy = deployKebab;
      }
    }
    if (!deployPolicy) deployPolicy = 'prompt';

    return {
      policy,
      qshPolicy,
      clPolicy,
      pasePolicy,
      deployPolicy,
      requireCliClient: getVal<boolean>('requireCliClient', true),
      promptTimeoutSeconds: getVal<number>('promptTimeoutSeconds', 60),
      customBlockedCommands: getVal<string[]>('customBlockedCommands', []),
      customPromptCommands: getVal<string[]>('customPromptCommands', []),
      allowedCommands: getVal<string[]>('allowedCommands', []),
      enableActionInspection: getVal<boolean>('enableActionInspection', true),
      allowQsh: qshPolicy === 'allow',
      promptAllClCommands: clPolicy === 'prompt'
    };
  };

  const handlePromptUser = async (details: {
    command: string;
    environment: string;
    reason: string;
    matchedPattern?: string;
  }): Promise<boolean> => {
    outputChannel?.appendLine(`[Security Guardrail] Intercepted command requiring approval:`);
    outputChannel?.appendLine(`  Environment: ${details.environment}`);
    outputChannel?.appendLine(`  Command: ${details.command}`);
    outputChannel?.appendLine(`  Reason: ${details.reason}`);

    const allowOption = 'Allow Execution';
    const blockOption = 'Reject';

    const choice = await vscode.window.showWarningMessage(
      `[Security Guardrail Alert]\n\n` +
      `An external AI agent or automation script is requesting to execute a command on the connected IBM i system:\n\n` +
      `Command: ${details.command}\n` +
      `Environment: ${details.environment.toUpperCase()}\n` +
      `Reason: ${details.reason}\n\n` +
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

  // Detect npm and native binary availability
  const npmInstalled = await checkNpmInstalled();
  const cliGlobalInstalled = npmInstalled ? await checkCodeforiGlobalInstalled(context.extensionPath) : false;
  const bridgeConfig = vscode.workspace.getConfiguration('code-for-ibmi-bridge');
  const { mode: cliMode, activeMethod } = getEffectiveCliMode(npmInstalled, context.extensionPath);
  const promptOnMissingNpm = bridgeConfig.get<boolean>('promptOnMissingNpm', true);
  const cliBinaryPath = getCliBinaryPath(context.extensionPath, activeMethod);

  // Sync CLI scripts based on activeMethod and register in Integrated Terminal PATH
  const { homeBinDir, extBinDir } = syncCliScripts(context.extensionPath, activeMethod);
  updateTerminalPath(context, activeMethod, homeBinDir, extBinDir);

  bridgeServer.setFallbackInfo(activeMethod === 'curl', cliBinaryPath, npmInstalled);

  if (npmInstalled && !cliGlobalInstalled && cliMode === 'auto') {
    const PROMPT_INSTALL_CLI_KEY = 'codeForIBMiBridge.dismissedNpmInstallPrompt';
    const alreadyDismissed = context.globalState.get<boolean>(PROMPT_INSTALL_CLI_KEY, false);

    if (!alreadyDismissed) {
      const optInstall = 'Install via npm';
      const optUseCurl = 'Use Git Bash / curl Script';
      const optDismiss = "Don't Ask Again";
      const choices = [optInstall, optUseCurl, optDismiss];

      vscode.window.showInformationMessage(
        `Node.js and npm were detected, but Code for IBM i CLI (@rishabkshk/codefori-cli) is not yet installed globally. Would you like to install it?`,
        ...choices
      ).then(async (choice) => {
        if (choice === optInstall) {
          runNpmInstallCliTerminal();
        } else if (choice === optUseCurl) {
          await bridgeConfig.update('cliMode', 'curl', vscode.ConfigurationTarget.Global);
          const cliCmd = getCliInvocationCommand(cliBinaryPath);
          await vscode.env.clipboard.writeText(`${cliCmd} status`);
          vscode.window.showInformationMessage(`Code for IBM i Bridge: CLI mode set to 'curl'. Command '${cliCmd} status' copied to clipboard.`);
          outputChannel?.appendLine(`[Bridge] CLI mode updated to 'curl'. Script: ${cliBinaryPath}`);
        } else if (choice === optDismiss) {
          await context.globalState.update(PROMPT_INSTALL_CLI_KEY, true);
        }
      });
    }
  } else if (!npmInstalled && promptOnMissingNpm) {
    const PROMPT_STORAGE_KEY = 'codeForIBMiBridge.dismissedNpmFallbackPrompt';
    const alreadyDismissed = context.globalState.get<boolean>(PROMPT_STORAGE_KEY, false);

    if (!alreadyDismissed) {
      const cliCmd = getCliInvocationCommand(cliBinaryPath);
      const optUseFallback = 'Use Git Bash / curl Script';
      const optCopyCommand = 'Copy Command';
      const optDismiss = "Don't Ask Again";

      vscode.window.showInformationMessage(
        `Node.js / npm was not detected on this system. Would you like to use the zero-dependency Git Bash / POSIX script (codefori.sh) to interact with Code for IBM i Bridge?`,
        optUseFallback,
        optCopyCommand,
        optDismiss
      ).then(async (choice) => {
        if (choice === optUseFallback) {
          await bridgeConfig.update('cliMode', 'curl', vscode.ConfigurationTarget.Global);
          await vscode.env.clipboard.writeText(`${cliCmd} status`);
          vscode.window.showInformationMessage(`Code for IBM i Bridge: CLI mode set to 'curl'. Command '${cliCmd} status' copied to clipboard.`);
          outputChannel?.appendLine(`[Bridge] CLI mode updated to 'curl'. Script: ${cliBinaryPath}`);
        } else if (choice === optCopyCommand) {
          await vscode.env.clipboard.writeText(`${cliCmd} status`);
          vscode.window.showInformationMessage(`Code for IBM i Bridge: Command '${cliCmd} status' copied to clipboard.`);
        } else if (choice === optDismiss) {
          await context.globalState.update(PROMPT_STORAGE_KEY, true);
        }
      });
    }
  }

  // Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
  statusBarItem.command = 'codeForIBMiBridge.showStatus';
  context.subscriptions.push(statusBarItem);

  // 5. Command Implementations
  const startCmd = async () => {
    const port = vscode.workspace.getConfiguration('code-for-ibmi-bridge').get<number>('port')
      ?? vscode.workspace.getConfiguration('codeForIBMiBridge').get<number>('port')
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

  const copyCurlCommandCmd = async () => {
    const isNpm = await checkNpmInstalled();
    const { activeMethod } = getEffectiveCliMode(isNpm, context.extensionPath);
    let cmd = 'codefori status';
    if (activeMethod === 'curl') {
      const cliPath = getCliBinaryPath(context.extensionPath, 'curl');
      cmd = `${getCliInvocationCommand(cliPath)} status`;
    }
    await vscode.env.clipboard.writeText(cmd);
    vscode.window.showInformationMessage(`Code for IBM i Bridge: CLI command copied to clipboard: ${cmd}`);
  };

  const configureCliModeCmd = async () => {
    const config = vscode.workspace.getConfiguration('code-for-ibmi-bridge');
    const currentMode = config.get<string>('cliMode', 'auto');

    const choices = [
      {
        id: 'auto',
        label: '$(sync) auto',
        description: 'Auto-detect: Prefer npm package if installed, otherwise use Git Bash / POSIX curl script (Default)',
        picked: currentMode === 'auto'
      },
      {
        id: 'npm',
        label: '$(package) npm',
        description: 'Force npm: Always use Node.js / npm CLI package (@rishabkshk/codefori-cli)',
        picked: currentMode === 'npm'
      },
      {
        id: 'curl',
        label: '$(terminal-bash) curl',
        description: 'Force curl: Always use zero-dependency Git Bash / POSIX script (codefori.sh)',
        picked: currentMode === 'curl'
      }
    ];

    const selected = await vscode.window.showQuickPick(choices, {
      placeHolder: `Select CLI Interaction Mode (Current: ${currentMode})`
    });

    if (selected) {
      await config.update('cliMode', selected.id, vscode.ConfigurationTarget.Global);
      const isNpm = await checkNpmInstalled();
      const { activeMethod: newMethod } = getEffectiveCliMode(isNpm, context.extensionPath);
      const { homeBinDir, extBinDir } = syncCliScripts(context.extensionPath, newMethod);
      updateTerminalPath(context, newMethod, homeBinDir, extBinDir);
      vscode.window.showInformationMessage(`Code for IBM i Bridge: CLI mode set to '${selected.id}'.`);
      outputChannel?.appendLine(`[Bridge] CLI mode updated to '${selected.id}'.`);
    }
  };

  const configureSecurityCmd = async () => {
    const config = getSecurityConfig();

    const categoryChoices = [
      {
        id: 'policy',
        label: '$(shield) Destructive Commands Policy',
        description: `Current: ${config.policy}`,
        detail: 'Controls guardrail behavior when potentially destructive commands (DLT*, CLR*, etc.) are detected'
      },
      {
        id: 'qshPolicy',
        label: '$(terminal-bash) QSH Execution Policy',
        description: `Current: ${config.qshPolicy}`,
        detail: 'Controls execution of QSH shell commands, STRQSH invocations, and actions in QSH environment'
      },
      {
        id: 'pasePolicy',
        label: '$(terminal-powershell) PASE Execution Policy',
        description: `Current: ${config.pasePolicy}`,
        detail: 'Controls execution of direct PASE shell commands and environments (/run-command -Env pase)'
      },
      {
        id: 'clPolicy',
        label: '$(terminal) IBM i CL Commands Policy',
        description: `Current: ${config.clPolicy}`,
        detail: 'Controls execution of direct IBM i CL commands (/run-cl). Predefined actions are exempted.'
      },
      {
        id: 'deployPolicy',
        label: '$(cloud-upload) Workspace Deploy Policy',
        description: `Current: ${config.deployPolicy}`,
        detail: 'Controls workspace deployment to IBM i IFS; prioritizes targeted file selection over blanket deploys'
      }
    ];

    const chosenCategory = await vscode.window.showQuickPick(categoryChoices, {
      placeHolder: 'Select security guardrail area to configure'
    });

    if (!chosenCategory) return;

    const currentVal = chosenCategory.id === 'policy' ? config.policy
      : chosenCategory.id === 'qshPolicy' ? config.qshPolicy
      : chosenCategory.id === 'pasePolicy' ? config.pasePolicy
      : chosenCategory.id === 'clPolicy' ? config.clPolicy
      : config.deployPolicy;

    const policyChoices = [
      {
        label: 'block',
        description: 'Strictly block execution automatically without prompts',
        picked: currentVal === 'block'
      },
      {
        label: 'prompt',
        description: 'Require AI agent or client to request user confirmation in chat before execution',
        picked: currentVal === 'prompt'
      },
      {
        label: 'modal',
        description: 'Display an interactive modal confirmation dialog in VS Code for user approval',
        picked: currentVal === 'modal'
      },
      {
        label: 'allow',
        description: 'Permit execution without guardrail intervention (Permissive)',
        picked: currentVal === 'allow'
      }
    ];

    const selectedPolicy = await vscode.window.showQuickPick(policyChoices, {
      placeHolder: `Select policy for ${chosenCategory.label} (Current: ${currentVal})`
    });

    if (selectedPolicy) {
      const secConfig = vscode.workspace.getConfiguration('code-for-ibmi-bridge.security');
      await secConfig.update(chosenCategory.id, selectedPolicy.label, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Code for IBM i Bridge: ${chosenCategory.label} updated to '${selectedPolicy.label}'.`);
      outputChannel?.appendLine(`[Security Guardrail] ${chosenCategory.id} updated to '${selectedPolicy.label}'.`);
    }
  };

  const openSettingsCmd = () => {
    SettingsWebviewPanel.createOrShow(
      context.extensionUri,
      bridgeServer,
      getSecurityConfig,
      handleTokenReset,
      async () => { await startCmd(); sidebarProvider?.refresh(); },
      async () => { await stopCmd(); sidebarProvider?.refresh(); },
      getEffectiveCliMode,
      checkNpmInstalled,
      () => getCliBinaryPath(context.extensionPath)
    );
  };

  sidebarProvider = new BridgeSidebarProvider(
    bridgeServer,
    getSecurityConfig,
    getEffectiveCliMode,
    checkNpmInstalled
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('codeForIBMiBridge.sidebar', sidebarProvider)
  );

  const showStatusCmd = async () => {
    if (!bridgeServer || !bridgeServer.isRunning()) {
      const openSettingsOption = '$(gear) Open Settings';
      const startOption = 'Start Server';
      const choice = await vscode.window.showWarningMessage('Code for IBM i Bridge is currently stopped.', openSettingsOption, startOption);
      if (choice === openSettingsOption) {
        openSettingsCmd();
      } else if (choice === startOption) {
        startCmd();
      }
      return;
    }

    const host = bridgeServer.getHost();
    const port = bridgeServer.getPort();
    const currentToken = bridgeServer.getToken();
    const extActive = adapter.isActive();
    const secConfig = getSecurityConfig();
    const isNpm = await checkNpmInstalled();
    const { mode: configuredCliMode, activeMethod } = getEffectiveCliMode(isNpm, context.extensionPath);
    const cliPath = getCliBinaryPath(context.extensionPath, activeMethod);
    let cliCmd = 'codefori';
    if (activeMethod === 'curl') {
      cliCmd = getCliInvocationCommand(cliPath);
    }

    const items = [
      '$(gear) Settings',
      `Server: Running on port ${port}`,
      `CLI Mode: ${configuredCliMode} (Active: ${activeMethod}) - Click to Change`,
      `Destructive Policy: ${secConfig.policy}`,
      `QSH Policy: ${secConfig.qshPolicy}`,
      `PASE Policy: ${secConfig.pasePolicy}`,
      `CL Policy: ${secConfig.clPolicy}`,
      `Deploy Policy: ${secConfig.deployPolicy}`,
      'Configure CLI Mode (auto / npm / curl)',
      'Configure Security Policy',
      'Copy Token to Clipboard',
      'Copy CLI Environment Export Command',
      'Copy CLI Command'
    ];

    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: `Code for IBM i Bridge running at http://${host}:${port} [CLI: ${activeMethod} | Destructive: ${secConfig.policy} | QSH: ${secConfig.qshPolicy} | PASE: ${secConfig.pasePolicy} | CL: ${secConfig.clPolicy}]`
    });

    if (choice === '$(gear) Settings') {
      openSettingsCmd();
    } else if (choice === 'Configure CLI Mode (auto / npm / curl)' || choice?.startsWith('CLI Mode:')) {
      configureCliModeCmd();
    } else if (choice === 'Configure Security Policy') {
      configureSecurityCmd();
    } else if (choice === 'Copy Token to Clipboard') {
      await vscode.env.clipboard.writeText(currentToken);
      vscode.window.showInformationMessage('Bridge token copied to clipboard.');
    } else if (choice === 'Copy CLI Environment Export Command') {
      const cmd = `export CODEFORI_HOST=${host} CODEFORI_PORT=${port} CODEFORI_TOKEN=${currentToken}`;
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.showInformationMessage('CLI environment export command copied to clipboard.');
    } else if (choice === 'Copy CLI Command') {
      await vscode.env.clipboard.writeText(`${cliCmd} status`);
      vscode.window.showInformationMessage(`CLI command '${cliCmd} status' copied to clipboard.`);
    }
  };

  const installNpmCliCmd = async () => {
    const isNpm = await checkNpmInstalled();
    if (!isNpm) {
      vscode.window.showErrorMessage('Code for IBM i Bridge: Node.js / npm is not installed or not found on system PATH.');
      return;
    }
    runNpmInstallCliTerminal();
  };

  const generateAgentDocCmd = async () => {
    const isNpm = await checkNpmInstalled();
    const { activeMethod } = getEffectiveCliMode(isNpm, context.extensionPath);
    const cliPath = getCliBinaryPath(context.extensionPath, activeMethod);
    const cliCmd = activeMethod === 'npm' ? 'codefori' : getCliInvocationCommand(cliPath);
    syncAgentDoc(vscode.workspace.workspaceFolders, cliCmd);
    vscode.window.showInformationMessage('Code for IBM i Bridge: AI Agent instructions (AGENTS.md) updated in workspace.');
  };

  // 6. Register VS Code Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codeForIBMiBridge.openSettings', openSettingsCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.start', async () => { await startCmd(); sidebarProvider?.refresh(); }),
    vscode.commands.registerCommand('codeForIBMiBridge.stop', async () => { await stopCmd(); sidebarProvider?.refresh(); }),
    vscode.commands.registerCommand('codeForIBMiBridge.resetToken', resetTokenCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.configureSecurity', configureSecurityCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.configureCliMode', configureCliModeCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.showStatus', showStatusCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.copyCurlCommand', copyCurlCommandCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.installNpmCli', installNpmCliCmd),
    vscode.commands.registerCommand('codeForIBMiBridge.generateAgentDoc', generateAgentDocCmd)
  );

  // 7. Auto-start Server if configured
  const kebabBridgeConfig = vscode.workspace.getConfiguration('code-for-ibmi-bridge');
  const camelBridgeConfig = vscode.workspace.getConfiguration('codeForIBMiBridge');
  const legacyBridgeConfig = vscode.workspace.getConfiguration('codefori.bridge');
  const autoStart = kebabBridgeConfig.get<boolean>('autoStart')
    ?? camelBridgeConfig.get<boolean>('autoStart')
    ?? legacyBridgeConfig.get<boolean>('autoStart', true);
  const configuredPort = kebabBridgeConfig.get<number>('port')
    ?? camelBridgeConfig.get<number>('port')
    ?? legacyBridgeConfig.get<number>('port', 0);

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
  const isNpm = await checkNpmInstalled();
  const { mode: configuredCliMode, activeMethod: currentActiveMethod } = getEffectiveCliMode(isNpm, context.extensionPath);
  const cliPath = getCliBinaryPath(context.extensionPath, currentActiveMethod);
  const cliCmd = currentActiveMethod === 'npm' ? 'codefori' : getCliInvocationCommand(cliPath);
  writeBridgeStateFile(host, activePort, token, {
    cliMode: configuredCliMode,
    activeMethod: currentActiveMethod,
    cliBinary: cliPath,
    cliCommand: cliCmd,
    preferredClient: 'codefori',
    agentInstructions: `Always interact with Code for IBM i using the CLI command: ${cliCmd} <subcommand>. Direct raw curl/HTTP access is disabled by security guardrails.`,
    fallbackScript: cliPath
  });
  syncAgentDoc(vscode.workspace.workspaceFolders, cliCmd);
  sidebarProvider?.refresh();
}

async function stopBridgeServer(): Promise<void> {
  if (bridgeServer && bridgeServer.isRunning()) {
    await bridgeServer.stop();
  }
  if (statusBarItem) {
    statusBarItem.hide();
  }
  removeBridgeStateFile();
  sidebarProvider?.refresh();
  outputChannel?.appendLine('[Bridge Server] Stopped.');
}

function getBridgeStatePaths(): string[] {
  return [
    path.join(os.homedir(), '.code-for-ibmi-bridge', 'bridge.json'),
    path.join(os.homedir(), '.codefori', 'bridge.json')
  ];
}

function writeBridgeStateFile(host: string, port: number, token: string, extra?: Record<string, any>): void {
  const paths = getBridgeStatePaths();
  const data = JSON.stringify({
    host,
    port,
    token,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    ...extra
  }, null, 2);

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

const AGENT_DOC_MARKER_START = '<!-- CODEFORI_GUIDE_START -->';
const AGENT_DOC_MARKER_END = '<!-- CODEFORI_GUIDE_END -->';

export function generateAgentDocContent(cliCmd: string): string {
  return [
    `# Code for IBM i Bridge — AI Coding Agent Guidelines`,
    ``,
    `This repository uses the **Code for IBM i Bridge** extension. The intended development model is **local development** in VS Code, followed by **deploying, compiling, and testing on the remote IBM i system** through the bridge CLI (\`codefori\`).`,
    ``,
    `## Prerequisites`,
    `- **Git Bash (Windows)**: When running on Windows, all CLI commands **MUST** be executed within Git Bash (\`bash.exe\` / \`sh.exe\`). Do NOT execute the curl runner script in PowerShell or CMD.`,
    `- **VS Code & Bridge**: Visual Studio Code must be running with the Code for IBM i connection active and the Bridge server running.`,
    ``,
    `## Workspace Actions & \`.vscode/actions.json\``,
    `Workspace compilation and build actions are configured in **\`.vscode/actions.json\`**:`,
    `- Always inspect \`.vscode/actions.json\` or run \`${cliCmd} list-actions\` to discover the exact action names (e.g. \`Create Bound RPG Program (CRTBNDRPG)\`, \`Create SQL ILE RPG Object (CRTSQLRPGI)\`) and file associations for this project.`,
    `- Actions configured in \`.vscode/actions.json\` take top priority and are pre-screened, allowing seamless non-interactive compilation without prompt blocks.`,
    `- If an action in \`.vscode/actions.json\` has \`deployFirst: true\`, the Code for IBM i extension will automatically deploy the file before compiling.`,
    ``,
    `## Standard Development & Test Lifecycle`,
    `1. **Local Edit**: Modify source files locally in the workspace (e.g., \`qrpglesrc/myprog.rpgle\`).`,
    `2. **Check Actions**: Review \`.vscode/actions.json\` or execute \`${cliCmd} list-actions\`.`,
    `3. **Deploy & Compile**: Execute the matching compilation action:`,
    `   \`\`\`bash`,
    `   ${cliCmd} run-action -n "<Action Name>" -f "path/to/source.rpgle"`,
    `   \`\`\``,
    `4. **Diagnose on Failure**: If compilation fails, immediately inspect compiler errors and EVFEVENT diagnostics:`,
    `   \`\`\`bash`,
    `   ${cliCmd} diagnostics`,
    `   ${cliCmd} read-eventf -o "MYLIB/MYPGM"`,
    `   \`\`\``,
    `5. **Test on IBM i**: Run verification programs or check system status safely:`,
    `   \`\`\`bash`,
    `   ${cliCmd} run-cl -c "CALL PGM(MYLIB/MYPGM)" --confirm`,
    `   \`\`\``,
    ``,
    `## Critical Rules & Guardrails`,
    `1. **DO NOT use raw \`curl\`**: Direct HTTP/curl requests to the bridge server loopback port are blocked (\`requireCliClient: true\`). Always use \`${cliCmd}\`.`,
    `2. **DO NOT use QSH or PASE**: Direct QSH and PASE shell execution is strictly disabled by default security policies (\`qshPolicy: block\`, \`pasePolicy: block\`). Do NOT run \`STRQSH\`, \`QSH\`, or PASE shell scripts.`,
    `3. **Destructive Operations Require User Confirmation**: Any command that deletes or clears objects (\`DLTLIB\`, \`DLTOBJ\`, \`DLTF\`, \`CLRPFM\`, etc.) requires explicit confirmation. Prompt the user in chat first, and once confirmed, pass \`--confirm\`.`,
    `4. **Targeted Deployment**: When deploying files, prioritize targeting specific modified files using \`--files "path/to/file"\` rather than blanket deploys. Blanket deploys require \`--confirm\`.`,
    `5. **Inspect Compiler Messages**: Never speculate on why a build failed. Always inspect the compiler listing via \`${cliCmd} diagnostics\` or \`${cliCmd} read-eventf\`.`,
    ``,
    `## Quick Reference`,
    `\`\`\`bash`,
    `# Check connection and active library`,
    `${cliCmd} status`,
    ``,
    `# List actions from .vscode/actions.json`,
    `${cliCmd} list-actions`,
    ``,
    `# Compile a source file`,
    `${cliCmd} run-action -n "Create Bound RPG Program (CRTBNDRPG)" -f "qrpglesrc/myprog.rpgle"`,
    ``,
    `# View compiler errors`,
    `${cliCmd} diagnostics`,
    `${cliCmd} read-eventf -o "MYLIB/MYPGM"`,
    ``,
    `# Deploy targeted changed files to IFS`,
    `${cliCmd} deploy -m changes --files "qrpglesrc/myprog.rpgle"`,
    ``,
    `# Run CL command (requires --confirm)`,
    `${cliCmd} run-cl -c "DSPOBJD OBJ(MYLIB/*ALL) OBJTYPE(*PGM)" --confirm`,
    `\`\`\``
  ].join('\n');
}

export function syncAgentDoc(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined, cliCmd: string): void {
  const config = vscode.workspace.getConfiguration('code-for-ibmi-bridge');
  const shouldGenerate = config.get<boolean>('generateAgentDoc', true);
  if (!shouldGenerate || !workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const guideBody = generateAgentDocContent(cliCmd);
  const blockContent = `${AGENT_DOC_MARKER_START}\n${guideBody}\n${AGENT_DOC_MARKER_END}\n`;

  for (const folder of workspaceFolders) {
    const docPath = path.join(folder.uri.fsPath, 'AGENTS.md');
    try {
      if (fs.existsSync(docPath)) {
        const existing = fs.readFileSync(docPath, 'utf8');
        const startIndex = existing.indexOf(AGENT_DOC_MARKER_START);
        const endIndex = existing.indexOf(AGENT_DOC_MARKER_END);

        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
          const before = existing.substring(0, startIndex);
          const after = existing.substring(endIndex + AGENT_DOC_MARKER_END.length);
          fs.writeFileSync(docPath, `${before}${blockContent.trim()}${after}`, 'utf8');
        } else {
          const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
          fs.writeFileSync(docPath, `${existing}${separator}${blockContent}`, 'utf8');
        }
      } else {
        fs.writeFileSync(docPath, blockContent, 'utf8');
      }
      outputChannel?.appendLine(`[Agent Doc] Synchronized AGENTS.md at ${docPath}`);
    } catch (err: any) {
      outputChannel?.appendLine(`[Agent Doc] Failed to write AGENTS.md to ${docPath}: ${err?.message}`);
    }
  }
}


