import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustClaudeWorkspace, withClaudeWorkspaceTrust } from "./workspace-trust.js";

const json = (value: unknown) => JSON.stringify(value, null, 2);

describe("withClaudeWorkspaceTrust", () => {
  const none = () => false;

  it("adds the documented trust key and keeps everything else", () => {
    const state = json({ numStartups: 3, projects: { "/home/a": { allowedTools: ["x"] } } });
    expect(withClaudeWorkspaceTrust(state, "/c/p/s1", none)).toBe(
      json({
        numStartups: 3,
        projects: {
          "/home/a": { allowedTools: ["x"] },
          "/c/p/s1": { hasTrustDialogAccepted: true },
        },
      }),
    );
  });

  it("keeps an existing entry's other fields", () => {
    const state = json({ projects: { "/c/p/s1": { lastCost: 1, hasTrustDialogAccepted: false } } });
    expect(JSON.parse(withClaudeWorkspaceTrust(state, "/c/p/s1", none)!)).toEqual({
      projects: { "/c/p/s1": { lastCost: 1, hasTrustDialogAccepted: true } },
    });
  });

  it("creates the projects map when it is missing", () => {
    expect(JSON.parse(withClaudeWorkspaceTrust(json({}), "/c/p/s1", none)!)).toEqual({
      projects: { "/c/p/s1": { hasTrustDialogAccepted: true } },
    });
  });

  it("changes nothing when the workspace is already trusted", () => {
    const state = json({ projects: { "/c/p/s1": { hasTrustDialogAccepted: true } } });
    expect(withClaudeWorkspaceTrust(state, "/c/p/s1", none)).toBeNull();
  });

  it("removes entries of sibling workspaces that no longer exist, and only those", () => {
    const state = json({
      projects: {
        "/c/p/gone": { hasTrustDialogAccepted: false },
        "/c/p/live": { hasTrustDialogAccepted: false },
        "/elsewhere/gone": {},
      },
    });
    const exists = (path: string) => path === "/c/p/live";
    expect(
      Object.keys(JSON.parse(withClaudeWorkspaceTrust(state, "/c/p/new", exists)!).projects),
    ).toEqual(["/c/p/live", "/elsewhere/gone", "/c/p/new"]);
  });

  it("leaves a missing or unreadable state file alone", () => {
    expect(withClaudeWorkspaceTrust(null, "/c/p/s1", none)).toBeNull();
    expect(withClaudeWorkspaceTrust("{ not json", "/c/p/s1", none)).toBeNull();
    expect(withClaudeWorkspaceTrust("[]", "/c/p/s1", none)).toBeNull();
  });
});

describe("trustClaudeWorkspace", () => {
  let dir: string;
  let statePath: string;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ao-claude-trust-"));
    statePath = join(dir, ".claude.json");
    workspace = join(dir, "clones", "proj", "proj-2");
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the entry, prunes a deleted sibling and keeps the file owner-only", () => {
    const gone = join(dir, "clones", "proj", "proj-1");
    writeFileSync(statePath, json({ projects: { [gone]: {} } }), { mode: 0o600 });

    trustClaudeWorkspace(workspace, statePath);

    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual({
      projects: { [workspace]: { hasTrustDialogAccepted: true } },
    });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("does not create the state file", () => {
    trustClaudeWorkspace(workspace, statePath);
    expect(() => statSync(statePath)).toThrow();
  });
});
