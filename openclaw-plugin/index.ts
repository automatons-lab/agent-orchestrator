/**
 * OpenClaw Plugin: Agent Orchestrator v0.3.0
 *
 * Open-source, pluggable agentic coding orchestrator. Manages durable coding
 * agents (Claude Code, Codex, OpenCode) and wires up feedback loops so PR
 * reviews and CI failures automatically route to the right agent.
 *
 * Provides:
 * - Hook: injects live repo data into AI context for work-related messages
 * - Slash command: /ao (with subcommands)
 * - 14 agent tools: ao_sessions, ao_session_list, ao_status, ao_issues,
 *   ao_spawn, ao_batch_spawn, ao_send, ao_kill, ao_doctor, ao_review_check,
 *   ao_verify, ao_session_cleanup, ao_session_restore, ao_session_claim_pr
 * - Background services: health monitoring + issue board scanner + auto follow-up
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginConfig {
  aoPath?: string;
  aoCwd?: string;
  ghPath?: string;
  healthPollIntervalMs?: number;
  boardScanIntervalMs?: number;
}

/** Minimal shape of the OpenClaw plugin API passed to the default export. */
interface PluginApi {
  pluginConfig?: PluginConfig;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  on?: (
    name: string,
    handler: (event: PluginEvent) => Promise<void>,
    opts?: { priority: number },
  ) => void;
  registerHook?: (
    name: string,
    handler: (event: PluginEvent) => Promise<void>,
    opts?: { priority: number },
  ) => void;
  registerCommand?: (cmd: CommandRegistration) => void;
  registerTool?: (tool: Record<string, unknown>) => void;
  registerService?: (svc: Record<string, unknown>) => void;
  runtime?: {
    sendMessageToDefaultSession?: (message: string) => void;
  };
}

interface CommandRegistration {
  name: string;
  description: string;
  acceptsArgs: boolean;
  requireAuth: boolean;
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}

interface CommandResult {
  text: string;
}

interface PluginEvent {
  sessionKey?: string;
  sessionId?: string;
  channelId?: string;
  message?: { text?: string; content?: string };
  text?: string;
  content?: string;
  appendSystemContext?: (text: string) => void;
  prependContext?: (text: string) => void;
  context?: Record<string, unknown>;
  messages?: Array<{ role: string; content: string }>;
}

interface CommandContext {
  args?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// NOTE: must stay async (execFile, not execFileSync). The OpenClaw plugin runs
// inside the gateway's Node event loop. A synchronous execFileSync blocks that
// loop for the whole child-process duration, so any `ao` subcommand that calls
// back into the same gateway over HTTP (e.g. `ao doctor` notifier-connectivity
// probe to 127.0.0.1:18789) deadlocks against the blocked loop and fails.
async function runCmd(
  bin: string,
  args: string[],
  timeoutMs: number = 15_000,
  cwd?: string,
): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    cwd,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  return stdout.trim();
}

