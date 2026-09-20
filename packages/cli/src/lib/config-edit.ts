/**
 * Fork: edit the live AO config file (projects, agents, identities) from the
 * CLI and the OpenClaw plugin. The YAML document is edited in place so
 * comments and key order survive, rendered, validated through the real
 * loader (`loadConfig` on a probe file next to the config, so path handling
 * is identical) and only then written with a timestamped backup. Nothing here
 * restarts the engine: it reads the config at startup, so callers print a
 * reminder.
 */
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import chalk from "chalk";
import { parseDocument, parse as parseYamlValue, stringify as stringifyYaml, type Document } from "yaml";
import { findConfigFile, loadConfig, type OrchestratorConfig } from "@aoagents/ao-core";

export type ConfigYamlDocument = Document.Parsed;

export interface ConfigDocument {
  path: string;
  doc: ConfigYamlDocument;
}

export function openConfigDocument(configPath?: string): ConfigDocument {
  const path = configPath ?? findConfigFile();
  if (!path) throw new Error("No config file found (set AO_CONFIG_PATH or run from a project).");
  return { path, doc: parseConfigDocument(readFileSync(path, "utf-8"), path) };
}

export function parseConfigDocument(text: string, label = "config"): ConfigYamlDocument {
  const doc = parseDocument(text);
  const problem = doc.errors[0];
  if (problem) throw new Error(`${label}: ${problem.message}`);
  return doc;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain JS view of the document, for reads and reference checks. */
export function documentToJS(doc: ConfigYamlDocument): Record<string, unknown> {
  const value: unknown = doc.toJS();
  return isRecord(value) ? value : {};
}

export function hasPath(doc: ConfigYamlDocument, path: string[]): boolean {
  return doc.hasIn(path);
}

export function setPath(doc: ConfigYamlDocument, path: string[], value: unknown): void {
  doc.setIn(path, doc.createNode(value));
}

export function deletePath(doc: ConfigYamlDocument, path: string[]): boolean {
  return doc.deleteIn(path);
}

export function renderDocument(doc: ConfigYamlDocument): string {
  return doc.toString({ lineWidth: 0 });
}

/** `--set a.b=value`: dotted key path plus a YAML-parsed value (falls back to the raw string). */
export interface SetArgument {
  path: string[];
  value: unknown;
}

export function parseKeyPath(key: string): string[] {
  const parts = key.split(".").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new Error(`Invalid key path "${key}" (use dotted keys like reviewer.timeoutMinutes)`);
  }
  return parts;
}

export function parseSetArgument(arg: string): SetArgument {
  const eq = arg.indexOf("=");
  if (eq <= 0) throw new Error(`--set expects <key.path>=<value>, got "${arg}"`);
  const path = parseKeyPath(arg.slice(0, eq));
  const raw = arg.slice(eq + 1);
  if (raw.trim().length === 0) throw new Error(`--set ${arg}: empty value (use --unset to remove a key)`);
  return { path, value: parseScalarOrRaw(raw) };
}

/** YAML-parse a CLI value (numbers, booleans, [lists], {maps}); anything YAML rejects stays a string. */
export function parseScalarOrRaw(raw: string): unknown {
  try {
    const value: unknown = parseYamlValue(raw);
    return value === undefined ? raw : value;
  } catch {
    return raw;
  }
}

/**
 * Validate the rendered text exactly like the engine will read it: through
 * `loadConfig` on a probe file next to the real one (same directory, so the
 * wrapped-file handling and relative paths behave the same). Throws on any
 * schema or reference problem; the real file is untouched.
 */
export function validateRendered(text: string, configPath: string): OrchestratorConfig {
  const probe = join(
    dirname(configPath),
    `.${basename(configPath)}.validate-${process.pid}-${Date.now()}.yaml`,
  );
  writeFileSync(probe, text, { encoding: "utf-8", mode: 0o600 });
  try {
    return loadConfig(probe);
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // ignore
    }
  }
}

export interface WriteResult {
  text: string;
  backupPath?: string;
}

