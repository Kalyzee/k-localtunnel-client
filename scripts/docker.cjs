const shell = require("shelljs");

const args = process.argv.splice(2)

let baseCommand = 'web'

if (args[0] === 'test') {
  baseCommand = `test test` // first test is docker profile, second one is package.json script (the docker command)
  if (args.length > 1) baseCommand += ` ${args.splice(1).join(' ')}` // add optionnal params
}

const downCommand = 'docker-compose down --remove-orphans'
const clearCommand = 'clear'
const runCommand = `docker-compose run ${baseCommand}`

shell.exec(downCommand)
shell.exec(clearCommand)
shell.exec(runCommand)