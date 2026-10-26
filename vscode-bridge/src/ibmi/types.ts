import * as vscode from 'vscode';

export type DeploymentMethod = 'all' | 'staged' | 'unstaged' | 'changed' | 'compare' | 'selected' | 'changes';

export type ActionType = 'member' | 'streamfile' | 'object' | 'file';
export type ActionEnvironment = 'ile' | 'qsh' | 'pase';

export interface Action {
  name: string;
  command: string;
  type?: ActionType;
  environment: ActionEnvironment;
  extensions?: string[];
  deployFirst?: boolean;
  postDownload?: string[];
  refresh?: string;
  runOnProtected?: boolean;
  outputToFile?: string;
  source?: 'workspace' | 'connection' | 'global' | 'default';
}

export interface ActionResult {
  success: boolean;
  output?: any;
  message?: string;
  error?: string;
}

export interface DeploymentParameters {
  method: DeploymentMethod;
  workspaceFolder: vscode.WorkspaceFolder;
  remotePath: string;
  selectedFiles?: vscode.Uri[];
}

export interface ConnectionData {
  name: string;
  host: string;
  port: number;
  currentUser?: string;
}

export interface DiagnosticItem {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'Error' | 'Warning' | 'Information' | 'Hint';
  code?: string | number;
  message: string;
  source: string;
}

export interface DiagnosticsResult {
  count: number;
  errorCount: number;
  warningCount: number;
  diagnostics: DiagnosticItem[];
}

export interface RemoteCommandResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
  command: string;
}

export interface BridgeStatus {
  ready: boolean;
  extensionFound: boolean;
  extensionActive: boolean;
  tokenConfigured: boolean;
  connected?: boolean;
  connectionName?: string;
  host?: string;
  port?: number;
}

export interface CodeForIBMi {
  instance?: {
    getConnection: () => any;
    connect: (options: any) => Promise<any>;
    disconnect: (reconnect?: boolean) => Promise<void>;
    getStorage: () => {
      getDeployment: () => Record<string, string> | undefined;
      setDeployment: (paths: Record<string, string>) => Promise<void>;
    } | undefined;
    fire?: (event: string) => void;
  };
  deployTools?: {
    launchDeploy: (workspaceIndex?: number, method?: any, selectedFiles?: vscode.Uri[]) => Promise<{ remoteDirectory: string; workspaceId: number } | undefined>;
    deploy: (parameters: any) => Promise<boolean>;
    getRemoteDeployDirectory: (workspaceFolder: vscode.WorkspaceFolder) => string | undefined;
    setDeployLocation: (node: any, workspaceFolder?: vscode.WorkspaceFolder, value?: string, method?: any, selectedFiles?: vscode.Uri[]) => Promise<void>;
  };
  actionTools?: {
    getActions: (workspace?: vscode.WorkspaceFolder) => Promise<Action[]>;
    getConnectionActions: () => Action[];
    getLocalActionsFiles?: (workspace: vscode.WorkspaceFolder) => Promise<vscode.Uri[]>;
  };
  connectionManager?: {
    get: <T = any>(key: string) => T | undefined;
    getAll: () => ConnectionData[];
    getByName: (name: string) => { index: number; data: ConnectionData } | undefined;
  };
}
