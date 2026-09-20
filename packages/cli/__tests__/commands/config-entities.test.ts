/** Fork: `ao project|agent|identity add|update|rm` document edits + validation. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentToJS, openConfigDocument, renderDocument, validateRendered } from "../../src/lib/config-edit.js";
import { applyProjectAdd, applyProjectRemove, applyProjectUpdate, defaultProjectPath } from "../../src/commands/project-config.js";
import {
  applyAgentAdd,
  applyAgentRemove,
  applyAgentUpdate,
  applyIdentityAdd,
  applyIdentityRemove,
  applyIdentityUpdate,
} from "../../src/commands/config-entities.js";
import { FIXTURE } from "../fixtures/config-edit-fixture.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ao-config-entities-"));
  file = join(dir, "config-multi-projects.yaml");
  writeFileSync(file, FIXTURE, "utf-8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function projectsOf(text: string): Record<string, Record<string, unknown>> {
  return documentToJS(openConfigDocumentFromText(text))["projects"] as Record<string, Record<string, unknown>>;
}
function openConfigDocumentFromText(text: string) {
  writeFileSync(file, text, "utf-8");
  return openConfigDocument(file).doc;
}

describe("ao project", () => {
  it("add writes a minimal block with conventions filled in and validates against defaults", () => {
    const { doc } = openConfigDocument(file);
    const messages = applyProjectAdd(doc, "web", { repo: "org/web" });
    expect(messages).toEqual([
      'projects.web.name = "web"',
      `projects.web.path = ${JSON.stringify(defaultProjectPath("web"))}`,
      'projects.web.repo = "org/web"',
      'projects.web.defaultBranch = "main"',
      'projects.web.sessionPrefix = "web"',
    ]);
    const text = renderDocument(doc);
    expect(projectsOf(text)["web"]).toEqual({
      name: "web",
      path: defaultProjectPath("web"),
      repo: "org/web",
      defaultBranch: "main",
      sessionPrefix: "web",
    });
    const loaded = validateRendered(text, file);
    expect(loaded.projects["web"]!.worker?.agentProfile).toBe("codex-coder");
    expect(loaded.projects["web"]!.reviewer?.enabled).toBe(false);
  });

  it("add takes optional overrides, role settings, --set, and refuses duplicates or a missing repo", () => {
    const { doc } = openConfigDocument(file);
    applyProjectAdd(doc, "web", {
      repo: "org/web",
      name: "Web",
      path: "/repos/web",
      workerAgent: "codex-reviewer",
      reviewerEnabled: true,
      reviewerRulesFile: "/rules/web.md",
      reviewers: "trinity-automaton, neo-automaton",
      postCreate: ["npm ci"],
      set: ["reviewer.timeoutMinutes=40"],
    });
    const text = renderDocument(doc);
    expect(projectsOf(text)["web"]).toEqual({
      name: "Web",
      path: "/repos/web",
      repo: "org/web",
      defaultBranch: "main",
      sessionPrefix: "web",
      reviewers: ["trinity-automaton", "neo-automaton"],
      postCreate: ["npm ci"],
      worker: { agent: "codex-reviewer" },
      reviewer: { enabled: true, rulesFile: "/rules/web.md", timeoutMinutes: 40 },
    });
    const loaded = validateRendered(text, file);
    expect(loaded.projects["web"]!.worker?.agentProfile).toBe("codex-reviewer");
    expect(loaded.projects["web"]!.reviewer?.timeoutMinutes).toBe(40);
    expect(() => applyProjectAdd(doc, "web", { repo: "org/web" })).toThrow(/already exists/);
    expect(() => applyProjectAdd(doc, "x", {})).toThrow(/--repo/);
  });

  it("update changes fields, unsets keys and refuses no-ops or unknown ids; validation catches bad references", () => {
    const { doc } = openConfigDocument(file);
    expect(applyProjectUpdate(doc, "app", { reviewerEnabled: false, branchNameTemplate: "feat/{issue}", unset: ["name"] })).toEqual([
      'projects.app.branchNameTemplate = "feat/{issue}"',
      "projects.app.reviewer.enabled = false",
      "projects.app.name: removed",
    ]);
    const text = renderDocument(doc);
    expect(projectsOf(text)["app"]).toEqual({
      path: "/repos/app",
      repo: "org/app",
      defaultBranch: "main",
      sessionPrefix: "app",
      reviewer: { enabled: false },
      branchNameTemplate: "feat/{issue}",
    });
    expect(validateRendered(text, file).projects["app"]!.branchNameTemplate).toBe("feat/{issue}");
    expect(() => applyProjectUpdate(doc, "app", {})).toThrow(/nothing to change/);
    expect(() => applyProjectUpdate(doc, "nope", { name: "x" })).toThrow(/unknown project/);
    applyProjectUpdate(doc, "app", { workerIdentity: "ghost" });
    expect(() => validateRendered(renderDocument(doc), file)).toThrow(/unknown identity/);
  });

  it("rm deletes the block and validates", () => {
    const { doc } = openConfigDocument(file);
    expect(applyProjectRemove(doc, "app")).toEqual(["projects.app: removed (repo clone and session data are left in place)"]);
    const text = renderDocument(doc);
    expect(projectsOf(text)).toEqual({});
    expect(Object.keys(validateRendered(text, file).projects)).toEqual([]);
    expect(() => applyProjectRemove(doc, "app")).toThrow(/unknown project/);
  });
});

describe("ao agent", () => {
  it("add, update and rm with reference protection", () => {
    const { doc } = openConfigDocument(file);
    expect(applyAgentAdd(doc, "claude-coder", { plugin: "claude-code", model: "claude-opus-5", reasoningEffort: "high", permissions: "permissionless" })).toEqual([
      'agents.claude-coder.plugin = "claude-code"',
      'agents.claude-coder.model = "claude-opus-5"',
      'agents.claude-coder.reasoningEffort = "high"',
      'agents.claude-coder.permissions = "permissionless"',
    ]);
    expect(() => applyAgentAdd(doc, "claude-coder", { plugin: "claude-code" })).toThrow(/already exists/);
    expect(() => applyAgentAdd(doc, "x", {})).toThrow(/--plugin/);
    expect(applyAgentUpdate(doc, "claude-coder", { model: "claude-sonnet-5", unset: ["permissions"] })).toEqual([
      'agents.claude-coder.model = "claude-sonnet-5"',
      "agents.claude-coder.permissions: removed",
    ]);
    let loaded = validateRendered(renderDocument(doc), file);
    expect(loaded.agents?.["claude-coder"]).toEqual({ plugin: "claude-code", model: "claude-sonnet-5", reasoningEffort: "high" });

    const cfg = documentToJS(doc);
    expect(() => applyAgentRemove(doc, cfg, "codex-coder")).toThrow(/referenced by identities\.neo\.agent/);
    expect(applyAgentRemove(doc, cfg, "claude-coder")).toEqual(["agents.claude-coder: removed"]);
    expect(applyAgentRemove(doc, cfg, "codex-coder", true)).toEqual(["agents.codex-coder: removed — still referenced by identities.neo.agent"]);
    // With the profile gone the identity's `agent: codex-coder` resolves as a bare plugin name.
    loaded = validateRendered(renderDocument(doc), file);
    expect(loaded.projects["app"]!.worker?.agent).toBe("codex-coder");
    expect(loaded.projects["app"]!.worker?.agentProfile).toBeUndefined();
  });
});

describe("ao identity", () => {
  it("add, update and rm with usage protection", () => {
    const { doc } = openConfigDocument(file);
    expect(applyIdentityAdd(doc, "synty", { tokenEnv: "SYNTY_GITHUB_TOKEN", githubUser: "synty-automaton", tokenSecret: "projects/1/secrets/github-token-synty", agent: "codex-coder" })).toEqual([
      'identities.synty.githubUser = "synty-automaton"',
      'identities.synty.tokenEnv = "SYNTY_GITHUB_TOKEN"',
      'identities.synty.tokenSecret = "projects/1/secrets/github-token-synty"',
      'identities.synty.agent = "codex-coder"',
    ]);
    expect(() => applyIdentityAdd(doc, "synty", { tokenEnv: "X" })).toThrow(/already exists/);
    expect(() => applyIdentityAdd(doc, "x", {})).toThrow(/--token-env/);
    expect(applyIdentityUpdate(doc, "synty", { agent: "codex-reviewer", unset: ["tokenSecret"] })).toEqual([
      'identities.synty.agent = "codex-reviewer"',
      "identities.synty.tokenSecret: removed",
    ]);
    let loaded = validateRendered(renderDocument(doc), file);
    expect(loaded.identities?.["synty"]).toEqual({ githubUser: "synty-automaton", tokenEnv: "SYNTY_GITHUB_TOKEN", agent: "codex-reviewer" });
    // Schema problems surface at validation, not at edit time.
    applyIdentityUpdate(doc, "synty", { tokenSecret: "not-a-secret-name" });
    expect(() => validateRendered(renderDocument(doc), file)).toThrow(/tokenSecret must be projects/);
    applyIdentityUpdate(doc, "synty", { unset: ["tokenSecret"] });

    const cfg = documentToJS(doc);
    expect(() => applyIdentityRemove(doc, cfg, "neo")).toThrow(/used by defaults\.scm, defaults\.worker/);
    expect(applyIdentityRemove(doc, cfg, "synty")).toEqual(["identities.synty: removed"]);
    expect(applyIdentityRemove(doc, cfg, "trinity", true)).toEqual(["identities.trinity: removed — still used by defaults.reviewer"]);
    expect(() => validateRendered(renderDocument(doc), file)).toThrow(/unknown identity/);
    loaded = validateRendered(renderDocument(openConfigDocument(file).doc), file);
    expect(Object.keys(loaded.identities ?? {})).toEqual(["neo", "trinity"]);
  });
});
