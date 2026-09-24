import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "./index.js";

describe("claude-code preLaunchSetup", () => {
  let dir: string;
  let workspace: string;
  const savedHome = process.env["HOME"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ao-claude-prelaunch-"));
    workspace = join(dir, "clones", "proj", "proj-1");
    mkdirSync(workspace, { recursive: true });
    process.env["HOME"] = dir;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("trusts the workspace in ~/.claude.json", async () => {
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ numStartups: 1 }));

    await create().preLaunchSetup!(workspace);

    expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8"))).toEqual({
      numStartups: 1,
      projects: { [workspace]: { hasTrustDialogAccepted: true } },
    });
  });

  it("warns instead of failing the spawn when the workspace is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(create().preLaunchSetup!(join(dir, "missing"))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not trust"));
  });
});
