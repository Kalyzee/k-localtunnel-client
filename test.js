const localtunnel = require('./localtunnel');

const manager = localtunnel({
  host: 'http://localhost:3001',
  authKey: 'abcd1234',
  tunnels: [
    { port: 3000, id: 'device-1' },
    { port: 3000, id: 'device-2' },
  ],
  /*
  // Exemple avec un serveur distant et TCP statique :
  host: 'https://tunnel.dev.kast.app',
  staticTcpTunnel: {
    tls: true,
    host: 'socket-tunnel.dev.kast.app',
    port: 443,
  },
  */
});

manager.on('open', (id, tunnel) => {
  console.log(`Tunnel ${id} opened: ${tunnel.url}`);
});

manager.on('unauthorized', (id) => {
  console.log(`Tunnel ${id} closed by authorization revocation`);
});

manager.on('close', (id) => {
  if (typeof id === 'string') {
    console.log(`Tunnel ${id} closed`);
  }
});

manager.on('error', (err, id) => {
  if (id) {
    console.error(`Error on tunnel ${id}:`, err.message);
  } else {
    console.error('Manager error:', err.message);
  }
});

manager.on('sse:connected', () => {
  console.log('SSE connected, waiting for authorization events...');
});

manager.on('sse:disconnected', () => {
  console.log('SSE disconnected');
});
