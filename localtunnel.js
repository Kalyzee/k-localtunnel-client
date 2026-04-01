const TunnelManager = require('./lib/TunnelManager');

/**
 * Create a TunnelManager that connects via SSE and manages
 * tunnel lifecycles based on server authorization.
 *
 * @param {object} opts
 * @param {string} opts.host - Tunnel server URL
 * @param {string} [opts.authKey] - Auth key
 * @param {Array<{port: number, id: string}>} opts.tunnels - Tunnel configs
 * @param {object} [opts.staticTcpTunnel] - Static TCP tunnel config
 * @returns {TunnelManager}
 */
module.exports = function localtunnel(opts) {
  return new TunnelManager(opts);
};
