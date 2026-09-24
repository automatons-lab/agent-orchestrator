/**
 * Unit tests for updateSharedConfigFileSync — read-modify-write of a config
 * file that an agent CLI also writes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSharedConfigFileSync } from "../shared-config-file.js";

describe("updateSharedConfigFileSync", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ao-shared-config-"));
    file = join(dir, "config.toml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes the current content and writes what the update returns", () => {
    writeFileSync(file, "a = 1\n");
    let seen: string | null = "unset";
    const written = updateSharedConfigFileSync(file, (current) => {
      seen = current;
      return current + "b = 2\n";
    });
    expect(written).toBe(true);
    expect(seen).toBe("a = 1\n");
    expect(readFileSync(file, "utf-8")).toBe("a = 1\nb = 2\n");
  });

  it("passes null for a missing file and creates it", () => {
    const written = updateSharedConfigFileSync(file, (current) => {
      expect(current).toBeNull();
      return "a = 1\n";
    });
    expect(written).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("a = 1\n");
  });

  it("leaves the file untouched when the update returns null or the same text", () => {
    writeFileSync(file, "a = 1\n");
    const before = statSync(file).mtimeMs;
    expect(updateSharedConfigFileSync(file, () => null)).toBe(false);
    expect(updateSharedConfigFileSync(file, (current) => current)).toBe(false);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("keeps the file's permission bits", () => {
    writeFileSync(file, "a = 1\n", { mode: 0o600 });
    updateSharedConfigFileSync(file, (current) => current + "b = 2\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("creates a missing file owner-only", () => {
    updateSharedConfigFileSync(file, () => "a = 1\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("removes its lock and temp files", () => {
    updateSharedConfigFileSync(file, () => "a = 1\n");
    expect(readdirSync(dir)).toEqual(["config.toml"]);
  });

  it("releases the lock when the update throws", () => {
    writeFileSync(file, "a = 1\n");
    expect(() =>
      updateSharedConfigFileSync(file, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${file}.ao-lock`)).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe("a = 1\n");
  });
});
