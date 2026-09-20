/**
 * Fork: `~` resolution follows process.env.HOME.
 *
 * vitest runs every test file in a worker thread, where `process.env.HOME` is
 * thread-local and `os.homedir()` (libuv, real process env) keeps returning the
 * developer's home — so a test that points HOME at a temp dir used to write
 * into `~/.agent-orchestrator` for real.
 */
import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, getAoBaseDir, resolveHomeDir } from "../src/paths.js";

const savedHome = process.env["HOME"];
afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
});

describe("resolveHomeDir", () => {
  it("prefers process.env.HOME over os.homedir()", () => {
    process.env["HOME"] = "/tmp/ao-home-probe";
    expect(resolveHomeDir()).toBe("/tmp/ao-home-probe");
    expect(expandHome("~/.agent-orchestrator")).toBe("/tmp/ao-home-probe/.agent-orchestrator");
    expect(getAoBaseDir()).toBe(join("/tmp/ao-home-probe", ".agent-orchestrator"));
  });

  it("falls back to os.homedir() when HOME is unset or blank, and leaves other paths alone", () => {
    delete process.env["HOME"];
    expect(resolveHomeDir()).toBe(process.env["USERPROFILE"]?.trim() || homedir());
    process.env["HOME"] = "   ";
    expect(resolveHomeDir()).toBe(process.env["USERPROFILE"]?.trim() || homedir());
    expect(expandHome("/etc/ao.yaml")).toBe("/etc/ao.yaml");
    expect(expandHome("~notauser/x")).toBe("~notauser/x");
  });
});
