const shell = require("shelljs");
const { validate } = require("compare-versions");
const packageJson = require("../package.json");

const path = process.argv[1];
const args = process.argv.splice(2);

const version = args[0] ?? packageJson.version;
console.log("Version: ", version);
let devMode = false;
if (version.startsWith("dev")) devMode = true;
else if (!validate(version))
  throw new Error("Version format isn't correct. Version must be : X.Y.Z or X.Y.Z-(alpha|beta|...).A. Exemple : 1.10.2 or 1.18.0-beta.1");

const imageTag = devMode ? version : "v" + version;
const buildCmd = "docker push ghcr.io/kalyzee/k-localtunnel-client:" + imageTag;
console.log("Running command : ", buildCmd);
shell.exec(buildCmd);
