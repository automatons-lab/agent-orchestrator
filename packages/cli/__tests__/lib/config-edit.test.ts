/** Fork: config-file editing primitives used by `ao project|agent|identity`. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentProfileReferences,
  applySetUnset,
  deletePath,
  documentToJS,
  hasPath,
  identityReferences,
  openConfigDocument,
  parseConfigDocument,
  parseKeyPath,
  parseScalarOrRaw,
  parseSetArgument,
  renderDocument,
  setPath,
  validateRendered,
  writeConfigDocument,
} from "../../src/lib/config-edit.js";
import { FIXTURE } from "../fixtures/config-edit-fixture.js";


let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ao-config-edit-"));
  file = join(dir, "config-multi-projects.yaml");
  writeFileSync(file, FIXTURE, "utf-8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("--set parsing", () => {
  it("splits the dotted key and YAML-parses the value, keeping odd strings raw", () => {
    expect(parseSetArgument("reviewer.timeoutMinutes=30")).toEqual({ path: ["reviewer", "timeoutMinutes"], value: 30 });
    expect(parseSetArgument("reviewer.enabled=true")).toEqual({ path: ["reviewer", "enabled"], value: true });
    expect(parseSetArgument("reviewers=[a, b]")).toEqual({ path: ["reviewers"], value: ["a", "b"] });
    expect(parseSetArgument("repo=org/name")).toEqual({ path: ["repo"], value: "org/name" });
    expect(parseSetArgument('branchNameTemplate="{issue}.{slug}"')).toEqual({ path: ["branchNameTemplate"], value: "{issue}.{slug}" });
    expect(parseScalarOrRaw("{issue}.{slug}")).toBe("{issue}.{slug}");
    expect(parseScalarOrRaw("main")).toBe("main");
    expect(() => parseSetArgument("novalue")).toThrow(/expects <key.path>=<value>/);
    expect(() => parseSetArgument("key=")).toThrow(/empty value/);
    expect(() => parseKeyPath("a..b")).toThrow(/Invalid key path/);
  });
});

describe("document edits", () => {
  it("set, has, delete and render while keeping comments and key order", () => {
    const { doc } = openConfigDocument(file);
    expect(hasPath(doc, ["projects", "app"])).toBe(true);
    setPath(doc, ["projects", "web", "repo"], "org/web");
    setPath(doc, ["projects", "web", "reviewer", "enabled"], true);
    setPath(doc, ["projects", "app", "reviewers"], ["trinity-automaton"]);
    expect(deletePath(doc, ["projects", "app", "sessionPrefix"])).toBe(true);
    expect(deletePath(doc, ["projects", "app", "missing"])).toBe(false);
    const text = renderDocument(doc);
    expect(text).toContain("# live config");
    expect(text).toContain("# the first project");
    expect(text.indexOf("agents:")).toBeLessThan(text.indexOf("identities:"));
    const js = documentToJS(parseConfigDocument(text));
    const projects = js["projects"] as Record<string, Record<string, unknown>>;
    expect(projects["web"]).toEqual({ repo: "org/web", reviewer: { enabled: true } });
    expect(projects["app"]!["sessionPrefix"]).toBeUndefined();
    expect(projects["app"]!["reviewers"]).toEqual(["trinity-automaton"]);
  });

  it("applies --set/--unset under a base path", () => {
    const { doc } = openConfigDocument(file);
    const messages = applySetUnset(doc, ["projects", "app"], ["reviewer.timeoutMinutes=40", "postCreate=[npm ci]"], ["name", "nope"]);
    expect(messages).toEqual([
      'projects.app.reviewer.timeoutMinutes = 40',
      'projects.app.postCreate = ["npm ci"]',
      "projects.app.name: removed",
      "projects.app.nope: not set (nothing to remove)",
    ]);
  });
});

describe("validation and writing", () => {
  it("validates through the real loader and reports effective inheritance", () => {
    const { doc } = openConfigDocument(file);
    setPath(doc, ["projects", "web"], { repo: "org/web", path: "/repos/web", sessionPrefix: "web" });
    const loaded = validateRendered(renderDocument(doc), file);
    const web = loaded.projects["web"]!;
    expect(web.worker?.identity).toBe("neo");
    expect(web.worker?.agentProfile).toBe("codex-coder");
    expect(web.branchNameTemplate).toBe("{issue}.{slug}");
    expect(readdirSync(dir)).toEqual(["config-multi-projects.yaml"]); // probe file removed
  });

  it("rejects an unknown identity reference and leaves no probe behind", () => {
    const { doc } = openConfigDocument(file);
    setPath(doc, ["projects", "app", "worker", "identity"], "ghost");
    expect(() => validateRendered(renderDocument(doc), file)).toThrow(/unknown identity/);
    expect(readdirSync(dir)).toEqual(["config-multi-projects.yaml"]);
  });

  it("writes with a timestamped backup, or nothing on dry run", () => {
    const cfg = openConfigDocument(file);
    setPath(cfg.doc, ["projects", "app", "name"], "Renamed");
    const dry = writeConfigDocument(cfg, { dryRun: true });
    expect(dry.backupPath).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe(FIXTURE);
    const written = writeConfigDocument(cfg);
    expect(written.backupPath).toMatch(/config-multi-projects\.yaml\.bak-\d{4}-/);
    expect(readFileSync(written.backupPath!, "utf-8")).toBe(FIXTURE);
    expect(readFileSync(file, "utf-8")).toContain("name: Renamed");
  });
});

describe("reference checks", () => {
  it("finds agent profile and identity references", () => {
    const { doc } = openConfigDocument(file);
    setPath(doc, ["projects", "app", "reviewer", "agent"], "codex-reviewer");
    setPath(doc, ["projects", "app", "worker", "githubUser"], "neo-automaton");
    const cfg = documentToJS(doc);
    expect(agentProfileReferences(cfg, "codex-reviewer")).toEqual(["identities.trinity.agent", "projects.app.reviewer.agent"]);
    expect(agentProfileReferences(cfg, "unused")).toEqual([]);
    expect(identityReferences(cfg, "neo")).toEqual(["defaults.scm", "defaults.worker", "projects.app.worker"]);
    expect(identityReferences(cfg, "trinity")).toEqual(["defaults.reviewer"]);
  });
});
