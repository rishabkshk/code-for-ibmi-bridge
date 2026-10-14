import * as http from 'http';
import { URL } from 'url';
import { CodeForIBMiAdapter } from '../ibmi/adapter';
import { authenticateRequest } from './auth';
import { SecurityGuardrail } from '../security/guardrail';

export interface RouteContext {
  adapter: CodeForIBMiAdapter;
  getToken: () => string;
  onResetToken: () => Promise<string>;
  getPort: () => number;
  guardrail?: SecurityGuardrail;
}

export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext
): Promise<void> {
  // CORS & Security headers for loopback
  res.setHeader('Access-Control-Allow-Origin', 'null');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CodeForIBMi-Token');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Authenticate Request
  if (!authenticateRequest(req, res, ctx.getToken())) {
    return;
  }

  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = reqUrl.pathname.replace(/\/+$/, '') || '/';
  const method = req.method?.toUpperCase();

  try {
    // 2. Dispatch routes
    if (pathname === '/status' && method === 'GET') {
      const status = ctx.adapter.getStatus(ctx.getPort(), Boolean(ctx.getToken()));
      const securityConfig = ctx.guardrail?.getConfig();
      sendJson(res, 200, {
        ...status,
        securityPolicy: securityConfig?.policy || 'prompt'
      });
      return;
    }

    if (pathname === '/security' && method === 'GET') {
      const securityConfig = ctx.guardrail?.getConfig() || {};
      sendJson(res, 200, securityConfig);
      return;
    }

    if (pathname === '/activate' && method === 'POST') {
      if (!ctx.adapter.isInstalled()) {
        sendJson(res, 404, {
          error: "Extension 'halcyontechltd.code-for-ibmi' is not installed in VS Code."
        });
        return;
      }
      const activation = await ctx.adapter.activate();
      sendJson(res, 200, activation);
      return;
    }

    if (pathname === '/actions' && method === 'GET') {
      if (!ctx.adapter.isInstalled()) {
        sendJson(res, 503, {
          error: "Extension 'halcyontechltd.code-for-ibmi' is not available."
        });
        return;
      }
      const wsParam = reqUrl.searchParams.get('workspace') || reqUrl.searchParams.get('workspaceIndex');
      const workspaceIndex = wsParam !== null ? parseInt(wsParam, 10) : undefined;
      const actions = await ctx.adapter.getActions(workspaceIndex);
      sendJson(res, 200, { actions });
      return;
    }

    if (pathname === '/run-action' && method === 'POST') {
      const body = await parseJsonBody(req);
      const actionName = body.actionName || body.name;
      if (!actionName || typeof actionName !== 'string') {
        sendJson(res, 400, { error: "Field 'actionName' is required." });
        return;
      }
      const workspaceIndex = body.workspaceIndex !== undefined ? Number(body.workspaceIndex) : undefined;

      // Inspect action for destructive commands if enabled
      const confirmed = body.confirm === true || body.confirmed === true || String(body.confirm).toLowerCase() === 'true' || String(body.confirmed).toLowerCase() === 'true';

      // Inspect target action for destructive command if enabled
      if (ctx.guardrail && ctx.guardrail.getConfig().enableActionInspection) {
        const availableActions = await ctx.adapter.getActions(workspaceIndex);
        const targetAction = availableActions.find(
          a => a.name.toLowerCase() === actionName.toLowerCase()
        );
        if (targetAction && targetAction.command) {
          const actionEnv = targetAction.environment || 'ile';
          const decision = await ctx.guardrail.evaluateCommand(targetAction.command, actionEnv, { confirmed });
          if (!decision.allowed) {
            sendJson(res, 403, {
              error: decision.reason || `Action '${actionName}' contains a destructive command blocked by security guardrail.`,
              actionName,
              command: targetAction.command,
              environment: actionEnv,
              status: decision.status,
              isDestructive: decision.isDestructive,
              matchedPattern: decision.matchedPattern,
              message: decision.message
            });
            return;
          }
        }
      }

      const result = await ctx.adapter.runAction(actionName, workspaceIndex);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/deploy' && method === 'POST') {
      const body = await parseJsonBody(req);
      const workspaceIndex = body.workspaceIndex !== undefined ? Number(body.workspaceIndex) : undefined;
      const result = await ctx.adapter.deploy({
        workspaceIndex,
        method: body.method,
        selectedFiles: body.selectedFiles
      });
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/set-deploy-location' && method === 'POST') {
      const body = await parseJsonBody(req);
      const remotePath = body.remotePath || body.path;
      if (!remotePath) {
        sendJson(res, 400, { error: "Field 'remotePath' is required." });
        return;
      }
      const workspaceIndex = body.workspaceIndex !== undefined ? Number(body.workspaceIndex) : undefined;
      const result = await ctx.adapter.setDeployLocation(remotePath, workspaceIndex);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/connect' && method === 'POST') {
      const body = await parseJsonBody(req);
      const result = await ctx.adapter.connect(body.connectionName || body.profile);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/disconnect' && method === 'POST') {
      const result = await ctx.adapter.disconnect();
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/exec-command' && method === 'POST') {
      const body = await parseJsonBody(req);
      const commandId = body.commandId || body.command;
      if (!commandId) {
        sendJson(res, 400, { error: "Field 'commandId' is required." });
        return;
      }
      const result = await ctx.adapter.execCommand(commandId, body.args);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/diagnostics' && method === 'GET') {
      const fileFilter = reqUrl.searchParams.get('file') || undefined;
      const severityFilter = reqUrl.searchParams.get('severity') || undefined;
      const result = await ctx.adapter.getDiagnostics(fileFilter, severityFilter);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/diagnostics/clear' && method === 'POST') {
      const result = await ctx.adapter.clearDiagnostics();
      sendJson(res, 200, result);
      return;
    }

    if ((pathname === '/run-command' || pathname === '/run-cl') && method === 'POST') {
      const body = await parseJsonBody(req);
      const command = body.command || body.cmd;
      if (!command) {
        sendJson(res, 400, { error: "Field 'command' is required." });
        return;
      }
      const defaultEnv = pathname === '/run-cl' ? 'ile' : (body.environment || body.env || 'ile');
      const confirmed = body.confirm === true || body.confirmed === true || String(body.confirm).toLowerCase() === 'true' || String(body.confirmed).toLowerCase() === 'true';

      // Intercept and evaluate potentially destructive commands
      if (ctx.guardrail) {
        const decision = await ctx.guardrail.evaluateCommand(command, defaultEnv, { confirmed });
        if (!decision.allowed) {
          sendJson(res, 403, {
            error: decision.reason || 'Destructive command blocked by security guardrail.',
            command,
            environment: defaultEnv,
            status: decision.status,
            isDestructive: decision.isDestructive,
            matchedPattern: decision.matchedPattern,
            message: decision.message
          });
          return;
        }
      }

      const result = await ctx.adapter.runRemoteCommand(command, defaultEnv, body.cwd);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/token/reset' && method === 'POST') {
      const newToken = await ctx.onResetToken();
      sendJson(res, 200, { newToken });
      return;
    }

    // Route not found
    sendJson(res, 404, { error: `Route not found: ${method} ${pathname}` });
  } catch (err: any) {
    const statusCode = err.statusCode || (err.message && err.message.includes('not found') ? 404 : 500);
    sendJson(res, statusCode, {
      error: err.message || 'Internal Bridge Server Error',
      validActions: err.validActions
    });
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
  if (res.writableEnded) return;
  res.writeHead(statusCode);
  res.end(JSON.stringify(data));
}

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err: any) {
        const error: any = new Error(`Invalid JSON body: ${err.message}`);
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', err => reject(err));
  });
}
