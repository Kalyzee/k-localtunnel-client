const localtunnel = require('./localtunnel');

(async () => {
  const tunnel = await localtunnel({
    port: 8080,                     // le port de ton serveur local
    host: 'http://localhost:3001',   // ton serveur localtunnel custom
    authKey: 'abcd1234',
    clientId: 'device-1'
  });

  // the assigned public url for your tunnel
  // i.e. https://abcdefgjhij.localtunnel.me
  console.log("tunnel : ", tunnel)

  tunnel.on("connection", (...args) => {
    console.log("args : ", ...args);

  });

  tunnel.on('close', () => {
    // tunnels are closed
    console.log("close");
  });
})();