import * as vscode from 'vscode';
import { Action, ActionResult, BridgeStatus, CodeForIBMi, DeploymentMethod } from './types';

export const EXTENSION_ID = 'halcyontechltd.code-for-ibmi';

export class CodeForIBMiAdapter {
  private extension: vscode.Extension<CodeForIBMi> | undefined;

  constructor() {
    this.refreshExtension();
  }

  public refreshExtension(): vscode.Extension<CodeForIBMi> | undefined {
    this.extension = vscode.extensions.getExtension<CodeForIBMi>(EXTENSION_ID);
    return this.extension;
  }

  public isInstalled(): boolean {
    return !!this.refreshExtension();
  }

  public isActive(): boolean {
    const ext = this.refreshExtension();
    return ext ? ext.isActive : false;
  }

  public async activate(): Promise<{ activated: boolean; exportedKeys: string[] }> {
    const ext = this.refreshExtension();
    if (!ext) {
      throw new Error(
        `Extension '${EXTENSION_ID}' is not installed in VS Code. ` +
        `Please install it from the VS Code Extensions marketplace (Ctrl+Shift+X or 'code --install-extension ${EXTENSION_ID}').`
      );
    }

    if (!ext.isActive) {
      await ext.activate();
    }

    const exportedKeys = ext.exports ? Object.keys(ext.exports) : [];
    return {
      activated: ext.isActive,
      exportedKeys
    };
  }

  public getExportedApi(): CodeForIBMi | undefined {
    const ext = this.refreshExtension();
    if (ext && ext.isActive && ext.exports) {
      return ext.exports;
    }
    return undefined;
  }

  public getStatus(port: number, tokenConfigured: boolean): BridgeStatus {
    const ext = this.refreshExtension();
    const installed = !!ext;
    const active = ext?.isActive ?? false;
    const api = this.getExportedApi();
    const connection = api?.instance?.getConnection();
    const connected = connection !== undefined && connection !== null;

    return {
      ready: installed && active,
      extensionFound: installed,
      extensionActive: active,
      tokenConfigured,
      connected,
      connectionName: connection?.currentConnectionName,
      host: connection?.currentHost,
      port
    };
  }

  public async getActions(workspaceIndex?: number): Promise<Action[]> {
    await this.ensureActive();
    const folder = this.resolveWorkspaceFolder(workspaceIndex);
    const api = this.getExportedApi();
    const actions: Action[] = [];

    // Method 1: Exported ActionTools API
    if (api?.actionTools) {
      try {
        if (folder) {
          const workspaceActions = await api.actionTools.getActions(folder);
          if (Array.isArray(workspaceActions)) {
            actions.push(...workspaceActions);
          }
        }
        const connActions = api.actionTools.getConnectionActions();
        if (Array.isArray(connActions)) {
          // Merge avoiding exact duplicates by name
          for (const ca of connActions) {
            if (!actions.some(a => a.name === ca.name)) {
              actions.push(ca);
            }
          }
        }
      } catch (err) {
        console.warn('[Bridge] api.actionTools.getActions failed, attempting fallback:', err);
      }
    }

    // Fallback 1: Read local actions from .vscode/actions.json
    if (actions.length === 0 && folder) {
      try {
        const localActionsUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'actions.json');
        const content = await vscode.workspace.fs.readFile(localActionsUri);
        const parsed = JSON.parse(Buffer.from(content).toString('utf-8'));
        if (Array.isArray(parsed)) {
          actions.push(...parsed);
        }
      } catch {
        // file doesn't exist or not readable, ignore
      }
    }

    // Fallback 2: Check global/connection settings
    if (actions.length === 0) {
      const config = vscode.workspace.getConfiguration('code-for-ibmi');
      const connSettings = config.get<any[]>('connectionSettings') || [];
      for (const setting of connSettings) {
        if (Array.isArray(setting.actions)) {
          actions.push(...setting.actions);
        }
      }
    }

