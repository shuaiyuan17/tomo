#!/usr/bin/env node
import { Command } from "commander";
import { cronCommand } from "./cli/cron.js";
import { startCommand } from "./cli/start.js";
import { initCommand } from "./cli/init.js";
import { stopCommand, restartCommand, statusCommand, logsCommand, continuityCommand } from "./cli/daemon.js";
import { sessionsCommand } from "./cli/sessions.js";

const program = new Command()
  .name("tomo")
  .description("Tomo — personal assistant powered by Claude")
  .version("0.1.4");

program.addCommand(initCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(cronCommand);
program.addCommand(continuityCommand);
program.addCommand(sessionsCommand);

program.parse();
