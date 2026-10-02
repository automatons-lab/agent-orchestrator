import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type * as NodeOs from "node:os";
import { join, resolve } from "node:path";
import { setupPathWrapperWorkspace } from "../agent-workspace-hooks.js";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => state.home,
}));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

describe("workspace metadata Git exclusion", () => {
  let root: string;
  let source: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ao git exclusion "));
    state.home = join(root, "home");
    source = join(root, "source");
    await mkdir(source);
    git(source, "init", "--initial-branch=main");
    await writeFile(join(source, "README.md"), "tracked content\n");
    await writeFile(join(root, "empty-excludes"), "");
    git(source, "config", "core.excludesFile", join(root, "empty-excludes"));
    git(source, "add", "README.md");
    git(
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "initial",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(["clone", "worktree"])(
    "keeps a %s clean and excludes metadata from git add",
    async (kind) => {
      const workspace = join(root, kind);
      if (kind === "clone") {
        git(source, "clone", "--local", source, workspace);
        git(workspace, "config", "core.excludesFile", join(root, "empty-excludes"));
      } else {
        git(source, "worktree", "add", "-b", "worker", workspace);
      }
      const excludePath = resolve(
        workspace,
        git(workspace, "rev-parse", "--git-path", "info/exclude"),
      );
      const original = "# Preserve local rules\nscratch/";
      await writeFile(excludePath, original);

      await setupPathWrapperWorkspace(workspace);

      expect(await readFile(join(workspace, ".ao", "AGENTS.md"), "utf8")).toContain(
        "Agent Orchestrator",
      );
      expect(git(workspace, "status", "--porcelain")).toBe("");
      git(workspace, "add", "-A");
      expect(git(workspace, "diff", "--cached", "--name-only")).toBe("");
      git(workspace, "checkout", "-b", "claimed-pr");
      expect(git(workspace, "branch", "--show-current")).toBe("claimed-pr");

      await setupPathWrapperWorkspace(workspace);

      expect(await readFile(excludePath, "utf8")).toBe(`${original}\n.ao/\n`);
      if (kind === "worktree") {
        expect(excludePath).toBe(
          resolve(source, git(source, "rev-parse", "--git-path", "info/exclude")),
        );
      }
      await writeFile(join(workspace, "README.md"), "real user changes\n");
      expect(git(workspace, "status", "--porcelain")).toBe("M README.md");
    },
  );

  it("preserves an existing CRLF rule without adding a duplicate", async () => {
    const excludePath = join(source, ".git", "info", "exclude");
    const original = "# Local rules\r\n.ao/\r\nscratch/\r\n";
    await writeFile(excludePath, original);
    await setupPathWrapperWorkspace(source);
    expect(await readFile(excludePath, "utf8")).toBe(original);
  });
});
