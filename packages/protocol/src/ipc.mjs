import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export function getSocketPath(projectRoot) {
  // Use a deterministic hash in /tmp to avoid macOS 104-char socket path limit
  const hash = crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
  return path.join('/tmp', `contextos-osd-${hash}.sock`);
}

export class IPCServer {
  constructor({ socketPath, handler }) {
    this.socketPath = socketPath;
    this.handler = handler;
    this.server = null;
    this.connections = new Set();
  }

  async start() {
    // Clean up existing socket file if it exists
    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch (_) {}

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.connections.add(socket);
        let buffer = '';

        socket.on('data', async (chunk) => {
          buffer += chunk.toString('utf8');
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) continue;

            let request;
            try {
              request = JSON.parse(line);
            } catch (err) {
              socket.write(JSON.stringify({ error: `Malformed JSON: ${err.message}` }) + '\n');
              continue;
            }

            const { id, method, params } = request;
            try {
              const result = await this.handler(method, params);
              socket.write(JSON.stringify({ id, result, error: null }) + '\n');
            } catch (err) {
              socket.write(JSON.stringify({ id, result: null, error: err.message }) + '\n');
            }
          }
        });

        socket.on('close', () => {
          this.connections.delete(socket);
        });

        socket.on('error', () => {
          this.connections.delete(socket);
        });
      });

      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        resolve();
      });
    });
  }

  async stop() {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }

    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch (_) {}
  }
}

export class IPCClient {
  constructor({ socketPath }) {
    this.socketPath = socketPath;
    this.socket = null;
    this.pending = new Map();
    this.requestId = 0;
    this.buffer = '';
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.socketPath, () => {
        resolve();
      });

      this.socket.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8');
        let newlineIndex;
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, newlineIndex).trim();
          this.buffer = this.buffer.slice(newlineIndex + 1);
          if (!line) continue;

          try {
            const response = JSON.parse(line);
            const callback = this.pending.get(response.id);
            if (callback) {
              this.pending.delete(response.id);
              if (response.error) {
                callback.reject(new Error(response.error));
              } else {
                callback.resolve(response.result);
              }
            }
          } catch (_) {}
        }
      });

      this.socket.on('error', (err) => {
        for (const [, callback] of this.pending) {
          callback.reject(err);
        }
        this.pending.clear();
        reject(err);
      });
    });
  }

  async call(method, params = {}) {
    if (!this.socket || this.socket.destroyed) {
      await this.connect();
    }

    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
