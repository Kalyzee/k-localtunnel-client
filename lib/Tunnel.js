/* eslint-disable consistent-return, no-underscore-dangle */

const { parse } = require('url');
const { EventEmitter } = require('events');
const axios = require('axios');
const debug = require('debug')('localtunnel:client');

const TunnelCluster = require('./TunnelCluster');

let i = 0;
module.exports = class Tunnel extends EventEmitter {
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.closed = false;
    if (!this.opts.host) {
      this.opts.host = 'https://localtunnel.me';
    }
    this.i = i++;
  }

  _getInfo(body) {
    /* eslint-disable camelcase */
    const { id, ip, port, url, cached_url, max_conn_count, token, type, public_port } = body;
    const { host, port: local_port, local_host } = this.opts;
    const { local_https, local_cert, local_key, local_ca, allow_invalid_cert } = this.opts;
    const { staticTcpTunnel } = this.opts;
    return {
      id,
      name: id,
      url,
      cached_url,
      max_conn: max_conn_count || 1,
      remote_host: parse(host).hostname,
      remote_ip: ip,
      remote_port: port,
      local_port,
      local_host,
      local_https,
      local_cert,
      local_key,
      local_ca,
      allow_invalid_cert,
      token,
      staticTcpTunnel,
      type: type || 'http',
      public_port,
    };
    /* eslint-enable camelcase */
  }

  // initialize connection
  // callback with connection info
  _init(cb) {
    const opt = this.opts;
    const getInfo = this._getInfo.bind(this);

    const headers = {};
    if (opt.authKey) headers['x-lt-auth'] = opt.authKey;
    if (opt.clientId) headers['x-lt-client-id'] = opt.clientId;
    const localProtocol = opt.type === 'tcp' ? 'tcp' : opt.type === 'udp' ? 'udp' : (opt.local_https ? 'https' : 'http');
    const localHost = opt.local_host || 'localhost';
    headers['x-lt-target'] = `${localProtocol}://${localHost}:${opt.port}`;

    const params = {
      responseType: 'json',
      headers: headers,
    };

    const baseUri = `${opt.host}/`;
    // no subdomain at first, maybe use requested domain
    const assignedDomain = opt.subdomain;
    // where to quest
    let uri = baseUri + (assignedDomain || '?new');
    // Add type and port params for TCP/UDP tunnels
    if (opt.type && (opt.type === 'tcp' || opt.type === 'udp')) {
      const separator = uri.includes('?') ? '&' : '?';
      uri += `${separator}type=${opt.type}`;
      const publicPort = opt.udpPort || opt.tcpPort;
      if (publicPort) {
        uri += `&${opt.type}_port=${publicPort}`;
      }
    }
    // Client can request a max connection count
    if (opt.maxConn) {
      const separator = uri.includes('?') ? '&' : '?';
      uri += `${separator}max_conn=${opt.maxConn}`;
    }

    const getUrl = () => {
      axios
        .get(uri, params)
        .then(res => {
          const body = res.data;
          debug('got tunnel information', res.data);
          if (res.status !== 200) {
            const err = new Error(
              (body && body.message) || 'localtunnel server returned an error, please try again'
            );
            return cb(err);
          }
          cb(null, getInfo(body));
        })
        .catch(err => {
          const response = err?.response;
          const status = response?.status;
          const serverMsg = response?.data?.error;

          // Non-retryable errors: return immediately
          if (status === 401) {
            return cb(new Error(serverMsg ?? "Unauthorized"));
          }
          if (status === 403) {
            return cb(new Error(serverMsg ?? "Tunnel ID not authorized"));
          }
          if (status === 409) {
            return cb(new Error(serverMsg ?? "Client ID already used"));
          }

          // Retryable: server offline or transient error
          debug(`tunnel server offline: ${err.message} - ${serverMsg}, retry 1s`);
          clearTimeout(this.retryTimeout);
          this.retryTimeout = setTimeout(getUrl, 1000);
        });
    };
    getUrl();
  }

  _establish(info) {
    // increase max event listeners so that localtunnel consumers don't get
    // warning messages as soon as they setup even one listener. See #71
    this.setMaxListeners(info.max_conn + (EventEmitter.defaultMaxListeners || 10));

    this.tunnelCluster = new TunnelCluster(info.id, info);

    // Detect a stuck reconnection loop: when a socket dies and no subsequent
    // socket manages to stay alive more than SOCKET_ALIVE_MS within
    // SOCKET_UNHEALTHY_MS, the server has likely forgotten this client — emit
    // an error so TunnelManager tears down this Tunnel and re-registers via
    // `/?new`. The timestamp marks the *start of the failure window*, not the
    // last healthy moment, so a tunnel that was healthy for hours doesn't
    // bail out on the first blip.
    const SOCKET_ALIVE_MS = 3000;
    const SOCKET_UNHEALTHY_MS = 15000;
    let failingSince = null;

    // only emit the url the first time
    this.tunnelCluster.once('open', () => {
      this.emit('url', info.url);
    });

    // re-emit socket error
    this.tunnelCluster.on('error', err => {
      if (this.closed) return;
      debug('got socket error', err.message);
      this.emit('error', err);
    });

    this.tunnelCluster.on('open', tunnel => {
      debug('tunnel open [total: %d]', this.tunnelCluster.tunnelCount);

      // A socket that survives SOCKET_ALIVE_MS ends any ongoing failure window.
      const aliveTimer = setTimeout(() => {
        failingSince = null;
      }, SOCKET_ALIVE_MS);

      const closeHandler = () => {
        tunnel.destroy();
      };

      if (this.closed) {
        clearTimeout(aliveTimer);
        return closeHandler();
      }

      this.once('close', closeHandler);
      tunnel.once('close', () => {
        clearTimeout(aliveTimer);
        this.removeListener('close', closeHandler);
      });
    });

    // when a tunnel dies, open a new one
    this.tunnelCluster.on('dead', () => {
      debug('tunnel dead [total: %d]', this.tunnelCluster.tunnelCount);
      if (this.closed) {
        return;
      }

      // Enter the failure window on the first dead without recovery.
      if (failingSince === null) {
        failingSince = Date.now();
      }

      const failingFor = Date.now() - failingSince;
      if (failingFor > SOCKET_UNHEALTHY_MS) {
        debug(
          'sockets have been failing to stay alive for %dms — bailing out to force re-registration',
          failingFor
        );
        return this.emit(
          'error',
          new Error('tunnel sockets repeatedly rejected; server likely forgot the client')
        );
      }

      if (this.tunnelCluster.tunnelCount < info.max_conn) this.tunnelCluster.open();
    });

    this.tunnelCluster.on('request', req => {
      this.emit('request', req);
    });

    // establish as many tunnels as allowed
    for (let count = 0; count < info.max_conn; ++count) {
      this.tunnelCluster.open();
    }
  }

  open(cb) {
    this._init((err, info) => {
      if (err) {
        return cb(err);
      }

      this.clientId = info.name;
      this.url = info.url;
      this.type = info.type;
      this.publicPort = info.public_port;

      // `cached_url` is only returned by proxy servers that support resource caching.
      if (info.cached_url) {
        this.cachedUrl = info.cached_url;
      }

      this._establish(info);
      cb();
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimeout);
    this.tunnelCluster.closeAll();
    this.emit('close');
  }
};
