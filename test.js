const localtunnel = require('./localtunnel');

const run = (async () => {
  let tunnel;
  try {
    tunnel = await localtunnel({
      port: 3000,                     // le port de ton serveur local
      host: 'https://tunnel.dev.kast.app',   // ton serveur localtunnel custom
      authKey: 'abcd1234',
      clientId: 'device-1',
      staticTcpTunnel: {
        tls: true,
        host: 'socket-tunnel.dev.kast.app',
        port: 443
      }
    });
    /*tunnel = await localtunnel({
      port: 3000,                     // le port de ton serveur local
      host: 'http://localhost:3001',   // ton serveur localtunnel custom
      authKey: 'abcd1234',
      clientId: 'device-2'
    });*/
  } catch(err) {
    console.error("Error connection : ", err)
  }

  if (!tunnel) {
    setTimeout(() => {
      // retry
      run();
    }, 1000);
    return;
  }
  // the assigned public url for your tunnel
  // i.e. https://abcdefgjhij.localtunnel.me
  console.log("tunnel : ", tunnel)

  tunnel.on("connection", (...args) => {
    console.log("args : ", ...args);

  });

  tunnel.on("error", (err) => {
    console.error("Error : ", err);
    try {
      tunnel.close();
    } catch(_) {};
    setTimeout(() => {
      // retry
      run();
    }, 1000);
  })

  tunnel.on('close', () => {
    // tunnels are closed
    console.log("close");
  });
});

run();