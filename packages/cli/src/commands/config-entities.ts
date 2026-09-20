/**
 * Fork: `ao agent` and `ao identity` manage the `agents:` (agent profiles)
 * and `identities:` (GitHub users) maps of the live config file. Removing a
 * profile or identity that is still referenced is refused unless --force,
 * because validation would otherwise fail on the next engine start.
 */
import chalk from "chalk";
import type { Command } from "commander";
import { identityUsage, loadConfigWithPath, type OrchestratorConfig } from "@aoagents/ao-core";
import {
  agentProfileReferences,
  applySetUnset,
  deletePath,
  hasPath,
  identityReferences,
  runConfigEdit,
  setPath,
  type ConfigYamlDocument,
} from "../lib/config-edit.js";

export interface AgentProfileOptions {
  plugin?: string;
  model?: string;
  reasoningEffort?: string;
  permissions?: string;
  sandbox?: string;
  set?: string[];
  unset?: string[];
}

export interface IdentityOptions {
  tokenEnv?: string;
  githubUser?: string;
  tokenSecret?: string;
  agent?: string;
  name?: string;
  email?: string;
  set?: string[];
  unset?: string[];
}

const AGENT_FIELDS = ["plugin", "model", "reasoningEffort", "permissions", "sandbox"] as const;
const IDENTITY_FIELDS = ["githubUser", "tokenEnv", "tokenSecret", "agent", "name", "email"] as const;

function applyFields(
  doc: ConfigYamlDocument,
  base: string[],
  fields: readonly string[],
  opts: Record<string, unknown>,
): string[] {
  const messages: string[] = [];
  for (const field of fields) {
    const value = opts[field];
    if (value === undefined) continue;
    setPath(doc, [...base, field], value);
    messages.push(`${[...base, field].join(".")} = ${JSON.stringify(value)}`);
  }
  messages.push(
    ...applySetUnset(doc, base, opts["set"] as string[] | undefined, opts["unset"] as string[] | undefined),
  );
  return messages;
}

export function applyAgentAdd(doc: ConfigYamlDocument, id: string, opts: AgentProfileOptions): string[] {
  if (hasPath(doc, ["agents", id])) throw new Error(`agent profile "${id}" already exists (use \`ao agent update\`)`);
  if (!opts.plugin) throw new Error("--plugin <name> is required (codex, claude-code, ...)");
  return applyFields(doc, ["agents", id], AGENT_FIELDS, opts as Record<string, unknown>);
}

export function applyAgentUpdate(doc: ConfigYamlDocument, id: string, opts: AgentProfileOptions): string[] {
  if (!hasPath(doc, ["agents", id])) throw new Error(`unknown agent profile "${id}"`);
  const messages = applyFields(doc, ["agents", id], AGENT_FIELDS, opts as Record<string, unknown>);
  if (messages.length === 0) throw new Error("nothing to change (pass at least one option)");
  return messages;
}

export function applyAgentRemove(
  doc: ConfigYamlDocument,
  cfg: Record<string, unknown>,
  id: string,
  force = false,
): string[] {
  if (!hasPath(doc, ["agents", id])) throw new Error(`unknown agent profile "${id}"`);
  const refs = agentProfileReferences(cfg, id);
  if (refs.length > 0 && !force) {
    throw new Error(`agent profile "${id}" is referenced by ${refs.join(", ")} (repoint them first, or --force)`);
  }
  deletePath(doc, ["agents", id]);
  const note = refs.length > 0 ? ` — still referenced by ${refs.join(", ")}` : "";
  return [`agents.${id}: removed${note}`];
}

export function applyIdentityAdd(doc: ConfigYamlDocument, id: string, opts: IdentityOptions): string[] {
  if (hasPath(doc, ["identities", id])) throw new Error(`identity "${id}" already exists (use \`ao identity update\`)`);
  if (!opts.tokenEnv) throw new Error("--token-env <VAR> is required (the variable that carries the token)");
  return applyFields(doc, ["identities", id], IDENTITY_FIELDS, opts as Record<string, unknown>);
}

