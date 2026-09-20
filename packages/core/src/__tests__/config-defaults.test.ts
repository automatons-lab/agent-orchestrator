/**
 * Fork: `defaults:` inheritance for every project behaviour field, and
 * `identities:` reference validation.
 */
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateConfig, mergeConfigValues } from "../config.js";

function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "/repos/app",
    repo: "org/app",
    defaultBranch: "main",
    sessionPrefix: "app",
    ...overrides,
  };
}

describe("defaults inheritance", () => {
  it("copies scalar and array defaults into projects that leave them unset", () => {
    const cfg = validateConfig({
      defaults: {
        runtime: "tmux",
        agent: "codex",
        workspace: "clone",
        agentRulesFile: "/rules/coder.md",
        branchNameTemplate: "{issue}.{slug}",
        postCreate: ["echo hi"],
        reviewers: ["trinity"],
        orchestratorSessionStrategy: "reuse",
      },
      projects: { app: project() },
    });
    const p = cfg.projects["app"]!;
    expect(p.runtime).toBe("tmux");
    expect(p.agent).toBe("codex");
    expect(p.workspace).toBe("clone");
    expect(p.agentRulesFile).toBe("/rules/coder.md");
    expect(p.branchNameTemplate).toBe("{issue}.{slug}");
    expect(p.postCreate).toEqual(["echo hi"]);
    expect(p.reviewers).toEqual(["trinity"]);
    expect(p.orchestratorSessionStrategy).toBe("reuse");
  });

  it("lets project scalars and arrays replace defaults entirely", () => {
    const cfg = validateConfig({
      defaults: { postCreate: ["a", "b"], agentRulesFile: "/d.md", reviewers: ["x"] },
      projects: { app: project({ postCreate: ["c"], agentRulesFile: "/p.md", reviewers: [] }) },
    });
    const p = cfg.projects["app"]!;
    expect(p.postCreate).toEqual(["c"]);
    expect(p.agentRulesFile).toBe("/p.md");
    expect(p.reviewers).toEqual([]);
  });

  it("deep-merges role blocks and agentConfig with project keys winning", () => {
    const cfg = validateConfig({
      identities: { neo: { tokenEnv: "NEO_TOKEN" }, trinity: { tokenEnv: "TRI_TOKEN" } },
      defaults: {
        agentConfig: { model: "shared-model" },
        worker: {
          githubUser: "neo",
          agent: "codex",
          agentConfig: { model: "gpt-6-astra", reasoningEffort: "xhigh", permissions: "permissionless" },
        },
        reviewer: {
          githubUser: "trinity",
          agent: "codex",
          agentConfig: { model: "gpt-6-astra" },
          timeoutMinutes: 25,
        },
      },
      projects: {
        app: project({
          worker: { agentConfig: { reasoningEffort: "high" } },
          reviewer: { agent: "claude-code", enabled: true },
        }),
      },
    });
    const p = cfg.projects["app"]!;
    expect(p.worker).toEqual({
      identity: "neo",
      githubUser: "neo",
      agent: "codex",
      agentConfig: { model: "gpt-6-astra", reasoningEffort: "high", permissions: "permissionless" },
    });
    expect(p.reviewer).toEqual({
      identity: "trinity",
      githubUser: "trinity",
      agent: "claude-code",
      agentConfig: { model: "gpt-6-astra" },
      timeoutMinutes: 25,
      enabled: true,
    });
    expect(p.agentConfig?.model).toBe("shared-model");
  });

  it("gives every project its own copy of default objects and arrays", () => {
    const cfg = validateConfig({
      defaults: { postCreate: ["a"], worker: { agentConfig: { model: "m" } } },
      projects: { one: project({ path: "/repos/one", sessionPrefix: "one" }), two: project({ path: "/repos/two", sessionPrefix: "two" }) },
    });
    cfg.projects["one"]!.postCreate!.push("mutated");
    cfg.projects["one"]!.worker!.agentConfig!.model = "changed";
    expect(cfg.projects["two"]!.postCreate).toEqual(["a"]);
    expect(cfg.projects["two"]!.worker!.agentConfig!.model).toBe("m");
    expect(cfg.defaults.postCreate).toEqual(["a"]);
    expect(cfg.defaults.worker!.agentConfig!.model).toBe("m");
  });

  it("expands ~ in agentRulesFile and reviewer.rulesFile", () => {
    const cfg = validateConfig({
      defaults: { agentRulesFile: "~/rules/coder.md", reviewer: { rulesFile: "~/rules/review.md" } },
      projects: { app: project() },
    });
    expect(cfg.projects["app"]!.agentRulesFile).toBe(join(homedir(), "rules/coder.md"));
    expect(cfg.projects["app"]!.reviewer?.rulesFile).toBe(join(homedir(), "rules/review.md"));
  });

  it("merges defaults.scm into the project scm block", () => {
    const cfg = validateConfig({
      identities: { neo: { tokenEnv: "NEO_TOKEN" } },
      defaults: { scm: { plugin: "github", githubUser: "neo" } },
      projects: { app: project(), other: project({ path: "/repos/o", sessionPrefix: "o", scm: { plugin: "gitlab" } }) },
    });
    expect(cfg.projects["app"]!.scm).toEqual({ plugin: "github", identity: "neo", githubUser: "neo" });
    expect(cfg.projects["other"]!.scm).toEqual({ plugin: "gitlab", identity: "neo", githubUser: "neo" });
  });

  it("keeps the legacy project-level agent/agentConfig working without defaults", () => {
    const cfg = validateConfig({
      projects: { app: project({ agent: "codex", agentConfig: { model: "m1" } }) },
    });
    expect(cfg.projects["app"]!.agent).toBe("codex");
    expect(cfg.projects["app"]!.agentConfig?.model).toBe("m1");
  });
});

