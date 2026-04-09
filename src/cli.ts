#!/usr/bin/env node
import { Command } from "commander";
import { cronCommand } from "./cli/cron.js";
import { startCommand } from "./cli/start.js";
import { initCommand } from "./cli/init.js";
import { stopCommand, restartCommand, statusCommand, logsCommand, continuityCommand } from "./cli/daemon.js";
import { sessionsCommand } from "./cli/sessions.js";
import { migrateCommand } from "./cli/migrate.js";
import { lcmCommand } from "./cli/lcm.js";
import { configCommand } from "./cli/config.js";

const program = new Command()
  .name("tomo")
  .description("Tomo — personal assistant powered by Claude")
  .version("0.3.0");

program.addCommand(initCommand);
program.addCommand(configCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(cronCommand);
program.addCommand(continuityCommand);
program.addCommand(migrateCommand);
program.addCommand(sessionsCommand);
program.addCommand(lcmCommand);

program.parse();