export function applyIdentityUpdate(doc: ConfigYamlDocument, id: string, opts: IdentityOptions): string[] {
  if (!hasPath(doc, ["identities", id])) throw new Error(`unknown identity "${id}"`);
  const messages = applyFields(doc, ["identities", id], IDENTITY_FIELDS, opts as Record<string, unknown>);
  if (messages.length === 0) throw new Error("nothing to change (pass at least one option)");
  return messages;
}

export function applyIdentityRemove(
  doc: ConfigYamlDocument,
  cfg: Record<string, unknown>,
  id: string,
  force = false,
): string[] {
  if (!hasPath(doc, ["identities", id])) throw new Error(`unknown identity "${id}"`);
  const refs = identityReferences(cfg, id);
  if (refs.length > 0 && !force) {
    throw new Error(`identity "${id}" is used by ${refs.join(", ")} (repoint them first, or --force)`);
  }
  deletePath(doc, ["identities", id]);
  const note = refs.length > 0 ? ` — still used by ${refs.join(", ")}` : "";
  return [`identities.${id}: removed${note}`];
}

const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];

type CommonCli = { set?: string[]; unset?: string[]; dryRun?: boolean; json?: boolean };

function commonOptions(cmd: Command, withUnset: boolean): Command {
  cmd
    .option("--set <key=value>", "Any other key, dotted (repeatable)", collect)
    .option("--dry-run", "Validate and print, write nothing")
    .option("--json", "Machine-readable result");
  if (withUnset) cmd.option("--unset <key>", "Remove a key (repeatable)", collect);
  return cmd;
}

function agentOptions(cmd: Command): Command {
  return cmd
    .option("--model <model>", "Model name passed to the agent CLI")
    .option("--reasoning-effort <level>", "codex model_reasoning_effort / claude --effort (low, medium, high, xhigh, ...)")
    .option("--permissions <mode>", "permissionless | auto-edit | suggest | default")
    .option("--sandbox <mode>", "codex exec sandbox for headless reviews (e.g. danger-full-access)");
}

function identityOptions(cmd: Command): Command {
  return cmd
    .option("--github-user <login>", "GitHub login (default: the id)")
    .option("--token-secret <name>", "Google Secret Manager secret projects/<p>/secrets/<name>[/versions/<v>] that fills --token-env")
    .option("--agent <profile|plugin>", "agents key (or plugin) roles with this identity run")
    .option("--name <name>", "Git author name (default: the login)")
    .option("--email <email>", "Git author email (default: <login>@users.noreply.github.com)");
}

function listAgents(loaded: OrchestratorConfig, json: boolean): void {
  const usedBy: Record<string, string[]> = {};
  for (const [id, identity] of Object.entries(loaded.identities ?? {})) {
    if (identity.agent) (usedBy[identity.agent] ??= []).push(`identities.${id}`);
  }
  const rows = Object.entries(loaded.agents ?? {}).map(([id, p]) => ({ id, ...p, usedBy: usedBy[id] ?? [] }));
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(chalk.dim("No agents: profiles declared."));
    return;
  }
  for (const r of rows) {
    const extra = Object.entries(r)
      .filter(([k]) => !["id", "plugin", "usedBy"].includes(k))
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    const used = r.usedBy.length > 0 ? chalk.dim(` ← ${r.usedBy.join(", ")}`) : chalk.dim(" (unused)");
    console.log(`${chalk.bold(r.id)}  plugin=${r.plugin} ${extra}${used}`);
  }
}

function listIdentities(loaded: OrchestratorConfig, json: boolean): void {
  const usage = identityUsage(loaded);
  const rows = Object.entries(loaded.identities ?? {}).map(([id, i]) => ({
    id,
    githubUser: i.githubUser ?? id,
    tokenEnv: i.tokenEnv,
    tokenSecret: i.tokenSecret,
    agent: i.agent,
    usedBy: usage[id] ?? [],
  }));
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(chalk.dim("No identities: declared."));
    return;
  }
  for (const r of rows) {
    const secret = r.tokenSecret ? ` secret=${r.tokenSecret}` : "";
    const agent = r.agent ? ` agent=${r.agent}` : "";
    const used = r.usedBy.length > 0 ? chalk.dim(` ← ${r.usedBy.join(", ")}`) : chalk.dim(" (unused)");
    console.log(`${chalk.bold(r.id)}  login=${r.githubUser} env=${r.tokenEnv}${secret}${agent}${used}`);
  }
}