/** Write the document back with a `<path>.bak-<timestamp>` copy of the previous content. */
export function writeConfigDocument(cfg: ConfigDocument, options: { dryRun?: boolean } = {}): WriteResult {
  const text = renderDocument(cfg.doc);
  if (options.dryRun) return { text };
  const backupPath = `${cfg.path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(cfg.path, backupPath);
  writeFileSync(cfg.path, text, "utf-8");
  return { text, backupPath };
}

const ROLE_KEYS = ["worker", "reviewer", "orchestrator"] as const;

function blockAt(cfg: Record<string, unknown>, ...path: string[]): Record<string, unknown> | undefined {
  let cur: unknown = cfg;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return isRecord(cur) ? cur : undefined;
}

/** Where an `agents:` profile is referenced (identities and role blocks). */
export function agentProfileReferences(cfg: Record<string, unknown>, profileId: string): string[] {
  const refs: string[] = [];
  for (const [id, identity] of Object.entries(blockAt(cfg, "identities") ?? {})) {
    if (isRecord(identity) && identity["agent"] === profileId) refs.push(`identities.${id}.agent`);
  }
  for (const role of ROLE_KEYS) {
    if (blockAt(cfg, "defaults", role)?.["agent"] === profileId) refs.push(`defaults.${role}.agent`);
  }
  for (const [pid, project] of Object.entries(blockAt(cfg, "projects") ?? {})) {
    if (!isRecord(project)) continue;
    for (const role of ROLE_KEYS) {
      if (blockAt(project, role)?.["agent"] === profileId) refs.push(`projects.${pid}.${role}.agent`);
    }
  }
  return refs;
}

/** Where an identity is referenced (`identity:` keys, or a legacy `githubUser` equal to its login). */
export function identityReferences(cfg: Record<string, unknown>, identityId: string): string[] {
  const identity = blockAt(cfg, "identities", identityId);
  const login = typeof identity?.["githubUser"] === "string" ? identity["githubUser"] : identityId;
  const refs: string[] = [];
  const check = (block: Record<string, unknown> | undefined, where: string): void => {
    if (!block) return;
    if (block["identity"] === identityId || block["githubUser"] === login) refs.push(`${where}`);
  };
  check(blockAt(cfg, "defaults", "scm"), "defaults.scm");
  for (const role of ROLE_KEYS) check(blockAt(cfg, "defaults", role), `defaults.${role}`);
  for (const [pid, project] of Object.entries(blockAt(cfg, "projects") ?? {})) {
    if (!isRecord(project)) continue;
    check(blockAt(project, "scm"), `projects.${pid}.scm`);
    for (const role of ROLE_KEYS) check(blockAt(project, role), `projects.${pid}.${role}`);
  }
  return refs;
}

/** Apply `--set k=v` and `--unset k` lists under `base`. Returns change messages. */
export function applySetUnset(
  doc: ConfigYamlDocument,
  base: string[],
  set: string[] | undefined,
  unset: string[] | undefined,
): string[] {
  const messages: string[] = [];
  for (const arg of set ?? []) {
    const parsed = parseSetArgument(arg);
    setPath(doc, [...base, ...parsed.path], parsed.value);
    messages.push(`${[...base, ...parsed.path].join(".")} = ${JSON.stringify(parsed.value)}`);
  }
  for (const key of unset ?? []) {
    const path = [...base, ...parseKeyPath(key)];
    if (deletePath(doc, path)) messages.push(`${path.join(".")}: removed`);
    else messages.push(`${path.join(".")}: not set (nothing to remove)`);
  }
  return messages;
}

export interface ConfigEditRun {
  /** One line naming the operation, e.g. `add project "x"`. */
  title: string;
  /** Mutate the document; return change messages. Throw to abort before validation. */
  apply: (doc: ConfigYamlDocument, cfg: Record<string, unknown>) => string[];
  /** Runs after validation and before the write (e.g. clone a stub repo). */
  beforeWrite?: (loaded: OrchestratorConfig) => void;
  /** Effective block to print after the write. */
  show?: (loaded: OrchestratorConfig) => unknown;
  dryRun?: boolean;
  json?: boolean;
  configPath?: string;
}

export const RESTART_REMINDER =
  "Config is read at engine startup: restart ao-engine.service at 0 active sessions (ao session ls) to apply.";

/**
 * Open → apply → render → validate → (beforeWrite) → write with backup → print.
 * Exits 1 with a red message on any failure; the config file is never left
 * half-written because the write happens only after validation.
 */
export function runConfigEdit(run: ConfigEditRun): void {
  let cfg: ConfigDocument;
  let messages: string[];
  let loaded: OrchestratorConfig;
  try {
    cfg = openConfigDocument(run.configPath);
    messages = run.apply(cfg.doc, documentToJS(cfg.doc));
    loaded = validateRendered(renderDocument(cfg.doc), cfg.path);
    run.beforeWrite?.(loaded);
  } catch (err) {
    console.error(chalk.red(`Cannot ${run.title}: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
  const result = writeConfigDocument(cfg, { dryRun: run.dryRun });
  const shown = run.show?.(loaded);
  if (run.json) {
    console.log(JSON.stringify({ ok: true, dryRun: run.dryRun ?? false, path: cfg.path, backupPath: result.backupPath, changes: messages, effective: shown }, null, 2));
    return;
  }
  console.log(chalk.bold(run.dryRun ? `Dry run: ${run.title} (nothing written)` : `Done: ${run.title}`));
  for (const m of messages) console.log(`  - ${m}`);
  if (result.backupPath) console.log(chalk.dim(`  ${cfg.path} written, backup ${result.backupPath}`));
  if (shown !== undefined) {
    console.log(chalk.dim("Effective:"));
    console.log(stringifyYaml(shown, { lineWidth: 0 }).replace(/^/gm, "  ").trimEnd());
  }
  if (!run.dryRun) console.log(chalk.yellow(RESTART_REMINDER));
}