describe("identities validation", () => {
  it("rejects a githubUser that is not declared", () => {
    expect(() =>
      validateConfig({ projects: { app: project({ worker: { githubUser: "ghost" } }) } }),
    ).toThrow(/projects\.app\.worker references unknown githubUser "ghost"/);
    expect(() =>
      validateConfig({
        identities: { neo: { tokenEnv: "NEO_TOKEN" } },
        defaults: { reviewer: { githubUser: "trinity" } },
        projects: { app: project() },
      }),
    ).toThrow(/defaults\.reviewer references unknown githubUser "trinity". Declared identities: neo/);
  });

  it("rejects the same identity for worker and an enabled reviewer", () => {
    expect(() =>
      validateConfig({
        identities: { neo: { tokenEnv: "NEO_TOKEN" } },
        defaults: { worker: { githubUser: "neo" }, reviewer: { githubUser: "neo", enabled: true } },
        projects: { app: project() },
      }),
    ).toThrow(/worker and reviewer use the same githubUser "neo"/);
  });

  it("allows the same identity while the reviewer is disabled", () => {
    expect(() =>
      validateConfig({
        identities: { neo: { tokenEnv: "NEO_TOKEN" } },
        defaults: { worker: { githubUser: "neo" }, reviewer: { githubUser: "neo" } },
        projects: { app: project() },
      }),
    ).not.toThrow();
  });

  it("rejects malformed identity keys, non-login keys without githubUser and entries without tokenEnv", () => {
    expect(() =>
      validateConfig({ identities: { "bad login": { tokenEnv: "X" } }, projects: {} }),
    ).toThrow();
    expect(() => validateConfig({ identities: { neo: {} }, projects: {} })).toThrow();
    expect(() =>
      validateConfig({ identities: { neo_codex: { tokenEnv: "X" } }, projects: {} }),
    ).toThrow(/identities\.neo_codex: the key is not a GitHub login, so githubUser is required/);
    expect(() =>
      validateConfig({ identities: { neo_codex: { tokenEnv: "X", githubUser: "bad login" } }, projects: {} }),
    ).toThrow();
    expect(() =>
      validateConfig({
        identities: { neo_codex: { tokenEnv: "X", githubUser: "neo-automaton" }, "dependabot[bot]": { tokenEnv: "Y" } },
        projects: {},
      }),
    ).not.toThrow();
  });
});

