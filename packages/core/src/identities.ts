/**
 * Identities (fork).
 *
 * `identities:` maps an id to a GitHub login, the environment variable that
 * holds its token and the agent settings it runs with. Roles (`worker`,
 * `orchestrator`, `reviewer`) and the engine's own SCM calls (`scm.identity`)
 * reference an identity by key; config validation also resolves the legacy
 * `githubUser: <login>` form. Tokens are read from the environment at use
 * time and are never written to config, traces or logs.
 */
import { execGhObserved } from "./gh-trace.js";
import { findIdentityKey, identityLogin } from "./identity-lookup.js";
import type { OrchestratorConfig, ProjectConfig } from "./types.js";

export type IdentityRole = "worker" | "orchestrator" | "reviewer";

export const IDENTITY_ROLES: readonly IdentityRole[] = ["worker", "orchestrator", "reviewer"];

export interface ResolvedIdentity {
  /** Key under `identities:`. */
  id: string;
  /** GitHub login (`githubUser`, else the key). */
  login: string;
  tokenEnv: string;
  /** Present when the environment variable is set. Never log it. */
  token?: string;
  /** Git author name (defaults to the login). */
  name: string;
  /** Git author email (defaults to the GitHub noreply address). */
  email: string;
  /** Agent settings the identity carries, if any. */
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  permissions?: string;
}

type IdentityConfigSource = Pick<OrchestratorConfig, "identities">;

/**
 * Resolve an identity by key, or by login when exactly one identity carries
 * it. Undefined when nothing matches or the login is ambiguous.
 */
export function resolveIdentity(
  config: IdentityConfigSource,
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedIdentity | undefined {
  let key: string | undefined;
  try {
    key = findIdentityKey(config.identities, ref);
  } catch {
    return undefined;
  }
  if (key === undefined) return undefined;
  const entry = config.identities?.[key];
  if (!entry) return undefined;
  const login = identityLogin(config.identities, key);
  const raw = env[entry.tokenEnv];
  const token = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  return {
    id: key,
    login,
    tokenEnv: entry.tokenEnv,
    ...(token !== undefined ? { token } : {}),
    name: entry.name ?? login,
    email: entry.email ?? `${login}@users.noreply.github.com`,
    ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.reasoningEffort !== undefined ? { reasoningEffort: entry.reasoningEffort } : {}),
    ...(entry.permissions !== undefined ? { permissions: entry.permissions } : {}),
  };
}

export function getIdentityToken(
  config: IdentityConfigSource,
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveIdentity(config, ref, env)?.token;
}

/** Identity reference of a role (key, or legacy login) after validation. */
export function roleIdentityRef(project: ProjectConfig, role: IdentityRole): string | undefined {
  return project[role]?.identity ?? project[role]?.githubUser;
}

/** Login a role acts as, after defaults were merged into the project. */
export function roleIdentityLogin(project: ProjectConfig, role: IdentityRole): string | undefined {
  return project[role]?.githubUser;
}

/**
 * Environment for a process acting as `identity`: `GH_TOKEN` for gh/git
 * credential helpers plus git author/committer so commits carry the right
 * name without `git config` steps in `postCreate`.
 */
export function identityEnvironment(identity: ResolvedIdentity): Record<string, string> {
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
  if (identity.token !== undefined) env["GH_TOKEN"] = identity.token;
  return env;
}

/**
 * Environment for a role session of `project`, or `{}` when the role has no
 * identity. Throws when the identity is undeclared or its token env var is
 * unset, so a spawn fails loudly instead of pushing as the wrong user.
 */
export function roleIdentityEnvironment(
  config: IdentityConfigSource,
  project: ProjectConfig,
  role: IdentityRole,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const ref = roleIdentityRef(project, role);
  if (ref === undefined) return {};
  const identity = resolveIdentity(config, ref, env);
  if (!identity) {
    throw new Error(
      `Project "${project.name}": ${role}.identity "${ref}" is not declared under identities:`,
    );
  }
  if (identity.token === undefined) {
    throw new Error(
      `Identity "${identity.id}": environment variable ${identity.tokenEnv} is not set ` +
        `(needed by project "${project.name}" role ${role})`,
    );
  }
  return identityEnvironment(identity);
}

/** Identity reference (key, or legacy login) the engine itself uses for SCM/tracker API calls. */
export function engineIdentityRef(config: OrchestratorConfig): string | undefined {
  return config.defaults?.scm?.identity ?? config.defaults?.scm?.githubUser;
}

/**
 * Login the engine itself uses for SCM/tracker API calls. Only the default
 * is honoured process-wide; per-project `scm.identity` overrides are applied
 * by plugins that support per-call auth (e.g. review submission).
 */
export function engineIdentityLogin(config: OrchestratorConfig): string | undefined {
  return config.defaults?.scm?.githubUser;
}

export interface EngineIdentityResult {
  login?: string;
  applied: boolean;
  reason: string;
}

/**
 * Export `GH_TOKEN` for the engine process from the engine identity. Replaces
 * the systemd-level `GH_TOKEN` export: config, not the unit file, decides who
 * the engine is on GitHub. Idempotent.
 */
