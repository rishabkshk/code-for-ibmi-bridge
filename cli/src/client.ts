import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface BridgeConfig {
  host: string;
  port: number;
  token: string;
  json: boolean;
}

export interface CliOptions {
  host?: string;
  port?: string | number;
  token?: string;
  json?: boolean;
}

export class BridgeClient {
  public config: BridgeConfig;

  constructor(cliOpts: CliOptions = {}) {
    this.config = this.resolveConfig(cliOpts);
  }

  private resolveConfig(opts: CliOptions): BridgeConfig {
    const state = this.readStateFile();

    // 1. Host: Flags > Env (CODEFORI_HOST / CODEFORIBMI_HOST) > State file > Default
    const host =
      opts.host ||
      process.env.CODEFORI_HOST ||
      process.env.CODEFORIBMI_HOST ||
      state?.host ||
      '127.0.0.1';

    // 2. Port: Flags > Env (CODEFORI_PORT / CODEFORIBMI_PORT) > State file > Default (5588)
    const rawPort =
      opts.port ||
      process.env.CODEFORI_PORT ||
      process.env.CODEFORIBMI_PORT ||
      state?.port ||
      5588;
    const port = Number(rawPort);

    // 3. Token: Flags > Env (CODEFORI_TOKEN / CODEFORIBMI_TOKEN) > State file > Default
    const token =
      opts.token ||
      process.env.CODEFORI_TOKEN ||
      process.env.CODEFORIBMI_TOKEN ||
      state?.token ||
      '';

    const json = Boolean(opts.json);

    return { host, port, token, json };
  }

  private readStateFile(): { host?: string; port?: number; token?: string } | undefined {
    const candidates = [
      path.join(os.homedir(), '.codefori', 'bridge.json'),
      path.join(os.homedir(), '.code-for-ibmi-bridge', 'bridge.json')
    ];

    for (const stateFile of candidates) {
      try {
        if (fs.existsSync(stateFile)) {
          const content = fs.readFileSync(stateFile, 'utf-8');
          return JSON.parse(content);
        }
      } catch {
        // Continue to next candidate
      }
    }
    return undefined;
  }

  public async getStatus(): Promise<any> {
    return this.request('GET', '/status');
  }

  public async activate(): Promise<any> {
    return this.request('POST', '/activate');
  }

  public async listActions(workspaceIndex?: number): Promise<any> {
    const query = workspaceIndex !== undefined ? `?workspaceIndex=${workspaceIndex}` : '';
    return this.request('GET', `/actions${query}`);
  }

  public async runAction(
    actionName: string,
    workspaceIndex?: number,
    confirm?: boolean,
    file?: string,
    deployMethod?: string
  ): Promise<any> {
    return this.request('POST', '/run-action', { actionName, workspaceIndex, confirm, file, deployMethod });
  }

  public async readEventf(object: string): Promise<any> {
    return this.request('POST', '/read-eventf', { object });
  }

  public async deploy(workspaceIndex?: number, method?: string, selectedFiles?: string[], confirm?: boolean): Promise<any> {
    return this.request('POST', '/deploy', { workspaceIndex, method, selectedFiles, confirm });
  }

  public async setDeployLocation(remotePath: string, workspaceIndex?: number): Promise<any> {
    return this.request('POST', '/set-deploy-location', { remotePath, workspaceIndex });
  }

  public async getDeployLocation(workspaceIndex?: number): Promise<any> {
    const query = workspaceIndex !== undefined ? `?workspaceIndex=${workspaceIndex}` : '';
    return this.request('GET', `/deploy-location${query}`);
  }


  public async connect(connectionName?: string): Promise<any> {
    return this.request('POST', '/connect', { connectionName });
  }

  public async disconnect(): Promise<any> {
    return this.request('POST', '/disconnect');
  }

  public async execCommand(commandId: string, args?: any[]): Promise<any> {
    return this.request('POST', '/exec-command', { commandId, args });
  }

  public async getDiagnostics(file?: string, severity?: string): Promise<any> {
    const params = new URLSearchParams();
    if (file) params.append('file', file);
    if (severity) params.append('severity', severity);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/diagnostics${qs}`);
  }

  public async clearDiagnostics(): Promise<any> {
    return this.request('POST', '/diagnostics/clear');
  }

  public async runRemoteCommand(command: string, environment: string = 'ile', cwd?: string, confirm?: boolean): Promise<any> {
    return this.request('POST', '/run-command', { command, environment, cwd, confirm });
  }

  public async resetToken(): Promise<any> {
    return this.request('POST', '/token/reset');
  }

  private request(method: string, path: string, body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.config.token) {
        return reject(
          new Error(
            'No bridge authentication token provided. Pass --token, set CODEFORI_TOKEN, or launch VS Code with the bridge extension.'
          )
        );
      }

      const payload = body ? JSON.stringify(body) : undefined;
      const headers: http.OutgoingHttpHeaders = {
        'X-CodeForIBMi-Token': this.config.token,
        'X-CodeForIBMi-Client': 'codefori-cli',
        'Accept': 'application/json'
      };

      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(
        {
          hostname: this.config.host,
          port: this.config.port,
          path,
          method,
          headers
        },
        res => {
          let responseData = '';
          res.on('data', chunk => {
            responseData += chunk;
          });
          res.on('end', () => {
            let parsed: any;
            try {
              parsed = responseData ? JSON.parse(responseData) : {};
            } catch {
              parsed = { raw: responseData };
            }

            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const errorMessage =
                parsed?.error ||
                `Bridge returned HTTP ${res.statusCode}: ${res.statusMessage || 'Error'}`;
              const error: any = new Error(errorMessage);
              error.statusCode = res.statusCode;
              error.response = parsed;
              reject(error);
            }
          });
        }
      );

      req.on('error', err => {
        const error = err as any;
        if (error.code === 'ECONNREFUSED') {
          reject(
            new Error(
              `Cannot connect to Code for IBM i Bridge at http://${this.config.host}:${this.config.port}. ` +
              `Make sure VS Code is open and the bridge server is running.`
            )
          );
        } else {
          reject(new Error(`Bridge request failed: ${error.message}`));
        }
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}
