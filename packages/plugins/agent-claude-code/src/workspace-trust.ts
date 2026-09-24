import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { updateSharedConfigFileSync } from "@aoagents/ao-core";

// An interactive Claude Code session asks "Is this a project you created or one
// you trust?" (default: "No, exit") in a repository it has no trust for, and
// trust in a parent directory does not cover a nested repository. Every AO
// session gets a fresh clone, so the worker would sit at that dialog. The
// documented way to trust a folder ahead of time is
// `projects["<path>"].hasTrustDialogAccepted = true` in ~/.claude.json.
// Claude Code re-reads that file before it writes, so the entry survives
// sessions that were already running.

/** Claude Code's global state file. */
export function claudeStatePath(): string {
  return join(homedir(), ".claude.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return `state` with the workspace trusted and with the project entries of
 * sibling workspaces (same parent directory) that no longer exist removed.
 * Returns null when nothing changes, or when the file is missing or not an
 * object: Claude Code has not been set up there, and AO does not create it.
 */
export function withClaudeWorkspaceTrust(
  state: string | null,
  workspacePath: string,
  pathExists: (path: string) => boolean,
): string | null {
  if (state === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(state);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  const siblingsRoot = dirname(workspacePath) + sep;
  const isStale = (path: string) =>
    path !== workspacePath && path.startsWith(siblingsRoot) && !pathExists(path);
  const current = isRecord(data["projects"]) ? data["projects"] : {};
  const projects = Object.fromEntries(Object.entries(current).filter(([path]) => !isStale(path)));
  data["projects"] = projects;
  let changed = Object.keys(projects).length !== Object.keys(current).length;

  const entry = isRecord(projects[workspacePath]) ? projects[workspacePath] : {};
  if (entry["hasTrustDialogAccepted"] !== true) {
    projects[workspacePath] = { ...entry, hasTrustDialogAccepted: true };
    changed = true;
  }

  return changed ? JSON.stringify(data, null, 2) : null;
}

/** Trust `workspacePath` in Claude Code's state before Claude starts there. */
export function trustClaudeWorkspace(
  workspacePath: string,
  statePath: string = claudeStatePath(),
): void {
  const path = realpathSync(workspacePath);
  updateSharedConfigFileSync(statePath, (current) =>
    withClaudeWorkspaceTrust(current, path, existsSync),
  );
}
