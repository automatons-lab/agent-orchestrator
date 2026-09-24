import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustCodexWorkspace, withCodexWorkspaceTrust } from "./workspace-trust.js";

const block = (path: string) => `[projects."${path}"]\ntrust_level = "trusted"\n`;

describe("withCodexWorkspaceTrust", () => {
  const none = () => false;

  it("creates the entry Codex writes when its trust prompt is answered", () => {
    expect(withCodexWorkspaceTrust(null, "/c/p/s1", none)).toBe(block("/c/p/s1"));
  });

  it("appends to an existing config and keeps the rest byte for byte", () => {
    const config = '# mine\nmodel = "gpt"\n\n[projects."/home/a"]\ntrust_level = "trusted"\n';
    expect(withCodexWorkspaceTrust(config, "/c/p/s1", none)).toBe(`${config}\n${block("/c/p/s1")}`);
  });

  it("separates the entry from a config without a trailing newline", () => {
    expect(withCodexWorkspaceTrust('model = "gpt"', "/c/p/s1", none)).toBe(
      `model = "gpt"\n\n${block("/c/p/s1")}`,
    );
  });

  it("changes nothing when the workspace is already trusted", () => {
    expect(withCodexWorkspaceTrust(block("/c/p/s1"), "/c/p/s1", none)).toBeNull();
  });

  it("removes trust entries of sibling workspaces that no longer exist", () => {
    const config = [
      'model = "gpt"',
      "",
      block("/home/a"),
      block("/c/p/gone"),
      block("/c/p/live"),
    ].join("\n");
    const exists = (path: string) => path === "/c/p/live";
    expect(withCodexWorkspaceTrust(config, "/c/p/new", exists)).toBe(
      ['model = "gpt"', "", block("/home/a"), block("/c/p/live"), block("/c/p/new")].join("\n"),
    );
  });

  it("removes a stale last entry without losing the trailing newline", () => {
    const config = `${block("/c/p/live")}\n${block("/c/p/gone")}`;
    const exists = (path: string) => path === "/c/p/live";
    expect(withCodexWorkspaceTrust(config, "/c/p/live", exists)).toBe(block("/c/p/live"));
  });

  it("keeps missing entries outside the workspace's parent and entries with other keys", () => {
    const custom = '[projects."/c/p/gone2"]\ntrust_level = "trusted"\nnote = "mine"\n';
    const config = `${block("/elsewhere/gone")}\n${custom}`;
    expect(withCodexWorkspaceTrust(config, "/c/p/new", none)).toBe(
      `${config}\n${block("/c/p/new")}`,
    );
  });

  it("does not add a second definition when the path is configured in another form", () => {
    const config = '[projects]\n"/c/p/s1" = { trust_level = "trusted" }\n';
    expect(withCodexWorkspaceTrust(config, "/c/p/s1", none)).toBeNull();
  });

  it("escapes quotes and backslashes in the path", () => {
    expect(withCodexWorkspaceTrust(null, 'C:\\ao\\p "x"', none)).toBe(
      block('C:\\\\ao\\\\p \\"x\\"'),
    );
    expect(
      withCodexWorkspaceTrust(block('C:\\\\ao\\\\p \\"x\\"'), 'C:\\ao\\p "x"', none),
    ).toBeNull();
  });
});

describe("trustCodexWorkspace", () => {
  let dir: string;
  let configPath: string;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ao-codex-trust-"));
    configPath = join(dir, "codex", "config.toml");
    mkdirSync(join(dir, "codex"));
    workspace = join(dir, "clones", "proj", "proj-2");
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the entry once and prunes a deleted sibling clone", () => {
    const gone = join(dir, "clones", "proj", "proj-1");
    writeFileSync(configPath, `model = "gpt"\n\n${block(gone)}`);

    trustCodexWorkspace(workspace, configPath);
    trustCodexWorkspace(workspace, configPath);

    expect(readFileSync(configPath, "utf-8")).toBe(`model = "gpt"\n\n${block(workspace)}`);
  });
});
