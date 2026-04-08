const localtunnel = require('./localtunnel');
const debug = require('debug')('localtunnel:main');

const rawConfig = process.env.TUNNELS_CONFIG;
const host = process.env.TUNNEL_HOST;
const authKey = process.env.TUNNEL_AUTH_KEY;
const socketTcpHost = process.env.TUNNEL_SOCKET_TCP_HOST;
const socketTcpTls = process.env.TUNNEL_SOCKET_TCP_TLS === "true";
const socketTcpPort = process.env.TUNNEL_SOCKET_TCP_PORT ? Number(process.env.TUNNEL_SOCKET_TCP_PORT) : undefined;

let tunnels = [];

try {
  const json = JSON.parse(rawConfig || '[]');
  debug("json: ", json);
  if (!Array.isArray(json)) throw new Error("TUNNEL_CONFIG must be an array");
  if (!json.length) throw new Error("TUNNEL_CONFIG can't be empty");
  for (let item of json) {
    if (typeof item.port !== "number") throw new Error("item.port of TUNNEL_CONFIG must be a valid number");
    if (typeof item.id !== "string" || !item.id?.trim()) throw new Error("item.id of TUNNEL_CONFIG must be a valid string");
    if (item.type && item.type !== 'http' && item.type !== 'tcp' && item.type !== 'udp') throw new Error("item.type of TUNNEL_CONFIG must be 'http', 'tcp', or 'udp'");
    tunnels.push(item);
  }
  if (!host?.trim()) throw new Error("TUNNEL_HOST can't undefined")
} catch (error) {
  console.error("Erreur de lecture des variables d'environnents :", error.message);
  process.exit(1);
}

const manager = localtunnel({
  host,
  authKey,
  tunnels,
  staticTcpTunnel: socketTcpHost || socketTcpTls || socketTcpPort ? {
    tls: socketTcpTls,
    host: socketTcpHost,
    port: socketTcpPort,
  } : undefined,
});

manager.on('open', (id, tunnel) => {
  if (tunnel.type === 'tcp' || tunnel.type === 'udp') {
    debug(`Tunnel ${id} opened (${tunnel.type.toUpperCase()}, public port: ${tunnel.publicPort})`);
  } else {
    debug(`Tunnel ${id} opened: ${tunnel.url}`);
  }
});

manager.on('unauthorized', (id) => {
  debug(`Tunnel ${id} closed by authorization revocation`);
});

manager.on('close', (id) => {
  if (typeof id === 'string') {
    debug(`Tunnel ${id} closed`);
  }
});

manager.on('error', (err, id) => {
  if (id) {
    debug(`Error on tunnel ${id}:`, err.message);
  } else {
    debug('Manager error:', err.message);
  }
});

manager.on('sse:connected', () => {
  debug('SSE connected, waiting for authorization events...');
});

manager.on('sse:disconnected', () => {
  debug('SSE disconnected');
});
