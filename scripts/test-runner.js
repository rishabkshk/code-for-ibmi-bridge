const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

// Import built server modules
const { BridgeServer } = require('../vscode-bridge/out/server/httpServer');
const { SecurityGuardrail } = require('../vscode-bridge/out/security/guardrail');

let server;
let currentToken = 'test-secret-token-1234567890abcdef1234567890abcdef';
let activePort = 0;
let securityConfig = {
  policy: 'allow',
  allowedCommands: ['DLTSPLF *SELECT'],
  customBlockedCommands: ['CUSTOMDANGER'],
  enableActionInspection: true,
  promptTimeoutSeconds: 60
};
let guardrail = new SecurityGuardrail(() => securityConfig);

// Mock adapter simulating Code for IBM i
const mockAdapter = {
  isInstalled: () => true,
  isActive: () => true,
  activate: async () => ({ activated: true, exportedKeys: ['instance', 'deployTools', 'actionTools'] }),
  getStatus: (port, tokenConfigured) => ({
    ready: true,
    extensionFound: true,
    extensionActive: true,
    tokenConfigured,
    connected: true,
    connectionName: 'PUB400',
    host: 'pub400.com',
    port
  }),
  getActions: async (workspaceIndex) => [
    {
      name: 'Create Bound RPG Program (CRTBNDRPG)',
      command: 'CRTBNDRPG PGM(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENFILE)',
      type: 'file',
      environment: 'ile',
      deployFirst: true
    },
    {
      name: 'Create CL Program',
      command: 'CRTCLPGM PGM(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENFILE)',
      type: 'file',
      environment: 'ile'
    },
    {
      name: 'Delete Library (Destructive)',
      command: 'DLTLIB LIB(&OPENLIB)',
      type: 'file',
      environment: 'ile'
    }
  ],
  runAction: async (actionName, workspaceIndex) => {
    if (actionName.toLowerCase().includes('crtbndrpg') || actionName.toLowerCase().includes('delete library')) {
      return {
        success: true,
        message: `Action '${actionName}' completed successfully.`,
        output: [{ path: '/QSYS.LIB/MYLIB.LIB/PROG1.PGM', executionOK: true }]
      };
    }
    const err = new Error(`Action '${actionName}' was not found.`);
    err.statusCode = 400;
    err.validActions = ['Create Bound RPG Program (CRTBNDRPG)', 'Create CL Program'];
    throw err;
  },
  deploy: async (options) => ({
    success: true,
    filesDeployed: options.selectedFiles ? options.selectedFiles.length : 5,
    logs: [`Deployed using method ${options.method || 'all'}`]
  }),
  setDeployLocation: async (remotePath, workspaceIndex) => {
    if (!remotePath) {
      const err = new Error("Parameter 'remotePath' is required.");
      err.statusCode = 400;
      throw err;
    }
    return { success: true, path: remotePath };
  },
  connect: async (connectionName) => ({
    success: true,
    connectedTo: connectionName || 'PUB400'
  }),
  disconnect: async () => ({ success: true }),
  execCommand: async (commandId, args) => {
    if (commandId === 'test.validCommand') {
      return { success: true, result: args ? `Command output: ${JSON.stringify(args)}` : 'Command output: OK' };
    }
    const err = new Error(`Unknown command ID: '${commandId}'`);
    err.statusCode = 404;
    throw err;
  },
  getDiagnostics: async (fileFilter, severityFilter) => ({
    count: 1,
    errorCount: 1,
    warningCount: 0,
    diagnostics: [
      {
        file: '/src/infoin0.sqlrpgle',
        line: 42,
        column: 15,
        endLine: 42,
        endColumn: 25,
        severity: 'Error',
        code: 'RNF7030',
        message: 'The name or indicator DATA_IN is not defined.',
        source: 'IBM i'
      }
    ]
  }),
  clearDiagnostics: async () => ({ success: true }),
  runRemoteCommand: async (command, environment, cwd) => ({
    success: true,
    code: 0,
    stdout: `Executed ${command} in ${environment || 'ile'}`,
    stderr: '',
    command
  })
};

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const headers = { 'Accept': 'application/json' };
    if (token !== undefined) {
      headers['X-CodeForIBMi-Token'] = token;
    }
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: activePort,
      path,
      method,
      headers
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json;
        try {
          json = data ? JSON.parse(data) : {};
        } catch {
          json = { raw: data };
        }
        resolve({ status: res.statusCode, data: json });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function runCliAsync(args, env = {}) {
  return new Promise((resolve) => {
    const cliPath = path.join(__dirname, '../cli/bin/index.js');
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => {
      resolve({
        status: code,
        stdout,
        stderr
      });
    });
  });
}