export function applyEngineIdentity(
  config: OrchestratorConfig,
  env: NodeJS.ProcessEnv = process.env,
): EngineIdentityResult {
  const ref = engineIdentityRef(config);
  if (ref === undefined) {
    return { applied: false, reason: "no defaults.scm.identity configured" };
  }
  const identity = resolveIdentity(config, ref, env);
  if (!identity) {
    return { login: ref, applied: false, reason: `identity "${ref}" is not declared` };
  }
  const login = identity.login;
  if (identity.token === undefined) {
    return { login, applied: false, reason: `${identity.tokenEnv} is not set` };
  }
  if (env["GH_TOKEN"] === identity.token) {
    return { login, applied: false, reason: "GH_TOKEN already matches" };
  }
  env["GH_TOKEN"] = identity.token;
  return { login, applied: true, reason: `GH_TOKEN exported from ${identity.tokenEnv}` };
}

/** Where each declared identity (by key) is referenced ("defaults.worker", "projects.x.reviewer", ...). */
export function identityUsage(config: OrchestratorConfig): Record<string, string[]> {
  const usage: Record<string, string[]> = {};
  for (const key of Object.keys(config.identities ?? {})) usage[key] = [];
  const keyOf = (ref: string | undefined): string | undefined => {
    if (ref === undefined) return undefined;
    try {
      return findIdentityKey(config.identities, ref) ?? ref;
    } catch {
      return ref;
    }
  };
  const add = (ref: string | undefined, where: string): void => {
    const key = keyOf(ref);
    if (key === undefined) return;
    (usage[key] ??= []).push(where);
  };
  const defaultsScm = keyOf(config.defaults?.scm?.identity ?? config.defaults?.scm?.githubUser);
  add(defaultsScm, "defaults.scm");
  const defaultsRole: Partial<Record<IdentityRole, string | undefined>> = {};
  for (const role of IDENTITY_ROLES) {
    defaultsRole[role] = keyOf(config.defaults?.[role]?.identity ?? config.defaults?.[role]?.githubUser);
    add(defaultsRole[role], `defaults.${role}`);
  }
  for (const [id, project] of Object.entries(config.projects)) {
    const scm = keyOf(project.scm?.identity ?? project.scm?.githubUser);
    if (scm !== defaultsScm) add(scm, `projects.${id}.scm`);
    for (const role of IDENTITY_ROLES) {
      const key = keyOf(project[role]?.identity ?? project[role]?.githubUser);
      if (key !== defaultsRole[role]) add(key, `projects.${id}.${role}`);
    }
  }
  return usage;
}

export interface IdentityCheck {
  /** Key under `identities:`. */
  id: string;
  /** GitHub login the identity claims. */
  login: string;
  tokenEnv: string;
  tokenPresent: boolean;
  /** Login GitHub reports for the token (when verified). */
  resolvedLogin?: string;
  usedBy: string[];
  ok: boolean;
  problem?: string;
}

export interface CheckIdentitiesOptions {
  env?: NodeJS.ProcessEnv;
  /** Ask GitHub who the token belongs to. Default true. */
  verifyLogin?: boolean;
  /** Injectable gh runner: receives args and the per-call env. */
  exec?: (args: string[], env: Record<string, string>) => Promise<string>;
}

async function defaultGhExec(args: string[], env: Record<string, string>): Promise<string> {
  return execGhObserved(args, { component: "identities", operation: "verify", env }, 15_000);
}

/**
 * Check every declared identity: token env var present and, unless disabled,
 * the token really belongs to that login. Never throws; problems are reported
 * per identity so `ao doctor` and `ao start` can print them.
 */
export async function checkIdentities(
  config: OrchestratorConfig,
  options: CheckIdentitiesOptions = {},
): Promise<IdentityCheck[]> {
  const env = options.env ?? process.env;
  const verify = options.verifyLogin ?? true;
  const exec = options.exec ?? defaultGhExec;
  const usage = identityUsage(config);
  const results: IdentityCheck[] = [];
  for (const key of Object.keys(config.identities ?? {})) {
    const identity = resolveIdentity(config, key, env);
    if (!identity) continue;
    const usedBy = usage[key] ?? [];
    const login = identity.login;
    const base = { id: key, login, tokenEnv: identity.tokenEnv, usedBy };
    if (identity.token === undefined) {
      results.push({
        ...base,
        tokenPresent: false,
        ok: false,
        problem: `environment variable ${identity.tokenEnv} is not set`,
      });
      continue;
    }
    if (!verify) {
      results.push({ ...base, tokenPresent: true, ok: true });
      continue;
    }
    try {
      const resolvedLogin = (
        await exec(["api", "user", "--jq", ".login"], { GH_TOKEN: identity.token })
      ).trim();
      const ok = resolvedLogin.toLowerCase() === login.toLowerCase();
      results.push({
        ...base,
        tokenPresent: true,
        resolvedLogin,
        ok,
        ...(ok ? {} : { problem: `token in ${identity.tokenEnv} belongs to "${resolvedLogin}"` }),
      });
    } catch (err) {
      results.push({
        ...base,
        tokenPresent: true,
        ok: false,
        problem: `could not verify token: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}
