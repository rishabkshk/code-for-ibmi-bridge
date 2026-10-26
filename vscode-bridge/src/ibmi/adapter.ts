import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
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

    const localActions: Action[] = [];
    const otherActions: Action[] = [];

    // 1. Priority 1: Directly read local actions from .vscode/actions.json in the workspace folder
    if (folder) {
      try {
        const localActionsUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'actions.json');
        const content = await vscode.workspace.fs.readFile(localActionsUri);
        const parsed = JSON.parse(Buffer.from(content).toString('utf-8'));
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.name) {
              localActions.push({
                ...item,
                source: 'workspace'
              });
            }
          }
        }
      } catch {
        // file doesn't exist or not readable, ignore
      }
    }

    // 2. Query Code for IBM i actionTools API for workspace & connection actions
    if (api?.actionTools) {
      try {
        if (folder) {
          const workspaceActions = await api.actionTools.getActions(folder);
          if (Array.isArray(workspaceActions)) {
            for (const wa of workspaceActions) {
              if (!localActions.some(a => a.name.toLowerCase() === wa.name.toLowerCase())) {
                localActions.push({ ...wa, source: 'workspace' });
              }
            }
          }
        }
        const connActions = api.actionTools.getConnectionActions();
        if (Array.isArray(connActions)) {
          for (const ca of connActions) {
            otherActions.push({ ...ca, source: 'connection' });
          }
        }
      } catch (err) {
        console.warn('[Bridge] api.actionTools.getActions failed, attempting fallback:', err);
      }
    }

    // 3. Fallback: Check global/connection settings if otherActions is empty
    if (otherActions.length === 0) {
      const config = vscode.workspace.getConfiguration('code-for-ibmi');
      const connSettings = config.get<any[]>('connectionSettings') || [];
      for (const setting of connSettings) {
        if (Array.isArray(setting.actions)) {
          for (const sa of setting.actions) {
            otherActions.push({ ...sa, source: 'connection' });
          }
        }
      }
    }

    // 4. Merge: Local workspace actions ALWAYS take precedence over connection/global actions with matching name
    const finalActions: Action[] = [...localActions];
    for (const ca of otherActions) {
      if (!finalActions.some(a => a.name.toLowerCase() === ca.name.toLowerCase())) {
        finalActions.push(ca);
      }
    }

    return finalActions;
  }

  public async runAction(
    actionName: string,
    workspaceIndex?: number,
    options?: {
      targetFile?: string;
      deployMethod?: DeploymentMethod;
    }
  ): Promise<ActionResult> {
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
    if (options?.targetFile && folder) {
      targetUri = this.resolveSelectedFileUri(folder, options.targetFile);
    } else if (vscode.window.activeTextEditor?.document.uri) {
      targetUri = vscode.window.activeTextEditor.document.uri;
    } else if (folder) {
      // Find a matching source file in the workspace or default to folder root URI
      try {
        const extPattern = targetAction.extensions && targetAction.extensions.length > 0
          ? `**/*.{${targetAction.extensions.join(',')}}`
          : '**/*';
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, extPattern), '**/node_modules/**', 1);
        targetUri = files.length > 0 ? files[0] : folder.uri;
      } catch {
        targetUri = folder.uri;
      }
    }

    // Determine deployment method if deployFirst is true
    let deployMethod: any = options?.deployMethod || 'changed';
    if (deployMethod === 'changes') {
      deployMethod = 'changed';
    }

    try {
      // Execute command via Code for IBM i
      const result = await vscode.commands.executeCommand<any>(
        'code-for-ibmi.runAction',
        targetUri,
        undefined,
        targetAction,
        deployMethod,
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

  /**
   * Resolves a file path (which may be workspace-relative or absolute)
   * to a vscode.Uri relative to the specified workspace folder.
   * - Relative paths resolve beneath the given workspace folder.
   * - Windows drive-letter paths (C:\... or C:/...), UNC paths (\\server\share),
   *   and POSIX paths (/foo/bar) are preserved as absolute file URIs.
   */
  public resolveSelectedFileUri(folder: vscode.WorkspaceFolder, filePath: string): vscode.Uri {
    const clean = (filePath || '').trim();
    if (!clean) {
      throw new Error('Selected file path cannot be empty.');
    }

    // Preserve absolute paths as absolute file URIs
    const isWindowsAbsolute = /^[a-zA-Z]:[\\\/]/.test(clean) || clean.startsWith('\\\\');
    const isPosixAbsolute = clean.startsWith('/');

    if (isWindowsAbsolute || isPosixAbsolute) {
      return vscode.Uri.file(path.normalize(clean));
    }

    // Workspace-relative path: resolve beneath the specified workspace folder
    const cleanRelative = clean.replace(/\\/g, '/');
    if (folder.uri.scheme === 'file') {
      return vscode.Uri.file(path.resolve(folder.uri.fsPath, cleanRelative));
    }

    const segments = cleanRelative.split('/').filter(p => p && p !== '.');
    return vscode.Uri.joinPath(folder.uri, ...segments);
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

    const hasSelectedFiles = Array.isArray(options.selectedFiles) && options.selectedFiles.length > 0;

    let normalizedMethod: any;
    let selectedUris: vscode.Uri[] | undefined;

    if (hasSelectedFiles) {
      normalizedMethod = 'selected';
      selectedUris = options.selectedFiles!.map(f => this.resolveSelectedFileUri(folder, f));
    } else {
      normalizedMethod = options.method || 'all';
      if (normalizedMethod === 'changes') {
        normalizedMethod = 'changed';
      }
    }

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

  /**
   * Retrieves pending modified/uncommitted/untracked files in the workspace.
   */
  public async getPendingChanges(workspaceIndex?: number): Promise<string[]> {
    const folder = this.resolveWorkspaceFolder(workspaceIndex);
    if (!folder) return [];

    return new Promise<string[]>((resolve) => {
      exec('git status --porcelain', { cwd: folder.uri.fsPath, timeout: 3000 }, (err, stdout) => {
        if (!err && stdout) {
          const files: string[] = [];
          const lines = stdout.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let filePath = trimmed.substring(2).trim();
            if (filePath.includes('->')) {
              filePath = filePath.split('->')[1].trim();
            }
            filePath = filePath.replace(/^["']|["']$/g, '');
            if (filePath) {
              files.push(filePath);
            }
          }
          return resolve(files);
        }
        resolve([]);
      });
    });
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

  public async getDeployLocation(workspaceIndex?: number): Promise<{
    success: boolean;
    workspaceIndex: number;
    workspaceName: string;
    localPath: string;
    remotePath?: string;
    configured: boolean;
  }> {
    await this.ensureActive();
    const folder = this.resolveWorkspaceFolder(workspaceIndex);
    if (!folder) {
      const err: any = new Error('No workspace folder open in VS Code to inspect deployment location.');
      err.statusCode = 400;
      throw err;
    }

    const api = this.getExportedApi();
    let remotePath: string | undefined;

    // Method 1: Exported deployTools API
    if (api?.deployTools?.getRemoteDeployDirectory) {
      try {
        remotePath = api.deployTools.getRemoteDeployDirectory(folder);
      } catch (err) {
        console.warn('[Bridge] api.deployTools.getRemoteDeployDirectory failed:', err);
      }
    }

    // Method 2: Connection storage mapping
    if (!remotePath && api?.instance?.getStorage) {
      try {
        const deploymentMap = api.instance.getStorage()?.getDeployment();
        if (deploymentMap) {
          remotePath = deploymentMap[folder.uri.fsPath];
        }
      } catch (err) {
        console.warn('[Bridge] api.instance.getStorage().getDeployment failed:', err);
      }
    }

    return {
      success: true,
      workspaceIndex: folder.index,
      workspaceName: folder.name,
      localPath: folder.uri.fsPath,
      remotePath: remotePath || undefined,
      configured: Boolean(remotePath)
    };
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

  public async readEventf(qualifiedObject: string): Promise<any> {
    await this.ensureActive();
    const cleanObj = (qualifiedObject || '').trim();
    if (!cleanObj) {
      throw new Error("Parameter 'object' (e.g. 'MYLIB/MYPGM') is required.");
    }

    try {
      await vscode.commands.executeCommand('code-for-ibmi.openErrors', { qualifiedObject: cleanObj });
    } catch (err: any) {
      throw new Error(`Failed to read EVFEVENT for object '${cleanObj}': ${err.message || String(err)}`);
    }

    return this.getDiagnostics();
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