async function runTests() {
  console.log('--- Starting Code for IBM i Bridge System Verification ---');

  // 1. Start Server on ephemeral port (port 0)
  server = new BridgeServer(currentToken, mockAdapter, async () => {
    currentToken = 'new-rotated-token-998877665544332211';
    return currentToken;
  }, guardrail);

  const bound = await server.start(0);
  activePort = bound.port;
  console.log(`[PASS] Server started on ${bound.host}:${activePort}`);

  try {
    // 2. Authentication Tests
    console.log('\n[Test 1] Missing Token');
    const resNoAuth = await request('GET', '/status', null, undefined);
    assert.strictEqual(resNoAuth.status, 401);
    assert.deepStrictEqual(resNoAuth.data, { error: 'Invalid or missing bridge token' });
    console.log('[PASS] Returned 401 with expected error response');

    console.log('\n[Test 2] Invalid Token');
    const resBadAuth = await request('GET', '/status', null, 'wrong-token');
    assert.strictEqual(resBadAuth.status, 401);
    assert.deepStrictEqual(resBadAuth.data, { error: 'Invalid or missing bridge token' });
    console.log('[PASS] Returned 401 for incorrect token');

    // 3. Status Endpoint
    console.log('\n[Test 3] GET /status (Valid Token)');
    const resStatus = await request('GET', '/status', null, currentToken);
    assert.strictEqual(resStatus.status, 200);
    assert.strictEqual(resStatus.data.ready, true);
    assert.strictEqual(resStatus.data.extensionFound, true);
    assert.strictEqual(resStatus.data.extensionActive, true);
    assert.strictEqual(resStatus.data.tokenConfigured, true);
    console.log('[PASS] GET /status returned correct contract');

    // 4. Activate Endpoint
    console.log('\n[Test 4] POST /activate');
    const resAct = await request('POST', '/activate', {}, currentToken);
    assert.strictEqual(resAct.status, 200);
    assert.strictEqual(resAct.data.activated, true);
    assert(Array.isArray(resAct.data.exportedKeys));
    console.log('[PASS] POST /activate succeeded');

    // 5. Actions Endpoint
    console.log('\n[Test 5] GET /actions');
    const resActions = await request('GET', '/actions', null, currentToken);
    assert.strictEqual(resActions.status, 200);
    assert.strictEqual(resActions.data.actions.length, 3);
    assert.strictEqual(resActions.data.actions[0].name, 'Create Bound RPG Program (CRTBNDRPG)');
    console.log('[PASS] GET /actions returned action definitions');

    // 6. Run Action Endpoint - Success
    console.log('\n[Test 6] POST /run-action (Success)');
    const resRunSuccess = await request('POST', '/run-action', {
      actionName: 'Create Bound RPG Program (CRTBNDRPG)',
      workspaceIndex: 0
    }, currentToken);
    assert.strictEqual(resRunSuccess.status, 200);
    assert.strictEqual(resRunSuccess.data.success, true);
    console.log('[PASS] POST /run-action succeeded');

    // 7. Run Action Endpoint - 400 Bad Request
    console.log('\n[Test 7] POST /run-action (Unknown Action -> 400 Bad Request)');
    const resRunFail = await request('POST', '/run-action', { actionName: 'NonExistent' }, currentToken);
    assert.strictEqual(resRunFail.status, 400);
    assert(Array.isArray(resRunFail.data.validActions));
    console.log('[PASS] POST /run-action returned 400 with valid action list');

    // 8. Deploy Endpoint
    console.log('\n[Test 8] POST /deploy');
    const resDeploy = await request('POST', '/deploy', {
      workspaceIndex: 0,
      method: 'changes',
      selectedFiles: ['/src/prog1.rpgle']
    }, currentToken);
    assert.strictEqual(resDeploy.status, 200);
    assert.strictEqual(resDeploy.data.success, true);
    console.log('[PASS] POST /deploy succeeded');

    // 9. Set Deploy Location
    console.log('\n[Test 9] POST /set-deploy-location');
    const resSetLocation = await request('POST', '/set-deploy-location', {
      remotePath: '/home/USER/builds/project1'
    }, currentToken);
    assert.strictEqual(resSetLocation.status, 200);
    assert.strictEqual(resSetLocation.data.path, '/home/USER/builds/project1');
    console.log('[PASS] POST /set-deploy-location succeeded');

    // 10. Connect & Disconnect
    console.log('\n[Test 10] POST /connect & POST /disconnect');
    const resConn = await request('POST', '/connect', { connectionName: 'PUB400' }, currentToken);
    assert.strictEqual(resConn.status, 200);
    assert.strictEqual(resConn.data.connectedTo, 'PUB400');

    const resDisc = await request('POST', '/disconnect', {}, currentToken);
    assert.strictEqual(resDisc.status, 200);
    assert.strictEqual(resDisc.data.success, true);
    console.log('[PASS] Connect and disconnect succeeded');

    // 11. Exec Command Endpoint
    console.log('\n[Test 11] POST /exec-command');
    const resCmd = await request('POST', '/exec-command', { commandId: 'test.validCommand' }, currentToken);
    assert.strictEqual(resCmd.status, 200);
    assert.strictEqual(resCmd.data.result, 'Command output: OK');

    const resCmd404 = await request('POST', '/exec-command', { commandId: 'invalid.cmd' }, currentToken);
    assert.strictEqual(resCmd404.status, 404);
    console.log('[PASS] Exec-command valid and invalid routes passed');

    // 12. Token Reset Endpoint
    console.log('\n[Test 12] POST /token/reset');
    const resReset = await request('POST', '/token/reset', {}, currentToken);
    assert.strictEqual(resReset.status, 200);
    assert.strictEqual(resReset.data.newToken, 'new-rotated-token-998877665544332211');
    // Old token should now fail
    const resOldFail = await request('GET', '/status', null, 'test-secret-token-1234567890abcdef1234567890abcdef');
    assert.strictEqual(resOldFail.status, 401);
    // New token works
    const resNewOk = await request('GET', '/status', null, currentToken);
    assert.strictEqual(resNewOk.status, 200);
    console.log('[PASS] Token rotation and immediate invalidation of old token confirmed');

    // 13. Diagnostics Endpoint
    console.log('\n[Test 13] GET /diagnostics & POST /diagnostics/clear');
    const resDiags = await request('GET', '/diagnostics', null, currentToken);
    assert.strictEqual(resDiags.status, 200);
    assert.strictEqual(resDiags.data.count, 1);
    assert.strictEqual(resDiags.data.diagnostics[0].code, 'RNF7030');

    const resClear = await request('POST', '/diagnostics/clear', {}, currentToken);
    assert.strictEqual(resClear.status, 200);
    console.log('[PASS] Diagnostics endpoints verified');

    // 14. Run Remote Command Endpoint
    console.log('\n[Test 14] POST /run-command & POST /run-cl');
    const resRunCmd = await request('POST', '/run-command', {
      command: 'WRKSYSSTS',
      environment: 'ile'
    }, currentToken);
    assert.strictEqual(resRunCmd.status, 200);
    assert.strictEqual(resRunCmd.data.success, true);

    const resRunCl = await request('POST', '/run-cl', {
      command: 'DSPOBJD OBJ(MYLIB/*ALL) OBJTYPE(*PGM)'
    }, currentToken);
    assert.strictEqual(resRunCl.status, 200);
    assert.strictEqual(resRunCl.data.success, true);
    console.log('[PASS] Remote command endpoints verified');

    // 15. Security Guardrail Verification Tests
    console.log('\n[Test 15] Security Guardrail - Endpoint & Policy Verification');
    const resSecGet = await request('GET', '/security', null, currentToken);
    assert.strictEqual(resSecGet.status, 200);
    assert.strictEqual(resSecGet.data.policy, 'allow');
    console.log('[PASS] GET /security returned configuration');

    // Test Policy: BLOCK
    securityConfig.policy = 'block';

    console.log('\n[Test 15.1] Destructive CL Commands Blocked (DLTLIB, PWRDWNSYS, CLRPFM, SQL DROP)');
    const resDltLib = await request('POST', '/run-cl', { command: 'DLTLIB MYLIB' }, currentToken);
    assert.strictEqual(resDltLib.status, 403);
    assert.strictEqual(resDltLib.data.status, 'blocked');
    assert.strictEqual(resDltLib.data.matchedPattern, 'DLTLIB');

    const resPwrDwn = await request('POST', '/run-cl', { command: 'PWRDWNSYS *IMMED' }, currentToken);
    assert.strictEqual(resPwrDwn.status, 403);
    assert.strictEqual(resPwrDwn.data.status, 'blocked');

    const resClrPfm = await request('POST', '/run-cl', { command: 'CLRPFM FILE(MYLIB/F1)' }, currentToken);
    assert.strictEqual(resClrPfm.status, 403);

    const resRunSqlDrop = await request('POST', '/run-cl', { command: "RUNSQL SQL('DROP TABLE MYLIB.TABLE1')" }, currentToken);
    assert.strictEqual(resRunSqlDrop.status, 403);
    console.log('[PASS] All destructive CL commands rejected with 403 Forbidden');

    console.log('\n[Test 15.2] Destructive PASE Commands Blocked (rm -rf, shutdown)');
    const resRmRf = await request('POST', '/run-command', { command: 'rm -rf /somedir', environment: 'pase' }, currentToken);
    assert.strictEqual(resRmRf.status, 403);
    assert.strictEqual(resRmRf.data.status, 'blocked');

    const resShutdown = await request('POST', '/run-command', { command: 'shutdown -h now', environment: 'pase' }, currentToken);
    assert.strictEqual(resShutdown.status, 403);
    console.log('[PASS] Destructive PASE shell commands rejected with 403 Forbidden');

    console.log('\n[Test 15.3] Whitelist Exemption & Custom Blocked Commands');
    const resWhitelist = await request('POST', '/run-cl', { command: 'DLTSPLF *SELECT' }, currentToken);
    assert.strictEqual(resWhitelist.status, 200);
    assert.strictEqual(resWhitelist.data.success, true);

    const resCustomDanger = await request('POST', '/run-cl', { command: 'CUSTOMDANGER PARM(1)' }, currentToken);
    assert.strictEqual(resCustomDanger.status, 403);
    console.log('[PASS] Whitelist allowed and custom blocklist enforced');

    console.log('\n[Test 15.4] Action Inspection Guardrail');
    const resActionBlock = await request('POST', '/run-action', { actionName: 'Delete Library (Destructive)' }, currentToken);
    assert.strictEqual(resActionBlock.status, 403);
    assert(resActionBlock.data.error.toLowerCase().includes('destructive'));
    console.log('[PASS] Destructive action blocked before execution');

    console.log('\n[Test 15.5] Policy PROMPT: Agent Confirmation Protocol (Alt 1)');
    securityConfig.policy = 'prompt';

    // 1. Destructive CL command without confirmation -> 403 confirmation_required
    const resPromptRequired = await request('POST', '/run-cl', { command: 'DLTLIB MYLIB' }, currentToken);
    assert.strictEqual(resPromptRequired.status, 403);
    assert.strictEqual(resPromptRequired.data.status, 'confirmation_required');
    assert.strictEqual(resPromptRequired.data.isDestructive, true);
    assert(resPromptRequired.data.message.includes('confirm: true'));
    console.log('[PASS] Destructive command without confirmation returns 403 with status confirmation_required');

    // 2. Destructive CL command with confirm: true -> 200 executed
    const resPromptConfirmed = await request('POST', '/run-cl', { command: 'DLTLIB MYLIB', confirm: true }, currentToken);
    assert.strictEqual(resPromptConfirmed.status, 200);
    assert.strictEqual(resPromptConfirmed.data.success, true);
    console.log('[PASS] Destructive command with confirm: true executes successfully');

    // 3. Destructive action without confirm -> 403 confirmation_required
    const resActionConfirmReq = await request('POST', '/run-action', { actionName: 'Delete Library (Destructive)' }, currentToken);
    assert.strictEqual(resActionConfirmReq.status, 403);
    assert.strictEqual(resActionConfirmReq.data.status, 'confirmation_required');
    console.log('[PASS] Destructive action without confirmation returns 403 with status confirmation_required');

    // 4. Destructive action with confirm: true -> 200 executed
    const resActionConfirmed = await request('POST', '/run-action', { actionName: 'Delete Library (Destructive)', confirm: true }, currentToken);
    assert.strictEqual(resActionConfirmed.status, 200);
    assert.strictEqual(resActionConfirmed.data.success, true);
    console.log('[PASS] Destructive action with confirm: true executes successfully');

    console.log('\n[Test 15.6] Policy MODAL: Interactive Approval & Rejection');
    securityConfig.policy = 'modal';

    // Prompter approves
    guardrail.setPrompter(async (details) => {
      assert(details.command.includes('DLTLIB'));
      return true;
    });
    const resPromptApprove = await request('POST', '/run-cl', { command: 'DLTLIB MYLIB' }, currentToken);
    assert.strictEqual(resPromptApprove.status, 200);
    assert.strictEqual(resPromptApprove.data.success, true);
    console.log('[PASS] User interactive approval allows command to execute');

    // Prompter rejects
    guardrail.setPrompter(async (details) => {
      return false;
    });
    const resPromptReject = await request('POST', '/run-cl', { command: 'DLTLIB MYLIB' }, currentToken);
    assert.strictEqual(resPromptReject.status, 403);
    assert.strictEqual(resPromptReject.data.status, 'prompt_rejected');
    console.log('[PASS] User interactive rejection blocks command with 403 Forbidden');

    // Prompter timeout
    securityConfig.promptTimeoutSeconds = 0.05;
    guardrail.setPrompter(async () => new Promise(r => setTimeout(() => r(true), 150)));
    const resPromptTimeout = await request('POST', '/run-cl', { command: 'DLTLIB MYLIB' }, currentToken);
    assert.strictEqual(resPromptTimeout.status, 403);
    assert.strictEqual(resPromptTimeout.data.status, 'prompt_timeout');
    console.log('[PASS] User interactive prompt timeout properly halts execution');

    // Reset policy and timeout for CLI tests
    securityConfig.policy = 'prompt';
    securityConfig.promptTimeoutSeconds = 60;

    // 16. CLI Tests
    console.log('\n--- Testing CLI (codefori) ---');
    const cliEnv = {
      CODEFORI_PORT: String(activePort),
      CODEFORI_TOKEN: currentToken
    };

    // CLI status --json
    console.log('\n[CLI Test 1] codefori status --json');
    const cliStatusJson = await runCliAsync(['status', '--json'], cliEnv);
    assert.strictEqual(cliStatusJson.status, 0, `CLI failed with error: ${cliStatusJson.stderr}`);
    const parsedStatus = JSON.parse(cliStatusJson.stdout);
    assert.strictEqual(parsedStatus.ready, true);
    console.log('[PASS] codefori status --json returned valid JSON');

    // CLI status human-readable
    console.log('\n[CLI Test 2] codefori status (formatted text)');
    const cliStatusText = await runCliAsync(['status'], cliEnv);
    assert.strictEqual(cliStatusText.status, 0, `CLI failed with error: ${cliStatusText.stderr}`);
    assert(cliStatusText.stdout.includes('Code for IBM i Bridge Status'));
    console.log('[PASS] codefori status rendered clean formatted output');

    // CLI list-actions
    console.log('\n[CLI Test 3] codefori list-actions');
    const cliActions = await runCliAsync(['list-actions'], cliEnv);
    assert.strictEqual(cliActions.status, 0, `CLI failed with error: ${cliActions.stderr}`);
    assert(cliActions.stdout.includes('CRTBNDRPG'));
    console.log('[PASS] codefori list-actions displayed available actions');

    // CLI run-action
    console.log('\n[CLI Test 4] codefori run-action --name "Create Bound RPG Program (CRTBNDRPG)"');
    const cliRun = await runCliAsync(['run-action', '--name', 'Create Bound RPG Program (CRTBNDRPG)'], cliEnv);
    assert.strictEqual(cliRun.status, 0, `CLI failed with error: ${cliRun.stderr}`);
    assert(cliRun.stdout.includes('completed successfully'));
    console.log('[PASS] codefori run-action executed successfully');

    // CLI run-action failure exit code
    console.log('\n[CLI Test 5] codefori run-action failure non-zero exit code');
    const cliRunFail = await runCliAsync(['run-action', '--name', 'NonExistentAction'], cliEnv);
    assert.strictEqual(cliRunFail.status, 1);
    console.log('[PASS] Non-existent action exited with code 1');

    // CLI deploy
    console.log('\n[CLI Test 6] codefori deploy --workspace 0 --method changes');
    const cliDeploy = await runCliAsync(['deploy', '--workspace', '0', '--method', 'changes'], cliEnv);
    assert.strictEqual(cliDeploy.status, 0, `CLI failed with error: ${cliDeploy.stderr}`);
    console.log('[PASS] codefori deploy executed successfully');

    // CLI set-deploy-location
    console.log('\n[CLI Test 7] codefori set-deploy-location --remote "/home/USER/builds/project1"');
    const cliLocation = await runCliAsync(['set-deploy-location', '--remote', '/home/USER/builds/project1'], cliEnv);
    assert.strictEqual(cliLocation.status, 0, `CLI failed with error: ${cliLocation.stderr}`);
    console.log('[PASS] codefori set-deploy-location executed successfully');

    // CLI connect & disconnect
    console.log('\n[CLI Test 8] codefori connect --profile "PUB400" & codefori disconnect');
    const cliConn = await runCliAsync(['connect', '--profile', 'PUB400'], cliEnv);
    assert.strictEqual(cliConn.status, 0, `CLI failed with error: ${cliConn.stderr}`);
    const cliDisc = await runCliAsync(['disconnect'], cliEnv);
    assert.strictEqual(cliDisc.status, 0, `CLI failed with error: ${cliDisc.stderr}`);
    console.log('[PASS] codefori connect and disconnect executed successfully');

    // CLI flag precedence over env var
    console.log('\n[CLI Test 9] Flag precedence over environment variables');
    const cliFlagPrecedence = await runCliAsync(['status', '--json', '--port', String(activePort), '--token', currentToken], {
      CODEFORI_PORT: '9999', // wrong port in env
      CODEFORI_TOKEN: 'wrong-token' // wrong token in env
    });
    assert.strictEqual(cliFlagPrecedence.status, 0, `Flag precedence failed: ${cliFlagPrecedence.stderr}`);
    console.log('[PASS] Flags successfully took precedence over environment variables');

    // CLI diagnostics
    console.log('\n[CLI Test 10] codefori diagnostics');
    const cliDiags = await runCliAsync(['diagnostics'], cliEnv);
    assert(cliDiags.stdout.includes('RNF7030'));
    console.log('[PASS] codefori diagnostics retrieved compiler diagnostics');

    // CLI run-cl
    console.log('\n[CLI Test 11] codefori run-cl --command "WRKSYSSTS"');
    const cliRunCl = await runCliAsync(['run-cl', '--command', 'WRKSYSSTS'], cliEnv);
    assert.strictEqual(cliRunCl.status, 0, `CLI failed with error: ${cliRunCl.stderr}`);
    assert(cliRunCl.stdout.includes('Executed WRKSYSSTS'));
    console.log('[PASS] codefori run-cl executed successfully');

    // CLI exec-command with positional arg (PowerShell friendly)
    console.log('\n[CLI Test 12] codefori exec-command -c test.validCommand "MYLIB/MYPGM"');
    const cliExecPos = await runCliAsync(['exec-command', '-c', 'test.validCommand', 'MYLIB/MYPGM'], cliEnv);
    assert.strictEqual(cliExecPos.status, 0, `CLI failed with error: ${cliExecPos.stderr}`);
    assert(cliExecPos.stdout.includes('MYLIB/MYPGM'));
    console.log('[PASS] codefori exec-command with positional arguments executed successfully');

    // CLI exec-command with PowerShell unquoted style
    console.log('\n[CLI Test 13] codefori exec-command -c test.validCommand --args "[MYLIB/MYPGM]"');
    const cliExecPs = await runCliAsync(['exec-command', '-c', 'test.validCommand', '--args', '[MYLIB/MYPGM]'], cliEnv);
    assert.strictEqual(cliExecPs.status, 0, `CLI failed with error: ${cliExecPs.stderr}`);
    assert(cliExecPs.stdout.includes('MYLIB/MYPGM'));
    console.log('[PASS] codefori exec-command with PowerShell unquoted array syntax executed successfully');

    // CLI Security Guardrail Agent Confirmation Required Test
    console.log('\n[CLI Test 14] codefori run-cl --command "DLTLIB MYLIB" requires confirmation under policy prompt');
    securityConfig.policy = 'prompt';
    const cliRunClConfirmReq = await runCliAsync(['run-cl', '--command', 'DLTLIB MYLIB'], cliEnv);
    assert.strictEqual(cliRunClConfirmReq.status, 1, 'Command requiring confirmation should exit with code 1');
    assert(cliRunClConfirmReq.stderr.includes('Confirmation Required') || cliRunClConfirmReq.stdout.includes('Confirmation Required'));
    assert(cliRunClConfirmReq.stderr.includes('--confirm') || cliRunClConfirmReq.stdout.includes('--confirm'));
    console.log('[PASS] CLI cleanly displays confirmation instructions when command requires confirmation');

    // CLI Security Guardrail Execution with --confirm flag
    console.log('\n[CLI Test 15] codefori run-cl --command "DLTLIB MYLIB" --confirm executes successfully');
    const cliRunClConfirmed = await runCliAsync(['run-cl', '--command', 'DLTLIB MYLIB', '--confirm'], cliEnv);
    assert.strictEqual(cliRunClConfirmed.status, 0, `CLI failed with error: ${cliRunClConfirmed.stderr}`);
    assert(cliRunClConfirmed.stdout.includes('Executed DLTLIB MYLIB'));
    console.log('[PASS] CLI executes destructive command successfully when --confirm flag is provided');

    // CLI Security Guardrail Blocking Test (under policy 'block', even with --confirm it is rejected)
    console.log('\n[CLI Test 16] codefori run-cl --command "DLTLIB MYLIB" --confirm blocked under policy block');
    securityConfig.policy = 'block';
    const cliRunClBlocked = await runCliAsync(['run-cl', '--command', 'DLTLIB MYLIB', '--confirm'], cliEnv);
    assert.strictEqual(cliRunClBlocked.status, 1, 'Blocked command should exit with code 1');
    assert(cliRunClBlocked.stderr.includes('Security Guardrail Blocked') || cliRunClBlocked.stdout.includes('Security Guardrail Blocked'));
    console.log('[PASS] CLI cleanly blocks destructive command under policy block even with --confirm');

    console.log('\n========================================================');
    console.log(' ALL VERIFICATION TESTS PASSED SUCCESSFULLY! (100%)');
    console.log('========================================================\n');
  } finally {
    await server.stop();
    console.log('[PASS] Bridge server stopped cleanly');
  }
}

runTests().catch(err => {
  console.error('\n[FAIL] Test suite failed:', err);
  process.exit(1);
});
