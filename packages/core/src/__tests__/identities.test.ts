/** Fork: GitHub identities — token lookup, role environments, engine identity, checks. */
import { describe, it, expect } from "vitest";
import { validateConfig } from "../config.js";
import {
  applyEngineIdentity,
  checkIdentities,
  identityUsage,
  resolveIdentity,
  roleIdentityEnvironment,
} from "../identities.js";

function config(extra: Record<string, unknown> = {}) {
  return validateConfig({
    identities: {
      neo: { tokenEnv: "NEO_TOKEN" },
      trinity: { tokenEnv: "TRI_TOKEN", name: "Trinity", email: "trinity@example.com" },
    },
    defaults: {
      scm: { plugin: "github", githubUser: "neo" },
      worker: { githubUser: "neo" },
      reviewer: { githubUser: "trinity", enabled: true },
    },
    projects: {
      app: { path: "/repos/app", repo: "org/app", defaultBranch: "main", sessionPrefix: "app" },
      solo: {
        path: "/repos/solo",
        repo: "org/solo",
        defaultBranch: "main",
        sessionPrefix: "solo",
        worker: { githubUser: "trinity" },
        reviewer: { githubUser: "neo" },
      },
    },
    ...extra,
  });
}

describe("resolveIdentity", () => {
  it("reads the token from the named env var and fills git author defaults", () => {
    const cfg = config();
    const env = { NEO_TOKEN: " tok-neo " };
    expect(resolveIdentity(cfg, "neo", env)).toEqual({
      id: "neo",
      login: "neo",
      tokenEnv: "NEO_TOKEN",
      token: "tok-neo",
      name: "neo",
      email: "neo@users.noreply.github.com",
    });
    expect(resolveIdentity(cfg, "trinity", {})).toEqual({
      id: "trinity",
      login: "trinity",
      tokenEnv: "TRI_TOKEN",
      name: "Trinity",
      email: "trinity@example.com",
    });
    expect(resolveIdentity(cfg, "ghost", env)).toBeUndefined();
  });

  it("resolves a profile by key or by its login and carries the agent reference", () => {
    const cfg = validateConfig({
      identities: {
        neo: { tokenEnv: "NEO_TOKEN", githubUser: "neo-automaton", agent: "codex-coder" },
        "neo-claude": { tokenEnv: "NEO_TOKEN", githubUser: "neo-automaton", agent: "claude-code" },
        tri: { tokenEnv: "TRI_TOKEN", githubUser: "trinity-automaton" },
      },
      projects: {},
    });
    expect(resolveIdentity(cfg, "neo", { NEO_TOKEN: "t" })).toEqual({
      id: "neo",
      login: "neo-automaton",
      tokenEnv: "NEO_TOKEN",
      token: "t",
      name: "neo-automaton",
      email: "neo-automaton@users.noreply.github.com",
      agent: "codex-coder",
    });
    expect(resolveIdentity(cfg, "trinity-automaton", {})?.id).toBe("tri");
    // two profiles share the login: only the key can tell them apart
    expect(resolveIdentity(cfg, "neo-automaton", {})).toBeUndefined();
  });
});

describe("roleIdentityEnvironment", () => {
  it("returns gh token and git author variables for the role identity", () => {
    const cfg = config();
    const env = roleIdentityEnvironment(cfg, cfg.projects["app"]!, "worker", { NEO_TOKEN: "tok" });
    expect(env).toEqual({
      GH_TOKEN: "tok",
      GIT_AUTHOR_NAME: "neo",
      GIT_AUTHOR_EMAIL: "neo@users.noreply.github.com",
      GIT_COMMITTER_NAME: "neo",
      GIT_COMMITTER_EMAIL: "neo@users.noreply.github.com",
    });
  });

  it("is empty when the role has no githubUser", () => {
    const cfg = validateConfig({
      projects: { app: { path: "/repos/app", repo: "org/app", defaultBranch: "main", sessionPrefix: "app" } },
    });
    expect(roleIdentityEnvironment(cfg, cfg.projects["app"]!, "worker", {})).toEqual({});
  });

  it("throws when the token env var is unset", () => {
    const cfg = config();
    expect(() => roleIdentityEnvironment(cfg, cfg.projects["app"]!, "reviewer", {})).toThrow(
      /TRI_TOKEN is not set/,
    );
  });
});

