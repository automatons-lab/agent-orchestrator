/**
 * GitHub identities (fork).
 *
 * `identities:` maps a GitHub login to the environment variable that holds its
 * token. Roles (`worker`, `orchestrator`, `reviewer`) and the engine's own SCM
 * calls (`scm.githubUser`) name one of those logins. Tokens are read from the
 * environment at use time and are never written to config, traces or logs.
 */
import { execGhObserved } from "./gh-trace.js";
import type { OrchestratorConfig, ProjectConfig } from "./types.js";

export type IdentityRole = "worker" | "orchestrator" | "reviewer";

export const IDENTITY_ROLES: readonly IdentityRole[] = ["worker", "orchestrator", "reviewer"];

export interface ResolvedIdentity {
  login: string;
  tokenEnv: string;
  /** Present when the environment variable is set. Never log it. */
  token?: string;
  /** Git author name (defaults to the login). */
  name: string;
  /** Git author email (defaults to the GitHub noreply address). */
  email: string;
}

type IdentityConfigSource = Pick<OrchestratorConfig, "identities">;

export function resolveIdentity(
  config: IdentityConfigSource,
  login: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedIdentity | undefined {
  const entry = config.identities?.[login];
  if (!entry) return undefined;
  const raw = env[entry.tokenEnv];
  const token = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  return {
    login,
    tokenEnv: entry.tokenEnv,
    ...(token !== undefined ? { token } : {}),
    name: entry.name ?? login,
    email: entry.email ?? `${login}@users.noreply.github.com`,
  };
}

export function getIdentityToken(
  config: IdentityConfigSource,
  login: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveIdentity(config, login, env)?.token;
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
 * `githubUser`. Throws when the identity is undeclared or its token env var is
 * unset, so a spawn fails loudly instead of pushing as the wrong user.
 */
export function roleIdentityEnvironment(
  config: IdentityConfigSource,
  project: ProjectConfig,
  role: IdentityRole,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const login = roleIdentityLogin(project, role);
  if (login === undefined) return {};
  const identity = resolveIdentity(config, login, env);
  if (!identity) {
    throw new Error(
      `Project "${project.name}": ${role}.githubUser "${login}" is not declared under identities:`,
    );
  }
  if (identity.token === undefined) {
    throw new Error(
      `Identity "${login}": environment variable ${identity.tokenEnv} is not set ` +
        `(needed by project "${project.name}" role ${role})`,
    );
  }
  return identityEnvironment(identity);
}

/**
 * Login the engine itself uses for SCM/tracker API calls. Only the default
 * is honoured process-wide; per-project `scm.githubUser` overrides are applied
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
  const login = engineIdentityLogin(config);
  if (login === undefined) {
    return { applied: false, reason: "no defaults.scm.githubUser configured" };
  }
  const identity = resolveIdentity(config, login, env);
  if (!identity) {
    return { login, applied: false, reason: `identity "${login}" is not declared` };
  }
  if (identity.token === undefined) {
    return { login, applied: false, reason: `${identity.tokenEnv} is not set` };
  }
  if (env["GH_TOKEN"] === identity.token) {
    return { login, applied: false, reason: "GH_TOKEN already matches" };
  }
  env["GH_TOKEN"] = identity.token;
  return { login, applied: true, reason: `GH_TOKEN exported from ${identity.tokenEnv}` };
}

/** Where each declared identity is referenced ("defaults.worker", "projects.x.reviewer", ...). */
export function identityUsage(config: OrchestratorConfig): Record<string, string[]> {
  const usage: Record<string, string[]> = {};
  for (const login of Object.keys(config.identities ?? {})) usage[login] = [];
  const add = (login: string | undefined, where: string): void => {
    if (login === undefined) return;
    (usage[login] ??= []).push(where);
  };
  add(config.defaults?.scm?.githubUser, "defaults.scm");
  for (const role of IDENTITY_ROLES) add(config.defaults?.[role]?.githubUser, `defaults.${role}`);
  for (const [id, project] of Object.entries(config.projects)) {
    if (project.scm?.githubUser !== config.defaults?.scm?.githubUser) {
      add(project.scm?.githubUser, `projects.${id}.scm`);
    }
    for (const role of IDENTITY_ROLES) {
      if (project[role]?.githubUser !== config.defaults?.[role]?.githubUser) {
        add(project[role]?.githubUser, `projects.${id}.${role}`);
      }
    }
  }
  return usage;
}

export interface IdentityCheck {
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
  for (const login of Object.keys(config.identities ?? {})) {
    const identity = resolveIdentity(config, login, env);
    if (!identity) continue;
    const usedBy = usage[login] ?? [];
    const base = { login, tokenEnv: identity.tokenEnv, usedBy };
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
