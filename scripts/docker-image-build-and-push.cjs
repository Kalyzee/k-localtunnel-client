const shell = require("shelljs");
const packageJson = require("../package.json");

const path = process.argv[1];
const args = process.argv.splice(2);

const version = args[0] ?? packageJson.version;
shell.exec("yarn docker-image-build " + version);
shell.exec("yarn docker-image-push " + version);