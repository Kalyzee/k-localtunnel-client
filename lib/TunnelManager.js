const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const { parse } = require('url');
const debug = require('debug')('localtunnel:manager');

const Tunnel = require('./Tunnel');

class TunnelManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host - Tunnel server URL
   * @param {string} [opts.authKey] - Auth key for the server
   * @param {Array<{port: number, id: string, local_host?: string, type?: 'http'|'tcp', tcpPort?: number}>} opts.tunnels - Tunnel configs
   * @param {object} [opts.staticTcpTunnel] - Static TCP tunnel config
   * @param {boolean} [opts.staticTcpTunnel.tls]
   * @param {string} [opts.staticTcpTunnel.host]
   * @param {number} [opts.staticTcpTunnel.port]
   */
  constructor(opts) {
    super();
    this.host = opts.host;
    this.authKey = opts.authKey;
    this.tunnelConfigs = new Map();
    for (const t of opts.tunnels) {
      this.tunnelConfigs.set(t.id, t);
    }
    this.staticTcpTunnel = opts.staticTcpTunnel;

    this.activeTunnels = new Map();
    /** IDs currently authorized by the server */
    this.authorizedIds = new Set();
    this._tunnelRetryTimeouts = new Map();
    this.closed = false;
    this._sseReconnectTimeout = null;
    this._sseResponse = null;

    this._connectSSE();
  }

  // --- SSE ---

  _connectSSE() {
    if (this.closed) return;

    const ids = Array.from(this.tunnelConfigs.keys()).join(',');
    const parsed = parse(this.host);
    const isSecure = parsed.protocol === 'https:';
    const lib = isSecure ? https : http;

    const sseUrl = `${this.host}/api/sse?ids=${encodeURIComponent(ids)}`;
    debug('Connecting to SSE: %s', sseUrl);

    const headers = {};
    if (this.authKey) headers['x-lt-auth'] = this.authKey;

    const req = lib.get(sseUrl, { headers }, (res) => {
      if (res.statusCode !== 200) {
        debug('SSE connection failed with status %d', res.statusCode);
        res.resume();
        this.emit('error', new Error(`SSE connection failed with status ${res.statusCode}`));
        this._scheduleReconnect();
        return;
      }

      this._sseResponse = res;
      debug('SSE connected');
      this.emit('sse:connected');

      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const lines = part.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6));
                this._handleAuthEvent(event);
              } catch (e) {
                // ignore parse errors (heartbeat, etc.)
              }
            }
          }
        }
      });

      res.on('end', () => {
        debug('SSE connection ended');
        this._sseResponse = null;
        this.emit('sse:disconnected');
        this._scheduleReconnect();
      });

      res.on('error', (err) => {
        debug('SSE connection error: %s', err.message);
        this._sseResponse = null;
        this.emit('sse:disconnected');
        this._scheduleReconnect();
      });
    });

    req.on('error', (err) => {
      debug('SSE request error: %s', err.message);
      this.emit('error', err);
      this._scheduleReconnect();
    });

    this._sseRequest = req;
  }

  _scheduleReconnect() {
    if (this.closed) return;
    if (this._sseReconnectTimeout) clearTimeout(this._sseReconnectTimeout);
    this._sseReconnectTimeout = setTimeout(() => {
      debug('Reconnecting SSE...');
      this._connectSSE();
    }, 3000);
  }

  // --- Auth events ---

  _handleAuthEvent(event) {
    const { id, authorized } = event;
    debug('Authorization event: %s -> %s', id, authorized ? 'AUTHORIZED' : 'UNAUTHORIZED');

    if (authorized) {
      this.authorizedIds.add(id);
      this._openTunnel(id);
    } else {
      this.authorizedIds.delete(id);
      this._cancelRetry(id);
      this._closeTunnel(id);
    }
  }

  _scheduleRetry(id) {
    if (this.closed || !this.authorizedIds.has(id)) return;
    this._cancelRetry(id);
    const timeout = setTimeout(() => {
      this._tunnelRetryTimeouts.delete(id);
      if (this.closed || !this.authorizedIds.has(id)) return;
      debug('Retrying tunnel %s', id);
      this._openTunnel(id);
    }, 3000);
    this._tunnelRetryTimeouts.set(id, timeout);
  }

  _cancelRetry(id) {
    const timeout = this._tunnelRetryTimeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this._tunnelRetryTimeouts.delete(id);
    }
  }

  // --- Tunnel lifecycle ---

  async _openTunnel(id) {
    if (this.activeTunnels.has(id)) {
      debug('Tunnel %s already active, skipping', id);
      return;
    }

    const config = this.tunnelConfigs.get(id);
    if (!config) {
      debug('Unknown tunnel ID: %s', id);
      return;
    }

    const tunnelOpts = {
      port: config.port,
      local_host: config.local_host,
      host: this.host,
      authKey: this.authKey,
      clientId: id,
      staticTcpTunnel: this.staticTcpTunnel,
      type: config.type || 'http',
      tcpPort: config.tcpPort,
    };

    debug('Opening tunnel %s', id);

    const tunnel = new Tunnel(tunnelOpts);

    tunnel.on('error', (err) => {
      debug('Tunnel %s error: %s', id, err.message);
      this.emit('error', err, id);
      // Close and retry if still authorized
      this.activeTunnels.delete(id);
      try { tunnel.close(); } catch (_) {}
      this._scheduleRetry(id);
    });

    tunnel.on('close', () => {
      debug('Tunnel %s closed', id);
      this.activeTunnels.delete(id);
      this.emit('close', id);
      // Retry if still authorized (unexpected close)
      this._scheduleRetry(id);
    });

    tunnel.on('request', (info) => {
      this.emit('request', info, id);
    });

    try {
      await new Promise((resolve, reject) => {
        tunnel.open((err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      this.activeTunnels.set(id, tunnel);
      if (tunnel.type === 'tcp') {
        debug('Tunnel %s opened (TCP, public port: %s)', id, tunnel.publicPort);
      } else {
        debug('Tunnel %s opened: %s', id, tunnel.url);
      }
      this.emit('open', id, tunnel);
    } catch (err) {
      debug('Failed to open tunnel %s: %s', id, err.message);
      this.emit('error', err, id);
      this._scheduleRetry(id);
    }
  }

  _closeTunnel(id) {
    const tunnel = this.activeTunnels.get(id);
    if (!tunnel) return;
    try {
      tunnel.close();
    } catch (_) {}
    this.activeTunnels.delete(id);
    debug('Tunnel %s closed by authorization revocation', id);
    this.emit('unauthorized', id);
  }

  /**
   * Get an active tunnel by ID
   */
  getTunnel(id) {
    return this.activeTunnels.get(id);
  }

  /**
   * Close all tunnels and SSE connection
   */
  close() {
    this.closed = true;
    this.authorizedIds.clear();
    if (this._sseReconnectTimeout) clearTimeout(this._sseReconnectTimeout);
    for (const [id, timeout] of this._tunnelRetryTimeouts) {
      clearTimeout(timeout);
    }
    this._tunnelRetryTimeouts.clear();
    if (this._sseRequest) {
      try { this._sseRequest.destroy(); } catch (_) {}
    }
    if (this._sseResponse) {
      try { this._sseResponse.destroy(); } catch (_) {}
    }
    for (const [id, tunnel] of this.activeTunnels) {
      try { tunnel.close(); } catch (_) {}
    }
    this.activeTunnels.clear();
    this.emit('close');
  }
}

module.exports = TunnelManager;
