import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { updateSharedConfigFileSync } from "@aoagents/ao-core";

// Codex asks "Do you trust the contents of this directory?" before it starts in
// a directory it has no trust entry for, and every AO session gets a fresh
// clone. Until someone answers, the worker sits at that prompt with its task
// undelivered. Writing the entry Codex itself writes on "Yes" skips the prompt.

const TRUST_LINE = 'trust_level = "trusted"';
const PROJECT_HEADER = /^\[projects\."((?:[^"\\]|\\.)*)"\][ \t]*$/;

/** `$CODEX_HOME/config.toml`, by default `~/.codex/config.toml`. */
export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["CODEX_HOME"] || join(homedir(), ".codex"), "config.toml");
}

function escapeBasicString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeBasicString(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

/**
 * Return `config` with `[projects."<workspacePath>"] trust_level = "trusted"`
 * added, and with the same kind of entry removed for sibling workspaces (same
 * parent directory) that no longer exist. Everything else is kept verbatim.
 * Returns null when nothing changes.
 */
export function withCodexWorkspaceTrust(
  config: string | null,
  workspacePath: string,
  pathExists: (path: string) => boolean,
): string | null {
  const lines = (config ?? "").split("\n");
  const siblingsRoot = dirname(workspacePath) + sep;
  const kept: string[] = [];
  let trusted = false;
  let pruned = false;

  for (let i = 0; i < lines.length; ) {
    const header = PROJECT_HEADER.exec(lines[i]);
    if (!header) {
      kept.push(lines[i]);
      i++;
      continue;
    }

    // A table runs until the next table header.
    let end = i + 1;
    while (end < lines.length && !lines[end].trimStart().startsWith("[")) end++;

    const path = unescapeBasicString(header[1]);
    const body = lines
      .slice(i + 1, end)
      .map((line) => line.trim())
      .filter(Boolean);
    if (path === workspacePath) trusted = true;

    const stale =
      path !== workspacePath &&
      path.startsWith(siblingsRoot) &&
      body.length === 1 &&
      body[0] === TRUST_LINE &&
      !pathExists(path);
    if (stale) pruned = true;
    else kept.push(...lines.slice(i, end));
    i = end;
  }

  let text = kept.join("\n");
  const escaped = escapeBasicString(workspacePath);
  // A path configured in some other form must not get a second definition.
  if (!trusted && !text.includes(`"${escaped}"`)) {
    if (text !== "" && !text.endsWith("\n")) text += "\n";
    if (text.trim() !== "") text += "\n";
    text += `[projects."${escaped}"]\n${TRUST_LINE}\n`;
  } else if (!pruned) {
    return null;
  }
  return text === config ? null : text;
}

/** Trust `workspacePath` in the Codex config before Codex starts there. */
export function trustCodexWorkspace(
  workspacePath: string,
  configPath: string = codexConfigPath(),
): void {
  const path = realpathSync(workspacePath);
  updateSharedConfigFileSync(configPath, (current) =>
    withCodexWorkspaceTrust(current, path, existsSync),
  );
}
