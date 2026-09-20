/**
 * Fork: `ao project add|update|rm` edit the live config file directly. Per
 * project only the registry fields are required (`repo`; `path`,
 * `defaultBranch`, `sessionPrefix`, `name` have conventions); everything a
 * project can inherit from `defaults:` is optional and written only when
 * given, so a new block stays minimal. `--set/--unset` reach any other key.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import type { OrchestratorConfig } from "@aoagents/ao-core";
import {
  applySetUnset,
  deletePath,
  hasPath,
  runConfigEdit,
  setPath,
  type ConfigYamlDocument,
} from "../lib/config-edit.js";

export interface ProjectFieldOptions {
  name?: string;
  path?: string;
  repo?: string;
  defaultBranch?: string;
  sessionPrefix?: string;
  runtime?: string;
  workspace?: string;
  agentRules?: string;
  agentRulesFile?: string;
  branchNameTemplate?: string;
  reviewers?: string;
  postCreate?: string[];
  workerIdentity?: string;
  workerAgent?: string;
  reviewerIdentity?: string;
  reviewerAgent?: string;
  reviewerEnabled?: boolean;
  reviewerRulesFile?: string;
  reviewerPostMode?: string;
  reviewerTimeoutMinutes?: number;
  orchestratorIdentity?: string;
  orchestratorAgent?: string;
  scmIdentity?: string;
  set?: string[];
  unset?: string[];
}

interface FieldSpec {
  option: keyof ProjectFieldOptions;
  path: string[];
  parse?: (value: unknown) => unknown;
}

const csv = (value: unknown): unknown =>
  typeof value === "string" ? value.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : value;

/** Registry fields first, then the inheritable ones, then role blocks. */
export const PROJECT_FIELDS: readonly FieldSpec[] = [
  { option: "name", path: ["name"] },
  { option: "path", path: ["path"] },
  { option: "repo", path: ["repo"] },
  { option: "defaultBranch", path: ["defaultBranch"] },
  { option: "sessionPrefix", path: ["sessionPrefix"] },
  { option: "runtime", path: ["runtime"] },
  { option: "workspace", path: ["workspace"] },
  { option: "agentRules", path: ["agentRules"] },
  { option: "agentRulesFile", path: ["agentRulesFile"] },
  { option: "branchNameTemplate", path: ["branchNameTemplate"] },
  { option: "reviewers", path: ["reviewers"], parse: csv },
  { option: "postCreate", path: ["postCreate"] },
  { option: "workerIdentity", path: ["worker", "identity"] },
  { option: "workerAgent", path: ["worker", "agent"] },
  { option: "reviewerIdentity", path: ["reviewer", "identity"] },
  { option: "reviewerAgent", path: ["reviewer", "agent"] },
  { option: "reviewerEnabled", path: ["reviewer", "enabled"] },
  { option: "reviewerRulesFile", path: ["reviewer", "rulesFile"] },
  { option: "reviewerPostMode", path: ["reviewer", "postMode"] },
  { option: "reviewerTimeoutMinutes", path: ["reviewer", "timeoutMinutes"] },
  { option: "orchestratorIdentity", path: ["orchestrator", "identity"] },
  { option: "orchestratorAgent", path: ["orchestrator", "agent"] },
  { option: "scmIdentity", path: ["scm", "identity"] },
];

export function defaultProjectPath(id: string): string {
  return join(homedir(), ".agent-orchestrator", "repos", id);
}

/** Write every given field under `projects.<id>`; returns change messages. */
export function applyProjectFields(doc: ConfigYamlDocument, id: string, opts: ProjectFieldOptions): string[] {
  const messages: string[] = [];
  for (const spec of PROJECT_FIELDS) {
    const raw = opts[spec.option];
    if (raw === undefined) continue;
    const value = spec.parse ? spec.parse(raw) : raw;
    setPath(doc, ["projects", id, ...spec.path], value);
    messages.push(`projects.${id}.${spec.path.join(".")} = ${JSON.stringify(value)}`);
  }
  messages.push(...applySetUnset(doc, ["projects", id], opts.set, opts.unset));
  return messages;
}

export function applyProjectAdd(doc: ConfigYamlDocument, id: string, opts: ProjectFieldOptions): string[] {
  if (hasPath(doc, ["projects", id])) throw new Error(`project "${id}" already exists (use \`ao project update\`)`);
  if (!opts.repo) throw new Error("--repo <owner/name> is required");
  const filled: ProjectFieldOptions = {
    ...opts,
    name: opts.name ?? id,
    path: opts.path ?? defaultProjectPath(id),
    defaultBranch: opts.defaultBranch ?? "main",
    sessionPrefix: opts.sessionPrefix ?? id,
  };
  return applyProjectFields(doc, id, filled);
}

export function applyProjectUpdate(doc: ConfigYamlDocument, id: string, opts: ProjectFieldOptions): string[] {
  if (!hasPath(doc, ["projects", id])) throw new Error(`unknown project "${id}"`);
  const messages = applyProjectFields(doc, id, opts);
  if (messages.length === 0) throw new Error("nothing to change (pass at least one option)");
  return messages;
}