describe("identity profiles", () => {
  const identities = {
    neo: {
      tokenEnv: "NEO_TOKEN",
      githubUser: "neo-automaton",
      agent: "codex",
      model: "gpt-6-astra",
      reasoningEffort: "xhigh",
      permissions: "permissionless",
    },
    trinity: { tokenEnv: "TRI_TOKEN", githubUser: "trinity-automaton", agent: "claude-code", model: "opus" },
    synty: { tokenEnv: "SYN_TOKEN", githubUser: "synty-automaton" },
  };

  it("fills githubUser, agent and agentConfig from the identity, explicit role fields winning", () => {
    const cfg = validateConfig({
      identities,
      defaults: {
        scm: { plugin: "github", identity: "synty" },
        worker: { identity: "neo" },
        reviewer: { identity: "trinity", agentConfig: { model: "sonnet", sandbox: "read-only" }, enabled: true },
        orchestrator: { identity: "synty", agent: "codex" },
      },
      projects: { app: project({ worker: { agentConfig: { reasoningEffort: "high" } } }) },
    });
    expect(cfg.defaults.worker).toEqual({
      identity: "neo",
      githubUser: "neo-automaton",
      agent: "codex",
      agentConfig: { model: "gpt-6-astra", reasoningEffort: "xhigh", permissions: "permissionless" },
    });
    expect(cfg.defaults.scm).toEqual({ plugin: "github", identity: "synty", githubUser: "synty-automaton" });
    const p = cfg.projects["app"]!;
    expect(p.worker).toEqual({
      identity: "neo",
      githubUser: "neo-automaton",
      agent: "codex",
      agentConfig: { model: "gpt-6-astra", reasoningEffort: "high", permissions: "permissionless" },
    });
    expect(p.reviewer).toEqual({
      identity: "trinity",
      githubUser: "trinity-automaton",
      agent: "claude-code",
      agentConfig: { model: "sonnet", sandbox: "read-only" },
      enabled: true,
    });
    expect(p.orchestrator).toEqual({ identity: "synty", githubUser: "synty-automaton", agent: "codex" });
    expect(p.scm).toEqual({ plugin: "github", identity: "synty", githubUser: "synty-automaton" });
  });

  it("lets a project pick another identity than the defaults, by key or by login", () => {
    const cfg = validateConfig({
      identities,
      defaults: { worker: { identity: "neo" }, reviewer: { identity: "trinity" } },
      projects: {
        byKey: project({ path: "/repos/k", sessionPrefix: "k", worker: { identity: "trinity" } }),
        byLogin: project({ path: "/repos/l", sessionPrefix: "l", worker: { githubUser: "trinity-automaton" } }),
      },
    });
    for (const id of ["byKey", "byLogin"]) {
      expect(cfg.projects[id]!.worker).toEqual({
        identity: "trinity",
        githubUser: "trinity-automaton",
        agent: "claude-code",
        agentConfig: { model: "opus" },
      });
    }
  });

  it("resolves the legacy githubUser reference by key and by login", () => {
    const cfg = validateConfig({
      identities: { ...identities, "dependabot[bot]": { tokenEnv: "BOT_TOKEN" } },
      defaults: { worker: { githubUser: "neo-automaton" }, orchestrator: { githubUser: "dependabot[bot]" } },
      projects: { app: project() },
    });
    expect(cfg.projects["app"]!.worker?.identity).toBe("neo");
    expect(cfg.projects["app"]!.worker?.agent).toBe("codex");
    expect(cfg.projects["app"]!.orchestrator).toEqual({ identity: "dependabot[bot]", githubUser: "dependabot[bot]" });
  });

  it("rejects unknown, contradictory and ambiguous references", () => {
    expect(() =>
      validateConfig({ identities, defaults: { worker: { identity: "ghost" } }, projects: { app: project() } }),
    ).toThrow(/defaults\.worker references unknown identity "ghost"\. Declared identities: neo, trinity, synty/);
    expect(() =>
      validateConfig({
        identities,
        projects: { app: project({ worker: { identity: "neo", githubUser: "trinity-automaton" } }) },
      }),
    ).toThrow(/projects\.app\.worker: githubUser "trinity-automaton" does not match identity "neo" \(login neo-automaton\)/);
    expect(() =>
      validateConfig({
        identities: {
          neo: { tokenEnv: "A", githubUser: "neo-automaton" },
          neo2: { tokenEnv: "B", githubUser: "neo-automaton" },
        },
        projects: { app: project({ worker: { githubUser: "neo-automaton" } }) },
      }),
    ).toThrow(/githubUser "neo-automaton" matches several identities \(neo, neo2\)/);
  });

  it("compares worker and reviewer by login, not by key", () => {
    expect(() =>
      validateConfig({
        identities: {
          neo: { tokenEnv: "A", githubUser: "neo-automaton" },
          "neo-claude": { tokenEnv: "A", githubUser: "neo-automaton", agent: "claude-code" },
        },
        defaults: { worker: { identity: "neo" }, reviewer: { identity: "neo-claude", enabled: true } },
        projects: { app: project() },
      }),
    ).toThrow(/worker and reviewer use the same githubUser "neo-automaton"/);
  });
});

describe("mergeConfigValues", () => {
  it("merges nested objects, replaces arrays and primitives, skips undefined", () => {
    expect(
      mergeConfigValues(
        { a: 1, b: { c: 1, d: [1] }, e: [1, 2] },
        { a: undefined, b: { d: [2] }, e: [3] } as never,
      ),
    ).toEqual({ a: 1, b: { c: 1, d: [2] }, e: [3] });
    expect(mergeConfigValues(undefined, { x: 1 })).toEqual({ x: 1 });
    expect(mergeConfigValues({ x: 1 }, undefined)).toEqual({ x: 1 });
    expect(mergeConfigValues(undefined, undefined)).toBeUndefined();
  });

  it("returns copies, never the inputs", () => {
    const base = { list: [1] };
    const out = mergeConfigValues(base, undefined)!;
    out.list.push(2);
    expect(base.list).toEqual([1]);
  });
});
