const localtunnel = require('./localtunnel');

const rawConfig = process.env.TUNNELS_CONFIG;
const host = process.env.TUNNEL_HOST;
const authKey = process.env.TUNNEL_AUTH_KEY;
const socketTcpHost = process.env.TUNNEL_SOCKET_TCP_HOST;
const socketTcpTls = process.env.TUNNEL_SOCKET_TCP_TLS === "true";
const socketTcpPort = process.env.TUNNEL_SOCKET_TCP_PORT ? Number(process.env.TUNNEL_SOCKET_TCP_PORT) : undefined;

let tunnels = [];

try {
  // On transforme la string JSON en véritable tableau JS
  const json = JSON.parse(rawConfig || '[]');
  console.log("json: ", json);
  if (!Array.isArray(json)) throw new Error("TUNNEL_CONFIG must be an array");
  if (!json.length) throw new Error("TUNNEL_CONFIG can't be empty");
  for (let item of json) {
    if (typeof item.port !== "number") throw new Error("item.port of TUNNEL_CONFIG must be a valid number");
    if (typeof item.id !== "string" || !item.id?.trim()) throw new Error("item.id of TUNNEL_CONFIG must be a valid string");
    tunnels.push(item);
  } 
  if (!host?.trim()) throw new Error("TUNNEL_HOST can't undefined")
} catch (error) {
  console.error("Erreur de lecture des variables d'environnents :", error.message);
  process.exit(1);
}


const runTunnel = async (config) => {
  let tunnel;
  try {
    const conf = {
      port: config.port,                     // le port de ton serveur local
      host: host,   // ton serveur localtunnel custom
      authKey: authKey,
      clientId: config.id,
      staticTcpTunnel: socketTcpHost || socketTcpTls || socketTcpPort ? {
        tls: socketTcpTls,
        host: socketTcpHost,
        port:  socketTcpPort 
      } : undefined
    };
    console.log("Run new tunnel : ", conf);
    tunnel = await localtunnel(conf);
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
}

// Maintenant vous pouvez itérer sur vos données
tunnels.forEach(config => {
  console.log(`Démarrage du tunnel pour le port ${config.port} avec l'ID ${config.id}`);
  runTunnel(config);
});

