import assert from "node:assert/strict";
import test from "node:test";
import {
  extractConfiguredReposFromYaml,
  fetchIssues,
  mergeStringLists,
  parseStringArraySetting,
} from "./index.ts";

function makeIssue(number: number, title: string, repo: string) {
  return {
    number,
    title,
    labels: [],
    state: "open",
    assignees: [],
    createdAt: `2026-03-${String(number).padStart(2, "0")}T00:00:00Z`,
    url: `https://github.com/${repo}/issues/${number}`,
  };
}

test("extractConfiguredReposFromYaml reads every project repo", () => {
  const rawYaml = `
port: 3000
projects:
  app:
    repo: acme/app
    path: ~/code/app
  docs:
    repo: "acme/docs" # keep quoted repos working
    path: ~/code/docs
notifiers:
  openclaw:
    plugin: openclaw
`;

  assert.deepEqual(extractConfiguredReposFromYaml(rawYaml), ["acme/app", "acme/docs"]);
});

test("fetchIssues queries every configured repo when repo is omitted", async () => {
  const ghCalls: string[] = [];
  const result = await fetchIssues(
    { aoCwd: "/tmp/work" },
    {},
    {
      getConfiguredRepos: () => ["acme/app", "acme/docs"],
      runGh: async (_config, args) => {
        const repoIndex = args.indexOf("-R");
        const repo = repoIndex >= 0 ? args[repoIndex + 1] : "default";
        ghCalls.push(repo);

        if (repo === "acme/app") {
          return { ok: true, output: JSON.stringify([makeIssue(1, "App bug", repo)]) };
        }
        if (repo === "acme/docs") {
          return { ok: true, output: JSON.stringify([makeIssue(2, "Docs bug", repo)]) };
        }

        return { ok: false, error: `unexpected repo: ${repo}` };
      },
    },
  );

  assert.deepEqual(ghCalls, ["acme/app", "acme/docs"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.scannedRepos, ["acme/app", "acme/docs"]);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(
    result.issues.map((issue) => issue.repository),
    ["acme/docs", "acme/app"],
  );
});

test("fetchIssues surfaces GitHub failures instead of reporting an empty board", async () => {
  const result = await fetchIssues(
    { aoCwd: "/tmp/work" },
    {},
    {
      getConfiguredRepos: () => ["acme/app"],
      runGh: async () => ({ ok: false, error: "gh auth token missing" }),
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /gh auth token missing/);
});

test("fetchIssues keeps partial failures visible when at least one repo succeeds", async () => {
  const result = await fetchIssues(
    { aoCwd: "/tmp/work" },
    {},
    {
      getConfiguredRepos: () => ["acme/app", "acme/docs"],
      runGh: async (_config, args) => {
        const repoIndex = args.indexOf("-R");
        const repo = repoIndex >= 0 ? args[repoIndex + 1] : "default";
        if (repo === "acme/app") {
          return { ok: true, output: JSON.stringify([makeIssue(3, "App bug", repo)]) };
        }
        return { ok: false, error: "gh not authenticated for docs repo" };
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.warnings, ["acme/docs: gh not authenticated for docs repo"]);
});

test("allowlist helpers preserve existing entries while adding AO requirements", () => {
  assert.deepEqual(mergeStringLists(["custom:tools", "group:plugins"], ["group:plugins"]), [
    "custom:tools",
    "group:plugins",
  ]);
  assert.deepEqual(parseStringArraySetting('["group:plugins","custom:tools"]'), [
    "group:plugins",
    "custom:tools",
  ]);
  assert.deepEqual(parseStringArraySetting("null"), []);
});

test("buildConfigEntityArgs maps tool params to ao CLI flags and always asks for JSON", async () => {
  const { buildConfigEntityArgs } = await import("./index.ts");
  assert.deepEqual(
    buildConfigEntityArgs("project", "add", {
      id: "my-service",
      repo: "org/my-service",
      workerAgent: "claude-coder",
      reviewerEnabled: true,
      postCreate: ["npm ci", "--rm -rf /"],
      clone: true,
      set: { "reviewer.timeoutMinutes": 30, reviewers: ["a", "b"], "reviewer.postMode": "dry-run" },
      dryRun: true,
    }),
    [
      "project", "add", "my-service",
      "--repo", "org/my-service",
      "--worker-agent", "claude-coder",
      "--reviewer-enabled",
      "--post-create", "npm ci",
      "--post-create", "rm -rf /",
      "--clone",
      "--set", 'reviewer.timeoutMinutes=30',
      "--set", 'reviewers=["a","b"]',
      "--set", 'reviewer.postMode="dry-run"',
      "--dry-run",
      "--json",
    ],
  );
  assert.deepEqual(
    buildConfigEntityArgs("project", "update", { id: "app", reviewerEnabled: false, unset: ["name", "--path"], clone: true }),
    ["project", "update", "app", "--no-reviewer-enabled", "--unset", "name", "--unset", "path", "--json"],
  );
  assert.deepEqual(
    buildConfigEntityArgs("agent", "add", { id: "claude-coder", plugin: "claude-code", model: "claude-opus-5", reasoningEffort: "high", permissions: "permissionless" }),
    ["agent", "add", "claude-coder", "--plugin", "claude-code", "--model", "claude-opus-5", "--reasoning-effort", "high", "--permissions", "permissionless", "--json"],
  );
  assert.deepEqual(
    buildConfigEntityArgs("identity", "rm", { id: "--neo", force: true }),
    ["identity", "rm", "neo", "--force", "--json"],
  );
  assert.deepEqual(
    buildConfigEntityArgs("identity", "add", { id: "neo", tokenEnv: "NEO_GITHUB_TOKEN", tokenSecret: "projects/1/secrets/github-token-neo", agent: "codex-coder", email: "" }),
    ["identity", "add", "neo", "--token-env", "NEO_GITHUB_TOKEN", "--token-secret", "projects/1/secrets/github-token-neo", "--agent", "codex-coder", "--json"],
  );
  assert.throws(() => buildConfigEntityArgs("project", "rm", {}), /id is required/);
});

test("buildDefaultsArgs builds ao defaults set/unset calls and always asks for JSON", async () => {
  const { buildDefaultsArgs } = await import("./index.ts");
  assert.deepEqual(
    buildDefaultsArgs({ key: "reviewer.enabled", value: "true", unset: ["--reviewer.postMode", "worker.agentConfig"], dryRun: true }),
    ["defaults", "set", "reviewer.enabled", "true", "--unset", "reviewer.postMode", "--unset", "worker.agentConfig", "--dry-run", "--json"],
  );
  assert.deepEqual(buildDefaultsArgs({ key: "reviewer.timeoutMinutes", value: 25 }), ["defaults", "set", "reviewer.timeoutMinutes", "25", "--json"]);
  assert.deepEqual(buildDefaultsArgs({ unset: ["branchNameTemplate", "reviewer.rulesFile"] }), ["defaults", "unset", "branchNameTemplate", "--unset", "reviewer.rulesFile", "--json"]);
  assert.throws(() => buildDefaultsArgs({ key: "reviewer.enabled" }), /pass key \+ value/);
  assert.throws(() => buildDefaultsArgs({ key: "x", unset: ["y"] }), /pass value together with key/);
  assert.throws(() => buildDefaultsArgs({ key: "x", value: "-1" }), /must not start with/);
  assert.throws(() => buildDefaultsArgs({}), /pass key \+ value/);
});
