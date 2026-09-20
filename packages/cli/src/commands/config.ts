/**
 * `ao config` — read/write fields in ~/.agent-orchestrator/config.yaml.
 *
 * Today this only manages `updateChannel` and `installMethod`, which are the
 * two settings the release pipeline depends on. We deliberately resist adding
 * a generic key/value writer — the global config has Zod validation and most
 * fields are not safe to set blindly from a flag.
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  createDefaultGlobalConfig,
  getGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  loadConfigWithPath,
  findConfigFile,
  UpdateChannelSchema,
  InstallMethodOverrideSchema,
  type GlobalConfig,
  type UpdateChannel,
  type InstallMethodOverride,
} from "@aoagents/ao-core";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  diffEffectiveProjects,
  normalizeConfigDocument,
  printableConfig,
} from "../lib/config-normalize.js";

const SUPPORTED_KEYS = ["updateChannel", "installMethod"] as const;
type SupportedKey = (typeof SUPPORTED_KEYS)[number];

function isSupportedKey(value: string): value is SupportedKey {
  return (SUPPORTED_KEYS as readonly string[]).includes(value);
}

function loadOrInit(): GlobalConfig {
  const path = getGlobalConfigPath();
  if (existsSync(path)) {
    const config = loadGlobalConfig(path);
    if (config) return config;
  }
  return createDefaultGlobalConfig();
}

function setUpdateChannel(value: string): void {
  const parsed = UpdateChannelSchema.safeParse(value);
  if (!parsed.success) {
    console.error(
      chalk.red(`Invalid value for updateChannel: "${value}". Expected: stable | nightly | manual`),
    );
    process.exit(1);
  }
  const channel: UpdateChannel = parsed.data;
  const config = loadOrInit();
  saveGlobalConfig({ ...config, updateChannel: channel }, getGlobalConfigPath());
  console.log(chalk.green(`✓ updateChannel set to ${chalk.bold(channel)}`));
}

function setInstallMethod(value: string): void {
  const parsed = InstallMethodOverrideSchema.safeParse(value);
  if (!parsed.success) {
    console.error(
      chalk.red(
        `Invalid value for installMethod: "${value}". Expected: git | npm-global | pnpm-global | bun-global | homebrew | unknown`,
      ),
    );
    process.exit(1);
  }
  const method: InstallMethodOverride = parsed.data;
  const config = loadOrInit();
  saveGlobalConfig({ ...config, installMethod: method }, getGlobalConfigPath());
  console.log(chalk.green(`✓ installMethod set to ${chalk.bold(method)}`));
}

function showGet(key: SupportedKey): void {
  const path = getGlobalConfigPath();
  if (!existsSync(path)) {
    console.log(chalk.dim("(unset)"));
    return;
  }
  const config = loadGlobalConfig(path);
  const value = config?.[key];
  console.log(value === undefined ? chalk.dim("(unset)") : String(value));
}

export function registerConfig(program: Command): void {
  const config = program
    .command("config")
    .description("Read or write global AO config (~/.agent-orchestrator/config.yaml)");

  config
    .command("set <key> <value>")
    .description(`Set a config value. Keys: ${SUPPORTED_KEYS.join(", ")}`)
    .action((key: string, value: string) => {
      if (!isSupportedKey(key)) {
        console.error(
          chalk.red(`Unsupported config key: "${key}". Supported: ${SUPPORTED_KEYS.join(", ")}`),
        );
        process.exit(1);
      }
      switch (key) {
        case "updateChannel":
          setUpdateChannel(value);
          break;
        case "installMethod":
          setInstallMethod(value);
          break;
      }
    });

  config
    .command("get <key>")
    .description(`Read a config value. Keys: ${SUPPORTED_KEYS.join(", ")}`)
    .action((key: string) => {
      if (!isSupportedKey(key)) {
        console.error(
          chalk.red(`Unsupported config key: "${key}". Supported: ${SUPPORTED_KEYS.join(", ")}`),
        );
        process.exit(1);
      }
      showGet(key);
    });

  // Fork: effective config after defaults inheritance and validation.
  config
    .command("show")
    .description("Print the effective config (defaults merged into every project)")
    .option("-p, --project <id>", "Only this project")
    .option("--json", "Output as JSON")
    .action((opts: { project?: string; json?: boolean }) => {
      const { config: loaded, path } = loadConfigWithPath();
      const printable = printableConfig(loaded);
      let out: unknown = printable;
      if (opts.project) {
        const project = loaded.projects[opts.project];
        if (!project) {
          console.error(chalk.red(`Unknown project "${opts.project}" in ${path}`));
          process.exit(1);
        }
        out = { agents: printable["agents"], identities: printable["identities"], project: project };
      }
      console.log(opts.json ? JSON.stringify(out, null, 2) : stringifyYaml(out, { lineWidth: 0 }));
    });

  // Fork: hoist repeated project behaviour into defaults.
  config
    .command("normalize")
    .description(
      "Hoist behaviour repeated in every project into defaults:, fold legacy agent/agentConfig into worker, " +
        "reference identities by key and move shared agent settings into them, drop registry-only keys",
    )
    .option("--write", "Replace the config file (a timestamped .bak copy is kept)")
    .option("--out <file>", "Write the normalized YAML to this file instead of stdout")
    .option("--keep-legacy-agent", "Leave project-level agent/agentConfig in place")
    .option("--keep-git-identity-steps", "Leave git config user.* postCreate steps in place")
    .option("--keep-github-user", "Leave githubUser references and per-role agent settings in place")
    .action((opts: { write?: boolean; out?: string; keepLegacyAgent?: boolean; keepGitIdentitySteps?: boolean; keepGithubUser?: boolean }) => {
      const path = findConfigFile();
      if (!path) {
        console.error(chalk.red("No config file found (set AO_CONFIG_PATH or run from a project)."));
        process.exit(1);
      }
      const raw = parseYaml(readFileSync(path, "utf-8")) as Record<string, unknown>;
      const { normalized, changes } = normalizeConfigDocument(raw, {
        foldLegacyAgent: !opts.keepLegacyAgent,
        dropGitIdentitySteps: !opts.keepGitIdentitySteps,
        identityProfiles: !opts.keepGithubUser,
      });
      const diff = diffEffectiveProjects(raw, normalized);
      const yaml = stringifyYaml(normalized, { lineWidth: 0 });
      if (opts.out) {
        writeFileSync(opts.out, yaml, "utf-8");
      } else if (opts.write) {
        const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        copyFileSync(path, backup);
        writeFileSync(path, yaml, "utf-8");
        console.error(chalk.dim(`Backup written to ${backup}`));
      } else {
        process.stdout.write(yaml);
      }
      console.error(chalk.bold(`\n${changes.length} change(s):`));
      for (const change of changes) console.error(`  - ${change}`);
      if (diff.length === 0) {
        console.error(chalk.green("Effective project behaviour is unchanged."));
      } else {
        console.error(chalk.yellow(`Effective behaviour differs for ${diff.length} field(s):`));
        for (const d of diff) {
          console.error(`  - ${d.project}.${d.key}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`);
        }
        console.error(chalk.dim("Expected only for folded legacy agent fields and removed git identity steps."));
      }
      if (opts.write || opts.out) {
        console.error(chalk.dim("Comments in the original file are not preserved."));
      }
    });
}