    return actions;
  }

  public async runAction(actionName: string, workspaceIndex?: number): Promise<ActionResult> {
    await this.ensureActive();
    const availableActions = await this.getActions(workspaceIndex);
    const targetAction = availableActions.find(
      a => a.name.toLowerCase() === actionName.toLowerCase()
    );

    if (!targetAction) {
      const validNames = availableActions.map(a => a.name);
      const error: any = new Error(
        `Action '${actionName}' was not found. Available actions: ${validNames.length > 0 ? validNames.join(', ') : 'none'}`
      );
      error.validActions = validNames;
      error.statusCode = 400;
      throw error;
    }

    const folder = this.resolveWorkspaceFolder(workspaceIndex);

    // Determine target URI to pass to code-for-ibmi.runAction
    let targetUri: vscode.Uri | undefined;
    if (vscode.window.activeTextEditor?.document.uri) {
      targetUri = vscode.window.activeTextEditor.document.uri;
    } else if (folder) {
      // Find a local file or default to folder root URI
      try {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '**/node_modules/**', 1);
        targetUri = files.length > 0 ? files[0] : folder.uri;
      } catch {
        targetUri = folder.uri;
      }
    }

    try {
      // Execute command via Code for IBM i
      const result = await vscode.commands.executeCommand<any>(
        'code-for-ibmi.runAction',
        targetUri,
        undefined,
        targetAction,
        undefined,
        folder
      );

      if (result && typeof result === 'object' && 'success' in result) {
        const errorDetail = result.error || result.message;
        return {
          success: Boolean(result.success),
          message: errorDetail || (result.success ? `Action '${actionName}' executed successfully.` : `Action '${actionName}' failed.`),
          output: result.output,
          error: result.error
        };
      }

      return {
        success: true,
        message: `Action '${actionName}' initiated successfully.`,
        output: result
      };
    } catch (err: any) {
      return {
        success: false,
        message: err.message || `Failed to execute action '${actionName}'.`,
        error: String(err)
      };
    }
  }

  public async deploy(options: {
    workspaceIndex?: number;
    method?: DeploymentMethod;
    selectedFiles?: string[];
  }): Promise<{ success: boolean; filesDeployed: number; logs?: string[] }> {
    await this.ensureActive();
    const folder = this.resolveWorkspaceFolder(options.workspaceIndex);
    if (!folder) {
      throw new Error('No workspace folder found to deploy. Open a folder in VS Code first.');
    }

    // Normalize method: "changes" -> "changed"
    let normalizedMethod: any = options.method || 'all';
    if (normalizedMethod === 'changes') {
      normalizedMethod = 'changed';
    }

    const selectedUris = options.selectedFiles?.map(f => vscode.Uri.file(f));
    const api = this.getExportedApi();

    try {
      // Try direct API if available
      if (api?.deployTools?.launchDeploy) {
        const deployResult = await api.deployTools.launchDeploy(
          folder.index,
          normalizedMethod,
          selectedUris
        );

        if (deployResult) {
          return {
            success: true,
            filesDeployed: selectedUris?.length ?? 0,
            logs: [`Deployed workspace ${folder.name} to ${deployResult.remoteDirectory} using ${normalizedMethod}`]
          };
        }
      }

      // Fallback to executeCommand
      const cmdResult = await vscode.commands.executeCommand<any>(
        'code-for-ibmi.launchDeploy',
        folder.index,
        normalizedMethod,
        selectedUris
      );

      const success = cmdResult !== undefined && cmdResult !== false;
      return {
        success,
        filesDeployed: selectedUris?.length ?? 0,
        logs: cmdResult ? [JSON.stringify(cmdResult)] : ['Deployment command executed']
      };
    } catch (err: any) {
      throw new Error(`Deployment failed: ${err.message || String(err)}`);
    }
  }

  public async setDeployLocation(
    remotePath: string,
    workspaceIndex?: number
  ): Promise<{ success: boolean; path: string }> {
    if (!remotePath || typeof remotePath !== 'string' || remotePath.trim() === '') {
      const err: any = new Error("Parameter 'remotePath' is required.");
      err.statusCode = 400;
      throw err;
    }

    await this.ensureActive();
    const folder = this.resolveWorkspaceFolder(workspaceIndex);
    if (!folder) {
      throw new Error('No workspace folder open in VS Code to configure deployment location.');
    }

    const cleanPath = remotePath.trim();
    const api = this.getExportedApi();

    try {
      // Try setting via storage
      const storage = api?.instance?.getStorage();
      if (storage) {
        const existingPaths = storage.getDeployment() || {};
        existingPaths[folder.uri.fsPath] = cleanPath;
        await storage.setDeployment(existingPaths);
        api?.instance?.fire?.('deployLocation');
        return { success: true, path: cleanPath };
      }

      // Fallback via command
      await vscode.commands.executeCommand(
        'code-for-ibmi.setDeployLocation',
        { path: cleanPath },
        folder
      );
      return { success: true, path: cleanPath };
    } catch (err: any) {
      throw new Error(`Failed to set deploy location: ${err.message || String(err)}`);
    }
  }

  public async connect(connectionName?: string): Promise<{ success: boolean; connectedTo: string }> {
    await this.ensureActive();
    const targetName = connectionName?.trim();

    try {
      let result: any;
      if (targetName) {
        result = await vscode.commands.executeCommand('code-for-ibmi.connectTo', targetName);
      } else {
        result = await vscode.commands.executeCommand('code-for-ibmi.connectToPrevious');
      }

      const api = this.getExportedApi();
      const connection = api?.instance?.getConnection();
      const connectedName = connection?.currentConnectionName || targetName || 'IBM i';

      return {
        success: result !== false && (connection !== undefined || result === true),
        connectedTo: connectedName
      };
    } catch (err: any) {
      throw new Error(`Connection attempt failed: ${err.message || String(err)}`);
    }
  }

  public async disconnect(): Promise<{ success: boolean }> {
    await this.ensureActive();
    try {
      await vscode.commands.executeCommand('code-for-ibmi.disconnect');
      return { success: true };
    } catch (err: any) {
      throw new Error(`Disconnect failed: ${err.message || String(err)}`);
    }
  }

  public async execCommand(commandId: string, args?: any[]): Promise<{ success: boolean; result: any }> {
    if (!commandId || typeof commandId !== 'string') {
      const err: any = new Error("Parameter 'commandId' is required.");
      err.statusCode = 400;
      throw err;
    }

    const allCommands = await vscode.commands.getCommands(true);
    if (!allCommands.includes(commandId)) {
      const err: any = new Error(`Unknown command ID: '${commandId}'`);
      err.statusCode = 404;
      throw err;
    }

    let normalizedArgs = args || [];
    // Ergonomic compatibility for code-for-ibmi.openErrors
    if (commandId === 'code-for-ibmi.openErrors' && normalizedArgs.length > 0 && typeof normalizedArgs[0] === 'string') {
      normalizedArgs = [{ qualifiedObject: normalizedArgs[0] }];
    }

    try {
      const result = await vscode.commands.executeCommand(commandId, ...normalizedArgs);
      return { success: true, result };
    } catch (err: any) {
      throw new Error(`Execution of command '${commandId}' failed: ${err.message || String(err)}`);
    }
  }

  public async getDiagnostics(fileFilter?: string, severityFilter?: string): Promise<{
    count: number;
    errorCount: number;
    warningCount: number;
    diagnostics: any[];
  }> {
    const allDiagnostics = vscode.languages.getDiagnostics();
    const items: any[] = [];
    let errorCount = 0;
    let warningCount = 0;

    const sevMap: Record<number, 'Error' | 'Warning' | 'Information' | 'Hint'> = {
      [vscode.DiagnosticSeverity.Error]: 'Error',
      [vscode.DiagnosticSeverity.Warning]: 'Warning',
      [vscode.DiagnosticSeverity.Information]: 'Information',
      [vscode.DiagnosticSeverity.Hint]: 'Hint'
    };

    const targetSev = severityFilter ? severityFilter.toLowerCase() : undefined;

    for (const [uri, diagList] of allDiagnostics) {
      const fsPath = uri.fsPath.replace(/\\/g, '/');
      if (fileFilter && !fsPath.toLowerCase().includes(fileFilter.toLowerCase().replace(/\\/g, '/'))) {
        continue;
      }

      for (const d of diagList) {
        const severityStr = sevMap[d.severity] || 'Error';
        if (targetSev && severityStr.toLowerCase() !== targetSev) {
          continue;
        }

        if (severityStr === 'Error') errorCount++;
        if (severityStr === 'Warning') warningCount++;

        items.push({
          file: uri.fsPath,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          endLine: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
          severity: severityStr,
          code: typeof d.code === 'object' && d.code !== null ? d.code.value : d.code,
          message: d.message,
          source: d.source || 'IBM i'
        });
      }
    }

    return {
      count: items.length,
      errorCount,
      warningCount,
      diagnostics: items
    };
  }

  public async clearDiagnostics(): Promise<{ success: boolean }> {
    try {
      await vscode.commands.executeCommand('code-for-ibmi.clearDiagnostics');
      return { success: true };
    } catch (err: any) {
      throw new Error(`Failed to clear diagnostics: ${err.message || String(err)}`);
    }
  }

  public async runRemoteCommand(
    command: string,
    environment: 'ile' | 'pase' | 'qsh' = 'ile',
    cwd?: string
  ): Promise<{ success: boolean; code: number; stdout: string; stderr: string; command: string }> {
    await this.ensureActive();
    const api = this.getExportedApi();
    const connection = api?.instance?.getConnection();

    if (!connection) {
      throw new Error("IBM i is not connected. Connect first via 'codefori connect --profile <name>' or the VS Code connection menu.");
    }

    try {
      let result: any;
      if (environment === 'pase' && connection.sendCommand) {
        result = await connection.sendCommand({ command, directory: cwd });
      } else if (connection.runCommand) {
        result = await connection.runCommand({
          command,
          environment,
          cwd
        });
      } else if (connection.sendCommand) {
        result = await connection.sendCommand({ command, directory: cwd });
      } else {
        throw new Error('Connection does not expose runCommand or sendCommand.');
      }

      const code = result.code !== undefined ? result.code : 0;
      return {
        success: code === 0,
        code,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        command
      };
    } catch (err: any) {
      throw new Error(`Remote command failed: ${err.message || String(err)}`);
    }
  }

  private async ensureActive(): Promise<void> {
    if (!this.isActive()) {
      await this.activate();
    }
  }

  private resolveWorkspaceFolder(workspaceIndex?: number): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    if (workspaceIndex !== undefined && workspaceIndex >= 0 && workspaceIndex < folders.length) {
      return folders[workspaceIndex];
    }
    return folders[0];
  }
}