async function tryRun(
  bin: string,
  args: string[],
  timeoutMs?: number,
  cwd?: string,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  try {
    return { ok: true, output: await runCmd(bin, args, timeoutMs, cwd) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Strip leading dashes from LLM-supplied args to prevent CLI flag injection. */
function sanitizeCliArg(arg: string): string {
  return arg.replace(/^-+/, "");
}

// ---------------------------------------------------------------------------
// Fork: config entity tools (`ao project|agent|identity add|update|rm`)
// ---------------------------------------------------------------------------

export type ConfigEntity = "project" | "agent" | "identity";
export type ConfigEntityAction = "add" | "update" | "rm";

/** camelCase tool parameter → CLI flag, per entity. Booleans/arrays are handled separately. */
const CONFIG_ENTITY_FLAGS: Record<ConfigEntity, Record<string, string>> = {
  project: {
    name: "--name",
    path: "--path",
    repo: "--repo",
    defaultBranch: "--default-branch",
    sessionPrefix: "--session-prefix",
    runtime: "--runtime",
    workspace: "--workspace",
    agentRules: "--agent-rules",
    agentRulesFile: "--agent-rules-file",
    branchNameTemplate: "--branch-name-template",
    reviewers: "--reviewers",
    workerIdentity: "--worker-identity",
    workerAgent: "--worker-agent",
    reviewerIdentity: "--reviewer-identity",
    reviewerAgent: "--reviewer-agent",
    reviewerRulesFile: "--reviewer-rules-file",
    reviewerPostMode: "--reviewer-post-mode",
    reviewerTimeoutMinutes: "--reviewer-timeout-minutes",
    orchestratorIdentity: "--orchestrator-identity",
    orchestratorAgent: "--orchestrator-agent",
    scmIdentity: "--scm-identity",
  },
  agent: {
    plugin: "--plugin",
    model: "--model",
    reasoningEffort: "--reasoning-effort",
    permissions: "--permissions",
    sandbox: "--sandbox",
  },
  identity: {
    tokenEnv: "--token-env",
    githubUser: "--github-user",
    tokenSecret: "--token-secret",
    agent: "--agent",
    name: "--name",
    email: "--email",
  },
};

/**
 * Build the `ao <entity> <action> <id> ...` argument list from tool params.
 * Every value passes through sanitizeCliArg; `set` becomes `--set k=<JSON>`
 * (JSON is valid YAML, so numbers, booleans, lists and quoted strings survive),
 * `unset` becomes repeated `--unset`. Always asks for `--json`.
 */
export function buildConfigEntityArgs(
  entity: ConfigEntity,
  action: ConfigEntityAction,
  params: Record<string, unknown>,
): string[] {
  const id = params["id"];
  if (typeof id !== "string" || id.trim().length === 0) throw new Error("id is required");
  const args = [entity, action, sanitizeCliArg(id.trim())];
  for (const [key, flag] of Object.entries(CONFIG_ENTITY_FLAGS[entity])) {
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    args.push(flag, sanitizeCliArg(String(value)));
  }
  if (entity === "project") {
    if (params["reviewerEnabled"] === true) args.push("--reviewer-enabled");
    if (params["reviewerEnabled"] === false) args.push("--no-reviewer-enabled");
    const postCreate = params["postCreate"];
    if (Array.isArray(postCreate)) {
      for (const step of postCreate) args.push("--post-create", sanitizeCliArg(String(step)));
    }
    if (action === "add" && params["clone"] === true) args.push("--clone");
  }
  const set = params["set"];
  if (set && typeof set === "object" && !Array.isArray(set)) {
    for (const [key, value] of Object.entries(set as Record<string, unknown>)) {
      args.push("--set", sanitizeCliArg(`${key}=${JSON.stringify(value)}`));
    }
  }
  const unset = params["unset"];
  if (action === "update" && Array.isArray(unset)) {
    for (const key of unset) args.push("--unset", sanitizeCliArg(String(key)));
  }
  if (action === "rm" && params["force"] === true) args.push("--force");
  if (params["dryRun"] === true) args.push("--dry-run");
  args.push("--json");
  return args;
}

function tryRunAo(config: PluginConfig, args: string[], timeoutMs?: number) {
  // AO requires cwd to be the repo root where agent-orchestrator.yaml lives
  const cwd = config.aoCwd || process.cwd();
  return tryRun(config.aoPath || "ao", args, timeoutMs, cwd);
}

function tryRunGh(config: PluginConfig, args: string[], timeoutMs?: number) {
  // Run gh from aoCwd so default-repo queries resolve correctly
  const cwd = config.aoCwd || process.cwd();
  return tryRun(config.ghPath || "gh", args, timeoutMs, cwd);
}

// ---------------------------------------------------------------------------
// Issue board helpers
// ---------------------------------------------------------------------------

interface GitHubIssue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  state: string;
  assignees: Array<{ login: string }>;
  createdAt: string;
  url: string;
  repository?: string;
}

interface FetchIssuesSuccess {
  ok: true;
  issues: GitHubIssue[];
  scannedRepos: string[];
  warnings: string[];
}

interface FetchIssuesFailure {
  ok: false;
  error: string;
}

type FetchIssuesResult = FetchIssuesSuccess | FetchIssuesFailure;

interface FetchIssuesOptions {
  repo?: string;
  labels?: string;
}

interface FetchIssuesDeps {
  getConfiguredRepos: (config: PluginConfig) => string[];
  runGh: typeof tryRunGh;
}

function resolveAoConfigPath(config: PluginConfig): string | null {
  const candidates: string[] = [];

  // Explicit overrides (most specific first).
  // AO_CONFIG_PATH is the dashboard/runtime convention.
  // AO_GLOBAL_CONFIG matches ao-core's getGlobalConfigPath() override.
  const envPath = process.env.AO_CONFIG_PATH ?? process.env.AO_GLOBAL_CONFIG;
  if (envPath) candidates.push(resolve(envPath));

  // Walk up the tree from aoCwd (or process.cwd) and try every reasonable name.
  // Names match what core uses:
  //   - global config:      ~/.agent-orchestrator/config.yaml   (getGlobalConfigPath)
  //   - per-repo behavior:  <repo>/agent-orchestrator.yaml      (LOCAL_CONFIG_FILENAMES)
  // Some setups also keep the global config under the project-style name; try both.
  let currentDir = resolve(config.aoCwd || process.cwd());
  while (true) {
    candidates.push(
      join(currentDir, "agent-orchestrator.yaml"),
      join(currentDir, "agent-orchestrator.yml"),
      join(currentDir, "config.yaml"),
      join(currentDir, "config.yml"),
    );
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  // Final fallback: ao-core's canonical global config path.
  candidates.push(join(homedir(), ".agent-orchestrator", "config.yaml"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function stripYamlInlineComment(value: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (char === "#" && !inSingleQuote && !inDoubleQuote) {
      return value.slice(0, i).trim();
    }
  }

  return value.trim();
}

function normalizeYamlScalar(value: string): string {
  const stripped = stripYamlInlineComment(value);
  if (!stripped) return "";

  if (
    (stripped.startsWith('"') && stripped.endsWith('"')) ||
    (stripped.startsWith("'") && stripped.endsWith("'"))
  ) {
    return stripped.slice(1, -1).trim();
  }

  return stripped;
}

export function extractConfiguredReposFromYaml(rawYaml: string): string[] {
  const repos = new Set<string>();
  const lines = rawYaml.split(/\r?\n/);
  let inProjects = false;
  // Detected at runtime from the first project entry line — not hardcoded.
  let projectKeyIndent: number | null = null;

  // State for parsing the rich object form:
  //   repo:
  //     owner: foo
  //     name:  bar
  // We track when we're inside a `repo:` block at a known indent, then emit
  // `owner/name` once we leave the block.
  let inRepoBlock = false;
  let repoBlockIndent = -1;
  let pendingOwner: string | null = null;
  let pendingName: string | null = null;
  const flushRepoBlock = (): void => {
    if (pendingOwner && pendingName) {
      repos.add(`${pendingOwner}/${pendingName}`);
    }
    inRepoBlock = false;
    repoBlockIndent = -1;
    pendingOwner = null;
    pendingName = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.match(/^ */)?.[0].length ?? 0;

    if (!inProjects) {
      if (trimmed === "projects:" && indent === 0) {
        inProjects = true;
      }
      continue;
    }

    // Any top-level key after projects: ends the block (and any open repo block).
    if (indent === 0) {
      flushRepoBlock();
      break;
    }

    // Detect the indentation level of project name keys from the first entry.
    // Strip inline comments before checking — `my-app: # comment` is a valid key.
    if (projectKeyIndent === null) {
      if (trimmed.replace(/\s*#.*$/, "").endsWith(":")) projectKeyIndent = indent;
      continue;
    }

    // Lines at the project-key indent are project names — skip them, and
    // close any in-flight repo block from the previous project.
    if (indent === projectKeyIndent) {
      flushRepoBlock();
      continue;
    }

    // We may still be parsing a `repo:` rich-form block from the previous
    // line. Children of that block are at indent > repoBlockIndent.
    if (inRepoBlock) {
      if (indent > repoBlockIndent) {
        const ownerMatch = trimmed.match(/^owner:\s*(.+)$/);
        if (ownerMatch) {
          pendingOwner = normalizeYamlScalar(ownerMatch[1]) || null;
          continue;
        }
        const nameMatch = trimmed.match(/^name:\s*(.+)$/);
        if (nameMatch) {
          pendingName = normalizeYamlScalar(nameMatch[1]) || null;
          continue;
        }
        // platform / originUrl / other keys — ignore inside the block.
        continue;
      }
      // Outdented — the block is finished, fall through to normal parsing.
      flushRepoBlock();
    }

    // Lines indented deeper than the project key are project properties.
    if (indent > projectKeyIndent) {
      // Flat form: `repo: owner/name`
      const flatMatch = trimmed.match(/^repo:\s*(\S.*)$/);
      if (flatMatch) {
        const repo = normalizeYamlScalar(flatMatch[1]);
        if (repo) repos.add(repo);
        continue;
      }
      // Rich form: bare `repo:` opens a child object block on the next line.
      if (trimmed === "repo:") {
        inRepoBlock = true;
        repoBlockIndent = indent;
        pendingOwner = null;
        pendingName = null;
        continue;
      }
    }
  }
  flushRepoBlock();

  return [...repos];
}

function getConfiguredRepos(config: PluginConfig): string[] {
  const configPath = resolveAoConfigPath(config);
  if (!configPath) return [];

  try {
    const rawYaml = readFileSync(configPath, "utf-8");
    return extractConfiguredReposFromYaml(rawYaml);
  } catch {
    return [];
  }
}

function getIssueRepository(issue: GitHubIssue): string | null {
  if (issue.repository) return issue.repository;
  const match = issue.url.match(/github\.com\/([^/]+\/[^/]+)\/issues\//);
  return match?.[1] ?? null;
}

function getIssueIdentity(issue: GitHubIssue): string {
  return issue.url || `${getIssueRepository(issue) ?? "default"}#${issue.number}`;
}

function formatIssueWarnings(warnings: string[]): string {
  return warnings.map((warning) => `- ${warning}`).join("\n");
}

export function mergeStringLists(existing: string[], required: string[]): string[] {
  const merged = [...existing];
  for (const value of required) {
    if (!merged.includes(value)) merged.push(value);
  }
  return merged;
}

export function parseStringArraySetting(output: string): string[] | null {
  const trimmed = output.trim();
  if (!trimmed) return [];
  if (trimmed === "null" || trimmed === "undefined") return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || parsed === undefined) return [];
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === "string");
    }
    if (typeof parsed === "string") {
      return parsed ? [parsed] : [];
    }
  } catch {
    // Fall through to plain-text parsing
  }

  if (trimmed.includes("\n")) {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  if (trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return [trimmed];
}

function getNestedValue(root: unknown, path: string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function readOpenClawConfig(): Record<string, unknown> | null {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readOpenClawStringArraySetting(setting: string, path: string[]): Promise<string[]> {
  const cliResult = await tryRun("openclaw", ["config", "get", setting], 5_000);
  if (cliResult.ok) {
    const parsed = parseStringArraySetting(cliResult.output);
    if (parsed) return parsed;
  }

  const openClawConfig = readOpenClawConfig();
  if (!openClawConfig) return [];

  const nestedValue = getNestedValue(openClawConfig, path);
  if (Array.isArray(nestedValue)) {
    return nestedValue.filter((value): value is string => typeof value === "string");
  }
  if (typeof nestedValue === "string" && nestedValue) {
    return [nestedValue];
  }

  return [];
}

export async function fetchIssues(
  config: PluginConfig,
  options: FetchIssuesOptions = {},
  deps: FetchIssuesDeps = {
    getConfiguredRepos,
    runGh: tryRunGh,
  },
): Promise<FetchIssuesResult> {
  const repos = options.repo ? [options.repo] : deps.getConfiguredRepos(config);
  const targets = repos.length > 0 ? repos : [undefined];
  const issues: GitHubIssue[] = [];
  const warnings: string[] = [];
  const scannedRepos: string[] = [];

  for (const targetRepo of targets) {
    const args = ["issue", "list"];
    const repoLabel = targetRepo ?? "default repo";
    if (targetRepo) args.push("-R", targetRepo);
    if (options.labels) args.push("--label", options.labels);
    args.push(
      "--state",
      "open",
      "--json",
      "number,title,labels,state,assignees,createdAt,url",
      "--limit",
      "30",
    );

    const result = await deps.runGh(config, args, 15_000);
    if (!result.ok) {
      warnings.push(`${repoLabel}: ${result.error}`);
      continue;
    }

    try {
      const parsed = JSON.parse(result.output) as GitHubIssue[];
      for (const issue of parsed) {
        issue.repository = targetRepo ?? getIssueRepository(issue) ?? undefined;
        issues.push(issue);
      }
      if (targetRepo) scannedRepos.push(targetRepo);
    } catch {
      warnings.push(`${repoLabel}: failed to parse GitHub CLI output`);
    }
  }

  const dedupedIssues = issues
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter(
      (issue, index, allIssues) =>
        allIssues.findIndex(
          (candidate) => getIssueIdentity(candidate) === getIssueIdentity(issue),
        ) === index,
    );
  const inferredRepos = dedupedIssues
    .map((issue) => getIssueRepository(issue))
    .filter((repo): repo is string => Boolean(repo));

  if (warnings.length > 0 && dedupedIssues.length === 0) {
    return {
      ok: false,
      error: `GitHub issue query failed:\n${formatIssueWarnings(warnings)}`,
    };
  }

  return {
    ok: true,
    issues: dedupedIssues,
    scannedRepos: [
      ...new Set(
        scannedRepos.length > 0 ? scannedRepos : inferredRepos.length > 0 ? inferredRepos : repos,
      ),
    ],
    warnings,
  };
}

function formatIssueList(issues: GitHubIssue[]): string {
  if (issues.length === 0) return "No open issues found.";
  const repoLabels = new Set(issues.map((issue) => getIssueRepository(issue)).filter(Boolean));
  const includeRepository = repoLabels.size > 1;
  return issues
    .map((issue, i) => {
      const labels = issue.labels.map((l) => l.name).join(", ");
      const labelStr = labels ? ` [${labels}]` : "";
      const repoPrefix = includeRepository
        ? `${getIssueRepository(issue) ?? issue.repository ?? "unknown"}#${issue.number}`
        : `#${issue.number}`;
      return `${i + 1}. ${repoPrefix} — ${issue.title}${labelStr}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Spawn with silent retry
// ---------------------------------------------------------------------------

async function spawnWithRetry(
  config: PluginConfig,
  issueArgs: string[],
  maxRetries: number = 3,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  let lastResult: { ok: true; output: string } | { ok: false; error: string } | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    lastResult = await tryRunAo(config, issueArgs, 30_000);
    if (lastResult.ok) return lastResult;
    // Only retry on transient errors, not config/auth errors
    if (
      lastResult.error.includes("not found") ||
      lastResult.error.includes("not configured") ||
      lastResult.error.includes("401")
    ) {
      return lastResult;
    }
    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  return lastResult!;
}

// ---------------------------------------------------------------------------
// Work-trigger detection
// ---------------------------------------------------------------------------

const WORK_TRIGGERS = [
  "what needs",
  "what should i",
  "what do i need",
  "start working",
  "morning",
  "let's go",
  "lets go",
  "what's going on",
  "whats going on",
  "status update",
  "check my repos",
  "check my issues",
  "check issues",
  "any issues",
  "what's on the board",
  "whats on the board",
  "what can i work on",
  "what to work on",
  "work on today",
  "what's open",
  "whats open",
  "open issues",
  "scan my repos",
  "scan repos",
  "scan issues",
  "engineering update",
  "dev update",
  "project update",
  "anything to do",
  "what's pending",
  "whats pending",
  "ready to work",
  "what's the plan",
  "whats the plan",
];

function isWorkRelated(message: string): boolean {
  const lower = message.toLowerCase();
  return WORK_TRIGGERS.some((t) => lower.includes(t));
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default function (api: PluginApi) {
  const config: PluginConfig = api.pluginConfig || {};

  // =========================================================================
  // HOOKS — intercept work-related messages and inject live data
  //
  // OpenClaw hook names (see docs.openclaw.ai/concepts/agent-loop):
  //   message_received  — inbound message arrives from any channel
  //   before_prompt_build — runs after session load, can inject context via
  //                         event.appendSystemContext / event.prependContext
  // =========================================================================

  /** Build a live-data context block from AO + GitHub */
  async function buildLiveContext(): Promise<string | null> {
    try {
      const [issuesResult, sessionsResult] = await Promise.all([
        fetchIssues(config),
        tryRunAo(config, ["status"], 10_000),
      ]);

      const issuesSummary = !issuesResult.ok
        ? issuesResult.error
        : issuesResult.issues.length > 0
          ? [
              `Open issues (${issuesResult.issues.length}${issuesResult.scannedRepos.length > 1 ? ` across ${issuesResult.scannedRepos.length} repos` : ""}):`,
              formatIssueList(issuesResult.issues),
              issuesResult.warnings.length > 0
                ? `GitHub warnings:\n${formatIssueWarnings(issuesResult.warnings)}`
                : null,
            ]
              .filter(Boolean)
              .join("\n")
          : `No open issues found${issuesResult.scannedRepos.length > 1 ? ` across ${issuesResult.scannedRepos.length} repos` : ""}.`;

      const sessionsSummary = sessionsResult.ok
        ? `Active sessions:\n${sessionsResult.output}`
        : "No active AO sessions (or AO not running).";

      return [
        "=== LIVE AGENT ORCHESTRATOR DATA (just fetched — use this, NOT your memory) ===",
        "",
        issuesSummary,
        "",
        sessionsSummary,
        "",
        "INSTRUCTIONS: Present this data to the user. Recommend which issues to start agents on.",
        "Ask for approval before spawning. Use ao_batch_spawn after they approve.",
        "Do NOT answer from memory about their projects — this live data supersedes everything.",
        "=== END LIVE DATA ===",
      ].join("\n");
    } catch (err) {
      api.logger.warn(`[ao-hook] Failed to build live context: ${err}`);
      return null;
    }
  }

  // Track pending work-related messages per session/channel to avoid
  // cross-conversation interference. Uses Map with timestamps for TTL cleanup.
  const pendingWorkSessions = new Map<string, number>();
  const PENDING_TTL_MS = 60_000; // 60s — if prompt build doesn't fire, clean up

  function cleanStalePending() {
    const now = Date.now();
    for (const [key, ts] of pendingWorkSessions) {
      if (now - ts > PENDING_TTL_MS) pendingWorkSessions.delete(key);
    }
  }

  function getSessionKey(event: PluginEvent): string {
    return event?.sessionKey || event?.sessionId || event?.channelId || "default";
  }

  // Hook 1: message_received — detect work-related inbound messages
  const onMessageReceived = async (event: PluginEvent) => {
    const message =
      event?.message?.text || event?.message?.content || event?.text || event?.content || "";

    if (isWorkRelated(message)) {
      cleanStalePending();
      pendingWorkSessions.set(getSessionKey(event), Date.now());
      api.logger.info("[ao-hook] Work-related message detected, will inject context");
    }
  };

  // Hook 2: before_prompt_build — inject AO routing context + live data
  const onBeforePromptBuild = async (event: PluginEvent) => {
    const key = getSessionKey(event);

    // Inform the model that AO is available and what it offers.
    // Not a command — just context so the model can make an informed choice.
    const routingContext = [
      "[Agent Orchestrator] This project has AO installed — an open-source orchestrator " +
        "for durable coding agents (Claude Code, Codex, OpenCode). ao_spawn creates an " +
        "isolated git worktree, starts an agent, and wires up feedback loops so PR reviews " +
        "and CI failures automatically route to the right agent.",
    ];

    // If this is a work-related message, also inject live repo data
    if (pendingWorkSessions.has(key)) {
      pendingWorkSessions.delete(key);
      api.logger.info("[ao-hook] Injecting live data into prompt context...");
      const context = await buildLiveContext();
      if (context) routingContext.push(context);
    }

    const fullContext = routingContext.join("\n\n");

    // OpenClaw before_prompt_build supports these injection points:
    if (typeof event.appendSystemContext === "function") {
      event.appendSystemContext(fullContext);
    } else if (typeof event.prependContext === "function") {
      event.prependContext(fullContext);
    } else if (event.context && typeof event.context === "object") {
      // Fallback: write to context object directly
      event.context.aoLiveData = fullContext;
    } else if (event.messages && Array.isArray(event.messages)) {
      // Last resort: push a system message
      event.messages.push({ role: "system", content: fullContext });
    }

    api.logger.info("[ao-hook] Injected AO context into prompt");
  };

  // Register hooks using the correct OpenClaw event names
  const register = (name: string, handler: (event: PluginEvent) => Promise<void>) => {
    try {
      if (typeof api.on === "function") {
        api.on(name, handler, { priority: 10 });
      } else if (typeof api.registerHook === "function") {
        api.registerHook(name, handler, { priority: 10 });
      }
    } catch {
      api.logger.warn(`[ao-hook] Failed to register hook: ${name}`);
    }
  };

  register("message_received", onMessageReceived);
  register("before_prompt_build", onBeforePromptBuild);

  api.logger.info("[ao-hook] Hooks registered (message_received, before_prompt_build)");

  // =========================================================================
  // SLASH COMMAND — single /ao command with subcommand parsing
  // =========================================================================

  api.registerCommand({
    name: "ao",
    description:
      "Agent Orchestrator — /ao sessions | status | spawn | issues | batch-spawn | retry | kill | doctor",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: CommandContext) => {
      const raw = (ctx.args || "").trim();
      const parts = raw.split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "help";
      const rest = parts.slice(1).join(" ").trim();

      // Sanitize user input: strip leading dashes to prevent flag injection
      const sanitizeArg = (arg: string): string => arg.replace(/^-+/, "");
      const isValidIssueId = (s: string): boolean => /^#?\d+$/.test(s.trim());
      const isValidSessionId = (s: string): boolean => /^[\w-]+$/.test(s.trim());

      switch (subcommand) {
        case "sessions": {
          const result = await tryRunAo(config, ["status"]);
          if (!result.ok) return { text: `Failed to get sessions:\n${result.error}` };
          return { text: result.output || "No active sessions." };
        }

        case "status": {
          // `ao status` shows all sessions; no per-session lookup available
          const result = await tryRunAo(config, ["status"]);
          if (!result.ok) return { text: `Failed:\n${result.error}` };
          return { text: result.output };
        }

        case "spawn": {
          if (!rest) return { text: "Usage: /ao spawn <issue-number>" };
          const issueArg = sanitizeArg(rest.split(/\s+/)[0]);
          if (!isValidIssueId(issueArg))
            return {
              text: `Invalid issue identifier: ${issueArg}. Expected a number like 42 or #42.`,
            };
          const result = await spawnWithRetry(config, ["spawn", issueArg]);
          if (!result.ok) return { text: `Failed to spawn:\n${result.error}` };
          return { text: result.output };
        }

        case "issues": {
          const issuesResult = await fetchIssues(config, { repo: rest || undefined });
          if (!issuesResult.ok) return { text: issuesResult.error };

          const lines = [formatIssueList(issuesResult.issues)];
          if (issuesResult.warnings.length > 0) {
            lines.push("");
            lines.push("GitHub warnings:");
            lines.push(formatIssueWarnings(issuesResult.warnings));
          }

          return { text: lines.join("\n") };
        }

        case "batch-spawn": {
          if (!rest) return { text: "Usage: /ao batch-spawn <issue1> <issue2> ..." };
          const issueArgs = rest.split(/\s+/).map(sanitizeArg);
          if (!issueArgs.every(isValidIssueId))
            return { text: `Invalid issue identifiers. Expected numbers like: 42 43 44` };
          const result = await tryRunAo(config, ["batch-spawn", ...issueArgs], 60_000);
          if (!result.ok) return { text: `Failed to batch-spawn:\n${result.error}` };
          return { text: result.output };
        }

        case "retry": {
          if (!rest) return { text: "Usage: /ao retry <session-id>" };
          const sessionId = sanitizeArg(rest.trim());
          if (!isValidSessionId(sessionId))
            return { text: `Invalid session ID: ${rest}. Expected format like ao-42.` };
          const result = await tryRunAo(config, [
            "send",
            sessionId,
            "Please retry the failed task.",
          ]);
          if (!result.ok) return { text: `Failed to send retry:\n${result.error}` };
          return { text: `Retry sent to session ${sessionId}.` };
        }

        case "kill": {
          if (!rest) return { text: "Usage: /ao kill <session-id>" };
          const sessionId = sanitizeArg(rest.trim());
          if (!isValidSessionId(sessionId))
            return { text: `Invalid session ID: ${rest}. Expected format like ao-42.` };
          const result = await tryRunAo(config, ["session", "kill", sessionId]);
          if (!result.ok) return { text: `Failed to kill session:\n${result.error}` };
          return { text: `Session ${sessionId} killed.` };
        }

        case "doctor": {
          const result = await tryRunAo(config, ["doctor"], 30_000);
          if (!result.ok) return { text: `Failed to run doctor:\n${result.error}` };
          return { text: result.output };
        }

        case "setup": {
          // Auto-configure OpenClaw settings for AO plugin
          const steps: string[] = [];
          const runSetup = async (bin: string, args: string[]): Promise<boolean> => {
            try {
              await execFileAsync(bin, args, { encoding: "utf-8", timeout: 10_000 });
              return true;
            } catch {
              return false;
            }
          };

          // 1. tools.profile must be "full" for plugin tools to be visible
          if (await runSetup("openclaw", ["config", "set", "tools.profile", "full"]))
            steps.push("✅ tools.profile → full");
          else steps.push("❌ Failed to set tools.profile");

          // 2. Allow plugin tools
          const mergedToolsAllow = mergeStringLists(
            await readOpenClawStringArraySetting("tools.allow", ["tools", "allow"]),
            ["group:plugins"],
          );
          if (
            await runSetup("openclaw", [
              "config",
              "set",
              "tools.allow",
              JSON.stringify(mergedToolsAllow),
            ])
          ) {
            steps.push(`✅ tools.allow → ${mergedToolsAllow.join(", ")}`);
          } else steps.push("❌ Failed to set tools.allow");

          // 3. Trust the plugin
          const mergedPluginsAllow = mergeStringLists(
            await readOpenClawStringArraySetting("plugins.allow", ["plugins", "allow"]),
            ["agent-orchestrator"],
          );
          if (
            await runSetup("openclaw", [
              "config",
              "set",
              "plugins.allow",
              JSON.stringify(mergedPluginsAllow),
            ])
          ) {
            steps.push(`✅ plugins.allow → ${mergedPluginsAllow.join(", ")}`);
          } else steps.push("❌ Failed to set plugins.allow");

          // 4. Group chat settings
          if (
            await runSetup("openclaw", ["config", "set", "messages.groupChat.historyLimit", "100"])
          )
            steps.push("✅ historyLimit → 100");
          else steps.push("⚠️ Could not set historyLimit");

          steps.push("");
          steps.push("⚡ Restart the gateway to apply: pm2 restart openclaw-gateway");
          steps.push("Then verify with: /ao doctor");
          steps.push("");
          steps.push("⚠️  Action required — run these once to avoid conflicts:");
          steps.push("   openclaw config set skills.entries.coding-agent.enabled false");
          steps.push("   openclaw config set skills.entries.gh-issues.enabled false");
          steps.push(
            '   openclaw config set tools.deny \'["exec","write","str_replace_based_edit_tool","create_file","str_replace_editor"]\'',
          );
          steps.push("Without these, the bot may code directly instead of delegating to AO.");

          return { text: `AO Plugin Setup\n\n${steps.join("\n")}` };
        }

        default:
          return {
            text: [
              "Agent Orchestrator commands:",
              "  /ao sessions              — list all sessions",
              "  /ao status                — all sessions overview",
              "  /ao issues [owner/repo]   — list open issues",
              "  /ao spawn <issue>         — spawn agent on issue",
              "  /ao batch-spawn <i1> <i2> — spawn multiple agents",
              "  /ao retry <id>            — retry failed session",
              "  /ao kill <id>             — kill a session",
              "  /ao doctor                — run health checks",
              "  /ao setup                 — auto-configure OpenClaw for AO",
            ].join("\n"),
          };
      }
    },
  });

  // =========================================================================
  // AGENT TOOLS
  // =========================================================================

  api.registerTool({
    name: "ao_sessions",
    description:
      "Returns live session data from Agent Orchestrator — what agents are running, " +
      "their status, branches, and progress. Use when the user asks about status or progress.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const result = await tryRunAo(config, ["status"]);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to get sessions: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.output || "No active sessions." }],
      };
    },
  });

  api.registerTool({
    name: "ao_issues",
    description:
      "Returns live GitHub issue data — open issues, labels, assignees, and priorities. " +
      "Use when the user asks about work, tasks, issues, or what needs attention.",
    parameters: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "GitHub repo in owner/repo format. Omit to scan the default repo.",
        },
        labels: {
          type: "string",
          description: "Comma-separated label filter (e.g. 'bug,P1'). Optional.",
        },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { repo?: string; labels?: string }) {
      const result = await fetchIssues(config, params);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.error }],
          isError: true,
        };
      }

      const lines = [formatIssueList(result.issues)];
      if (result.warnings.length > 0) {
        lines.push("");
        lines.push("GitHub warnings:");
        lines.push(formatIssueWarnings(result.warnings));
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  api.registerTool({
    name: "ao_spawn",
    description:
      "Spawn a durable coding agent (Claude Code, Codex, or OpenCode) on a task. " +
      "Creates an isolated git worktree, starts the agent, and wires up feedback " +
      "loops — CI failures and PR reviews automatically route back to the agent. " +
      "Works with issue numbers (#42) or without for freeform tasks.",
    parameters: {
      type: "object",
      properties: {
        issue: {
          type: "string",
          description:
            "Issue identifier. Multi-project setups: use `<projectId>/<n>` format (e.g. `feed-gathering/36`) where projectId or sessionPrefix matches a registered AO project. Single-project setups accept bare `#42`. Omit for freeform tasks, then use ao_send to describe the work.",
        },
        agent: { type: "string", description: "Override agent plugin (e.g. codex, claude-code)" },
        claimPr: {
          type: "string",
          description: "Immediately claim an existing PR number for the session",
        },
      },
    },
    async execute(
      _toolCallId: string,
      params: { issue?: string; agent?: string; claimPr?: string },
    ) {
      const args = ["spawn"];
      if (params.issue) {
        args.push(sanitizeCliArg(params.issue));
      } else {
        // Freeform spawn — ao CLI supports bare `ao spawn` which creates
        // a session without an issue. Use ao_send afterward to describe the task.
        api.logger.info("[ao_spawn] Spawning without issue — freeform session");
      }
      if (params.agent) args.push("--agent", sanitizeCliArg(params.agent));
      if (params.claimPr) args.push("--claim-pr", sanitizeCliArg(params.claimPr));
      const result = await spawnWithRetry(config, args);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to spawn: ${result.error}` }],
          isError: true,
        };
      }
      const spawnOutput = params.issue
        ? result.output
        : result.output +
          "\n\nNote: This is a freeform session (no issue). Use ao_send to describe the task to the agent.";
      return { content: [{ type: "text", text: spawnOutput }] };
    },
  });

  api.registerTool({
    name: "ao_batch_spawn",
    description:
      "Spawn durable coding agents for multiple GitHub issues in parallel. " +
      "Always confirm the list with the user before calling this. " +
      "Each agent gets its own isolated worktree with CI and PR review feedback loops.",
    parameters: {
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: { type: "string" },
          description: "List of GitHub issue numbers",
        },
      },
      required: ["issues"],
    },
    async execute(_toolCallId: string, params: { issues: string[] }) {
      const result = await tryRunAo(
        config,
        ["batch-spawn", ...params.issues.map(sanitizeCliArg)],
        60_000,
      );

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to batch-spawn: ${result.error}` }],
          isError: true,
        };
      }

      // Schedule auto follow-ups
      const checkStatus = async (label: string) => {
        const status = await tryRunAo(config, ["status"], 10_000);
        const msg = status.ok ? status.output : "Could not reach AO for status check.";
        try {
          api.runtime?.sendMessageToDefaultSession?.(
            `${label}:\n\n${msg}\n\nNeed me to do anything?`,
          );
        } catch {
          api.logger.info(`[ao-followup] ${label}: ${msg}`);
        }
      };

      batchSpawnFollowUpTimeouts.push(
        setTimeout(() => void checkStatus("Progress check (3 min)"), 3 * 60_000),
      );
      batchSpawnFollowUpTimeouts.push(
        setTimeout(() => void checkStatus("Status update (8 min)"), 8 * 60_000),
      );

      api.logger.info("[ao-batch] Scheduled auto follow-ups at 3min and 8min");

      return {
        content: [
          {
            type: "text",
            text:
              result.output +
              "\n\nI'll check status automatically in a few minutes and update you.",
          },
        ],
      };
    },
  });

  api.registerTool({
    name: "ao_send",
    description: "Send a message to a running Agent Orchestrator session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The AO session ID (e.g. ao-5)" },
        message: { type: "string", description: "Message to send" },
      },
      required: ["sessionId", "message"],
    },
    async execute(_toolCallId: string, params: { sessionId: string; message: string }) {
      const result = await tryRunAo(config, [
        "send",
        sanitizeCliArg(params.sessionId),
        params.message,
      ]);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to send: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Message sent to ${params.sessionId}.` }],
      };
    },
  });

  api.registerTool({
    name: "ao_kill",
    description:
      "Kill an Agent Orchestrator session. Always confirm with the user before calling this.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The AO session ID to kill" },
      },
      required: ["sessionId"],
    },
    async execute(_toolCallId: string, params: { sessionId: string }) {
      const result = await tryRunAo(config, ["session", "kill", sanitizeCliArg(params.sessionId)]);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to kill: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text", text: `Session ${params.sessionId} killed and worktree cleaned up.` },
        ],
      };
    },
  });

  api.registerTool({
    name: "ao_doctor",
    description: "Run Agent Orchestrator health checks. Use when troubleshooting.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const result = await tryRunAo(config, ["doctor"], 30_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Doctor failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  api.registerTool({
    name: "ao_review_check",
    description:
      "Check PRs for review comments and trigger agents to address them. " +
      "Use when the user asks to check reviews, handle PR feedback, or address reviewer comments. " +
      "Optionally pass a project ID to filter.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project ID (checks all if omitted)" },
        dryRun: { type: "boolean", description: "Show what would be done without acting" },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { project?: string; dryRun?: boolean }) {
      const args = ["review-check"];
      if (params.project) args.push(sanitizeCliArg(params.project));
      if (params.dryRun) args.push("--dry-run");
      const result = await tryRunAo(config, args, 30_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Review check failed: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.output || "No review comments to address." }],
      };
    },
  });

  api.registerTool({
    name: "ao_verify",
    description:
      "Mark an issue as verified (or failed) after checking the fix on staging. " +
      "Use when the user confirms a fix works or reports it doesn't. " +
      "Use with --list to show all merged-but-unverified issues.",
    parameters: {
      type: "object",
      properties: {
        issue: { type: "string", description: "Issue number to verify" },
        project: { type: "string", description: "Project ID (required if multiple projects)" },
        fail: { type: "boolean", description: "Mark verification as failed instead of passing" },
        comment: { type: "string", description: "Custom comment to add" },
        list: { type: "boolean", description: "List all issues with merged-unverified label" },
      },
      required: [],
    },
    async execute(
      _toolCallId: string,
      params: {
        issue?: string;
        project?: string;
        fail?: boolean;
        comment?: string;
        list?: boolean;
      },
    ) {
      const args = ["verify"];
      if (params.list) {
        args.push("--list");
        if (params.project) args.push("-p", params.project);
      } else {
        if (!params.issue) {
          return {
            content: [
              {
                type: "text",
                text: "Need an issue number. Use list: true to see unverified issues.",
              },
            ],
            isError: true,
          };
        }
        args.push(params.issue);
        if (params.project) args.push("-p", params.project);
        if (params.fail) args.push("--fail");
        if (params.comment) args.push("-c", params.comment);
      }
      const result = await tryRunAo(config, args, 15_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Verify failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  api.registerTool({
    name: "ao_session_cleanup",
    description:
      "Kill sessions where the PR is merged or the issue is closed. " +
      "Cleans up stale sessions. Use dry-run first to preview.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project ID to filter" },
        dryRun: { type: "boolean", description: "Preview what would be cleaned up" },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { project?: string; dryRun?: boolean }) {
      const args = ["session", "cleanup"];
      if (params.project) args.push("-p", sanitizeCliArg(params.project));
      if (params.dryRun) args.push("--dry-run");
      const result = await tryRunAo(config, args, 30_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Cleanup failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output || "No sessions to clean up." }] };
    },
  });

  api.registerTool({
    name: "ao_session_restore",
    description:
      "Restore a terminated or crashed agent session in-place. " +
      "Use when a session died unexpectedly and needs to resume.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session name to restore" },
      },
      required: ["sessionId"],
    },
    async execute(_toolCallId: string, params: { sessionId: string }) {
      const result = await tryRunAo(
        config,
        ["session", "restore", sanitizeCliArg(params.sessionId)],
        30_000,
      );
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Restore failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  api.registerTool({
    name: "ao_session_claim_pr",
    description:
      "Attach an existing PR to an agent session. " +
      "Use when there's a PR that was created outside AO that should be tracked.",
    parameters: {
      type: "object",
      properties: {
        pr: { type: "string", description: "Pull request number or URL" },
        sessionId: { type: "string", description: "Session name (optional)" },
        assignOnGithub: {
          type: "boolean",
          description: "Assign the PR to the authenticated GitHub user",
        },
      },
      required: ["pr"],
    },
    async execute(
      _toolCallId: string,
      params: { pr: string; sessionId?: string; assignOnGithub?: boolean },
    ) {
      const args = ["session", "claim-pr", params.pr];
      if (params.sessionId) args.push(params.sessionId);
      if (params.assignOnGithub) args.push("--assign-on-github");
      const result = await tryRunAo(config, args, 15_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Claim PR failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  api.registerTool({
    name: "ao_session_list",
    description:
      "List all agent sessions with detailed info. " +
      "Use for a comprehensive session listing. For a quick status overview, use ao_sessions instead.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project ID to filter" },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { project?: string }) {
      const args = ["session", "ls"];
      if (params.project) args.push("-p", params.project);
      const result = await tryRunAo(config, args, 15_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Session list failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output || "No sessions found." }] };
    },
  });

  api.registerTool({
    name: "ao_status",
    description:
      "Show all sessions with branch, activity, PR, and CI status. " +
      "Returns JSON when requested. Use for a comprehensive dashboard view.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project ID" },
        json: { type: "boolean", description: "Return output as JSON for easier parsing" },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { project?: string; json?: boolean }) {
      const args = ["status"];
      if (params.project) args.push("-p", params.project);
      if (params.json) args.push("--json");
      const result = await tryRunAo(config, args, 15_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Status failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  // =========================================================================
  // Fork: config entity tools — edit the live AO config file through the CLI
  // =========================================================================

  const CONFIG_EDIT_NOTE =
    "Writes the AO config file after validation (a timestamped backup is kept). " +
    "The engine reads config at startup: after a real (non-dryRun) change tell the operator to restart " +
    "ao-engine at 0 active sessions. Use dryRun:true to preview.";
  const SET_PARAM = {
    type: "object",
    description: "Any other keys under the entity, dotted (e.g. {\"reviewer.timeoutMinutes\": 30}); values are written as YAML",
    additionalProperties: true,
  };
  const UNSET_PARAM = { type: "array", items: { type: "string" }, description: "Dotted keys to remove" };
  const DRY_RUN_PARAM = { type: "boolean", description: "Validate and show the result without writing" };
  const projectBehaviourParams = {
    runtime: { type: "string", description: "Override defaults.runtime (tmux, process)" },
    workspace: { type: "string", description: "Override defaults.workspace (clone, worktree)" },
    agentRulesFile: { type: "string", description: "Worker rules file (override)" },
    branchNameTemplate: { type: "string", description: "Override defaults.branchNameTemplate" },
    reviewers: { type: "string", description: "Comma-separated reviewer logins (override)" },
    postCreate: { type: "array", items: { type: "string" }, description: "postCreate steps (replaces the list)" },
    workerIdentity: { type: "string", description: "identities key the worker acts as" },
    workerAgent: { type: "string", description: "agents key (or plugin) the worker runs, e.g. claude-coder" },
    reviewerIdentity: { type: "string", description: "identities key the reviewer acts as" },
    reviewerAgent: { type: "string", description: "agents key (or plugin) the reviewer runs, e.g. claude-reviewer" },
    reviewerEnabled: { type: "boolean", description: "Enable/disable the AO-native reviewer for this project" },
    reviewerRulesFile: { type: "string", description: "Reviewer-only rules file" },
    reviewerPostMode: { type: "string", description: "live | dry-run" },
    reviewerTimeoutMinutes: { type: "number", description: "Reviewer run timeout" },
    orchestratorIdentity: { type: "string", description: "identities key the orchestrator acts as" },
    orchestratorAgent: { type: "string", description: "agents key (or plugin) the orchestrator runs" },
    scmIdentity: { type: "string", description: "identities key for the project's SCM calls" },
    set: SET_PARAM,
    dryRun: DRY_RUN_PARAM,
  };

  async function runConfigEntity(entity: ConfigEntity, action: ConfigEntityAction, params: Record<string, unknown>) {
    let args: string[];
    try {
      args = buildConfigEntityArgs(entity, action, params);
    } catch (err) {
      return { content: [{ type: "text", text: `Invalid parameters: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
    const result = await tryRunAo(config, args, 60_000);
    if (!result.ok) {
      return { content: [{ type: "text", text: `ao ${entity} ${action} failed: ${result.error}` }], isError: true };
    }
    const suffix = params["dryRun"] === true ? "" : "\n\nRestart ao-engine at 0 active sessions to apply (config is read at startup).";
    return { content: [{ type: "text", text: result.output + suffix }] };
  }

  api.registerTool({
    name: "ao_project_add",
    description:
      "Add a project to the AO config. Required: id and repo (owner/name). path defaults to " +
      "~/.agent-orchestrator/repos/<id>, defaultBranch to main, sessionPrefix and name to the id. " +
      "Behaviour (runtime, agents, identities, reviewer) is inherited from defaults: — pass overrides only when needed. " +
      "clone:true creates the stub clone AO uses as the project path. " + CONFIG_EDIT_NOTE,
    parameters: {
      type: "object",
      required: ["id", "repo"],
      properties: {
        id: { type: "string", description: "Project id (config key, e.g. my-service)" },
        repo: { type: "string", description: "GitHub repository owner/name" },
        name: { type: "string", description: "Display name" },
        path: { type: "string", description: "Stub clone path used by AO" },
        defaultBranch: { type: "string", description: "Default branch (default main)" },
        sessionPrefix: { type: "string", description: "Session name prefix (default: the id)" },
        clone: { type: "boolean", description: "Create the stub clone from git@github.com:<repo>.git when the path is missing" },
        ...projectBehaviourParams,
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      return runConfigEntity("project", "add", params);
    },
  });

  api.registerTool({
    name: "ao_project_update",
    description:
      "Change fields of a project in the AO config (registry fields, behaviour overrides, role identity/agent, reviewer settings; " +
      "set for any other dotted key, unset to remove keys). " + CONFIG_EDIT_NOTE,
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Project id" },
        repo: { type: "string", description: "GitHub repository owner/name" },
        name: { type: "string", description: "Display name" },
        path: { type: "string", description: "Stub clone path used by AO" },
        defaultBranch: { type: "string", description: "Default branch" },
        sessionPrefix: { type: "string", description: "Session name prefix" },
        ...projectBehaviourParams,
        unset: UNSET_PARAM,
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      return runConfigEntity("project", "update", params);
    },
  });

  api.registerTool({
    name: "ao_project_remove",
    description: "Remove a project from the AO config (its clone and session data stay on disk). Confirm with the user first. " + CONFIG_EDIT_NOTE,
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "Project id" }, dryRun: DRY_RUN_PARAM },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      return runConfigEntity("project", "rm", params);
    },
  });

  const agentParams = {
    model: { type: "string", description: "Model passed to the agent CLI (e.g. gpt-6-astra, claude-opus-5)" },
    reasoningEffort: { type: "string", description: "codex model_reasoning_effort / claude --effort: low, medium, high, xhigh" },
    permissions: { type: "string", description: "permissionless | auto-edit | suggest | default" },
    sandbox: { type: "string", description: "codex exec sandbox for headless reviews (e.g. danger-full-access)" },
    set: SET_PARAM,
    dryRun: DRY_RUN_PARAM,
  };

  api.registerTool({
    name: "ao_agent_add",
    description:
      "Add an agents: profile (plugin + model + effort + permissions) to the AO config, e.g. claude-coder / codex-reviewer. " +
      "Identities and role blocks reference profiles by id. " + CONFIG_EDIT_NOTE,
    parameters: {
      type: "object",
      required: ["id", "plugin"],
      properties: {
        id: { type: "string", description: "Profile id, e.g. claude-coder" },
        plugin: { type: "string", description: "Agent plugin: codex, claude-code, ..." },
        ...agentParams,
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      return runConfigEntity("agent", "add", params);
    },
  });

  api.registerTool({
    name: "ao_agent_update",
    description: "Change fields of an agents: profile in the AO config (model, effort, permissions, sandbox, set/unset). " + CONFIG_EDIT_NOTE,
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Profile id" },
        plugin: { type: "string", description: "Agent plugin" },
        ...agentParams,
        unset: UNSET_PARAM,
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      return runConfigEntity("agent", "update", params);
    },
  });

  api.registerTool({
    name: "ao_agent_remove",
    description: "Remove an agents: profile. Refused while an identity or role references it unless force:true. " + CONFIG_EDIT_NOTE,
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Profile id" },
        force: { type: "boolean", description: "Remove even when referenced" },
        dryRun: DRY_RUN_PARAM,
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      return runConfigEntity("agent", "rm", params);
    },
  });

  api.registerTool({
    name: "ao_agent_list",
    description: "List agents: profiles in the AO config (plugin, model, effort, permissions) and which identities use them.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const result = await tryRunAo(config, ["agent", "ls", "--json"]);
      return result.ok
        ? { content: [{ type: "text", text: result.output }] }
        : { content: [{ type: "text", text: `ao agent ls failed: ${result.error}` }], isError: true };
    },
  });

  const identityParams = {
    githubUser: { type: "string", description: "GitHub login (default: the id)" },
    tokenSecret: { type: "string", description: "Google Secret Manager secret projects/<p>/secrets/<name>[/versions/<v>] that fills tokenEnv" },
    agent: { type: "string", description: "agents key (or plugin) roles with this identity run" },
    name: { type: "string", description: "Git author name (default: the login)" },
    email: { type: "string", description: "Git author email (default: <login>@users.noreply.github.com)" },
    set: SET_PARAM,
    dryRun: DRY_RUN_PARAM,
  };

  api.registerTool({
    name: "ao_identity_add",
    description:
      "Add an identities: entry (a GitHub user AO acts as) to the AO config. Required: id and tokenEnv (the env var carrying the token); " +
      "tokenSecret lets the CLI fill it from Google Secret Manager. Never pass token values. " + CONFIG_EDIT_NOTE,
    parameters: {
      type: "object",
      required: ["id", "tokenEnv"],
      properties: {
        id: { type: "string", description: "Identity id, e.g. neo" },
        tokenEnv: { type: "string", description: "Environment variable that carries the GitHub token" },
        ...identityParams,
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      return runConfigEntity("identity", "add", params);
    },
  });

  api.registerTool({
    name: "ao_identity_update",
    description: "Change fields of an identities: entry (login, tokenEnv, tokenSecret, agent profile, git author; set/unset). " + CONFIG_EDIT_NOTE,
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Identity id" },
        tokenEnv: { type: "string", description: "Environment variable that carries the GitHub token" },
        ...identityParams,
        unset: UNSET_PARAM,
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      return runConfigEntity("identity", "update", params);
    },
  });

  api.registerTool({
    name: "ao_identity_remove",
    description: "Remove an identities: entry. Refused while a role or scm block uses it unless force:true. " + CONFIG_EDIT_NOTE,
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Identity id" },
        force: { type: "boolean", description: "Remove even when used" },
        dryRun: DRY_RUN_PARAM,
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      return runConfigEntity("identity", "rm", params);
    },
  });

  api.registerTool({
    name: "ao_identity_list",
    description: "List identities: entries in the AO config (login, token env/secret name, agent profile, where used). Token values are never shown; ao_doctor verifies them.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const result = await tryRunAo(config, ["identity", "ls", "--json"]);
      return result.ok
        ? { content: [{ type: "text", text: result.output }] }
        : { content: [{ type: "text", text: `ao identity ls failed: ${result.error}` }], isError: true };
    },
  });

  api.registerTool({
    name: "ao_config_show",
    description: "Show the effective AO config after defaults inheritance: agents, identities and (with project) one project's resolved block (identity, agent profile, agentConfig, reviewer settings).",
    parameters: {
      type: "object",
      properties: { project: { type: "string", description: "Project id; omit for the whole effective config" } },
    },
    async execute(_toolCallId: string, params: { project?: string }) {
      const args = ["config", "show", "--json"];
      if (params.project) args.push("-p", sanitizeCliArg(params.project));
      const result = await tryRunAo(config, args);
      return result.ok
        ? { content: [{ type: "text", text: result.output }] }
        : { content: [{ type: "text", text: `ao config show failed: ${result.error}` }], isError: true };
    },
  });

  // =========================================================================
  // BACKGROUND SERVICES
  // =========================================================================

  let healthInterval: ReturnType<typeof setInterval> | null = null;
  let boardScanInterval: ReturnType<typeof setInterval> | null = null;
  let boardScanInitialTimeout: ReturnType<typeof setTimeout> | null = null;
  const batchSpawnFollowUpTimeouts: ReturnType<typeof setTimeout>[] = [];
  let lastKnownIssueIds: Set<string> = new Set();
  let isFirstBoardScan = true;

  // --- Health monitor ---
  api.registerService({
    id: "ao-health",
    start: async () => {
      const pollMs = config.healthPollIntervalMs ?? 30_000;
      if (pollMs <= 0) return;

      api.logger.info(`[ao-health] Starting (every ${pollMs / 1000}s)`);
      healthInterval = setInterval(() => {
        void (async () => {
          const result = await tryRunAo(config, ["status"], 10_000);
          if (!result.ok) {
            api.logger.warn(`[ao-health] AO unreachable: ${result.error}`);
          }
        })();
      }, pollMs);
    },
    stop: async () => {
      if (healthInterval) {
        clearInterval(healthInterval);
        healthInterval = null;
      }
      // Clear any pending batch-spawn follow-up timeouts
      for (const t of batchSpawnFollowUpTimeouts.splice(0)) {
        clearTimeout(t);
      }
    },
  });

  // --- Issue board scanner ---
  api.registerService({
    id: "ao-board-scanner",
    start: async () => {
      const scanMs = config.boardScanIntervalMs ?? 1_800_000;
      if (scanMs <= 0) return;

      api.logger.info(`[ao-board-scanner] Starting (every ${scanMs / 60_000}min)`);

      const scan = async () => {
        try {
          const issuesResult = await fetchIssues(config);
          if (!issuesResult.ok) {
            api.logger.warn(`[ao-board-scanner] ${issuesResult.error}`);
            return;
          }

          if (issuesResult.warnings.length > 0) {
            api.logger.warn(
              `[ao-board-scanner] Partial GitHub failures:\n${formatIssueWarnings(issuesResult.warnings)}`,
            );
          }

          const currentIds = new Set(issuesResult.issues.map((issue) => getIssueIdentity(issue)));

          if (isFirstBoardScan) {
            lastKnownIssueIds = currentIds;
            isFirstBoardScan = false;
            api.logger.info(`[ao-board-scanner] Baseline: ${currentIds.size} open issues`);
            return;
          }

          const newIssues = issuesResult.issues.filter(
            (issue) => !lastKnownIssueIds.has(getIssueIdentity(issue)),
          );

          if (newIssues.length > 0) {
            const summary = formatIssueList(newIssues);

            api.logger.info(`[ao-board-scanner] ${newIssues.length} new issue(s)`);

            try {
              api.runtime?.sendMessageToDefaultSession?.(
                `New issues detected:\n\n${summary}\n\nWant me to start agents on any of these?`,
              );
            } catch {
              api.logger.info(`[ao-board-scanner] New issues:\n${summary}`);
            }
          }

          lastKnownIssueIds = currentIds;
        } catch (err) {
          api.logger.warn(`[ao-board-scanner] Scan failed: ${err}`);
        }
      };

      boardScanInitialTimeout = setTimeout(() => void scan(), 10_000);
      boardScanInterval = setInterval(() => void scan(), scanMs);
    },
    stop: async () => {
      if (boardScanInitialTimeout) {
        clearTimeout(boardScanInitialTimeout);
        boardScanInitialTimeout = null;
      }
      if (boardScanInterval) {
        clearInterval(boardScanInterval);
        boardScanInterval = null;
      }
      // Clear batch-spawn follow-up timeouts here too — they may outlive the health
      // service if healthPollIntervalMs <= 0 (health service never starts/stops)
      for (const t of batchSpawnFollowUpTimeouts.splice(0)) {
        clearTimeout(t);
      }
    },
  });
}
