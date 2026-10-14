#!/usr/bin/env node

import { Command } from 'commander';
import { BridgeClient, CliOptions } from './client';
import { Formatter } from './formatters';

const program = new Command();

program
  .name('codefori-cli')
  .description('CLI companion for Code for IBM i VS Code Extension Bridge')
  .version('0.1.0')
  .option('--host <host>', 'Bridge server hostname (default: 127.0.0.1)')
  .option('-p, --port <port>', 'Bridge server port')
  .option('-t, --token <token>', 'Authentication token (X-CodeForIBMi-Token)')
  .option('--json', 'Output machine-parsable JSON instead of formatted text');

function getClient(cmd?: Command): BridgeClient {
  const mergedOpts = cmd ? cmd.optsWithGlobals() : program.opts();
  const opts: CliOptions = {
    host: mergedOpts.host,
    port: mergedOpts.port,
    token: mergedOpts.token,
    json: mergedOpts.json
  };
  return new BridgeClient(opts);
}

// 1. Status
program
  .command('status')
  .description('Check extension health, bridge status, and IBM i connection')
  .action(async (_options, cmd) => {
    const client = getClient(cmd);
    try {
      const status = await client.getStatus();
      Formatter.print(status, client.config.json, Formatter.formatStatus);
      process.exit(0);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 2. Activate
program
  .command('activate')
  .description('Activate the Code for IBM i extension in VS Code')
  .action(async (_options, cmd) => {
    const client = getClient(cmd);
    try {
      const result = await client.activate();
      Formatter.print(result, client.config.json, res => {
        console.log(`\x1b[32m✔ Extension activated successfully.\x1b[0m Exported keys: ${res.exportedKeys.join(', ')}`);
      });
      process.exit(0);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 3. List Actions
program
  .command('list-actions')
  .alias('actions')
  .description('Discover available actions defined in workspace or global config')
  .option('-w, --workspace <index>', 'Workspace index to inspect (default: 0)')
  .action(async (options, cmd) => {
    const client = getClient(cmd);
    try {
      const ws = options.workspace !== undefined ? parseInt(options.workspace, 10) : undefined;
      const result = await client.listActions(ws);
      Formatter.print(result, client.config.json, Formatter.formatActions);
      process.exit(0);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 4. Run Action
program
  .command('run-action')
  .description('Trigger compilation or custom build actions')
  .requiredOption('-n, --name <name>', 'Name of the action to execute')
  .option('-w, --workspace <index>', 'Workspace index (default: 0)')
  .option('--confirm', 'Confirm execution of potentially destructive commands')
  .action(async (options, cmd) => {
    const client = getClient(cmd);
    try {
      const ws = options.workspace !== undefined ? parseInt(options.workspace, 10) : undefined;
      const result = await client.runAction(options.name, ws, options.confirm);
      Formatter.print(result, client.config.json, Formatter.formatRunActionResult);
      process.exit(result.success ? 0 : 1);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 5. Deploy
program
  .command('deploy')
  .description('Deploy workspace source files to IFS')
  .option('-w, --workspace <index>', 'Workspace index (default: 0)')
  .option('-m, --method <method>', 'Deployment method: changes, all, staged, compare, selected', 'changes')
  .option('-f, --files <files...>', 'Specific files to deploy when using method "selected"')
  .action(async (options, cmd) => {
    const client = getClient(cmd);
    try {
      const ws = options.workspace !== undefined ? parseInt(options.workspace, 10) : undefined;
      const result = await client.deploy(ws, options.method, options.files);
      Formatter.print(result, client.config.json, Formatter.formatDeployResult);
      process.exit(result.success ? 0 : 1);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 6. Set Deploy Location
program
  .command('set-deploy-location')
  .description('Configure target IFS working directory for workspace')
  .requiredOption('-r, --remote <remotePath>', 'Target remote IFS path')
  .option('-w, --workspace <index>', 'Workspace index (default: 0)')
  .action(async (options, cmd) => {
    const client = getClient(cmd);
    try {
      const ws = options.workspace !== undefined ? parseInt(options.workspace, 10) : undefined;
      const result = await client.setDeployLocation(options.remote, ws);
      Formatter.print(result, client.config.json, Formatter.formatSetDeployLocationResult);
      process.exit(0);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 7. Connect
program
  .command('connect')
  .description('Connect to an IBM i host or profile')
  .option('--profile <name>', 'Connection profile or system name')
  .option('--name <name>', 'Connection name')
  .action(async (options, cmd) => {
    const client = getClient(cmd);
    try {
      const target = options.profile || options.name;
      const result = await client.connect(target);
      Formatter.print(result, client.config.json, Formatter.formatConnectResult);
      process.exit(result.success ? 0 : 1);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 8. Disconnect
program
  .command('disconnect')
  .description('Disconnect from current IBM i system')
  .action(async (_options, cmd) => {
    const client = getClient(cmd);
    try {
      const result = await client.disconnect();
      Formatter.print(result, client.config.json, Formatter.formatDisconnectResult);
      process.exit(0);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 9. Execute Arbitrary Command
program
  .command('exec-command [params...]')
  .description('Execute an arbitrary VS Code command via the bridge')
  .requiredOption('-c, --command <id>', 'VS Code command ID')
  .option('-a, --args <json>', 'Command arguments formatted as JSON array or string')
  .action(async (params, options, cmd) => {
    const client = getClient(cmd);
    try {
      let args: any[] = [];
      if (options.args) {
        const raw = String(options.args).trim();
        try {
          const parsed = JSON.parse(raw);
          args = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          // Fallback if PowerShell stripped quotes, e.g. [MYLIB/MYPGM]
          if (raw.startsWith('[') && raw.endsWith(']')) {
            const inner = raw.slice(1, -1).trim();
            args = inner ? inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) : [];
          } else {
            args = [raw];
          }
        }
      } else if (params && params.length > 0) {
        args = params;
      }
      const result = await client.execCommand(options.command, args);
      Formatter.print(result, client.config.json);
      process.exit(0);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 10. Diagnostics (Compiler Errors / Warnings)
program
  .command('diagnostics')
  .description('Fetch active compilation errors and diagnostics from VS Code EVFEVENT parser')
  .option('-f, --file <path>', 'Filter diagnostics by file name or path')
  .option('-s, --severity <level>', 'Filter by severity (error, warning, information, hint)')
  .option('--clear', 'Clear all active diagnostics')
  .action(async (options, cmd) => {
    const client = getClient(cmd);
    try {
      if (options.clear) {
        const clearResult = await client.clearDiagnostics();
        Formatter.print(clearResult, client.config.json, () => {
          console.log('\x1b[32m✔ Active diagnostics cleared.\x1b[0m');
        });
        process.exit(0);
      }
      const result = await client.getDiagnostics(options.file, options.severity);
      Formatter.print(result, client.config.json, Formatter.formatDiagnosticsResult);
      process.exit(result.errorCount > 0 ? 1 : 0);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 11. Run Remote Command (CL, PASE, QSH)
program
  .command('run-command')
  .description('Execute an arbitrary CL, PASE, or QSH command directly on the connected IBM i')
  .requiredOption('-c, --command <string>', 'Command string to execute')
  .option('-e, --env <environment>', 'Execution environment: ile (CL), pase, or qsh', 'ile')
  .option('--cwd <directory>', 'Working directory for command')
  .option('--confirm', 'Confirm execution of potentially destructive commands')
  .action(async (options, cmd) => {
    const client = getClient(cmd);
    try {
      const result = await client.runRemoteCommand(options.command, options.env, options.cwd, options.confirm);
      Formatter.print(result, client.config.json, Formatter.formatRemoteCommandResult);
      process.exit(result.success ? 0 : 1);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 12. Run CL Command (Shortcut for ILE CL commands)
program
  .command('run-cl')
  .description('Execute a Control Language (CL) command directly on the connected IBM i')
  .requiredOption('-c, --command <string>', 'CL command string (e.g. "WRKSYSSTS", "DSPOBJD OBJ(MYLIB/*ALL) OBJTYPE(*PGM)")')
  .option('--confirm', 'Confirm execution of potentially destructive commands')
  .action(async (options, cmd) => {
    const client = getClient(cmd);
    try {
      const result = await client.runRemoteCommand(options.command, 'ile', undefined, options.confirm);
      Formatter.print(result, client.config.json, Formatter.formatRemoteCommandResult);
      process.exit(result.success ? 0 : 1);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

// 13. Reset Token
program
  .command('reset-token')
  .description('Reset the bridge authentication token')
  .action(async (_options, cmd) => {
    const client = getClient(cmd);
    try {
      const result = await client.resetToken();
      Formatter.print(result, client.config.json, res => {
        console.log(`\x1b[32m✔ Token successfully reset!\x1b[0m New token: ${res.newToken}`);
      });
      process.exit(0);
    } catch (err: any) {
      Formatter.printError(err, client.config.json);
      process.exit(1);
    }
  });

program.parse(process.argv);
