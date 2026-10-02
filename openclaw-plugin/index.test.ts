import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerPlugin, {
  extractConfiguredReposFromYaml,
  fetchIssues,
  mergeStringLists,
  parseStringArraySetting,
} from "./index.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = {
  name: string;
  parameters: { required?: string[] };
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

async function reviewBoundary(t: test.TestContext, stderr?: string) {
  const cwd = await mkdtemp(join(tmpdir(), "ao-openclaw-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const callsPath = join(cwd, "calls.jsonl");
  // Node runs the file named by the CLI subcommand, exercising execFile on
  // every platform without a shell, executable bit, or Node module mocks.
  const cliScript = `
const fs = require("node:fs");
const args = [require("node:path").basename(process.argv[1]), ...process.argv.slice(2)];
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (${JSON.stringify(stderr ?? "")}) {
  console.error(${JSON.stringify(stderr ?? "")});
  process.exit(1);
}
console.log(args.includes("--json") ? JSON.stringify({ sessionId: "app-review-1", kind: "review-only" }) : "Review-only session app-review-1 created.");
`;
  for (const command of ["review", "review-check"]) {
    await writeFile(join(cwd, command), cliScript);
  }
  const tools = new Map<string, RegisteredTool>();
  let command: { handler: (ctx: { args?: string }) => Promise<{ text: string }> } | undefined;
  registerPlugin({
    pluginConfig: {
      aoPath: process.execPath,
      aoCwd: cwd,
      healthPollIntervalMs: 0,
      boardScanIntervalMs: 0,
    },
    logger: { info() {}, warn() {} },
    registerCommand(value) {
      command = value;
    },
    registerTool(value) {
      const tool = value as unknown as RegisteredTool;
      assert.equal(tools.has(tool.name), false, `duplicate tool: ${tool.name}`);
      tools.set(tool.name, tool);
    },
    registerService() {},
  });
  assert.ok(command, "the /ao slash command must be registered");
  return {
    cwd,
    tools,
    command,
    review: () => {
      const tool = tools.get("ao_review");
      assert.ok(tool, "ao_review must be registered");
      return tool;
    },
    calls: async () => {
      try {
        return (await readFile(callsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}

test("plugin tool contracts match all registrations and retain existing tools", async (t) => {
  const boundary = await reviewBoundary(t);
  const manifest = JSON.parse(
    await readFile(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  );
  const existing = [
    "ao_sessions",
    "ao_issues",
    "ao_spawn",
    "ao_batch_spawn",
    "ao_send",
    "ao_kill",
    "ao_doctor",
    "ao_review_check",
    "ao_verify",
    "ao_session_cleanup",
    "ao_session_restore",
    "ao_session_claim_pr",
    "ao_session_list",
    "ao_status",
    "ao_project_add",
    "ao_project_update",
    "ao_project_remove",
    "ao_agent_add",
    "ao_agent_update",
    "ao_agent_remove",
    "ao_agent_list",
    "ao_identity_add",
    "ao_identity_update",
    "ao_identity_remove",
    "ao_identity_list",
    "ao_config_show",
    "ao_defaults_set",
  ];
  assert.deepEqual([...boundary.tools.keys()].sort(), [...existing, "ao_review"].sort());
  assert.deepEqual(manifest.contracts.tools.slice().sort(), [...boundary.tools.keys()].sort());
  assert.deepEqual(boundary.review().parameters.required, ["pr"]);
  assert.match((await boundary.command.handler({ args: "help" })).text, /\/ao review/);
});

test("ao_review registers an existing PR with JSON and supplied project without worker commands", async (t) => {
  const boundary = await reviewBoundary(t);
  const result = await boundary.review().execute("call", { pr: "42", project: "my-app" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    sessionId: "app-review-1",
    kind: "review-only",
  });
  assert.deepEqual(await boundary.calls(), [
    { args: ["review", "42", "--project", "my-app", "--json"], cwd: boundary.cwd },
  ]);
});

test("ao_review accepts a PR URL and lets the CLI resolve an omitted project", async (t) => {
  const boundary = await reviewBoundary(t);
  const pr = "https://github.com/acme/app/pull/42";
  await boundary.review().execute("call", { pr });
  assert.deepEqual(await boundary.calls(), [{ args: ["review", pr, "--json"], cwd: boundary.cwd }]);
});

test("ao_review_check keeps routing worker feedback through review-check", async (t) => {
  const boundary = await reviewBoundary(t);
  const tool = boundary.tools.get("ao_review_check");
  assert.ok(tool);
  await tool.execute("call", { project: "my-app", dryRun: true });
  assert.deepEqual(await boundary.calls(), [
    { args: ["review-check", "my-app", "--dry-run"], cwd: boundary.cwd },
  ]);
});

test("/ao review forwards PR and project as separate arguments with text output", async (t) => {
  const boundary = await reviewBoundary(t);
  const result = await boundary.command.handler({
    args: "review https://github.com/acme/app/pull/42 --project my-app",
  });
  assert.match(result.text, /Review-only session app-review-1 created/);
  await boundary.command.handler({ args: "review 43" });
  assert.deepEqual(await boundary.calls(), [
    {
      args: ["review", "https://github.com/acme/app/pull/42", "--project", "my-app"],
      cwd: boundary.cwd,
    },
    { args: ["review", "43"], cwd: boundary.cwd },
  ]);
});

test("review entry points reject malformed PRs, subcommands and flag injection before executing", async (t) => {
  const boundary = await reviewBoundary(t);
  for (const pr of [
    undefined,
    "",
    "0",
    "-42",
    "--help",
    "run",
    "execute",
    "42 --json",
    "42; touch pwned",
    "9007199254740992",
    "https://github.com/acme/app/issues/42",
    "https://example.com/acme/app/pull/42",
    "https://github.com/acme/app/pull/0",
    "https://github.com/acme/app/pull/42?flag=--help",
    null,
    42,
  ]) {
    const result = await boundary.review().execute("call", { pr });
    assert.equal(result.isError, true, `invalid PR accepted: ${String(pr)}`);
    assert.match(result.content[0].text, /PR/);
  }
  for (const project of ["", "--help", "a b", "app;touch", "app/42", null, 42]) {
    const result = await boundary.review().execute("call", { pr: "42", project });
    assert.equal(result.isError, true, `invalid project accepted: ${String(project)}`);
    assert.match(result.content[0].text, /project/i);
  }
  for (const args of [
    "review",
    "review run",
    "review --help",
    "review 42 --project",
    "review 42 --project --help",
    "review 42 --project app --json",
    "review 42 app",
    "review 42 --agent codex",
  ]) {
    const result = await boundary.command.handler({ args });
    assert.match(result.text, /Usage|Invalid/i, `invalid slash input accepted: ${args}`);
  }
  assert.deepEqual(await boundary.calls(), []);
});

test("review entry points retain useful CLI failures including reviewer-disabled errors", async (t) => {
  const boundary = await reviewBoundary(
    t,
    "Native reviewer is disabled for project my-app. Enable reviewer.enabled first.",
  );
  const toolResult = await boundary.review().execute("call", { pr: "42", project: "my-app" });
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /Native reviewer is disabled/);
  assert.match(toolResult.content[0].text, /reviewer.enabled/);
  const slashResult = await boundary.command.handler({ args: "review 42 --project my-app" });
  assert.match(slashResult.text, /Native reviewer is disabled/);
  assert.equal((await boundary.calls()).length, 2);
});

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
