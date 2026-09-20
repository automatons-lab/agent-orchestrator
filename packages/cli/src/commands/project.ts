import chalk from "chalk";
import type { Command } from "commander";
import {
  getPortfolio,
  getPortfolioSessionCounts,
  isPortfolioEnabled,
  loadPreferences,
  savePreferences,
} from "@aoagents/ao-core";
import {
  formatPortfolioDegradedReason,
  formatPortfolioProjectName,
  formatPortfolioProjectStatus,
} from "../lib/portfolio-display.js";
import { registerProjectConfigCommands } from "./project-config.js";

function assertPortfolioEnabled(): void {
  if (isPortfolioEnabled()) return;
  console.error(
    chalk.red(
      "Portfolio mode is disabled. Unset AO_ENABLE_PORTFOLIO or set it to 1 to use `ao project`.",
    ),
  );
  process.exit(1);
}

export function registerProjectCommand(program: Command): void {
  const project = program.command("project").description("Manage portfolio projects");

  // ao project ls
  project
    .command("ls")
    .description("List all portfolio projects")
    .action(async () => {
      assertPortfolioEnabled();
      const portfolio = getPortfolio();

      if (portfolio.length === 0) {
        console.log(chalk.dim("No projects in portfolio."));
        console.log(
          chalk.dim("Run `ao project add <id> --repo <owner/name>` to register one."),
        );
        return;
      }

      const counts = await getPortfolioSessionCounts(portfolio);
      const prefs = loadPreferences();

      console.log(chalk.bold("\nPortfolio Projects\n"));

      for (const p of portfolio) {
        const count = counts[p.id] || { total: 0, active: 0 };
        const isDefault = prefs.defaultProjectId === p.id;
        const status = formatPortfolioProjectStatus(p, count);

        const pin = p.pinned ? chalk.yellow("*") : " ";
        const def = isDefault ? chalk.cyan(" (default)") : "";
        const name = formatPortfolioProjectName(p);
        const degradedReason = formatPortfolioDegradedReason(p);

        console.log(`  ${pin} ${chalk.bold(p.id)}${name}${def}`);
        console.log(`    ${status} | ${count.total} sessions | ${chalk.dim(p.source)}`);
        if (degradedReason) {
          console.log(`    ${degradedReason}`);
        }
      }

      console.log();
    });

  // Fork: add/update/rm edit the config file directly (see project-config.ts).
  registerProjectConfigCommands(project);

  // ao project set-default <id>
  project
    .command("set-default <id>")
    .description("Set the default project for the portfolio")
    .action((id: string) => {
      assertPortfolioEnabled();
      const portfolio = getPortfolio();
      const found = portfolio.find((p) => p.id === id);
      if (!found) {
        console.error(chalk.red(`Project "${id}" not found in portfolio`));
        process.exit(1);
      }

      const prefs = loadPreferences();
      prefs.defaultProjectId = id;
      savePreferences(prefs);
      console.log(chalk.green(`Set default project to "${id}"`));
    });
}
