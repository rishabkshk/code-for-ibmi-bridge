import * as http from 'http';
import * as net from 'net';
import { CodeForIBMiAdapter } from '../ibmi/adapter';
import { handleRequest, RouteContext } from './routes';
import { SecurityGuardrail } from '../security/guardrail';

export class BridgeServer {
  private server: http.Server | undefined;
  private host: string = '127.0.0.1';
  private port: number = 0;
  private activeSockets: Set<net.Socket> = new Set();
  private token: string;
  private adapter: CodeForIBMiAdapter;
  private onTokenResetCallback: () => Promise<string>;
  private guardrail: SecurityGuardrail;

  constructor(
    token: string,
    adapter: CodeForIBMiAdapter,
    onTokenReset: () => Promise<string>,
    guardrail?: SecurityGuardrail
  ) {
    this.token = token;
    this.adapter = adapter;
    this.onTokenResetCallback = onTokenReset;
    this.guardrail = guardrail || new SecurityGuardrail();
  }

  public getGuardrail(): SecurityGuardrail {
    return this.guardrail;
  }

  public setGuardrail(guardrail: SecurityGuardrail): void {
    this.guardrail = guardrail;
  }

  public updateToken(newToken: string): void {
    this.token = newToken;
  }

  public getToken(): string {
    return this.token;
  }

  public getPort(): number {
    return this.port;
  }

  public getHost(): string {
    return this.host;
  }

  public isRunning(): boolean {
    return this.server !== undefined && this.server.listening;
  }

  public start(requestedPort: number = 0): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      if (this.isRunning()) {
        resolve({ host: this.host, port: this.port });
        return;
      }

      const routeCtx: RouteContext = {
        adapter: this.adapter,
        getToken: () => this.token,
        onResetToken: async () => {
          const newToken = await this.onTokenResetCallback();
          this.token = newToken;
          return newToken;
        },
        getPort: () => this.port,
        guardrail: this.guardrail
      };

      this.server = http.createServer((req, res) => {
        // Enforce loopback check
        const remoteIp = req.socket.remoteAddress;
        if (remoteIp && remoteIp !== '127.0.0.1' && remoteIp !== '::1' && remoteIp !== '::ffff:127.0.0.1') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Access denied: loopback interface only' }));
          return;
        }

        handleRequest(req, res, routeCtx).catch(err => {
          console.error('[BridgeServer] Unhandled request error:', err);
          if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          }
        });
      });

      // Track active sockets for immediate graceful termination
      this.server.on('connection', socket => {
        this.activeSockets.add(socket);
        socket.once('close', () => {
          this.activeSockets.delete(socket);
        });
      });

      this.server.on('error', err => {
        console.error('[BridgeServer] Server error:', err);
        reject(err);
      });

      // Bind strictly to 127.0.0.1
      this.server.listen(requestedPort, this.host, () => {
        const address = this.server?.address() as net.AddressInfo;
        this.port = address.port;
        resolve({ host: this.host, port: this.port });
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise(resolve => {
      if (!this.server) {
        resolve();
        return;
      }

      for (const socket of this.activeSockets) {
        socket.destroy();
      }
      this.activeSockets.clear();

      this.server.close(() => {
        this.server = undefined;
        this.port = 0;
        resolve();
      });
    });
  }
}