export function applyProjectRemove(doc: ConfigYamlDocument, id: string): string[] {
  if (!hasPath(doc, ["projects", id])) throw new Error(`unknown project "${id}"`);
  deletePath(doc, ["projects", id]);
  return [`projects.${id}: removed (repo clone and session data are left in place)`];
}

/** Create the stub clone AO uses as `path` (origin only; sessions clone from it). */
export function cloneStubRepo(repo: string, path: string, log: (line: string) => void): void {
  if (existsSync(path)) {
    log(`  ${path} already exists, not cloning`);
    return;
  }
  const url = `git@github.com:${repo}.git`;
  log(`  cloning ${url} → ${path}`);
  execFileSync("git", ["clone", "--quiet", url, path], { stdio: "inherit" });
}

const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];
const int = (value: string): number => {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`expected an integer, got "${value}"`);
  return n;
};

function addFieldOptions(cmd: Command, forAdd: boolean): Command {
  cmd
    .option("--name <name>", forAdd ? "Display name (default: the id)" : "Display name")
    .option("--path <dir>", forAdd ? "Stub clone used as project path (default ~/.agent-orchestrator/repos/<id>)" : "Stub clone used as project path")
    .option("--default-branch <branch>", forAdd ? "Default branch (default main)" : "Default branch")
    .option("--session-prefix <prefix>", forAdd ? "Session name prefix (default: the id)" : "Session name prefix")
    .option("--runtime <plugin>", "Override defaults.runtime")
    .option("--workspace <plugin>", "Override defaults.workspace")
    .option("--agent-rules <text>", "Inline worker rules (override)")
    .option("--agent-rules-file <file>", "Worker rules file (override)")
    .option("--branch-name-template <tpl>", "Override defaults.branchNameTemplate")
    .option("--reviewers <logins>", "Comma-separated reviewer logins (override)")
    .option("--post-create <cmd>", "postCreate step (repeatable, replaces the list)", collect)
    .option("--worker-identity <id>", "identities key the worker acts as")
    .option("--worker-agent <profile|plugin>", "agents key (or plugin) the worker runs")
    .option("--reviewer-identity <id>", "identities key the reviewer acts as")
    .option("--reviewer-agent <profile|plugin>", "agents key (or plugin) the reviewer runs")
    .option("--reviewer-enabled", "Enable the AO-native reviewer for this project")
    .option("--no-reviewer-enabled", "Disable the AO-native reviewer for this project")
    .option("--reviewer-rules-file <file>", "Reviewer-only rules file")
    .option("--reviewer-post-mode <mode>", "live | dry-run")
    .option("--reviewer-timeout-minutes <n>", "Reviewer run timeout", int)
    .option("--orchestrator-identity <id>", "identities key the orchestrator acts as")
    .option("--orchestrator-agent <profile|plugin>", "agents key (or plugin) the orchestrator runs")
    .option("--scm-identity <id>", "identities key for the project's SCM calls")
    .option("--set <key=value>", "Any other key under the project, dotted (repeatable)", collect)
    .option("--dry-run", "Validate and print, write nothing")
    .option("--json", "Machine-readable result");
  if (!forAdd) cmd.option("--unset <key>", "Remove a key under the project, dotted (repeatable)", collect);
  return cmd;
}

type ProjectCliOptions = ProjectFieldOptions & { dryRun?: boolean; json?: boolean; clone?: boolean };

function showProject(id: string) {
  return (loaded: OrchestratorConfig): unknown => loaded.projects[id];
}

/** Registers `add`, `update`, `rm` on the `ao project` command group. */
export function registerProjectConfigCommands(project: Command): void {
  addFieldOptions(
    project
      .command("add <id>")
      .description("Add a project to the config file (only registry fields are required; behaviour comes from defaults:)")
      .requiredOption("--repo <owner/name>", "GitHub repository")
      .option("--clone", "Create the stub clone at --path from git@github.com:<repo>.git when missing"),
    true,
  ).action((id: string, opts: ProjectCliOptions) => {
    runConfigEdit({
      title: `add project "${id}"`,
      apply: (doc) => applyProjectAdd(doc, id, opts),
      beforeWrite: opts.clone
        ? (loaded) => cloneStubRepo(loaded.projects[id]!.repo as string, loaded.projects[id]!.path, (l) => console.log(chalk.dim(l)))
        : undefined,
      show: showProject(id),
      dryRun: opts.dryRun,
      json: opts.json,
    });
  });

  addFieldOptions(
    project
      .command("update <id>")
      .description("Change fields of a project in the config file")
      .option("--repo <owner/name>", "GitHub repository"),
    false,
  ).action((id: string, opts: ProjectCliOptions) => {
    runConfigEdit({
      title: `update project "${id}"`,
      apply: (doc) => applyProjectUpdate(doc, id, opts),
      show: showProject(id),
      dryRun: opts.dryRun,
      json: opts.json,
    });
  });

  project
    .command("rm <id>")
    .alias("remove")
    .description("Remove a project from the config file (its clone and session data stay on disk)")
    .option("--dry-run", "Validate and print, write nothing")
    .option("--json", "Machine-readable result")
    .action((id: string, opts: { dryRun?: boolean; json?: boolean }) => {
      runConfigEdit({
        title: `remove project "${id}"`,
        apply: (doc) => applyProjectRemove(doc, id),
        dryRun: opts.dryRun,
        json: opts.json,
      });
    });
}
