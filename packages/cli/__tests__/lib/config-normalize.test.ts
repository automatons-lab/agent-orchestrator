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
    // No agents: are declared, so agent settings stay on the role blocks and the
    // generic hoist collects what every project repeats; reasoningEffort differs
    // (xhigh vs high) and stays per project.
    expect(normalized["identities"]).toEqual({ neo: { tokenEnv: "NEO_TOKEN" }, trinity: { tokenEnv: "TRI_TOKEN" } });
    expect(defaults["worker"]).toEqual({
      identity: "neo",
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
        "defaults.worker: githubUser neo → identity neo",
        "projects.two.worker: kept only overrides",
      ]),
    );
  });

  describe("identity and agent profiles", () => {
    const identities = {
      neo: { tokenEnv: "NEO", githubUser: "neo-automaton" },
      tri: { tokenEnv: "TRI", githubUser: "trinity-automaton" },
      synty: { tokenEnv: "SYN", githubUser: "synty-automaton" },
    };
    const agents = {
      "codex-coder": { plugin: "codex", model: "gpt-6-astra", reasoningEffort: "xhigh", permissions: "permissionless" },
      "codex-reviewer": { plugin: "codex", model: "gpt-6-astra", reasoningEffort: "xhigh", sandbox: "danger-full-access" },
      "codex-orchestrator": { plugin: "codex" },
    };
    const plain = (id: string, extra: Record<string, unknown> = {}) => ({
      path: `/repos/${id}`,
      repo: `org/${id}`,
      defaultBranch: "main",
      sessionPrefix: id,
      ...extra,
    });
    const legacyDefaults = () => ({
      scm: { plugin: "github", githubUser: "neo-automaton" },
      worker: {
        githubUser: "neo-automaton",
        agent: "codex",
        agentConfig: { model: "gpt-6-astra", reasoningEffort: "xhigh", permissions: "permissionless" },
      },
      reviewer: {
        githubUser: "trinity-automaton",
        agent: "codex",
        agentConfig: { model: "gpt-6-astra", reasoningEffort: "xhigh", sandbox: "danger-full-access" },
        enabled: false,
      },
      orchestrator: { githubUser: "synty-automaton", agent: "codex" },
    });

    it("rewrites login references to identity keys and points identities at the matching profile", () => {
      const doc = {
        agents,
        identities,
        defaults: legacyDefaults(),
        projects: {
          one: plain("one"),
          two: plain("two", { worker: { agentConfig: { reasoningEffort: "high" } } }),
        },
      };
      const { normalized, changes } = normalizeConfigDocument(doc);
      const defaults = normalized["defaults"] as Record<string, unknown>;
      const projects = normalized["projects"] as Record<string, Record<string, unknown>>;
      expect(normalized["identities"]).toEqual({
        neo: { tokenEnv: "NEO", githubUser: "neo-automaton", agent: "codex-coder" },
        tri: { tokenEnv: "TRI", githubUser: "trinity-automaton", agent: "codex-reviewer" },
        synty: { tokenEnv: "SYN", githubUser: "synty-automaton", agent: "codex-orchestrator" },
      });
      expect(normalized["agents"]).toEqual(agents);
      expect(defaults["scm"]).toEqual({ plugin: "github", identity: "neo" });
      expect(defaults["worker"]).toEqual({ identity: "neo" });
      expect(defaults["reviewer"]).toEqual({ identity: "tri", enabled: false });
      expect(defaults["orchestrator"]).toEqual({ identity: "synty" });
      expect(projects["one"]!["worker"]).toBeUndefined();
      // two's own reasoningEffort stays as an override of the profile.
      expect(projects["two"]!["worker"]).toEqual({ agentConfig: { reasoningEffort: "high" } });
      expect(changes).toEqual(
        expect.arrayContaining([
          "defaults.scm: githubUser neo-automaton → identity neo",
          "defaults.worker: githubUser neo-automaton → identity neo",
          "identities.neo.agent: → codex-coder (matches agents.codex-coder)",
          "defaults.worker.agent: removed (agents.codex-coder provides it)",
          "defaults.worker.agentConfig.reasoningEffort: removed (agents.codex-coder provides it)",
          "identities.tri.agent: → codex-reviewer (matches agents.codex-reviewer)",
          "defaults.reviewer.agentConfig.sandbox: removed (agents.codex-reviewer provides it)",
          "identities.synty.agent: → codex-orchestrator (matches agents.codex-orchestrator)",
        ]),
      );
      expect(diffEffectiveProjects(doc, normalized)).toEqual([]);
      // Idempotent: a second pass finds nothing left to move.
      const again = normalizeConfigDocument(normalized);
      expect(again.changes.filter((c) => c.startsWith("identities.") || c.includes("provides it"))).toEqual([]);
    });

    it("keeps defaults fields in place when a project with another identity inherits them", () => {
      const doc = {
        agents,
        identities,
        defaults: { worker: { identity: "neo", agent: "codex", agentConfig: { model: "gpt-6-astra", reasoningEffort: "xhigh", permissions: "permissionless" } } },
        projects: {
          one: plain("one"),
          other: plain("other", { worker: { identity: "tri" } }),
        },
      };
      const { normalized } = normalizeConfigDocument(doc);
      // `other` runs as tri but takes the agent settings from defaults.worker;
      // moving them into codex-coder behind neo would change what `other` runs with.
      expect(normalized["identities"]).toEqual(identities);
      expect((normalized["defaults"] as Record<string, unknown>)["worker"]).toEqual(doc.defaults.worker);
      expect(diffEffectiveProjects(doc, normalized)).toEqual([]);
    });

    it("leaves blocks alone without a matching profile, with a bare-plugin identity, or when opted out", () => {
      const noMatch = normalizeConfigDocument({
        agents: { "claude-fast": { plugin: "claude-code", model: "opus" } },
        identities,
        defaults: { worker: { githubUser: "neo-automaton", agent: "codex", agentConfig: { model: "gpt-6-astra" } } },
        projects: { one: plain("one") },
      });
      expect(noMatch.normalized["identities"]).toEqual(identities);
      expect((noMatch.normalized["defaults"] as Record<string, unknown>)["worker"]).toEqual({
        identity: "neo",
        agent: "codex",
        agentConfig: { model: "gpt-6-astra" },
      });

      const bare = normalizeConfigDocument({
        agents,
        identities: { ...identities, neo: { ...identities.neo, agent: "codex" } },
        defaults: { worker: { identity: "neo", agentConfig: { model: "gpt-6-astra", reasoningEffort: "xhigh", permissions: "permissionless" } } },
        projects: { one: plain("one") },
      });
      expect((bare.normalized["identities"] as Record<string, unknown>)["neo"]).toEqual({ ...identities.neo, agent: "codex" });
      expect((bare.normalized["defaults"] as Record<string, unknown>)["worker"]).toEqual({
        identity: "neo",
        agentConfig: { model: "gpt-6-astra", reasoningEffort: "xhigh", permissions: "permissionless" },
      });

      const kept = normalizeConfigDocument(
        { agents, identities, defaults: legacyDefaults(), projects: { one: plain("one") } },
        { identityProfiles: false },
      ).normalized;
      expect((kept["defaults"] as Record<string, unknown>)["worker"]).toEqual(legacyDefaults().worker);
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
