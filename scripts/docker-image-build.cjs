const shell = require("shelljs");
const { validate } = require("compare-versions");
const packageJson = require("../package.json");

require("dotenv").config();

const path = process.argv[1];
const args = process.argv.splice(2);

const version = args[0] ?? packageJson.version;
console.log("Version: ", version);
let devMode = false;
if (version.startsWith("dev")) devMode = true;
else if (!validate(version))
  throw new Error("Version format isn't correct. Version must be : X.Y.Z or X.Y.Z-(alpha|beta|...).A. Exemple : 1.10.2 or 1.18.0-beta.1");

const npmToken = process.env.NPM_TOKEN;
if (!npmToken || !npmToken.trim().length) {
  throw new Error("Npm token is needed to download module from '@kalyzee'. Add your npm token in .env : 'NPM_TOKEN=...'");
}

const npmTokenMask = "XXXXXX";
const appVersion = version;
const imageTag = devMode ? version : `v${version}`;
const buildCmd = `docker build .`;
const buildArgs = [
  `--tag ghcr.io/kalyzee/k-localtunnel-client:${imageTag}`,
  `--build-arg APP_VERSION=${appVersion}`,
  `--build-arg NPM_TOKEN=${npmTokenMask}`,
  `--build-arg APP_DOCKER_IMAGE_BUILTAT="${new Date().toLocaleDateString("en", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  })}"`,
];
const cmd = `${buildCmd}${buildArgs.length ? ` ${buildArgs.join(" ")}` : ""}`;
console.log("Running command : ", cmd);
shell.exec(cmd.replace(npmTokenMask, npmToken));