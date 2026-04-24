# k-localtunnel-client

Client de tunnel permettant d'exposer des services locaux sur internet via un serveur [k-localtunnel-server](https://github.com/Kalyzee/k-localtunnel-server). Le client se connecte au serveur en SSE, attend l'autorisation pour chaque tunnel, puis ouvre automatiquement les connexions.

Supporte trois modes de tunneling :
- **HTTP** : accessible via sous-domaine `<id>.tunnel.exemple.com`
- **TCP** : accessible via un port TCP public assigne sur le serveur
- **UDP** : accessible via un port UDP public assigne sur le serveur

## Prerequis

- Node.js >= 18
- Yarn
- Un serveur k-localtunnel-server accessible

## Installation

```bash
git clone https://github.com/Kalyzee/k-localtunnel-client.git
cd k-localtunnel-client
yarn install
```

## Utilisation programmatique

```js
const localtunnel = require('./localtunnel');

const manager = localtunnel({
  host: 'https://tunnel.exemple.com',
  authKey: 'key_<objectId>_<data>',
  tunnels: [
    { port: 3000, id: 'device-1' },                              // HTTP (defaut)
    { port: 5432, id: 'device-2', type: 'tcp', tcpPort: 25000 }, // TCP sur port 25000
    { port: 5353, id: 'device-3', type: 'udp' },                 // UDP, port assigne par le serveur
  ],
});

manager.on('open', (id, tunnel) => {
  if (tunnel.type === 'tcp' || tunnel.type === 'udp') {
    console.log(`Tunnel ${id} ouvert (${tunnel.type.toUpperCase()}, port: ${tunnel.publicPort})`);
  } else {
    console.log(`Tunnel ${id} ouvert: ${tunnel.url}`);
  }
});

manager.on('unauthorized', (id) => {
  console.log(`Tunnel ${id} revoque`);
});

manager.on('error', (err, id) => {
  console.error(`Erreur${id ? ` sur ${id}` : ''}:`, err.message);
});

// Fermer proprement
// manager.close();
```

### Options

