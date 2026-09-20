/**
 * Fork: fill identity token variables from Google Secret Manager before a
 * command that acts as an identity runs (see core/secret-manager.ts). Wired
 * as a commander `preAction` hook so `ao start`, `ao spawn`, `ao doctor` and
 * friends work from any shell without sourcing an env file. Commands that
 * never touch tokens (worker-side `ao report`, `ao config`, ...) skip the
 * lookup so they stay fast and never need the metadata server.
 */
import type { Command } from "commander";
import chalk from "chalk";
import {
  identitiesUsingSecrets,
  loadConfig,
  resolveIdentitySecrets,
  type IdentitySecretResult,
  type OrchestratorConfig,
} from "@aoagents/ao-core";

/** Top-level commands that act as an identity (engine, spawns, reviews, checks). */
export const IDENTITY_COMMANDS: ReadonlySet<string> = new Set([
  "start",
  "status",
  "spawn",
  "batch-spawn",
  "session",
  "review-check",
  "review",
  "dashboard",
  "verify",
  "doctor",
]);

/** Name of the top-level `ao` command an action belongs to (`review run` → `review`). */
export function topLevelCommandName(actionCommand: Command): string | undefined {
  let cmd: Command = actionCommand;
  while (cmd.parent && cmd.parent.parent) cmd = cmd.parent;
  return cmd.parent ? cmd.name() : undefined;
}

export interface PreloadIdentitySecretsDeps {
  loadConfig?: () => OrchestratorConfig;
  resolve?: (config: OrchestratorConfig) => Promise<IdentitySecretResult[]>;
}

/**
 * Resolve identity secrets for `commandName` when it uses identities and the
 * config declares any `tokenSecret`. Config problems are left for the command
 * itself to report; secret lookups that fail throw so the command aborts
 * instead of running as the wrong user.
 */
export async function preloadIdentitySecrets(
  commandName: string | undefined,
  deps: PreloadIdentitySecretsDeps = {},
): Promise<IdentitySecretResult[]> {
  if (commandName === undefined || !IDENTITY_COMMANDS.has(commandName)) return [];
  let config: OrchestratorConfig;
  try {
    config = (deps.loadConfig ?? (() => loadConfig()))();
  } catch {
    return [];
  }
  if (!identitiesUsingSecrets(config)) return [];
  return (deps.resolve ?? ((c) => resolveIdentitySecrets(c)))(config);
}

export function registerIdentitySecretsHook(program: Command): void {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    try {
      await preloadIdentitySecrets(topLevelCommandName(actionCommand));
    } catch (err) {
      // One clear line instead of a stack trace: the secret name and identity
      // are in the message, the value never is.
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });
}
