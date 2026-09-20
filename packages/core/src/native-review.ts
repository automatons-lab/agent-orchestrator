/**
 * AO-native reviewer (fork).
 *
 * When a project's `reviewer` role is enabled, every new head SHA on a
 * worker's PR spawns a headless, read-only review agent in its own tmux
 * session (a detached worktree at that SHA). AO writes the context and prompt
 * the agent reads, validates the JSON verdict it writes back, and posts the
 * GitHub review itself with the reviewer identity's token. The agent never
 * receives a token and has no network.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { recordActivityEvent } from "./activity-events.js";
import { PREFERRED_GH_PATH, buildAgentPath } from "./agent-workspace-hooks.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { prepareGitReviewerWorkspace } from "./code-review-manager.js";
import type { CodeReviewRun, CodeReviewStore } from "./code-review-store.js";
import { getIdentityToken } from "./identities.js";
import { shellEscape } from "./utils.js";
import type {
  Agent,
  DefaultPlugins,
  OrchestratorConfig,
  PRInfo,
  ProjectConfig,
  Review,
  ReviewComment,
  ReviewSandboxMode,
  ReviewSubmission,
  ReviewSubmissionComment,
  Runtime,
  RuntimeHandle,
  SCM,
  Session,
  SubmittedReview,
  Tracker,
} from "./types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ResolvedReviewerConfig {
  githubUser: string;
  agent: string;
  model?: string;
  reasoningEffort?: string;
  timeoutMinutes: number;
  maxConcurrent: number;
  postMode: "live" | "dry-run";
  rulesFile?: string;
  /** Rounds per PR before AO stops spawning reviews and escalates. */
  maxRounds: number;
  /** Agent sandbox override (`reviewer.agentConfig.sandbox`). */
  sandbox?: ReviewSandboxMode;
}

const REVIEW_SANDBOX_MODES: ReadonlySet<string> = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

export const DEFAULT_REVIEW_TIMEOUT_MINUTES = 25;
export const DEFAULT_REVIEW_MAX_CONCURRENT = 1;
export const DEFAULT_REVIEW_MAX_ROUNDS = 6;

/**
 * Effective reviewer settings for a project, or null when the role is not
 * enabled. Throws when it is enabled but unusable (no identity), so a
 * misconfiguration is loud instead of silently skipping reviews.
 */
export function resolveReviewerConfig(
  project: ProjectConfig,
  defaults: DefaultPlugins,
  maxRounds: number = DEFAULT_REVIEW_MAX_ROUNDS,
): ResolvedReviewerConfig | null {
  const reviewer = project.reviewer;
  if (!reviewer?.enabled) return null;
  if (!reviewer.githubUser) {
    throw new Error(
      `Project "${project.name}": reviewer.enabled is true but reviewer.githubUser is not set`,
    );
  }
  const agent = reviewer.agent ?? project.worker?.agent ?? project.agent ?? defaults.agent;
  const agentConfig = reviewer.agentConfig ?? {};
  return {
    githubUser: reviewer.githubUser,
    agent,
    ...(agentConfig.model ? { model: agentConfig.model } : {}),
    ...(agentConfig.reasoningEffort ? { reasoningEffort: agentConfig.reasoningEffort } : {}),
    timeoutMinutes: reviewer.timeoutMinutes ?? DEFAULT_REVIEW_TIMEOUT_MINUTES,
    maxConcurrent: reviewer.maxConcurrent ?? DEFAULT_REVIEW_MAX_CONCURRENT,
    postMode: reviewer.postMode ?? "live",
    ...(reviewer.rulesFile ? { rulesFile: reviewer.rulesFile } : {}),
    maxRounds,
    ...(typeof agentConfig["sandbox"] === "string" && REVIEW_SANDBOX_MODES.has(agentConfig["sandbox"])
      ? { sandbox: agentConfig["sandbox"] as ReviewSandboxMode }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Verdict schema
// ---------------------------------------------------------------------------

/**
 * JSON schema handed to the agent (`codex --output-schema`, `claude --json-schema`).
 * Strict-mode friendly: every property required, nullable where optional.
 */
export const REVIEW_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "criteria", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes", "comment"] },
    summary: { type: "string" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "status", "evidence"],
        properties: {
          text: { type: "string" },
          status: { type: "string", enum: ["met", "unmet", "unclear"] },
          evidence: { type: ["string", "null"] },
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "severity",
          "title",
          "body",
          "filePath",
          "startLine",
          "endLine",
          "confidence",
          "blocking",
        ],
        properties: {
          severity: { type: "string", enum: ["info", "warning", "error"] },
          title: { type: "string" },
          body: { type: "string" },
          filePath: { type: ["string", "null"] },
          startLine: { type: ["integer", "null"] },
          endLine: { type: ["integer", "null"] },
          confidence: { type: ["number", "null"] },
          blocking: { type: "boolean" },
        },
      },
    },
  },
} as const;

