/** Fork: observability directory layout (`observability/<hash>`), env override, legacy move. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateConfigHash, getLegacyObservabilityBaseDir, getObservabilityBaseDir } from "../paths.js";
import { migrateLegacyObservabilityDir } from "../observability.js";

let home: string;
let configPath: string;
const savedHome = process.env["HOME"];
const savedOverride = process.env["AO_OBSERVABILITY_DIR"];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ao-obs-home-"));
  process.env["HOME"] = home;
  delete process.env["AO_OBSERVABILITY_DIR"];
  configPath = join(home, "config-multi-projects.yaml");
  writeFileSync(configPath, "projects: {}\n", "utf-8");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  if (savedOverride === undefined) delete process.env["AO_OBSERVABILITY_DIR"];
  else process.env["AO_OBSERVABILITY_DIR"] = savedOverride;
  rmSync(home, { recursive: true, force: true });
});

describe("observability directory", () => {
  it("lives under ~/.agent-orchestrator/observability/<hash> by default", () => {
    const hash = generateConfigHash(configPath);
    expect(getObservabilityBaseDir(configPath)).toBe(join(home, ".agent-orchestrator", "observability", hash));
    expect(getLegacyObservabilityBaseDir(configPath)).toBe(join(home, ".agent-orchestrator", `${hash}-observability`));
  });

  it("honours AO_OBSERVABILITY_DIR (with ~ expansion)", () => {
    const hash = generateConfigHash(configPath);
    process.env["AO_OBSERVABILITY_DIR"] = join(home, "elsewhere");
    expect(getObservabilityBaseDir(configPath)).toBe(join(home, "elsewhere", hash));
    process.env["AO_OBSERVABILITY_DIR"] = "~/tilde";
    expect(getObservabilityBaseDir(configPath)).toBe(join(home, "tilde", hash));
    process.env["AO_OBSERVABILITY_DIR"] = "   ";
    expect(getObservabilityBaseDir(configPath)).toBe(join(home, ".agent-orchestrator", "observability", hash));
  });

  it("moves a legacy <hash>-observability directory once, and never under an override", () => {
    const legacy = getLegacyObservabilityBaseDir(configPath);
    mkdirSync(join(legacy, "processes"), { recursive: true });
    writeFileSync(join(legacy, "processes", "lifecycle-manager-1.ndjson"), "{}\n", "utf-8");

    process.env["AO_OBSERVABILITY_DIR"] = join(home, "elsewhere");
    expect(migrateLegacyObservabilityDir(configPath)).toBe(false);
    expect(existsSync(legacy)).toBe(true);
    delete process.env["AO_OBSERVABILITY_DIR"];

    const base = getObservabilityBaseDir(configPath);
    expect(migrateLegacyObservabilityDir(configPath)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readdirSync(join(base, "processes"))).toEqual(["lifecycle-manager-1.ndjson"]);
    expect(readdirSync(join(home, ".agent-orchestrator"))).toEqual(["observability"]);
    // Nothing left to move; an existing new directory is never overwritten.
    expect(migrateLegacyObservabilityDir(configPath)).toBe(false);
    mkdirSync(legacy, { recursive: true });
    expect(migrateLegacyObservabilityDir(configPath)).toBe(false);
    expect(existsSync(legacy)).toBe(true);
  });
});
