import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "./index.js";

describe("codex preLaunchSetup", () => {
  let dir: string;
  let workspace: string;
  const savedCodexHome = process.env["CODEX_HOME"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ao-codex-prelaunch-"));
    workspace = join(dir, "clones", "proj", "proj-1");
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = savedCodexHome;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("trusts the workspace in $CODEX_HOME/config.toml", async () => {
    process.env["CODEX_HOME"] = join(dir, "codex-home");
    mkdirSync(process.env["CODEX_HOME"]);

    await create().preLaunchSetup!(workspace);

    expect(readFileSync(join(dir, "codex-home", "config.toml"), "utf-8")).toBe(
      `[projects."${workspace}"]\ntrust_level = "trusted"\n`,
    );
  });

  it("warns instead of failing the spawn when the config cannot be written", async () => {
    const notADirectory = join(dir, "file");
    writeFileSync(notADirectory, "");
    process.env["CODEX_HOME"] = notADirectory;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(create().preLaunchSetup!(workspace)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not trust"));
  });
});
