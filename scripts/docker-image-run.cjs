const shell = require("shelljs");
const fs = require("fs");
const _path = require("path");

require('dotenv').config();

const path = process.argv[1];
const args = process.argv.splice(2);
if (!args.length)
  throw new Error("Missing argument : tag is needed");

const tag = args[0];

const envFilename = '.env.image.docker'
if (!fs.existsSync(envFilename))
  throw new Error(`Missing environnement : ${envFilename} is needed to run an image`);

const pwd = shell.exec('pwd').stdout.replace(/\n/, '');
const opensslDirectory= 'openssl';
const opensslHostVolume = _path.join(pwd, opensslDirectory);

const runCmd = 'sudo docker run';
const runArgs = [
  `--env-file ${envFilename}`,
  '--network host',
  `--volume=${opensslHostVolume}:/openssl`,
  `ghcr.io/kalyzee/k-localtunnel-client:${tag}`
];
const cmd = `${runCmd}${runArgs.length ? ` ${runArgs.join(' ')}` : ''}`;
console.log('Running command : ', cmd);
shell.exec(cmd);