export function registerAgentCommand(program: Command): void {
  const agent = program.command("agent").description("Manage agents: profiles (plugin + model + effort + permissions) in the config file");

  agent
    .command("ls")
    .description("List agent profiles and which identities use them")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => listAgents(loadConfigWithPath().config, opts.json ?? false));

  commonOptions(
    agentOptions(
      agent
        .command("add <id>")
        .description("Add an agent profile (e.g. codex-coder, claude-reviewer)")
        .requiredOption("--plugin <name>", "Agent plugin: codex, claude-code, ..."),
    ),
    false,
  ).action((id: string, opts: AgentProfileOptions & CommonCli) => {
    runConfigEdit({
      title: `add agent profile "${id}"`,
      apply: (doc) => applyAgentAdd(doc, id, opts),
      show: (loaded) => loaded.agents?.[id],
      dryRun: opts.dryRun,
      json: opts.json,
    });
  });

  commonOptions(
    agentOptions(agent.command("update <id>").description("Change fields of an agent profile").option("--plugin <name>", "Agent plugin")),
    true,
  ).action((id: string, opts: AgentProfileOptions & CommonCli) => {
    runConfigEdit({
      title: `update agent profile "${id}"`,
      apply: (doc) => applyAgentUpdate(doc, id, opts),
      show: (loaded) => loaded.agents?.[id],
      dryRun: opts.dryRun,
      json: opts.json,
    });
  });

  agent
    .command("rm <id>")
    .alias("remove")
    .description("Remove an agent profile (refused while an identity or role references it)")
    .option("--force", "Remove even when referenced")
    .option("--dry-run", "Validate and print, write nothing")
    .option("--json", "Machine-readable result")
    .action((id: string, opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
      runConfigEdit({
        title: `remove agent profile "${id}"`,
        apply: (doc, cfg) => applyAgentRemove(doc, cfg, id, opts.force ?? false),
        dryRun: opts.dryRun,
        json: opts.json,
      });
    });
}

export function registerIdentityCommand(program: Command): void {
  const identity = program.command("identity").description("Manage identities: (GitHub users with token source and agent profile) in the config file");

  identity
    .command("ls")
    .description("List identities and where they are used (ao doctor verifies the tokens)")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => listIdentities(loadConfigWithPath().config, opts.json ?? false));

  commonOptions(
    identityOptions(
      identity
        .command("add <id>")
        .description("Add an identity (e.g. neo, trinity)")
        .requiredOption("--token-env <VAR>", "Environment variable that carries the GitHub token"),
    ),
    false,
  ).action((id: string, opts: IdentityOptions & CommonCli) => {
    runConfigEdit({
      title: `add identity "${id}"`,
      apply: (doc) => applyIdentityAdd(doc, id, opts),
      show: (loaded) => loaded.identities?.[id],
      dryRun: opts.dryRun,
      json: opts.json,
    });
  });

  commonOptions(
    identityOptions(
      identity.command("update <id>").description("Change fields of an identity").option("--token-env <VAR>", "Environment variable that carries the GitHub token"),
    ),
    true,
  ).action((id: string, opts: IdentityOptions & CommonCli) => {
    runConfigEdit({
      title: `update identity "${id}"`,
      apply: (doc) => applyIdentityUpdate(doc, id, opts),
      show: (loaded) => loaded.identities?.[id],
      dryRun: opts.dryRun,
      json: opts.json,
    });
  });

  identity
    .command("rm <id>")
    .alias("remove")
    .description("Remove an identity (refused while a role or scm block uses it)")
    .option("--force", "Remove even when used")
    .option("--dry-run", "Validate and print, write nothing")
    .option("--json", "Machine-readable result")
    .action((id: string, opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
      runConfigEdit({
        title: `remove identity "${id}"`,
        apply: (doc, cfg) => applyIdentityRemove(doc, cfg, id, opts.force ?? false),
        dryRun: opts.dryRun,
        json: opts.json,
      });
    });
}