describe("applyEngineIdentity", () => {
  it("exports GH_TOKEN from the engine identity and is idempotent", () => {
    const cfg = config();
    const env: NodeJS.ProcessEnv = { NEO_TOKEN: "tok" };
    expect(applyEngineIdentity(cfg, env)).toEqual({
      login: "neo",
      applied: true,
      reason: "GH_TOKEN exported from NEO_TOKEN",
    });
    expect(env["GH_TOKEN"]).toBe("tok");
    expect(applyEngineIdentity(cfg, env).applied).toBe(false);
  });

  it("reports why nothing was applied", () => {
    expect(applyEngineIdentity(config(), {}).reason).toBe("NEO_TOKEN is not set");
    const noScm = validateConfig({ projects: {} });
    expect(applyEngineIdentity(noScm, {}).reason).toMatch(/no defaults\.scm\.identity/);
  });
});

describe("identityUsage", () => {
  it("lists defaults and only differing project overrides", () => {
    expect(identityUsage(config())).toEqual({
      neo: ["defaults.scm", "defaults.worker", "projects.solo.reviewer"],
      trinity: ["defaults.reviewer", "projects.solo.worker"],
    });
  });

  it("keys usage by identity id even when roles reference the login", () => {
    const cfg = validateConfig({
      identities: { neo: { tokenEnv: "A", githubUser: "neo-automaton" }, tri: { tokenEnv: "B", githubUser: "trinity-automaton" } },
      defaults: { scm: { plugin: "github", identity: "neo" }, worker: { githubUser: "neo-automaton" } },
      projects: {
        app: { path: "/repos/app", repo: "org/app", defaultBranch: "main", sessionPrefix: "app", reviewer: { identity: "tri" } },
      },
    });
    expect(identityUsage(cfg)).toEqual({ neo: ["defaults.scm", "defaults.worker"], tri: ["projects.app.reviewer"] });
  });
});

describe("checkIdentities", () => {
  it("verifies each token against GitHub with the token scoped to that call", async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const results = await checkIdentities(config(), {
      env: { NEO_TOKEN: "tok-neo", TRI_TOKEN: "tok-tri" },
      exec: async (args, env) => {
        calls.push({ args, env });
        return env["GH_TOKEN"] === "tok-neo" ? "neo\n" : "someone-else\n";
      },
    });
    expect(calls.map((c) => c.args)).toEqual([
      ["api", "user", "--jq", ".login"],
      ["api", "user", "--jq", ".login"],
    ]);
    expect(results).toEqual([
      expect.objectContaining({ id: "neo", login: "neo", tokenPresent: true, resolvedLogin: "neo", ok: true }),
      expect.objectContaining({
        login: "trinity",
        ok: false,
        problem: 'token in TRI_TOKEN belongs to "someone-else"',
      }),
    ]);
  });

  it("reports missing env vars without calling GitHub and skips verification on request", async () => {
    let called = 0;
    const missing = await checkIdentities(config(), {
      env: {},
      exec: async () => {
        called += 1;
        return "";
      },
    });
    expect(called).toBe(0);
    expect(missing.map((r) => [r.login, r.ok, r.problem])).toEqual([
      ["neo", false, "environment variable NEO_TOKEN is not set"],
      ["trinity", false, "environment variable TRI_TOKEN is not set"],
    ]);
    const unverified = await checkIdentities(config(), {
      env: { NEO_TOKEN: "a", TRI_TOKEN: "b" },
      verifyLogin: false,
      exec: async () => {
        called += 1;
        return "";
      },
    });
    expect(called).toBe(0);
    expect(unverified.every((r) => r.ok && r.tokenPresent)).toBe(true);
  });

  it("turns a gh failure into a problem instead of throwing", async () => {
    const results = await checkIdentities(config(), {
      env: { NEO_TOKEN: "a", TRI_TOKEN: "b" },
      exec: async () => {
        throw new Error("gh: HTTP 401");
      },
    });
    expect(results[0]?.problem).toBe("could not verify token: gh: HTTP 401");
  });
});
