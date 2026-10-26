import * as vscode from 'vscode';
import { BridgeServer } from '../server/httpServer';
import { SecurityConfig } from '../security/guardrail';

export class BridgeSidebarProvider implements vscode.TreeDataProvider<BridgeTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<BridgeTreeItem | undefined | null | void> = new vscode.EventEmitter<BridgeTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<BridgeTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(
    private bridgeServer: BridgeServer | undefined,
    private getSecurityConfig: () => SecurityConfig,
    private getEffectiveCliMode: (npmInstalled: boolean) => { mode: string; activeMethod: string },
    private checkNpmInstalled: () => Promise<boolean>
  ) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: BridgeTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: BridgeTreeItem): Promise<BridgeTreeItem[]> {
    if (!element) {
      // Top-level groups
      return [
        new BridgeTreeItem('Bridge Server', vscode.TreeItemCollapsibleState.Expanded, 'server-group', new vscode.ThemeIcon('radio-tower')),
        new BridgeTreeItem('CLI & Runner', vscode.TreeItemCollapsibleState.Expanded, 'cli-group', new vscode.ThemeIcon('terminal')),
        new BridgeTreeItem('Security Policies', vscode.TreeItemCollapsibleState.Expanded, 'security-group', new vscode.ThemeIcon('shield')),
        new BridgeTreeItem('Actions', vscode.TreeItemCollapsibleState.Expanded, 'actions-group', new vscode.ThemeIcon('tools'))
      ];
    }

    if (element.contextValue === 'server-group') {
      const isRunning = this.bridgeServer?.isRunning() ?? false;
      const port = this.bridgeServer?.getPort() ?? 0;
      const host = this.bridgeServer?.getHost() ?? '127.0.0.1';

      return [
        new BridgeTreeItem(
          `Status: ${isRunning ? 'Running' : 'Stopped'}`,
          vscode.TreeItemCollapsibleState.None,
          'status',
          new vscode.ThemeIcon(isRunning ? 'pass' : 'error', isRunning ? new vscode.ThemeColor('testing.iconPassed') : new vscode.ThemeColor('testing.iconFailed')),
          isRunning ? `http://${host}:${port}` : undefined
        ),
        new BridgeTreeItem(
          `Port: ${port || 'Auto'}`,
          vscode.TreeItemCollapsibleState.None,
          'port',
          new vscode.ThemeIcon('server')
        )
      ];
    }

    if (element.contextValue === 'cli-group') {
      const isNpm = await this.checkNpmInstalled();
      const { mode, activeMethod } = this.getEffectiveCliMode(isNpm);
      return [
        new BridgeTreeItem(
          `Mode: ${mode}`,
          vscode.TreeItemCollapsibleState.None,
          'climode',
          new vscode.ThemeIcon('gear'),
          `Active interaction method: ${activeMethod}`
        ),
        new BridgeTreeItem(
          `Active Client: ${activeMethod === 'npm' ? 'NPM' : 'GIT BASH / POSIX'}`,
          vscode.TreeItemCollapsibleState.None,
          'activemethod',
          new vscode.ThemeIcon(activeMethod === 'npm' ? 'package' : 'terminal-bash'),
          activeMethod === 'npm' ? 'Using Node.js npm package (@rishabkshk/codefori-cli)' : 'Using zero-dependency Git Bash / POSIX curl script'
        )
      ];
    }

    if (element.contextValue === 'security-group') {
      const sec = this.getSecurityConfig();
      return [
        new BridgeTreeItem(`Destructive Policy: ${sec.policy}`, vscode.TreeItemCollapsibleState.None, 'sec-destructive', new vscode.ThemeIcon('shield')),
        new BridgeTreeItem(`QSH Policy: ${sec.qshPolicy}`, vscode.TreeItemCollapsibleState.None, 'sec-qsh', new vscode.ThemeIcon('terminal-bash')),
        new BridgeTreeItem(`PASE Policy: ${sec.pasePolicy}`, vscode.TreeItemCollapsibleState.None, 'sec-pase', new vscode.ThemeIcon('terminal-powershell')),
        new BridgeTreeItem(`CL Policy: ${sec.clPolicy}`, vscode.TreeItemCollapsibleState.None, 'sec-cl', new vscode.ThemeIcon('terminal')),
        new BridgeTreeItem(`Deploy Policy: ${sec.deployPolicy}`, vscode.TreeItemCollapsibleState.None, 'sec-deploy', new vscode.ThemeIcon('cloud-upload'))
      ];
    }

    if (element.contextValue === 'actions-group') {
      return [
        new BridgeTreeItem(
          'Open Bridge Settings UI',
          vscode.TreeItemCollapsibleState.None,
          'action-settings',
          new vscode.ThemeIcon('gear'),
          'Open dedicated settings page',
          { command: 'codeForIBMiBridge.openSettings', title: 'Open Settings' }
        ),
        new BridgeTreeItem(
          'Copy CLI Command',
          vscode.TreeItemCollapsibleState.None,
          'action-copy-curl',
          new vscode.ThemeIcon('copy'),
          'Copy CLI invocation command to clipboard',
          { command: 'codeForIBMiBridge.copyCurlCommand', title: 'Copy CLI Command' }
        ),
        new BridgeTreeItem(
          'Install CLI via npm',
          vscode.TreeItemCollapsibleState.None,
          'action-install-npm',
          new vscode.ThemeIcon('package'),
          'Run npm install -g @rishabkshk/codefori-cli',
          { command: 'codeForIBMiBridge.installNpmCli', title: 'Install CLI via npm' }
        ),
        new BridgeTreeItem(
          'Reset Authentication Token',
          vscode.TreeItemCollapsibleState.None,
          'action-reset-token',
          new vscode.ThemeIcon('key'),
          'Generate new secure authentication token',
          { command: 'codeForIBMiBridge.resetToken', title: 'Reset Token' }
        ),
        new BridgeTreeItem(
          'Show Bridge Status',
          vscode.TreeItemCollapsibleState.None,
          'action-show-status',
          new vscode.ThemeIcon('info'),
          'Show status dialog',
          { command: 'codeForIBMiBridge.showStatus', title: 'Show Status' }
        )
      ];
    }

    return [];
  }
}

export class BridgeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    public readonly iconPath?: vscode.ThemeIcon,
    public readonly description?: string,
    public readonly command?: vscode.Command
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
    this.iconPath = iconPath;
    this.description = description;
    this.command = command;
  }
}
