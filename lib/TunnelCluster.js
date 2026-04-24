const { EventEmitter } = require('events');
const debug = require('debug')('localtunnel:client');
const fs = require('fs');
const net = require('net');
const tls = require('tls');

const dgram = require('dgram');
const HeaderHostTransformer = require('./HeaderHostTransformer');
const { FRAME_DATA, FRAME_SESSION_CLOSE, encodeFrame, createFrameParser } = require('./UdpFrameCodec');

// manages groups of tunnels
module.exports = class TunnelCluster extends EventEmitter {
  constructor(id, opts = {}) {
    super(opts);
    this.opts = opts;
    this.connections = new Set();
    this.id = id;
    this.closed = false;
  }

  get tunnelCount() {
    return this.connections.size;
  }

  open() {
    const opt = this.opts;

    // Prefer IP if returned by the server
    const remoteHostOrIp = opt.remote_ip || opt.remote_host;
    const remotePort = opt.remote_port;
    const localHost = opt.local_host || 'localhost';
    const localPort = opt.local_port;
    const localProtocol = opt.local_https ? 'https' : 'http';
    const allowInvalidCert = opt.allow_invalid_cert;
    const token = opt.token;
    const staticTcpTunnel = opt.staticTcpTunnel;

    debug(
      'establishing tunnel %s://%s:%s <> %s:%s',
      localProtocol,
      localHost,
      localPort,
      remoteHostOrIp,
      remotePort
    );

    // connection to localtunnel server
    let remote;
    if (!staticTcpTunnel || !staticTcpTunnel.tls) {
      remote = net.connect({
        host: staticTcpTunnel?.host ?? remoteHostOrIp,
        port: staticTcpTunnel?.port ?? remotePort,
      });
    } else {
      remote = tls.connect({
        host: staticTcpTunnel.host ?? remoteHostOrIp,
        port: staticTcpTunnel.port ?? remotePort,
        servername: staticTcpTunnel.host ?? remoteHostOrIp,
      });
    }

    this.connections.add(remote);

    remote.setKeepAlive(true);
    // Ship the handshake immediately instead of waiting for Nagle to flush it;
    // the server has a short handshake window and the first write is tiny.
    remote.setNoDelay(true);

    remote.once('close', () => {
      this.connections.delete(remote);
    });

    remote.on('error', err => {
      debug('got remote connection error', err.message);

      // emit connection refused errors immediately, because they
      // indicate that the tunnel can't be established.
      if (err.code === 'ECONNREFUSED') {
        this.emit(
          'error',
          new Error(
            `connection refused: ${remoteHostOrIp}:${remotePort} (check your firewall settings)`
          )
        );
      }

      remote.end();
    });

    const connLocal = () => {
      if (remote.destroyed) {
        debug('remote destroyed');
        this.emit('dead');
        return;
      }

      debug('connecting locally to %s://%s:%d', localProtocol, localHost, localPort);
      remote.pause();

      if (allowInvalidCert) {
        debug('allowing invalid certificates');
      }

      const getLocalCertOpts = () =>
        allowInvalidCert
          ? { rejectUnauthorized: false }
          : {
              cert: fs.readFileSync(opt.local_cert),
              key: fs.readFileSync(opt.local_key),
              ca: opt.local_ca ? [fs.readFileSync(opt.local_ca)] : undefined,
            };

      // connection to local http server
      const local = opt.local_https
        ? tls.connect({ host: localHost, port: localPort, ...getLocalCertOpts() })
        : net.connect({ host: localHost, port: localPort });

      const remoteClose = () => {
        debug('remote close');
        this.emit('dead');
        local.end();
      };

      remote.once('close', remoteClose);

      // TODO some languages have single threaded servers which makes opening up
      // multiple local connections impossible. We need a smarter way to scale
      // and adjust for such instances to avoid beating on the door of the server
      local.once('error', err => {
        debug('local error %s', err.message);
        local.end();

        remote.removeListener('close', remoteClose);

        if (err.code !== 'ECONNREFUSED'
            && err.code !== 'ECONNRESET') {
          return remote.end();
        }

        // retrying connection to local server
        setTimeout(connLocal, 1000);
      });

      local.once('connect', () => {
        debug('connected locally');
        remote.resume();

        let stream = remote;

        // if user requested specific local host
        // then we use host header transform to replace the host header
        if (opt.local_host) {
          debug('transform Host header to %s', opt.local_host);
          stream = remote.pipe(new HeaderHostTransformer({ host: opt.local_host }));
        }
        stream.pipe(local).pipe(remote);

        // when local closes, also get a new remote
        local.once('close', hadError => {
          debug('local connection closed [%s]', hadError);
        });
      });
    };

    if (opt.type !== 'tcp') {
      remote.on('data', data => {
        const match = data.toString().match(/^(\w+) (\S+)/);
        if (match) {
          this.emit('request', {
            method: match[1],
            path: match[2],
          });
        }
      });
    }

    // tunnel is considered open when remote connects
    remote.once('connect', () => {
      this.writeHandshake(remote, this.id, token);
      this.emit('open', remote);

      if (opt.type === 'udp') {
        this._handleUdpTunnel(remote, opt);
      } else if (opt.type === 'tcp') {
        this._waitForDataThenConnectLocal(remote, opt);
      } else {
        connLocal();
      }
    });
  }

  _waitForDataThenConnectLocal(remote, opt) {
    const localHost = opt.local_host || 'localhost';
    const localPort = opt.local_port;

    const earlyClose = () => {
      debug('tcp: remote closed before data');
      this.emit('dead');
    };
    remote.once('close', earlyClose);

    remote.once('data', (firstChunk) => {
      // Data arrived, remove the early close handler
      remote.removeListener('close', earlyClose);

      if (remote.destroyed) {
        this.emit('dead');
        return;
      }

      debug('tcp: first data received, connecting locally to %s:%d', localHost, localPort);
      remote.pause();

      const local = net.connect({ host: localHost, port: localPort });

      const remoteClose = () => {
        debug('tcp: remote close');
        this.emit('dead');
        local.end();
      };

      remote.once('close', remoteClose);

      local.once('error', (err) => {
        debug('tcp: local error %s', err.message);
        local.end();
        remote.removeListener('close', remoteClose);

        if (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET') {
          return remote.end();
        }

        // Can't retry meaningfully in TCP mode — the data is lost
        remote.end();
      });

      local.once('connect', () => {
        debug('tcp: connected locally');
        // Write the first chunk that triggered the connection
        local.write(firstChunk);
        remote.resume();
        // Direct bidirectional pipe, no header transform
        remote.pipe(local).pipe(remote);

        local.once('close', (hadError) => {
          debug('tcp: local connection closed [%s]', hadError);
        });
      });
    });

  }

  _handleUdpTunnel(remote, opt) {
    const localHost = opt.local_host || 'localhost';
    const localPort = opt.local_port;

    // One local UDP socket per remote session (keyed by source addr:port)
    const sessions = new Map();
    const parser = createFrameParser();

    remote.on('data', (chunk) => {
      const frames = parser(chunk);
      for (const frame of frames) {
        if (frame.type === FRAME_DATA) {
          const key = `${frame.header.addr}:${frame.header.port}`;
          let session = sessions.get(key);

          if (!session) {
            // New session: create a dedicated local UDP socket
            const sock = dgram.createSocket('udp4');
            session = { key, addr: frame.header.addr, port: frame.header.port, localSocket: sock };
            sessions.set(key, session);

            sock.on('message', (msg) => {
              if (remote.destroyed) return;
              const responseFrame = encodeFrame(FRAME_DATA, { addr: session.addr, port: session.port }, msg);
              remote.write(responseFrame);
            });

            sock.on('error', (err) => {
              debug('udp: local socket error for session %s: %s', key, err.message);
              sessions.delete(key);
              try { sock.close(); } catch (e) {}
            });
          }

          // Forward datagram to local UDP service
          session.localSocket.send(frame.payload, localPort, localHost);

        } else if (frame.type === FRAME_SESSION_CLOSE) {
          const key = `${frame.header.addr}:${frame.header.port}`;
          const session = sessions.get(key);
          if (session) {
            try { session.localSocket.close(); } catch (e) {}
            sessions.delete(key);
            debug('udp: session %s closed by server', key);
          }
        }
      }
    });

    const cleanup = () => {
      for (const [key, session] of sessions) {
        try { session.localSocket.close(); } catch (e) {}
      }
      sessions.clear();
    };

    remote.once('close', () => {
      cleanup();
      this.emit('dead');
    });

    remote.once('error', () => {
      cleanup();
    });
  }

  writeHandshake(remote, clientId, token) {
    const data = {
      'clientId': clientId,
      'token': token ?? 'undefined',
    };
    remote.write(`${JSON.stringify(data)}`);
  }

  closeAll() {
    this.closed = true;
    this.connections.forEach((r) => {
      try {
        r.destroy();
      } catch(err) {};
    });
    this.connections.clear();
  }
};
