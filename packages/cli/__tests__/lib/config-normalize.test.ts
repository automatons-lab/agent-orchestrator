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
    // Every worker block agrees on agent, model and permissions, so they move
    // into the neo identity; reasoningEffort differs (xhigh vs high) and stays per project.
    expect(normalized["identities"]).toEqual({
      neo: { tokenEnv: "NEO_TOKEN", agent: "codex", model: "gpt-6-astra", permissions: "permissionless" },
      trinity: { tokenEnv: "TRI_TOKEN" },
    });
    expect(defaults["worker"]).toEqual({ identity: "neo" });
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
        "defaults.worker: githubUser neo → identity neo",
        "identities.neo.model: hoisted from projects.one.worker, projects.two.worker",
        "projects.one.worker.agentConfig.model: removed (identity neo provides it)",
        "projects.two.worker.agent: removed (identity neo provides it)",
      ]),
    );
  });

  describe("identity profiles", () => {
    const identities = {
      neo: { tokenEnv: "NEO", githubUser: "neo-automaton" },
      tri: { tokenEnv: "TRI", githubUser: "trinity-automaton" },
      synty: { tokenEnv: "SYN", githubUser: "synty-automaton" },
    };
    const plain = (id: string, extra: Record<string, unknown> = {}) => ({
      path: `/repos/${id}`,
      repo: `org/${id}`,
      defaultBranch: "main",
      sessionPrefix: id,
      ...extra,
    });

    it("rewrites login references to identity keys and moves shared agent settings into the identity", () => {
      const doc = {
        identities,
        defaults: {
          scm: { plugin: "github", githubUser: "neo-automaton" },
          worker: {
            githubUser: "neo-automaton",
            agent: "codex",
            agentConfig: { model: "gpt-6-astra", reasoningEffort: "xhigh", permissions: "permissionless" },
          },
          reviewer: {
            githubUser: "trinity-automaton",
            agent: "codex",
            agentConfig: { model: "gpt-6-astra", sandbox: "danger-full-access" },
            enabled: false,
          },
          orchestrator: { githubUser: "synty-automaton", agent: "codex" },
        },
        projects: {
          one: plain("one"),
          two: plain("two", { worker: { agentConfig: { reasoningEffort: "high" } } }),
        },
      };
      const { normalized, changes } = normalizeConfigDocument(doc);
      const defaults = normalized["defaults"] as Record<string, unknown>;
      const projects = normalized["projects"] as Record<string, Record<string, unknown>>;
      expect(normalized["identities"]).toEqual({
        neo: { tokenEnv: "NEO", githubUser: "neo-automaton", agent: "codex", model: "gpt-6-astra", permissions: "permissionless" },
        tri: { tokenEnv: "TRI", githubUser: "trinity-automaton", agent: "codex", model: "gpt-6-astra" },
        synty: { tokenEnv: "SYN", githubUser: "synty-automaton", agent: "codex" },
      });
      expect(defaults["scm"]).toEqual({ plugin: "github", identity: "neo" });
      expect(defaults["worker"]).toEqual({ identity: "neo", agentConfig: { reasoningEffort: "xhigh" } });
      expect(defaults["reviewer"]).toEqual({ identity: "tri", agentConfig: { sandbox: "danger-full-access" }, enabled: false });
      expect(defaults["orchestrator"]).toEqual({ identity: "synty" });
      expect(projects["one"]!["worker"]).toBeUndefined();
      expect(projects["two"]!["worker"]).toEqual({ agentConfig: { reasoningEffort: "high" } });
      expect(changes).toEqual(
        expect.arrayContaining([
          "defaults.scm: githubUser neo-automaton → identity neo",
          "defaults.worker: githubUser neo-automaton → identity neo",
          "identities.neo.agent: hoisted from defaults.worker",
          "defaults.worker.agent: removed (identity neo provides it)",
          "identities.tri.model: hoisted from defaults.reviewer",
        ]),
      );
      expect(diffEffectiveProjects(doc, normalized)).toEqual([]);
    });

    it("keeps a defaults value in place when a project with another identity inherits it", () => {
      const doc = {
        identities,
        defaults: { worker: { identity: "neo", agent: "codex", agentConfig: { model: "gpt-6-astra" } } },
        projects: {
          one: plain("one"),
          other: plain("other", { worker: { identity: "tri" } }),
        },
      };
      const { normalized } = normalizeConfigDocument(doc);
      const defaults = normalized["defaults"] as Record<string, unknown>;
      // `other` runs as tri but takes agent/model from defaults.worker; moving
      // them into neo would change what `other` runs with.
      expect(normalized["identities"]).toEqual(identities);
      expect(defaults["worker"]).toEqual({ identity: "neo", agent: "codex", agentConfig: { model: "gpt-6-astra" } });
      expect(diffEffectiveProjects(doc, normalized)).toEqual([]);
    });

    it("leaves unknown logins, conflicting values and opted-out documents alone", () => {
      const doc = {
        identities: { ...identities, neo: { ...identities.neo, model: "other-model" } },
        defaults: { worker: { githubUser: "ghost" }, reviewer: { githubUser: "neo-automaton", agentConfig: { model: "gpt-6-astra" } } },
        projects: { one: plain("one") },
      };
      const { normalized, changes } = normalizeConfigDocument(doc);
      const defaults = normalized["defaults"] as Record<string, unknown>;
      expect(defaults["worker"]).toEqual({ githubUser: "ghost" });
      expect(defaults["reviewer"]).toEqual({ identity: "neo", agentConfig: { model: "gpt-6-astra" } });
      expect(changes).toContain("defaults.reviewer: githubUser neo-automaton → identity neo");

      const kept = normalizeConfigDocument(
        { identities, defaults: { worker: { githubUser: "neo-automaton", agent: "codex" } }, projects: { one: plain("one") } },
        { identityProfiles: false },
      ).normalized;
      expect((kept["defaults"] as Record<string, unknown>)["worker"]).toEqual({ githubUser: "neo-automaton", agent: "codex" });
    });
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
