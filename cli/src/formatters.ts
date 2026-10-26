export class Formatter {
  public static print(data: any, isJson: boolean, customFormatter?: (data: any) => void): void {
    if (isJson) {
      console.log(JSON.stringify(data, null, 2));
    } else if (customFormatter) {
      customFormatter(data);
    } else {
      console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    }
  }

  public static printError(error: any, isJson: boolean): void {
    if (isJson) {
      const errObj: any = { error: error.message || String(error) };
      if (error.statusCode) errObj.statusCode = error.statusCode;
      if (error.response) errObj.details = error.response;
      console.error(JSON.stringify(errObj, null, 2));
    } else {
      if (error.statusCode === 403) {
        if (error.response?.status === 'confirmation_required') {
          console.error(`\x1b[33m⚠️  [Security Guardrail: Confirmation Required]\x1b[0m ${error.message || 'Destructive command requires confirmation.'}`);
          if (error.response?.command) {
            console.log(`  \x1b[90mCommand:\x1b[0m        \x1b[1m${error.response.command}\x1b[0m`);
          }
          if (error.response?.environment) {
            console.log(`  \x1b[90mEnvironment:\x1b[0m    ${error.response.environment}`);
          }
          if (error.response?.matchedPattern) {
            console.log(`  \x1b[90mMatched Pattern:\x1b[0m\x1b[33m ${error.response.matchedPattern}\x1b[0m`);
          }
          console.log(`\n  \x1b[36mTo execute this command, confirm with your human user and re-run with:\x1b[0m`);
          console.log(`    \x1b[1m--confirm\x1b[0m`);
          return;
        }

        console.error(`\x1b[31m[Security Guardrail Blocked]\x1b[0m ${error.message || 'Destructive command was rejected.'}`);
        if (error.response?.command) {
          console.log(`  \x1b[90mCommand:\x1b[0m        ${error.response.command}`);
        }
        if (error.response?.environment) {
          console.log(`  \x1b[90mEnvironment:\x1b[0m    ${error.response.environment}`);
        }
        if (error.response?.status) {
          console.log(`  \x1b[90mGuard Status:\x1b[0m   ${error.response.status}`);
        }
        if (error.response?.matchedPattern) {
          console.log(`  \x1b[90mMatched Pattern:\x1b[0m\x1b[33m ${error.response.matchedPattern}\x1b[0m`);
        }
        return;
      }

      console.error(`\x1b[31mError:\x1b[0m ${error.message || String(error)}`);
      if (error.response?.validActions && Array.isArray(error.response.validActions)) {
        console.log(`\nValid available actions:`);
        error.response.validActions.forEach((a: string) => console.log(`  - ${a}`));
      }
    }
  }

  public static formatStatus(status: any): void {
    console.log(`\x1b[1m=== Code for IBM i Bridge Status ===\x1b[0m`);
    console.log(`Bridge Ready:          ${status.ready ? '\x1b[32m✔ Yes\x1b[0m' : '\x1b[33m✖ No\x1b[0m'}`);
    console.log(`Port:                  ${status.port || 'Dynamic'}`);
    console.log(`Token Configured:      ${status.tokenConfigured ? '\x1b[32m✔ Yes\x1b[0m' : '\x1b[31m✖ No\x1b[0m'}`);
    console.log(`Base Extension Found:  ${status.extensionFound ? '\x1b[32m✔ Installed\x1b[0m' : '\x1b[31m✖ Missing\x1b[0m'}`);
    console.log(`Base Extension Active: ${status.extensionActive ? '\x1b[32m✔ Active\x1b[0m' : '\x1b[33m✖ Inactive\x1b[0m'}`);
    console.log(`Security Policy:       \x1b[36m${status.securityPolicy || 'prompt'}\x1b[0m (QSH: \x1b[33m${status.qshPolicy || 'block'}\x1b[0m, CL: \x1b[35m${status.clPolicy || 'prompt'}\x1b[0m)`);
    if (status.fallbackToCurl && !status.npmFound) {
      console.log(`CLI Mode:              \x1b[33mcurl/PowerShell Fallback\x1b[0m`);
      if (status.fallbackScript) {
        console.log(`Fallback Script:       \x1b[90m${status.fallbackScript}\x1b[0m`);
      }
    }
    
    if (!status.extensionFound) {
      console.log(`\n\x1b[33mRecommendation:\x1b[0m Install Code for IBM i via 'code --install-extension halcyontechltd.code-for-ibmi'`);
    }

    if (status.connected) {
      console.log(`Connection Status:     \x1b[32m✔ Connected to ${status.connectionName || 'IBM i'}${status.host ? ` (${status.host})` : ''}\x1b[0m`);
    } else {
      console.log(`Connection Status:     \x1b[90mNot connected\x1b[0m`);
    }
  }

  public static formatActions(data: { actions: any[] }): void {
    const actions = data?.actions || [];
    if (actions.length === 0) {
      console.log(`No actions found. Ensure actions are configured in .vscode/actions.json or connection settings.`);
      return;
    }

    console.log(`\x1b[1mAvailable Actions (${actions.length}):\x1b[0m\n`);
    actions.forEach((action, i) => {
      const deployBadge = action.deployFirst ? ' \x1b[36m[deployFirst]\x1b[0m' : '';
      const typeBadge = action.type ? `\x1b[90m(${action.type})\x1b[0m` : '';
      console.log(`  ${i + 1}. \x1b[1m${action.name}\x1b[0m ${typeBadge}${deployBadge}`);
      console.log(`     \x1b[90mEnvironment:\x1b[0m ${action.environment || 'ile'}`);
      console.log(`     \x1b[90mCommand:\x1b[0m     ${action.command}`);
      if (action.extensions?.length) {
        console.log(`     \x1b[90mExtensions:\x1b[0m  ${action.extensions.join(', ')}`);
      }
      console.log(``);
    });
  }

  public static formatRunActionResult(result: any): void {
    if (result.success) {
      console.log(`\x1b[32m✔ Action execution completed successfully!\x1b[0m`);
      if (result.message) console.log(result.message);
      if (result.output && (Array.isArray(result.output) ? result.output.length > 0 : true)) {
        console.log(`\n\x1b[1mOutput Details:\x1b[0m`);
        console.log(JSON.stringify(result.output, null, 2));
      }
    } else {
      console.log(`\x1b[31m✖ Action execution failed.\x1b[0m`);
      if (result.message) console.log(result.message);
      if (result.error && result.error !== result.message) console.log(`\x1b[33mReason:\x1b[0m ${result.error}`);
      if (result.output && (Array.isArray(result.output) ? result.output.length > 0 : Object.keys(result.output).length > 0)) {
        console.log(`\n\x1b[1mOutput Details:\x1b[0m`);
        console.log(JSON.stringify(result.output, null, 2));
      }
    }
  }

  public static formatDeployResult(result: any): void {
    if (result.success) {
      console.log(`\x1b[32m✔ Workspace deployed successfully!\x1b[0m`);
      if (result.filesDeployed !== undefined) {
        console.log(`Files deployed: ${result.filesDeployed}`);
      }
      if (result.logs && Array.isArray(result.logs)) {
        console.log(`\nDeployment Logs:`);
        result.logs.forEach((log: string) => console.log(`  ${log}`));
      }
    } else {
      console.log(`\x1b[31m✖ Deployment failed.\x1b[0m`);
      if (result.logs) console.log(result.logs);
    }
  }

  public static formatSetDeployLocationResult(result: any): void {
    console.log(`\x1b[32m✔ Deployment location successfully configured:\x1b[0m ${result.path}`);
  }

  public static formatGetDeployLocationResult(result: any): void {
    if (result.configured && result.remotePath) {
      console.log(`\x1b[32m✔ Remote IFS Deploy Directory:\x1b[0m \x1b[1m${result.remotePath}\x1b[0m`);
      console.log(`  \x1b[90mLocal Workspace:\x1b[0m  ${result.localPath} (${result.workspaceName})`);
    } else {
      console.log(`\x1b[33m⚠️  No deployment directory configured\x1b[0m for ${result.workspaceName || 'workspace'} (${result.localPath}).`);
      console.log(`  Use 'codefori set-deploy-location --remote <path>' to configure one.`);
    }
  }


  public static formatConnectResult(result: any): void {
    if (result.success) {
      console.log(`\x1b[32m✔ Successfully connected to:\x1b[0m ${result.connectedTo}`);
    } else {
      console.log(`\x1b[31m✖ Connection failed.\x1b[0m`);
    }
  }

  public static formatDisconnectResult(result: any): void {
    if (result.success) {
      console.log(`\x1b[32m✔ Disconnected from IBM i.\x1b[0m`);
    } else {
      console.log(`\x1b[31m✖ Disconnect failed.\x1b[0m`);
    }
  }

  public static formatDiagnosticsResult(result: any): void {
    const diags = result.diagnostics || [];
    if (diags.length === 0) {
      console.log(`\x1b[32m✔ No compile errors or warnings found (0 diagnostics).\x1b[0m`);
      return;
    }

    console.log(`\x1b[1m=== Diagnostics (${diags.length} total: ${result.errorCount || 0} errors, ${result.warningCount || 0} warnings) ===\x1b[0m\n`);
    diags.forEach((d: any, idx: number) => {
      const sevColor = d.severity === 'Error' ? '\x1b[31m' : d.severity === 'Warning' ? '\x1b[33m' : '\x1b[36m';
      const codeStr = d.code ? ` [${d.code}]` : '';
      console.log(`  ${idx + 1}. ${sevColor}${d.severity.toUpperCase()}${codeStr}\x1b[0m in \x1b[1m${d.file}\x1b[0m:${d.line}:${d.column}`);
      console.log(`     ${d.message}`);
    });
  }

  public static formatRemoteCommandResult(result: any): void {
    if (result.success) {
      console.log(`\x1b[32m✔ Command executed successfully (Exit Code: ${result.code})\x1b[0m`);
      if (result.stdout && result.stdout.trim()) {
        console.log(`\n\x1b[1mOutput (stdout):\x1b[0m\n${result.stdout}`);
      }
      if (result.stderr && result.stderr.trim()) {
        console.log(`\n\x1b[33mJob Log / Messages (stderr):\x1b[0m\n${result.stderr}`);
      }
    } else {
      console.log(`\x1b[31m✖ Command failed (Exit Code: ${result.code})\x1b[0m`);
      if (result.stderr && result.stderr.trim()) {
        console.log(`\n\x1b[31mError Details (stderr):\x1b[0m\n${result.stderr}`);
      }
      if (result.stdout && result.stdout.trim()) {
        console.log(`\n\x1b[1mOutput (stdout):\x1b[0m\n${result.stdout}`);
      }
    }
  }
}