| Option | Type | Requis | Description |
|--------|------|--------|-------------|
| `host` | `string` | oui | URL du serveur k-localtunnel-server |
| `authKey` | `string` | non | API key au format `key_<objectId>_<data>`, creee cote serveur (onglet API Keys de l'admin). Obligatoire si le serveur est demarre avec `--auth-required`. Envoyee dans le header `x-lt-auth`. |
| `tunnels` | `Array<object>` | oui | Liste des tunnels a gerer (voir ci-dessous) |
| `staticTcpTunnel` | `object` | non | Configuration TCP statique (voir ci-dessous) |

#### Configuration d'un tunnel

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `port` | `number` | oui | Port local a exposer |
| `id` | `string` | oui | Identifiant du tunnel |
| `local_host` | `string` | non | Hostname local (defaut: `localhost`) |
| `type` | `string` | non | Type de tunnel : `http` (defaut), `tcp`, ou `udp` |
| `tcpPort` | `number` | non | Port TCP public souhaite (mode `tcp` uniquement, sinon assigne par l'OS) |
| `udpPort` | `number` | non | Port UDP public souhaite (mode `udp` uniquement, sinon assigne par l'OS) |
| `maxConn` | `number` | non | Nombre max de sockets souhaite. La valeur effective est le min entre cette valeur et la limite serveur |

#### Option `staticTcpTunnel`

Quand le serveur utilise un port TCP unique partage (derriere un reverse proxy par exemple) :

| Champ | Type | Description |
|-------|------|-------------|
| `host` | `string` | Hostname du serveur TCP |
| `port` | `number` | Port du serveur TCP |
| `tls` | `boolean` | Utiliser TLS pour la connexion TCP |

```js
const manager = localtunnel({
  host: 'https://tunnel.exemple.com',
  authKey: 'key_<objectId>_<data>',
  tunnels: [{ port: 3000, id: 'device-1' }],
  staticTcpTunnel: {
    tls: true,
    host: 'socket-tunnel.exemple.com',
    port: 443,
  },
});
```

### TunnelManager

La fonction `localtunnel()` retourne un `TunnelManager` (EventEmitter) qui gere l'ensemble du cycle de vie :

1. Connexion SSE au serveur avec la liste des IDs
2. Reception des events d'autorisation
3. Ouverture/fermeture automatique des tunnels
4. Retry automatique en cas d'erreur (3s)
5. Reconnexion SSE automatique en cas de deconnexion (3s)

#### Resilience reseau

Le client detecte plusieurs classes d'echec silencieux et recupere automatiquement :

- **SSE zombie** (NAT/firewall qui drop une connexion idle sans envoyer de FIN/RST) : la socket SSE a un idle timeout de 45s cote client, combine a un heartbeat serveur de 15s. Au-dela de 45s sans donnee recue, la socket est detruite et la reconnexion demarre. Un `setKeepAlive(true, 30000)` est aussi active en defense en profondeur.
- **Serveur qui a oublie le client** (grace timeout ou agent error sans notification SSE) : si aucune socket tunnel ne survit au moins 3s pendant une fenetre de 15s, le `Tunnel` remonte une erreur. Le `TunnelManager` le ferme et relance un `GET /?new` complet pour re-enregistrer le client sous son ID.
- **Nagle sur le handshake** : `setNoDelay(true)` est applique sur chaque socket tunnel pour que le handshake JSON parte immediatement sans etre retarde par le buffering TCP (sinon, sous rafale, il peut depasser la fenetre de handshake cote serveur).

#### Events

| Event | Arguments | Description |
|-------|-----------|-------------|
| `open` | `(id, tunnel)` | Tunnel autorise et connexion etablie. `tunnel.url` (HTTP) ou `tunnel.publicPort` (TCP/UDP) |
| `close` | `(id)` | Tunnel ferme |
| `unauthorized` | `(id)` | Tunnel ferme suite a une revocation d'autorisation par le serveur |
| `error` | `(err, id?)` | Erreur sur un tunnel specifique ou sur la connexion SSE |
| `request` | `(info, id)` | Requete recue sur un tunnel. `info` contient `method` et `path` |
| `sse:connected` | - | Connexion SSE etablie avec le serveur |
| `sse:disconnected` | - | Connexion SSE perdue |

#### Methodes

| Methode | Description |
|---------|-------------|
| `getTunnel(id)` | Retourne l'instance tunnel active pour cet ID, ou `undefined` |
| `close()` | Ferme tous les tunnels et la connexion SSE |

## Docker

### Variables d'environnement

| Variable | Requis | Description |
|----------|--------|-------------|
| `TUNNEL_HOST` | oui | URL du serveur k-localtunnel-server |
| `TUNNEL_AUTH_KEY` | non | API key au format `key_<objectId>_<data>` (voir onglet API Keys de l'admin serveur). Obligatoire si le serveur a `--auth-required`. |
| `TUNNELS_CONFIG` | oui | JSON array des tunnels : `[{"port": 3000, "id": "mon-id"}]`. Champs optionnels : `type`, `tcpPort`, `udpPort` |
| `TUNNEL_SOCKET_TCP_HOST` | non | Hostname du serveur TCP statique |
| `TUNNEL_SOCKET_TCP_PORT` | non | Port du serveur TCP statique |
| `TUNNEL_SOCKET_TCP_TLS` | non | `"true"` pour activer TLS sur la connexion TCP |

### Build

```bash
yarn docker-image-build
# ou
docker build -t k-localtunnel-client .
```

### Run

```bash
docker run -d \
  --restart always \
  --name localtunnel-client \
  --net host \
  -e TUNNEL_HOST=https://tunnel.exemple.com \
  -e TUNNEL_AUTH_KEY=key_<objectId>_<data> \
  -e TUNNELS_CONFIG='[{"port":3000,"id":"device-1"},{"port":5432,"id":"device-2","type":"tcp","tcpPort":25000}]' \
  k-localtunnel-client
```

### Docker Compose

```yaml
services:
  localtunnel:
    image: ghcr.io/kalyzee/k-localtunnel-client:latest
    container_name: localtunnel
    network_mode: "host"
    restart: always
    environment:
      TUNNEL_HOST: https://tunnel.exemple.com
      TUNNEL_AUTH_KEY: key_<objectId>_<data>
      TUNNELS_CONFIG: '[{"port": 3000, "id": "device-1"}, {"port": 5432, "id": "device-2", "type": "tcp"}]'
      # Optionnel : TCP statique
      # TUNNEL_SOCKET_TCP_HOST: socket-tunnel.exemple.com
      # TUNNEL_SOCKET_TCP_TLS: "true"
      # TUNNEL_SOCKET_TCP_PORT: 443
```

## Flux de connexion

```
1. Le client se connecte en SSE au serveur
   GET /api/sse?ids=device-1,device-2
   Header: x-lt-auth: <auth-key>

2. Le serveur evalue les IDs contre ses filtres d'autorisation
   et envoie un event pour chaque ID :
   data: {"id":"device-1","authorized":true}
   data: {"id":"device-2","authorized":false}

3. Pour chaque ID autorise, le manager :
   a. Demande l'ouverture du tunnel : GET /?new (x-lt-client-id: device-1)
   b. Recoit les infos de connexion TCP (port, token)
   c. Ouvre les sockets TCP et etablit le tunnel
   → HTTP : accessible sur https://device-1.tunnel.exemple.com
   → TCP : accessible sur tcp://tunnel.exemple.com:<port>
   → UDP : accessible sur udp://tunnel.exemple.com:<port>

4. Si le serveur revoque l'autorisation :
   → Event SSE : {"id":"device-1","authorized":false}
   → Le manager ferme le tunnel automatiquement

5. En cas d'erreur (connexion TCP, serveur offline...) :
   → Retry automatique toutes les 3 secondes
   → Tant que l'ID reste autorise
```

## Architecture

```
localtunnel.js          Point d'entree, retourne un TunnelManager
lib/
  TunnelManager.js      Gestion SSE + cycle de vie multi-tunnels
  Tunnel.js             Gestion d'un tunnel individuel (init HTTP + establish)
  TunnelCluster.js      Gestion des connexions (HTTP piping, TCP deferred, UDP framing)
  HeaderHostTransformer.js  Transformation du header Host pour le proxy HTTP local
  UdpFrameCodec.js      Codec de framing UDP (encode/decode des datagrams sur TCP)
index.js                Point d'entree Docker (lecture env vars)
bin/lt.js               CLI
```

## Scripts

| Script | Description |
|--------|-------------|
| `yarn test` | Lancer les tests |
| `yarn docker-image-build` | Build l'image Docker |
| `yarn docker-image-push` | Push l'image Docker |
| `yarn docker-image-build-push` | Build + push |

## Licence

MIT
