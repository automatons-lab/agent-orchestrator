/**
 * Fork: `ao defaults show|set|unset` read and edit the `defaults:` block of
 * the live config file — the behaviour every project inherits (roles and
 * their agents, reviewer knobs, branchNameTemplate, ...). Same document edit
 * → validate → backup → write path as `ao project|agent|identity`, so a value
 * the schema rejects never reaches the file.
 */
import chalk from "chalk";
import type { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import {
  applySetUnset,
  deletePath,
  documentToJS,
  openConfigDocument,
  parseKeyPath,
  parseScalarOrRaw,
  runConfigEdit,
  setPath,
  type ConfigYamlDocument,
} from "../lib/config-edit.js";

export interface DefaultsEditOptions {
  set?: string[];
  unset?: string[];
}

/** `ao defaults set <key> <value>`: dotted key under `defaults:`, YAML-parsed value (raw string fallback). */
export function applyDefaultsSet(
  doc: ConfigYamlDocument,
  key: string,
  rawValue: string,
  opts: DefaultsEditOptions = {},
): string[] {
  const path = ["defaults", ...parseKeyPath(key)];
  if (rawValue.trim().length === 0) {
    throw new Error(`empty value for ${path.join(".")} (use \`ao defaults unset\` to remove a key)`);
  }
  const value = parseScalarOrRaw(rawValue);
  setPath(doc, path, value);
  return [`${path.join(".")} = ${JSON.stringify(value)}`, ...applySetUnset(doc, ["defaults"], opts.set, opts.unset)];
}

/** `ao defaults unset <key>`: remove a key under `defaults:`; a key that is not set is an error. */
export function applyDefaultsUnset(doc: ConfigYamlDocument, key: string, opts: DefaultsEditOptions = {}): string[] {
  const path = ["defaults", ...parseKeyPath(key)];
  if (!deletePath(doc, path)) throw new Error(`${path.join(".")} is not set`);
  return [`${path.join(".")}: removed`, ...applySetUnset(doc, ["defaults"], opts.set, opts.unset)];
}

/** The `defaults:` block as declared in the file (not merged into projects). */
export function declaredDefaults(configPath?: string): { path: string; defaults: Record<string, unknown> } {
  const cfg = openConfigDocument(configPath);
  const defaults = (documentToJS(cfg.doc)["defaults"] ?? {}) as Record<string, unknown>;
  return { path: cfg.path, defaults };
}

const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];

type DefaultsCli = DefaultsEditOptions & { dryRun?: boolean; json?: boolean };

function editOptions(cmd: Command): Command {
  return cmd
    .option("--set <key=value>", "Another key under defaults, dotted (repeatable)", collect)
    .option("--unset <key>", "Remove another key under defaults (repeatable)", collect)
    .option("--dry-run", "Validate and print, write nothing")
    .option("--json", "Machine-readable result");
}

function runDefaultsEdit(title: string, apply: (doc: ConfigYamlDocument) => string[], opts: DefaultsCli): void {
  let resulting: Record<string, unknown> | undefined;
  runConfigEdit({
    title,
    apply: (doc) => {
      const messages = apply(doc);
      resulting = (documentToJS(doc)["defaults"] ?? {}) as Record<string, unknown>;
      return messages;
    },
    show: () => resulting,
    dryRun: opts.dryRun,
    json: opts.json,
  });
}

export function registerDefaultsCommand(program: Command): void {
  const defaults = program
    .command("defaults")
    .description("Read or edit the defaults: block every project inherits (fork)");

  defaults
    .command("show")
    .description("Print the declared defaults: block (ao config show prints it merged into each project)")
    .option("--json", "Machine-readable result")
    .action((opts: { json?: boolean }) => {
      const { path, defaults: block } = declaredDefaults();
      if (opts.json) {
        console.log(JSON.stringify({ path, defaults: block }, null, 2));
        return;
      }
      console.log(chalk.dim(`# defaults: in ${path}`));
      console.log(stringifyYaml(block, { lineWidth: 0 }).trimEnd());
    });

  editOptions(
    defaults
      .command("set <key> <value>")
      .description(
        "Set defaults.<key> (dotted: reviewer.enabled true, worker.agent codex-coder, reviewer.agentConfig.reasoningEffort high, branchNameTemplate '{issue}.{slug}'); the value is YAML-parsed, anything YAML rejects stays a string",
      ),
  ).action((key: string, value: string, opts: DefaultsCli) => {
    runDefaultsEdit(`set defaults.${key}`, (doc) => applyDefaultsSet(doc, key, value, opts), opts);
  });

  editOptions(
    defaults.command("unset <key>").description("Remove defaults.<key> (dotted); projects fall back to the built-in default"),
  ).action((key: string, opts: DefaultsCli) => {
    runDefaultsEdit(`unset defaults.${key}`, (doc) => applyDefaultsUnset(doc, key, opts), opts);
  });
}