const nullableString = z.string().nullable().optional();
const nullableInt = z.number().int().positive().nullable().optional();

export const ReviewOutputSchema = z.object({
  verdict: z.enum(["approve", "request_changes", "comment"]),
  summary: z.string(),
  criteria: z
    .array(
      z.object({
        text: z.string(),
        status: z.enum(["met", "unmet", "unclear"]),
        evidence: nullableString,
      }),
    )
    .default([]),
  findings: z
    .array(
      z.object({
        severity: z.enum(["info", "warning", "error"]),
        title: z.string(),
        body: z.string(),
        filePath: nullableString,
        startLine: nullableInt,
        endLine: nullableInt,
        confidence: z.number().min(0).max(1).nullable().optional(),
        blocking: z.boolean().default(false),
      }),
    )
    .default([]),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/**
 * A verdict with no criteria and no findings whose summary reports that the
 * agent's sandbox or file access failed is not a review; posting it would only
 * add noise to the PR. Returns the reason when that is the case.
 */
export function reviewerCouldNotRun(output: ReviewOutput): string | null {
  if (output.criteria.length > 0 || output.findings.length > 0) return null;
  if (output.verdict !== "comment") return null;
  const summary = output.summary;
  if (/\bbwrap\b|sandbox (failed|error|could not)|operation not permitted|could not read|unable to read|cannot read/i.test(summary)) {
    return summary.replace(/\s+/g, " ").slice(0, 300);
  }
  return null;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence?.[1] ?? trimmed;
}

/**
 * Parse the agent's output file. Accepts the bare verdict object, a Claude
 * `--output-format json` envelope (`structured_output` or a JSON string in
 * `result`), and fenced JSON.
 */
export function parseReviewOutput(raw: string): ReviewOutput {
  const text = stripCodeFence(raw);
  if (text.length === 0) throw new Error("reviewer produced no output");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("reviewer output is not valid JSON");
  }
  if (value && typeof value === "object" && !("verdict" in (value as object))) {
    const envelope = value as Record<string, unknown>;
    if (envelope["structured_output"] && typeof envelope["structured_output"] === "object") {
      value = envelope["structured_output"];
    } else if (typeof envelope["result"] === "string") {
      try {
        value = JSON.parse(stripCodeFence(envelope["result"]));
      } catch {
        throw new Error("reviewer output envelope has no JSON verdict in `result`");
      }
    }
  }
  const parsed = ReviewOutputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `reviewer output does not match the verdict schema: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown"}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Context + prompt
// ---------------------------------------------------------------------------

export interface ReviewContextInput {
  pr: PRInfo;
  headSha: string;
  baseRef: string;
  round: number;
  issueText?: string;
  changedFiles: string[];
  reviews: Review[];
  unresolvedThreads: ReviewComment[];
  reviewerLogin: string;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

export function formatReviewContext(input: ReviewContextInput): string {
  const lines: string[] = [];
  lines.push(`# Review context`);
  lines.push("");
  lines.push(`## Pull request`);
  lines.push(`- Repository: ${input.pr.owner}/${input.pr.repo}`);
  lines.push(`- PR #${input.pr.number}: ${input.pr.title}`);
  lines.push(`- URL: ${input.pr.url}`);
  lines.push(`- Branch: ${input.pr.branch} → ${input.pr.baseBranch}`);
  lines.push(`- Head under review: ${input.headSha} (checked out as HEAD in this workspace)`);
  lines.push(`- Base ref for diffs: ${input.baseRef}`);
  lines.push(`- Review round: ${input.round}`);
  lines.push("");
  lines.push(`## Changed files (${input.changedFiles.length})`);
  for (const f of input.changedFiles) lines.push(`- ${f}`);
  if (input.changedFiles.length === 0) lines.push("- (none detected)");
  lines.push("");
  lines.push(`## Issue`);
  lines.push(input.issueText?.trim() || "(no linked issue found — review the PR description and the diff on their own terms)");
  lines.push("");
  const priorReviews = input.reviews
    .filter((r) => r.body && r.body.trim().length > 0)
    .slice(-5);
  lines.push(`## Previous reviews (${priorReviews.length} shown)`);
  if (priorReviews.length === 0) lines.push("(none)");
  for (const r of priorReviews) {
    const mine = r.author.toLowerCase() === input.reviewerLogin.toLowerCase() ? " (yours)" : "";
    lines.push(`### ${r.author}${mine} — ${r.state} — ${r.submittedAt.toISOString()}`);
    lines.push(r.body?.trim() ?? "");
    lines.push("");
  }
  lines.push(`## Unresolved review threads (${input.unresolvedThreads.length})`);
  if (input.unresolvedThreads.length === 0) lines.push("(none)");
  for (const t of input.unresolvedThreads) {
    const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "(general)";
    lines.push(`- ${where} — ${t.author}: ${t.body.trim().replace(/\s+/g, " ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

export interface ReviewPromptInput {
  contextFile: string;
  rulesText?: string;
  skills?: string[];
}

export const DEFAULT_REVIEW_SKILLS = ["conventions:review", "code-review"];

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const skills = input.skills ?? DEFAULT_REVIEW_SKILLS;
  const lines: string[] = [
    "You are the independent code reviewer for one pull request. You act on behalf of the reviewer account named in the context; the orchestrator posts your verdict to GitHub for you.",
    "",
    "## Ground rules",
    "- This workspace is a detached checkout of the PR head. Read only. Do not edit, create or delete files, do not commit, do not run builds, tests, linters or package managers. CI already covers those.",
    "- You have no network access and no GitHub token. Everything you need about the PR, the issue and earlier reviews is in the context file; do not try to fetch more.",
    `- Read ${input.contextFile} first.`,
    skills.length > 0
      ? `- If skills named ${skills.map((s) => `\`${s}\``).join(", ")} are available to you, load them before reviewing and follow them.`
      : "",
    "",
    "## What to review",
    "- Inspect the change with `git diff <base ref>...HEAD` (the base ref is in the context) and read surrounding code as needed.",
    "- Verify every acceptance criterion of the linked issue against HEAD. Mark each `met`, `unmet` or `unclear` and cite the evidence (file, function, behaviour).",
    "- Look for real defects: wrong behaviour, missing error handling, security problems, broken contracts, regressions, tests that no longer prove what they claim. Prefer precision over volume; skip style nits unless a loaded skill requires them.",
    "- If earlier reviews requested changes, check whether each request was addressed; do not repeat resolved threads.",
    "",
    "## Verdict",
    "- `request_changes` when any criterion is unmet or any finding is blocking.",
    "- `approve` when all criteria are met (or there is no issue and the change is sound) and no blocking finding remains.",
    "- `comment` only when you genuinely cannot judge (for example, the criteria are unclear and there are no defects).",
    "- Mark a finding `blocking: true` only for defects or unmet criteria that must be fixed before merge. Give `filePath` and `startLine` (line in the new file) for anything tied to a specific location so it can be posted inline.",
    "",
    "## Output",
    "- Your final answer must be exactly one JSON object matching the provided schema and nothing else: no prose before or after, no code fence. The harness stores it and posts the review.",
    "- `summary` is what the PR author reads first: two to five sentences, concrete, no filler.",
  ];
  if (input.rulesText && input.rulesText.trim().length > 0) {
    lines.push("", "## Project review rules", input.rulesText.trim());
  }
  return lines.filter((l) => l !== undefined).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Review body + submission mapping
// ---------------------------------------------------------------------------

export interface ReviewSubmissionBuildInput {
  output: ReviewOutput;
  headSha: string;
  round: number;
  runId: string;
  agent: string;
}

function criteriaTable(output: ReviewOutput): string[] {
  if (output.criteria.length === 0) return [];
  const rows = output.criteria.map((c) => {
    const mark = c.status === "met" ? "✅ met" : c.status === "unmet" ? "❌ unmet" : "❔ unclear";
    const evidence = (c.evidence ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
    const text = c.text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
    return `| ${text} | ${mark} | ${evidence} |`;
  });
  return ["### Acceptance criteria", "", "| Criterion | Status | Evidence |", "|---|---|---|", ...rows, ""];
}

export function buildReviewSubmission(input: ReviewSubmissionBuildInput): ReviewSubmission {
  const { output } = input;
  const inline: ReviewSubmissionComment[] = [];
  const notes: string[] = [];
  for (const f of output.findings) {
    const location = f.filePath ? `\`${f.filePath}${f.startLine ? `:${f.startLine}` : ""}\`` : undefined;
    const tag = f.blocking ? "**Blocking**" : f.severity === "error" ? "**Error**" : f.severity === "warning" ? "Warning" : "Note";
    const confidence = typeof f.confidence === "number" ? ` (confidence ${Math.round(f.confidence * 100)}%)` : "";
    if (f.blocking && f.filePath && f.startLine) {
      inline.push({
        path: f.filePath,
        line: f.endLine && f.endLine > f.startLine ? f.endLine : f.startLine,
        ...(f.endLine && f.endLine > f.startLine ? { startLine: f.startLine } : {}),
        side: "RIGHT",
        body: `${tag}: ${f.title}${confidence}\n\n${f.body}`,
      });
    } else {
      notes.push(`- ${tag}${location ? ` ${location}` : ""}: **${f.title}**${confidence} — ${f.body}`);
    }
  }
  const lines: string[] = [output.summary.trim(), ""];
  lines.push(...criteriaTable(output));
  if (notes.length > 0) lines.push("### Findings", "", ...notes, "");
  lines.push(
    `<sub>AO review run ${input.runId} · head ${short(input.headSha)} · round ${input.round} · agent ${input.agent}</sub>`,
  );
  const event =
    output.verdict === "approve" ? "approve" : output.verdict === "request_changes" ? "request_changes" : "comment";
  return {
    commitId: input.headSha,
    event,
    body: lines.join("\n"),
    ...(inline.length > 0 ? { comments: inline } : {}),
  };
}

// ---------------------------------------------------------------------------
// Environment for the reviewer session
// ---------------------------------------------------------------------------

/** Variables a headless reviewer legitimately needs; everything else stays out. */
export const REVIEWER_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "NO_COLOR",
  "FORCE_COLOR",
] as const;

export interface ReviewerEnvironmentInput {
  sessionId: string;
  runId: string;
  workerSessionId: string;
  projectId: string;
  agent: string;
  env?: NodeJS.ProcessEnv;
}

/** Explicit environment for the reviewer process (no tokens, no engine secrets). */
export function buildReviewerEnvironment(input: ReviewerEnvironmentInput): Record<string, string> {
  const source = input.env ?? process.env;
  const out: Record<string, string> = {};
  for (const key of REVIEWER_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  out["PATH"] = buildAgentPath(source["PATH"]);
  out["GH_PATH"] = PREFERRED_GH_PATH;
  out["AO_CALLER_TYPE"] = "reviewer";
  out["AO_REVIEW_RUN"] = input.runId;
  out["AO_REVIEW_SESSION"] = input.sessionId;
  out["AO_REVIEW_WORKER_SESSION"] = input.workerSessionId;
  out["AO_REVIEW_HARNESS"] = input.agent;
  out["AO_PROJECT_ID"] = input.projectId;
  return out;
}

/**
 * Wrap the agent command so it runs with exactly `environment` (tmux panes
 * otherwise inherit the engine's whole environment), then record the exit code.
 */
export function wrapReviewCommand(
  reviewCommand: string,
  environment: Record<string, string>,
  exitFile: string,
): string {
  const pairs = Object.entries(environment)
    .map(([k, v]) => `${k}=${shellEscape(v)}`)
    .join(" ");
  const inner = `${reviewCommand}; echo $? > ${shellEscape(exitFile)}`;
  return `env -i ${pairs} bash -c ${shellEscape(inner)}`;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface NativeReviewDeps {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
  session: Session;
  reviewer: ResolvedReviewerConfig;
  store: CodeReviewStore;
  scm: SCM;
  tracker?: Tracker;
  runtime: Runtime;
  agent: Agent;
  /** Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  git?: (args: string[], cwd: string) => Promise<string>;
  prepareWorkspace?: typeof prepareGitReviewerWorkspace;
  /** Called once the review finished; default keeps the pane 30 min then destroys it. */
  releasePane?: (handle: RuntimeHandle, runtime: Runtime) => void;
  keepPaneMs?: number;
}

export interface NativeReviewResult {
  run: CodeReviewRun;
  output?: ReviewOutput;
  submission?: ReviewSubmission;
  posted?: SubmittedReview;
}

const REVIEW_DIR = ".ao-review";

async function defaultGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout.trim();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultReleasePane(handle: RuntimeHandle, runtime: Runtime, keepMs: number): void {
  if (keepMs <= 0) {
    void runtime.destroy(handle).catch(() => {});
    return;
  }
  const timer = setTimeout(() => {
    void runtime.destroy(handle).catch(() => {});
  }, keepMs);
  timer.unref();
}

export function reviewRoundFor(store: CodeReviewStore, linkedSessionId: string): number {
  const prior = store
    .listRuns({ linkedSessionId })
    .filter((r) => r.status !== "outdated" && r.status !== "cancelled");
  return prior.length; // includes the run being executed when called after createRun
}

function findClosesReference(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const match = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  return match?.[1];
}

async function loadIssueText(deps: NativeReviewDeps): Promise<string | undefined> {
  const tracker = deps.tracker;
  if (!tracker) return undefined;
  let issueId: string | undefined =
    deps.session.issueId ?? deps.session.metadata["issue"] ?? undefined;
  if (!issueId) {
    const summary = await deps.scm.getPRSummary?.(deps.session.pr as PRInfo).catch(() => null);
    const body = (summary as { body?: string } | null)?.body;
    issueId = findClosesReference(body);
  }
  if (!issueId) return undefined;
  try {
    return await tracker.generatePrompt(issueId, deps.project);
  } catch {
    try {
      const issue = await tracker.getIssue(issueId, deps.project);
      return `${issue.title}\n\n${issue.description}\n\n${issue.url}`;
    } catch {
      return undefined;
    }
  }
}

/**
 * Run one native review for `run` (already created via
 * triggerCodeReviewForSession with targetSha = headSha). Never throws for
 * reviewer failures: the run is marked `failed` with a reason and returned.
 * Throws only for programming errors (missing PR, missing agent support).
 */
export async function executeNativeReview(
  deps: NativeReviewDeps,
  run: CodeReviewRun,
): Promise<NativeReviewResult> {
  const { store, reviewer, session, project, projectId } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const git = deps.git ?? defaultGit;
  const prepareWorkspace = deps.prepareWorkspace ?? prepareGitReviewerWorkspace;
  const pr = session.pr;
  if (!pr) throw new Error(`Session ${session.id} has no PR to review`);
  const headSha = run.targetSha;
  if (!headSha) throw new Error(`Review run ${run.id} has no target SHA`);
  if (!deps.agent.getReviewCommand) {
    throw new Error(`Agent "${deps.agent.name}" cannot run headless reviews (no getReviewCommand)`);
  }
  const round = reviewRoundFor(store, session.id);
  const fail = (reason: string): NativeReviewResult => {
    const failed = store.updateRun(
      run.id,
      { status: "failed", terminationReason: reason, completedAt: now().toISOString() },
      now(),
    );
    recordActivityEvent({
      projectId,
      sessionId: session.id,
      source: "review",
      kind: "review.native_failed",
      level: "warn",
      summary: `native review ${run.id} failed: ${reason.slice(0, 200)}`,
      data: { runId: run.id, headSha, round, agent: reviewer.agent },
    });
    return { run: failed };
  };

  store.updateRun(
    run.id,
    {
      status: "preparing",
      startedAt: now().toISOString(),
      agent: reviewer.agent,
      githubUser: reviewer.githubUser,
      postMode: reviewer.postMode,
      round,
    },
    now(),
  );

  // 1. Workspace at the exact head SHA GitHub has.
  let workspacePath: string;
  try {
    await git(["fetch", "--quiet", "origin", pr.baseBranch, `refs/pull/${pr.number}/head`], project.path);
    workspacePath = await prepareWorkspace({
      projectId,
      project,
      session,
      run: { ...run, targetSha: headSha },
    });
    const checkedOut = await git(["rev-parse", "HEAD"], workspacePath);
    if (checkedOut !== headSha) {
      return fail(`workspace HEAD ${checkedOut} does not match PR head ${headSha}`);
    }
  } catch (err) {
    return fail(`workspace preparation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  store.updateRun(run.id, { reviewerWorkspacePath: workspacePath }, now());

  // 2. Context the agent cannot fetch itself.
  const baseRef = `origin/${pr.baseBranch}`;
  let changedFiles: string[];
  try {
    const out = await git(["diff", "--name-status", `${baseRef}...HEAD`], workspacePath);
    changedFiles = out.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    changedFiles = [];
  }
  const [reviews, threadsResult, issueText] = await Promise.all([
    deps.scm.getReviews(pr).catch(() => [] as Review[]),
    deps.scm.getReviewThreads
      ? deps.scm.getReviewThreads(pr, { forceFresh: true }).catch(() => null)
      : Promise.resolve(null),
    loadIssueText(deps),
  ]);
  const unresolvedThreads = (threadsResult?.threads ?? []).filter((t) => !t.isResolved);
  const reviewDir = join(workspacePath, REVIEW_DIR);
  mkdirSync(reviewDir, { recursive: true });
  const contextFile = join(reviewDir, "context.md");
  const promptFile = join(reviewDir, "prompt.md");
  const schemaFile = join(reviewDir, "schema.json");
  const outputFile = join(reviewDir, "result.json");
  const exitFile = join(reviewDir, "exit");
  const payloadFile = join(reviewDir, "review.json");
  let rulesText: string | undefined;
  if (reviewer.rulesFile && existsSync(reviewer.rulesFile)) {
    rulesText = readFileSync(reviewer.rulesFile, "utf-8");
  }
  atomicWriteFileSync(
    contextFile,
    formatReviewContext({
      pr,
      headSha,
      baseRef,
      round,
      ...(issueText ? { issueText } : {}),
      changedFiles,
      reviews,
      unresolvedThreads,
      reviewerLogin: reviewer.githubUser,
    }),
  );
  atomicWriteFileSync(
    promptFile,
    buildReviewPrompt({ contextFile: REVIEW_DIR + "/context.md", ...(rulesText ? { rulesText } : {}) }),
  );
  atomicWriteFileSync(schemaFile, JSON.stringify(REVIEW_OUTPUT_JSON_SCHEMA, null, 2));

  // 3. Launch in tmux with an explicit environment.
  const environment = buildReviewerEnvironment({
    sessionId: run.reviewerSessionId,
    runId: run.id,
    workerSessionId: session.id,
    projectId,
    agent: reviewer.agent,
    ...(deps.env ? { env: deps.env } : {}),
  });
  const reviewCommand = deps.agent.getReviewCommand({
    workspacePath,
    promptFile,
    schemaFile,
    outputFile,
    ...(reviewer.model ? { model: reviewer.model } : {}),
    ...(reviewer.reasoningEffort ? { reasoningEffort: reviewer.reasoningEffort } : {}),
    ...(reviewer.sandbox ? { sandbox: reviewer.sandbox } : {}),
  });
  let handle: RuntimeHandle;
  try {
    handle = await deps.runtime.create({
      sessionId: run.reviewerSessionId,
      workspacePath,
      launchCommand: wrapReviewCommand(reviewCommand, environment, exitFile),
      environment,
    });
  } catch (err) {
    return fail(`could not start reviewer session: ${err instanceof Error ? err.message : String(err)}`);
  }
  store.updateRun(run.id, { status: "running", tmuxName: handle.id }, now());
  recordActivityEvent({
    projectId,
    sessionId: session.id,
    source: "review",
    kind: "review.native_started",
    summary: `native review ${run.id} started in ${handle.id} (round ${round}, ${reviewer.agent})`,
    data: { runId: run.id, headSha, round, agent: reviewer.agent, tmuxName: handle.id },
  });

  // 4. Wait for the exit marker.
  const deadline = now().getTime() + reviewer.timeoutMinutes * 60_000;
  const pollMs = deps.pollIntervalMs ?? 10_000;
  let exitCode: number | undefined;
  while (true) {
    if (existsSync(exitFile)) {
      const raw = readFileSync(exitFile, "utf-8").trim();
      exitCode = raw.length > 0 ? Number(raw) : Number.NaN;
      break;
    }
    if (now().getTime() >= deadline) {
      await deps.runtime.destroy(handle).catch(() => {});
      return fail(`reviewer exceeded ${reviewer.timeoutMinutes} min timeout`);
    }
    if (!(await deps.runtime.isAlive(handle).catch(() => true))) {
      return fail("reviewer session disappeared before writing a result");
    }
    await sleep(pollMs);
  }
  const release = (): void => {
    if (deps.releasePane) deps.releasePane(handle, deps.runtime);
    else defaultReleasePane(handle, deps.runtime, deps.keepPaneMs ?? 30 * 60_000);
  };

  // 5. Parse + persist findings.
  let output: ReviewOutput;
  try {
    if (!existsSync(outputFile)) {
      const tail = await deps.runtime.getOutput(handle, 40).catch(() => "");
      throw new Error(
        `no result file (exit code ${Number.isNaN(exitCode) ? "unknown" : exitCode})${tail ? `; last output: ${tail.trim().slice(-600)}` : ""}`,
      );
    }
    output = parseReviewOutput(readFileSync(outputFile, "utf-8"));
    const couldNotRun = reviewerCouldNotRun(output);
    if (couldNotRun) throw new Error(`reviewer could not run: ${couldNotRun}`);
  } catch (err) {
    release();
    return fail(err instanceof Error ? err.message : String(err));
  }
  store.updateRun(run.id, { reviewerOutputPath: outputFile, verdict: output.verdict, summary: output.summary }, now());
  for (const f of output.findings) {
    store.createFinding(
      {
        runId: run.id,
        linkedSessionId: session.id,
        severity: f.severity,
        title: f.title,
        body: f.body,
        ...(f.filePath ? { filePath: f.filePath } : {}),
        ...(f.startLine ? { startLine: f.startLine } : {}),
        ...(f.endLine ? { endLine: f.endLine } : {}),
        ...(typeof f.confidence === "number" ? { confidence: f.confidence } : {}),
        category: f.blocking ? "blocking" : "note",
      },
      now(),
    );
  }

  // 6. Post (or record) the review.
  const submission = buildReviewSubmission({
    output,
    headSha,
    round,
    runId: run.id,
    agent: reviewer.agent,
  });
  atomicWriteFileSync(payloadFile, JSON.stringify(submission, null, 2));
  const settledStatus =
    output.verdict === "approve" ? "clean" : output.verdict === "request_changes" ? "sent_to_agent" : "needs_triage";
  if (reviewer.postMode === "dry-run") {
    const dry = store.updateRun(
      run.id,
      { status: "needs_triage", payloadPath: payloadFile, completedAt: now().toISOString(), summary: `dry-run: ${output.verdict}` },
      now(),
    );
    release();
    return { run: dry, output, submission };
  }
  if (!deps.scm.submitReview) {
    release();
    return fail(`SCM plugin "${project.scm?.plugin ?? "?"}" cannot submit reviews`);
  }
  const token = getIdentityToken(deps.config, reviewer.githubUser, deps.env);
  if (!token) {
    release();
    return fail(`no token for reviewer identity "${reviewer.githubUser}" in the environment`);
  }
  let posted: SubmittedReview;
  try {
    posted = await deps.scm.submitReview(pr, submission, { token });
  } catch (err) {
    release();
    return fail(`posting the review failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const done = store.updateRun(
    run.id,
    {
      status: settledStatus,
      payloadPath: payloadFile,
      githubReviewId: posted.id,
      ...(posted.url ? { githubReviewUrl: posted.url } : {}),
      completedAt: now().toISOString(),
    },
    now(),
  );
  recordActivityEvent({
    projectId,
    sessionId: session.id,
    source: "review",
    kind: "review.native_posted",
    summary: `native review ${run.id}: ${output.verdict} posted as ${reviewer.githubUser}${posted.droppedComments ? ` (${posted.droppedComments} inline comment(s) folded into body)` : ""}`,
    data: { runId: run.id, headSha, round, verdict: output.verdict, reviewId: posted.id, url: posted.url },
  });
  release();
  return { run: done, output, submission, posted };
}
