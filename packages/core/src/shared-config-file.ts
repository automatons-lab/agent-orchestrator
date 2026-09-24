import { readFileSync, statSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { withFileLockSync } from "./file-lock.js";

/**
 * Read-modify-write a config file that another program — typically an agent
 * CLI — also writes, such as `~/.codex/config.toml` or `~/.claude.json`.
 *
 * AO writers are serialised by a sidecar lock (`<file>.ao-lock`); the file is
 * replaced atomically and keeps its permission bits (owner-only when created).
 * `update` receives the current content (null when the file does not exist)
 * and returns the new content, or null to leave the file untouched.
 *
 * @returns whether the file was written
 */
export function updateSharedConfigFileSync(
  filePath: string,
  update: (current: string | null) => string | null,
): boolean {
  return withFileLockSync(
    `${filePath}.ao-lock`,
    () => {
      let current: string | null = null;
      let mode = 0o600;
      try {
        current = readFileSync(filePath, "utf-8");
        mode = statSync(filePath).mode & 0o777;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      const next = update(current);
      if (next === null || next === current) return false;
      atomicWriteFileSync(filePath, next, mode);
      return true;
    },
    { timeoutMs: 5_000, staleMs: 30_000 },
  );
}
