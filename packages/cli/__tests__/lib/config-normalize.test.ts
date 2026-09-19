import { describe, it, expect } from "vitest";
import {
  deepEqual,
  diffEffectiveProjects,
  normalizeConfigDocument,
} from "../../src/lib/config-normalize.js";

function project(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: id,
    path: `/repos/${id}`,
    repo: `org/${id}`,
    defaultBranch: "main",
    sessionPrefix: id,
    displayName: `Project ${id}`,
    source: "manual-add",
    registeredAt: "2026-09-14T00:00:00Z",
    agentConfig: { model: "gpt-6-astra", reasoningEffort: "xhigh" },
    agent: "codex",
    runtime: "tmux",
    branchNameTemplate: "{issue}.{slug}",
    agentRulesFile: "/rules/coder.md",
    reviewers: ["trinity"],
    worker: { agent: "codex", agentConfig: { model: "gpt-6-astra", permissions: "permissionless" } },
    postCreate: ['git config user.name "neo"', 'git config user.email "neo@example.com"'],
    ...extra,
  };
}

const raw = {
  port: 3030,
  identities: { neo: { tokenEnv: "NEO_TOKEN" }, trinity: { tokenEnv: "TRI_TOKEN" } },
  defaults: { runtime: "tmux", agent: "codex", workspace: "clone", worker: { githubUser: "neo" } },
  projects: {
    one: project("one"),
    two: project("two", { worker: { agent: "codex", agentConfig: { model: "gpt-6-astra", permissions: "permissionless", reasoningEffort: "high" } } }),
  },
};

describe("normalizeConfigDocument", () => {
  it("hoists repeated behaviour, folds legacy agent fields and drops registry-only keys", () => {
    const { normalized, changes } = normalizeConfigDocument(raw);
    const defaults = normalized["defaults"] as Record<string, unknown>;
    const projects = normalized["projects"] as Record<string, Record<string, unknown>>;

    expect(defaults["branchNameTemplate"]).toBe("{issue}.{slug}");
    expect(defaults["agentRulesFile"]).toBe("/rules/coder.md");
    expect(defaults["reviewers"]).toEqual(["trinity"]);
    // reasoningEffort differs between the projects (xhigh vs high), so it stays per project.
    expect(defaults["worker"]).toEqual({
      githubUser: "neo",
      agent: "codex",
      agentConfig: { model: "gpt-6-astra", permissions: "permissionless" },
    });
    expect(defaults["postCreate"]).toBeUndefined();

    expect(projects["one"]).toEqual({
      name: "Project one",
      path: "/repos/one",
      repo: "org/one",
      defaultBranch: "main",
      sessionPrefix: "one",
      worker: { agentConfig: { reasoningEffort: "xhigh" } },
    });
    expect(projects["two"]).toEqual({
      name: "Project two",
      path: "/repos/two",
      repo: "org/two",
      defaultBranch: "main",
      sessionPrefix: "two",
      worker: { agentConfig: { reasoningEffort: "high" } },
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        "projects.one: displayName → name",
        "projects.one: folded agent/agentConfig into worker",
        expect.stringMatching(/projects\.one: removed 2 git identity postCreate step/),
        "defaults.branchNameTemplate: hoisted from 2 project(s)",
        "projects.two.worker: kept only overrides",
      ]),
    );
  });

  it("keeps values that differ between projects and honours opt-outs", () => {
    const input = {
      identities: { neo: { tokenEnv: "NEO_TOKEN" } },
      defaults: { worker: { githubUser: "neo" } },
      projects: {
        one: project("one", { branchNameTemplate: "a" }),
        two: project("two", { branchNameTemplate: "b" }),
      },
    };
    const { normalized } = normalizeConfigDocument(input, {
      foldLegacyAgent: false,
      dropGitIdentitySteps: false,
    });
    const projects = normalized["projects"] as Record<string, Record<string, unknown>>;
    expect(projects["one"]!["branchNameTemplate"]).toBe("a");
    expect(projects["two"]!["branchNameTemplate"]).toBe("b");
    // agent is identical everywhere, so it is hoisted even without folding.
    expect((normalized["defaults"] as Record<string, unknown>)["agent"]).toBe("codex");
    expect(projects["one"]!["agent"]).toBeUndefined();
    expect(projects["one"]!["postCreate"]).toBeUndefined();
    expect((normalized["defaults"] as Record<string, unknown>)["postCreate"]).toEqual([
      'git config user.name "neo"',
      'git config user.email "neo@example.com"',
    ]);
  });

  it("preserves effective behaviour except for the folded legacy fields and git steps", () => {
    const { normalized } = normalizeConfigDocument(raw, {
      foldLegacyAgent: false,
      dropGitIdentitySteps: false,
    });
    expect(diffEffectiveProjects(raw, normalized)).toEqual([]);

    const folded = normalizeConfigDocument(raw).normalized;
    const diff = diffEffectiveProjects(raw, folded);
    expect(new Set(diff.map((d) => d.key))).toEqual(new Set(["agentConfig", "postCreate", "worker"]));
  });
});

describe("deepEqual", () => {
  it("ignores key order and undefined members", () => {
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual([1, { x: 2 }], [1, { x: 2 }])).toBe(true);
    expect(deepEqual({ a: 1 }, { a: "1" })).toBe(false);
  });
});
