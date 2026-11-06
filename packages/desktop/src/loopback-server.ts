import http from 'node:http';
import { AddressInfo } from 'node:net';
import { getInstallGuideMarkdown } from './install-guide.js';

export interface LoopbackServerOptions {
  port?: number | undefined;
  getState?: (() => {
    isFirstLaunch: boolean;
    initialRoute: 'setup-wizard' | 'main';
    currentStep?: string | undefined;
  }) | undefined;
}

export class LoopbackServer {
  private server: http.Server | null = null;
  private port: number;
  private url: string = '';
  private getState?: (() => {
    isFirstLaunch: boolean;
    initialRoute: 'setup-wizard' | 'main';
    currentStep?: string | undefined;
  }) | undefined;

  constructor(options: LoopbackServerOptions = {}) {
    this.port = options.port ?? 0;
    this.getState = options.getState;
  }

  public async start(): Promise<string> {
    if (this.server) {
      return this.url;
    }

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      srv.once('error', (err) => {
        reject(err);
      });

      srv.listen(this.port, '127.0.0.1', () => {
        const address = srv.address() as AddressInfo;
        this.port = address.port;
        this.url = `http://127.0.0.1:${this.port}`;
        this.server = srv;
        resolve(this.url);
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  public getPort(): number {
    return this.port;
  }

  public getUrl(): string {
    return this.url;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/wizard/state') {
      const state = this.getState ? this.getState() : {
        isFirstLaunch: true,
        initialRoute: 'setup-wizard',
        currentStep: 'connect-whatsapp',
      };
      res.writeHead(200);
      res.end(JSON.stringify(state));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/status') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'running',
        uptime: process.uptime(),
        version: '0.1.0',
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/install-guide') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.writeHead(200);
      res.end(getInstallGuideMarkdown());
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}
