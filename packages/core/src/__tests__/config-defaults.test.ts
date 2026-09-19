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
      githubUser: "neo",
      agent: "codex",
      agentConfig: { model: "gpt-6-astra", reasoningEffort: "high", permissions: "permissionless" },
    });
    expect(p.reviewer).toEqual({
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
    expect(cfg.projects["app"]!.scm).toEqual({ plugin: "github", githubUser: "neo" });
    expect(cfg.projects["other"]!.scm).toEqual({ plugin: "gitlab", githubUser: "neo" });
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

  it("rejects identity keys that are not GitHub logins and entries without tokenEnv", () => {
    expect(() =>
      validateConfig({ identities: { "bad login": { tokenEnv: "X" } }, projects: {} }),
    ).toThrow();
    expect(() => validateConfig({ identities: { neo: {} }, projects: {} })).toThrow();
    expect(() =>
      validateConfig({ identities: { "dependabot[bot]": { tokenEnv: "X" } }, projects: {} }),
    ).not.toThrow();
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
