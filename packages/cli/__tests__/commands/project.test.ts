import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const {
  mockGetPortfolio,
  mockGetPortfolioSessionCounts,
  mockRegisterProject,
  mockUnregisterProject,
  mockLoadPreferences,
  mockSavePreferences,
  mockLoadLocalProjectConfig,
} = vi.hoisted(() => ({
  mockGetPortfolio: vi.fn(),
  mockGetPortfolioSessionCounts: vi.fn(),
  mockRegisterProject: vi.fn(),
  mockUnregisterProject: vi.fn(),
  mockLoadPreferences: vi.fn(),
  mockSavePreferences: vi.fn(),
  mockLoadLocalProjectConfig: vi.fn(),
}));

// Fork: keep the real config loader so `ao project add|update|rm` validate against a temp file.
vi.mock("@aoagents/ao-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aoagents/ao-core")>()),
  isPortfolioEnabled: () => true,
  getPortfolio: mockGetPortfolio,
  getPortfolioSessionCounts: mockGetPortfolioSessionCounts,
  recordActivityEvent: vi.fn(),
  registerProject: mockRegisterProject,
  unregisterProject: mockUnregisterProject,
  loadPreferences: mockLoadPreferences,
  savePreferences: mockSavePreferences,
  loadLocalProjectConfig: mockLoadLocalProjectConfig,
}));

vi.mock("../../src/lib/portfolio-display.js", () => ({
  formatPortfolioDegradedReason: vi.fn().mockReturnValue(null),
  formatPortfolioProjectName: vi.fn().mockReturnValue(""),
  formatPortfolioProjectStatus: vi.fn().mockReturnValue("idle"),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptConfirm: vi.fn(async () => true),
}));

import { registerProjectCommand } from "../../src/commands/project.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE } from "../fixtures/config-edit-fixture.js";

let program: Command;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let _exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  program = new Command();
  program.exitOverride();
  registerProjectCommand(program);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  _exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as typeof process.exit);
});

describe("ao project ls", () => {
  it("prints message when portfolio is empty", async () => {
    mockGetPortfolio.mockReturnValue([]);

    await program.parseAsync(["node", "ao", "project", "ls"]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No projects in portfolio"));
  });

  it("lists projects with session counts", async () => {
    mockGetPortfolio.mockReturnValue([
      { id: "app-1", name: "App One", source: "/tmp/app-1", pinned: false, enabled: true },
    ]);
    mockGetPortfolioSessionCounts.mockResolvedValue({
      "app-1": { total: 3, active: 1 },
    });
    mockLoadPreferences.mockReturnValue({ defaultProjectId: null });

    await program.parseAsync(["node", "ao", "project", "ls"]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("app-1"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("3 sessions"));
  });

  it("marks default project", async () => {
    mockGetPortfolio.mockReturnValue([
      { id: "app-1", name: "App One", source: "/tmp/app-1", pinned: false, enabled: true },
    ]);
    mockGetPortfolioSessionCounts.mockResolvedValue({
      "app-1": { total: 0, active: 0 },
    });
    mockLoadPreferences.mockReturnValue({ defaultProjectId: "app-1" });

    await program.parseAsync(["node", "ao", "project", "ls"]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("default"));
  });
});

describe("ao project set-default", () => {
  it("sets default project", async () => {
    mockGetPortfolio.mockReturnValue([{ id: "app-1", name: "App One", source: "/tmp/app-1" }]);
    mockLoadPreferences.mockReturnValue({ defaultProjectId: null });

    await program.parseAsync(["node", "ao", "project", "set-default", "app-1"]);

    expect(mockSavePreferences).toHaveBeenCalledWith({ defaultProjectId: "app-1" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Set default"));
  });

  it("exits with error when project not found", async () => {
    mockGetPortfolio.mockReturnValue([]);

    await expect(
      program.parseAsync(["node", "ao", "project", "set-default", "nonexistent"]),
    ).rejects.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });
});

// Fork: file-backed add/update/rm (see project-config.ts).
describe("ao project add/update/rm (config file)", () => {
  let dir: string;
  let file: string;
  const previousPath = process.env["AO_CONFIG_PATH"];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ao-project-cmd-"));
    file = join(dir, "config-multi-projects.yaml");
    writeFileSync(file, FIXTURE, "utf-8");
    process.env["AO_CONFIG_PATH"] = file;
  });
  afterEach(() => {
    if (previousPath === undefined) delete process.env["AO_CONFIG_PATH"];
    else process.env["AO_CONFIG_PATH"] = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
  const lastJson = (): Record<string, unknown> => {
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    return JSON.parse(calls[calls.length - 1]!) as Record<string, unknown>;
  };

  it("add --dry-run validates and prints JSON without writing", async () => {
    await program.parseAsync(["node", "ao", "project", "add", "web", "--repo", "org/web", "--worker-agent", "codex-reviewer", "--dry-run", "--json"]);
    const out = lastJson();
    expect(out["ok"]).toBe(true);
    expect(out["dryRun"]).toBe(true);
    expect(out["changes"]).toContain('projects.web.repo = "org/web"');
    expect((out["effective"] as Record<string, unknown>)["worker"]).toMatchObject({ identity: "neo", agentProfile: "codex-reviewer" });
    expect(readFileSync(file, "utf-8")).toBe(FIXTURE);
  });

  it("add, update and rm write the file with a backup", async () => {
    await program.parseAsync(["node", "ao", "project", "add", "web", "--repo", "org/web", "--path", "/repos/web"]);
    expect(readFileSync(file, "utf-8")).toContain("  web:\n    name: web\n    path: /repos/web\n    repo: org/web\n");
    await program.parseAsync(["node", "ao", "project", "update", "web", "--reviewer-enabled", "--set", "reviewer.timeoutMinutes=40"]);
    expect(readFileSync(file, "utf-8")).toContain("    reviewer:\n      enabled: true\n      timeoutMinutes: 40\n");
    await program.parseAsync(["node", "ao", "project", "rm", "web"]);
    expect(readFileSync(file, "utf-8")).not.toContain("web:");
    expect(readdirSync(dir).filter((f) => f.includes(".bak-"))).toHaveLength(3);
  });

  it("refuses an unknown project and an invalid reference, leaving the file untouched", async () => {
    await expect(program.parseAsync(["node", "ao", "project", "rm", "nope"])).rejects.toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('unknown project "nope"'))).toBe(true);
    await expect(program.parseAsync(["node", "ao", "project", "update", "app", "--worker-identity", "ghost"])).rejects.toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('unknown identity "ghost"'))).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe(FIXTURE);
  });
});
