const chalk = require("chalk");

function Logger(scope = "App") {
    return {
        log: (msg) => console.log(chalk.green(`[${scope}] ${msg}`)),
        error: (msg) => console.error(chalk.red(`[${scope}] ${msg}`)),
        warn: (msg) => console.warn(chalk.yellow(`[${scope}] ${msg}`)),
    };
}

module.exports = Logger;