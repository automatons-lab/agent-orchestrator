/** Fork: AO-native reviewer — prompt/context/schema, verdict parsing, posting, execution. */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Keep the shared activity-events database out of unit tests.
vi.mock("../activity-events.js", () => ({ recordActivityEvent: vi.fn() }));

import { validateConfig } from "../config.js";
import { createCodeReviewStore, type CodeReviewRun } from "../code-review-store.js";
import {
  buildReviewPrompt,
  buildReviewSubmission,
  buildReviewerEnvironment,
  executeNativeReview,
  formatReviewContext,
  contextPrInfo,
  countsAsReviewRound,
  reviewRoundFor,
  parseReviewOutput,
  resolveReviewerConfig,
  reviewerCouldNotRun,
  wrapReviewCommand,
  type ReviewOutput,
  type NativeReviewDeps,
} from "../native-review.js";
import type { Agent, PRInfo, ReviewCommandConfig, Runtime, RuntimeCreateConfig, RuntimeHandle, SCM, Session, Tracker } from "../types.js";

const config = validateConfig({
  identities: { neo: { tokenEnv: "NEO_TOKEN" }, trinity: { tokenEnv: "TRI_TOKEN" } },
  defaults: {
    agent: "codex",
    worker: { githubUser: "neo", agent: "codex" },
    reviewer: {
      githubUser: "trinity",
      agent: "codex",
      agentConfig: { model: "gpt-6-astra", reasoningEffort: "xhigh" },
      enabled: true,
      timeoutMinutes: 1,
    },
  },
  projects: {
    app: { path: "/repos/app", repo: "org/app", defaultBranch: "main", sessionPrefix: "app" },
  },
});
const project = config.projects["app"]!;

const pr: PRInfo = {
  number: 7,
  url: "https://github.com/org/app/pull/7",
  title: "Add login",
  owner: "org",
  repo: "app",
  branch: "12.add-login",
  baseBranch: "main",
  isDraft: false,
} as PRInfo;

const sampleOutput: ReviewOutput = {
  verdict: "request_changes",
  summary: "Login works but the token is logged.",
  criteria: [
    { text: "User can log in", status: "met", evidence: "auth.ts handleLogin" },
    { text: "No secrets in logs", status: "unmet", evidence: "auth.ts:42 logs the token" },
  ],
  findings: [
    {
      severity: "error",
      title: "Token written to log",
      body: "Remove the console.log of the raw token.",
      filePath: "src/auth.ts",
      startLine: 42,
      endLine: null,
      confidence: 0.95,
      blocking: true,
    },
    {
      severity: "info",
      title: "Naming",
      body: "handleLogin could be named login.",
      filePath: null,
      startLine: null,
      endLine: null,
      confidence: null,
      blocking: false,
    },
  ],
};

describe("resolveReviewerConfig", () => {
  it("returns null when disabled and merges role settings when enabled", () => {
    expect(resolveReviewerConfig({ ...project, reviewer: undefined }, config.defaults)).toBeNull();
    expect(resolveReviewerConfig(project, config.defaults, 4)).toEqual({
      githubUser: "trinity",
      agent: "codex",
      model: "gpt-6-astra",
      reasoningEffort: "xhigh",
      timeoutMinutes: 1,
      maxConcurrent: 1,
      postMode: "live",
      maxRounds: 4,
    });
  });

  it("passes a valid agentConfig.sandbox through and ignores unknown values", () => {
    const withSandbox = { ...project, reviewer: { ...project.reviewer, agentConfig: { sandbox: "danger-full-access" } } };
    expect(resolveReviewerConfig(withSandbox, config.defaults)?.sandbox).toBe("danger-full-access");
    const bogus = { ...project, reviewer: { ...project.reviewer, agentConfig: { sandbox: "yolo" } } };
    expect(resolveReviewerConfig(bogus, config.defaults)?.sandbox).toBeUndefined();
  });

  it("throws when enabled without an identity", () => {
    expect(() =>
      resolveReviewerConfig({ ...project, reviewer: { enabled: true } }, config.defaults),
    ).toThrow(/reviewer\.githubUser is not set/);
  });
});

describe("reviewerCouldNotRun", () => {
  it("flags an empty comment verdict that reports a sandbox failure, nothing else", () => {
    const broken: ReviewOutput = {
      verdict: "comment",
      summary: "The sandbox failed before any read command ran: `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`.",
      criteria: [],
      findings: [],
    };
    expect(reviewerCouldNotRun(broken)).toMatch(/bwrap/);
    expect(reviewerCouldNotRun({ ...broken, summary: "Nothing to add, looks fine." })).toBeNull();
    expect(reviewerCouldNotRun({ ...sampleOutput, verdict: "comment" })).toBeNull();
  });
});

describe("parseReviewOutput", () => {
  it("accepts a bare verdict, a Claude envelope and fenced JSON", () => {
    const bare = JSON.stringify(sampleOutput);
    expect(parseReviewOutput(bare).verdict).toBe("request_changes");
    expect(parseReviewOutput(JSON.stringify({ result: bare, structured_output: undefined })).findings).toHaveLength(2);
    expect(parseReviewOutput(JSON.stringify({ structured_output: sampleOutput })).summary).toMatch(/logged/);
    expect(parseReviewOutput("```json\n" + bare + "\n```").criteria).toHaveLength(2);
  });

  it("rejects empty, non-JSON and off-schema output with a clear reason", () => {
    expect(() => parseReviewOutput("")).toThrow(/no output/);
    expect(() => parseReviewOutput("not json")).toThrow(/not valid JSON/);
    expect(() => parseReviewOutput(JSON.stringify({ verdict: "maybe", summary: "x" }))).toThrow(
      /verdict/,
    );
  });
});

describe("context, prompt and submission", () => {
  it("formats the context with PR, files, issue, prior reviews and unresolved threads", () => {
    const text = formatReviewContext({
      pr,
      headSha: "abcdef1234567890",
      baseRef: "origin/main",
      round: 2,
      issueText: "## Issue 12\nAdd login",
      changedFiles: ["M\tsrc/auth.ts"],
      reviews: [
        { author: "trinity", state: "changes_requested", body: "Fix the log", submittedAt: new Date("2026-09-19T10:00:00Z") },
        { author: "someone", state: "commented", body: "", submittedAt: new Date("2026-09-19T11:00:00Z") },
      ],
      unresolvedThreads: [
        { id: "1", author: "trinity", body: "still logs", path: "src/auth.ts", line: 42, isResolved: false, createdAt: new Date(), url: "u" },
      ],
      reviewerLogin: "trinity",
    });
    expect(text).toContain("PR #7: Add login");
    expect(text).toContain("Review round: 2");
    expect(text).toContain("Diff to review: `git diff origin/main...HEAD`");
    expect(text).toContain("CI on this head, as reported to the orchestrator: unknown");
    expect(text).toContain("M\tsrc/auth.ts");
    expect(text).toContain("Add login");
    expect(text).toContain("trinity (yours) — changes_requested");
    expect(text).not.toContain("someone");
    expect(text).toContain("src/auth.ts:42 — trinity: still logs");
  });

  it("builds a prompt that names the context file, skills and project rules", () => {
    const prompt = buildReviewPrompt({ contextFile: ".ao-review/context.md", rulesText: "Never approve TODOs." });
    expect(prompt).toContain("Read .ao-review/context.md first");
    expect(prompt).toContain("`conventions:review`, `code-review`");
    expect(prompt).toContain("## Project review rules\nNever approve TODOs.");
    expect(prompt).toContain("exactly one JSON object");
  });

  it("maps blocking located findings to inline comments and the rest into the body", () => {
    const submission = buildReviewSubmission({
      output: sampleOutput,
      headSha: "abcdef1234567890",
      round: 1,
      runId: "run-1",
      agent: "codex",
    });
    expect(submission.event).toBe("request_changes");
    expect(submission.commitId).toBe("abcdef1234567890");
    expect(submission.comments).toEqual([
      expect.objectContaining({ path: "src/auth.ts", line: 42, side: "RIGHT" }),
    ]);
    expect(submission.comments?.[0]?.body).toContain("**Blocking**: Token written to log (confidence 95%)");
    expect(submission.body).toContain("| No secrets in logs | ❌ unmet | auth.ts:42 logs the token |");
    expect(submission.body).toContain("Note: **Naming** — handleLogin could be named login.");
    expect(submission.body).toContain("AO review run run-1 · head abcdef1 · round 1 · agent codex");
    expect(buildReviewSubmission({ output: { ...sampleOutput, verdict: "approve", findings: [] }, headSha: "a", round: 1, runId: "r", agent: "codex" }).event).toBe("approve");
  });
});

describe("reviewer environment", () => {
  it("passes only allowlisted variables plus AO markers and never a token", () => {
    const env = buildReviewerEnvironment({
      sessionId: "app-rev-1",
      runId: "run-1",
      workerSessionId: "app-3",
      projectId: "app",
      agent: "codex",
      env: { HOME: "/home/x", PATH: "/usr/bin", GH_TOKEN: "secret", NEO_TOKEN: "s2", DISCORD_WEBHOOK: "s3", TERM: "xterm" },
    });
    expect(env["HOME"]).toBe("/home/x");
    expect(env["TERM"]).toBe("xterm");
    expect(env["PATH"]).toContain("/usr/bin");
    expect(env["AO_CALLER_TYPE"]).toBe("reviewer");
    expect(env["AO_REVIEW_WORKER_SESSION"]).toBe("app-3");
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(["GH_TOKEN", "NEO_TOKEN", "DISCORD_WEBHOOK"]));
  });

  it("wraps the command in env -i with the explicit variables and an exit marker", () => {
    const cmd = wrapReviewCommand("codex exec --sandbox read-only", { HOME: "/h", PATH: "/b" }, "/ws/.ao-review/exit");
    expect(cmd).toBe("env -i HOME='/h' PATH='/b' bash -c 'codex exec --sandbox read-only; echo $? > '\\''/ws/.ao-review/exit'\\'''");
  });
});

// ---------------------------------------------------------------------------
// executeNativeReview with fakes
// ---------------------------------------------------------------------------

function makeHarness(opts: {
  agentOutput?: string | null;
  exitCode?: number;
  postMode?: "live" | "dry-run";
  env?: NodeJS.ProcessEnv;
  submitError?: Error;
  neverExit?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "ao-native-review-"));
  const storeDir = join(root, "store");
  const workspacePath = join(root, "ws");
  mkdirSync(workspacePath, { recursive: true });
  const store = createCodeReviewStore("app", { storeDir });
  const session = {
    id: "app-3",
    projectId: "app",
    status: "pr_open",
    branch: "12.add-login",
    issueId: "12",
    pr,
    workspacePath: join(root, "worker"),
    metadata: {},
  } as unknown as Session;
  const run = store.createRun({
    linkedSessionId: session.id,
    reviewerSessionId: "app-rev-1",
    targetSha: "abcdef1234567890",
    prNumber: 7,
    prUrl: pr.url,
  });
  const gitCalls: string[][] = [];
  const git = async (args: string[]): Promise<string> => {
    gitCalls.push(args);
    if (args[0] === "rev-parse") return "abcdef1234567890";
    if (args[0] === "merge-base") return "0000111122223333";
    if (args[0] === "diff") return "M\tsrc/auth.ts";
    return "";
  };
  const created: Array<{ launchCommand: string; environment: Record<string, string> }> = [];
  let destroyed = 0;
  const runtime: Runtime = {
    name: "tmux",
    async create(cfg: RuntimeCreateConfig) {
      created.push({ launchCommand: cfg.launchCommand, environment: cfg.environment });
      if (!opts.neverExit) {
        const dir = join(cfg.workspacePath, ".ao-review");
        if (opts.agentOutput !== null) {
          writeFileSync(join(dir, "result.json"), opts.agentOutput ?? JSON.stringify(sampleOutput));
        }
        writeFileSync(join(dir, "exit"), String(opts.exitCode ?? 0));
      }
      return { id: cfg.sessionId, runtimeName: "tmux", data: {} } as RuntimeHandle;
    },
    async destroy() {
      destroyed += 1;
    },
    async sendMessage() {},
    async getOutput() {
      return "codex: boom";
    },
    async isAlive() {
      return true;
    },
  } as unknown as Runtime;
  const submitted: unknown[] = [];
  const scm = {
    async getReviews() {
      return [];
    },
    async getReviewThreads() {
      return { threads: [], reviews: [] };
    },
    async submitReview(_pr: PRInfo, submission: unknown, auth: unknown) {
      if (opts.submitError) throw opts.submitError;
      submitted.push({ submission, auth });
      return { id: 99, url: "https://github.com/org/app/pull/7#pullrequestreview-99", state: "CHANGES_REQUESTED" };
    },
  } as unknown as SCM;
  const tracker = {
    async generatePrompt() {
      return "## Issue 12\nAdd login\n- [ ] no secrets in logs";
    },
    async getIssue() {
      throw new Error("unused");
    },
  } as unknown as Tracker;
  const agent: Agent = {
    name: "codex",
    processName: "codex",
    getLaunchCommand: () => "codex",
    getEnvironment: () => ({}),
    detectActivity: () => "unknown",
    getActivityState: async () => null,
    getReviewCommand: (cfg: ReviewCommandConfig) => `codex exec --sandbox read-only --output-schema ${cfg.schemaFile} -o ${cfg.outputFile} - < ${cfg.promptFile}`,
  } as unknown as Agent;
  let clock = new Date("2026-09-19T12:00:00Z").getTime();
  const deps: NativeReviewDeps = {
    config,
    projectId: "app",
    project: { ...project, path: root, reviewer: { ...project.reviewer, postMode: opts.postMode ?? "live" } },
    session,
    reviewer: resolveReviewerConfig(
      { ...project, reviewer: { ...project.reviewer, postMode: opts.postMode ?? "live" } },
      config.defaults,
    )!,
    store,
    scm,
    tracker,
    runtime,
    agent,
    env: opts.env ?? { TRI_TOKEN: "tok-tri", HOME: root, PATH: "/usr/bin" },
    ciStatus: "passing",
    now: () => new Date(clock),
    sleep: async () => {
      clock += 30_000;
    },
    pollIntervalMs: 1,
    git,
    prepareWorkspace: async () => workspacePath,
    releasePane: () => {
      destroyed += 100;
    },
  };
  return { root, store, run, deps, workspacePath, gitCalls, created, submitted, destroyedRef: () => destroyed, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("executeNativeReview", () => {
  it("prepares the workspace, writes context/prompt/schema, launches with a clean env and posts as the reviewer", async () => {
    const h = makeHarness({});
    try {
      const result = await executeNativeReview(h.deps, h.run);
      expect(result.run.status).toBe("sent_to_agent");
      expect(result.run.verdict).toBe("request_changes");
      expect(result.run.githubReviewId).toBe(99);
      expect(result.run.round).toBe(1);
      expect(result.run.tmuxName).toBe("app-rev-1");
      expect(h.gitCalls[0]).toEqual(["fetch", "--quiet", "origin", "main", "refs/pull/7/head"]);
      const dir = join(h.workspacePath, ".ao-review");
      const context = readFileSync(join(dir, "context.md"), "utf-8");
      expect(context).toContain("no secrets in logs");
      expect(context).toContain("Merge base: 0000111122223333");
      expect(context).toContain("Diff to review: `git diff 000011112222 HEAD`");
      expect(context).toContain("CI on this head, as reported to the orchestrator: passing");
      expect(h.gitCalls).toContainEqual(["merge-base", "origin/main", "HEAD"]);
      expect(readFileSync(join(dir, "prompt.md"), "utf-8")).toContain("Read .ao-review/context.md first");
      expect(JSON.parse(readFileSync(join(dir, "schema.json"), "utf-8")).required).toContain("verdict");
      expect(existsSync(join(dir, "review.json"))).toBe(true);
      const launch = h.created[0]!;
      expect(launch.launchCommand).toMatch(/^env -i /);
      expect(launch.launchCommand).toContain("codex exec --sandbox read-only");
      expect(launch.launchCommand).not.toContain("tok-tri");
      expect(launch.environment["GH_TOKEN"]).toBeUndefined();
      expect(launch.environment["AO_CALLER_TYPE"]).toBe("reviewer");
      const posted = h.submitted[0] as { submission: { event: string; comments: unknown[] }; auth: { token: string } };
      expect(posted.auth.token).toBe("tok-tri");
      expect(posted.submission.event).toBe("request_changes");
      expect(posted.submission.comments).toHaveLength(1);
      expect(h.store.listFindings({ runId: h.run.id })).toHaveLength(2);
      expect(h.destroyedRef()).toBe(100); // pane released, not destroyed immediately
    } finally {
      h.cleanup();
    }
  });

  it("records the payload without posting in dry-run mode", async () => {
    const h = makeHarness({ postMode: "dry-run" });
    try {
      const result = await executeNativeReview(h.deps, h.run);
      expect(result.run.status).toBe("needs_triage");
      expect(result.run.summary).toBe("dry-run: request_changes");
      expect(result.run.payloadPath).toMatch(/review\.json$/);
      expect(h.submitted).toHaveLength(0);
      expect(result.submission?.event).toBe("request_changes");
    } finally {
      h.cleanup();
    }
  });

  it("marks the run failed instead of posting when the reviewer reports it could not run", async () => {
    const h = makeHarness({
      agentOutput: JSON.stringify({ verdict: "comment", summary: "bwrap: setting up uid map: Permission denied", criteria: [], findings: [] }),
    });
    try {
      const r = await executeNativeReview(h.deps, h.run);
      expect(r.run.status).toBe("failed");
      expect(r.run.terminationReason).toMatch(/reviewer could not run: bwrap/);
      expect(h.submitted).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("fails cleanly on invalid output, missing token and posting errors", async () => {
    const bad = makeHarness({ agentOutput: "not json" });
    try {
      const r = await executeNativeReview(bad.deps, bad.run);
      expect(r.run.status).toBe("failed");
      expect(r.run.terminationReason).toMatch(/not valid JSON/);
    } finally {
      bad.cleanup();
    }
    const noFile = makeHarness({ agentOutput: null, exitCode: 2 });
    try {
      const r = await executeNativeReview(noFile.deps, noFile.run);
      expect(r.run.terminationReason).toMatch(/no result file \(exit code 2\); last output: codex: boom/);
    } finally {
      noFile.cleanup();
    }
    const noToken = makeHarness({ env: { HOME: "/h", PATH: "/usr/bin" } });
    try {
      const r = await executeNativeReview(noToken.deps, noToken.run);
      expect(r.run.terminationReason).toMatch(/no token for reviewer identity "trinity"/);
    } finally {
      noToken.cleanup();
    }
    const postFail = makeHarness({ submitError: new Error("HTTP 403") });
    try {
      const r = await executeNativeReview(postFail.deps, postFail.run);
      expect(r.run.terminationReason).toMatch(/posting the review failed: HTTP 403/);
    } finally {
      postFail.cleanup();
    }
  });

  it("times out, destroys the pane and marks the run failed", async () => {
    const h = makeHarness({ neverExit: true });
    try {
      const r = await executeNativeReview(h.deps, h.run);
      expect(r.run.status).toBe("failed");
      expect(r.run.terminationReason).toMatch(/exceeded 1 min timeout/);
      expect(h.destroyedRef()).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("falls back to the project default branch when the PR base branch is empty", async () => {
    const h = makeHarness({ postMode: "dry-run" });
    try {
      const session = { ...h.deps.session, pr: { ...pr, baseBranch: "" } } as unknown as Session;
      await executeNativeReview({ ...h.deps, session }, h.run);
      expect(h.gitCalls[0]).toEqual(["fetch", "--quiet", "origin", "main", "refs/pull/7/head"]);
      expect(h.gitCalls).toContainEqual(["merge-base", "origin/main", "HEAD"]);
    } finally {
      h.cleanup();
    }
  });

  it("refuses to run when the agent has no review command", async () => {
    const h = makeHarness({});
    try {
      const agent = { ...h.deps.agent, getReviewCommand: undefined } as unknown as Agent;
      await expect(executeNativeReview({ ...h.deps, agent }, h.run)).rejects.toThrow(/cannot run headless reviews/);
    } finally {
      h.cleanup();
    }
  });

  it("silences unused mocks", () => {
    expect(vi.isMockFunction(vi.fn())).toBe(true);
  });
});

describe("contextPrInfo", () => {
  const restored = { number: 6, title: "", branch: "5.add-modulo", baseBranch: "" } as unknown as PRInfo;

  it("fills an empty title from the enrichment and the base branch from the resolved base", () => {
    const pr = contextPrInfo(restored, "main", "feat: add modulo");
    expect(pr.title).toBe("feat: add modulo");
    expect(pr.baseBranch).toBe("main");
    expect(pr.branch).toBe("5.add-modulo");
  });

  it("keeps the session's own title when present and tolerates a missing enrichment title", () => {
    const own = contextPrInfo({ ...restored, title: "own title" }, "main", "other");
    expect(own.title).toBe("own title");
    expect(contextPrInfo(restored, "develop").title).toBe("");
    expect(contextPrInfo(restored, "develop").baseBranch).toBe("develop");
  });
});

describe("review round counting", () => {
  const run = (status: CodeReviewRun["status"], verdict?: CodeReviewRun["verdict"]): CodeReviewRun =>
    ({ id: `run-${status}-${verdict ?? "none"}`, status, ...(verdict ? { verdict } : {}) }) as unknown as CodeReviewRun;

  it("counts delivered verdicts even after the upstream trigger marked them outdated", () => {
    expect(countsAsReviewRound(run("outdated", "request_changes"))).toBe(true);
    expect(countsAsReviewRound(run("sent_to_agent", "request_changes"))).toBe(true);
    expect(countsAsReviewRound(run("running"))).toBe(true);
  });

  it("ignores superseded, cancelled and failed runs without a delivered verdict", () => {
    expect(countsAsReviewRound(run("outdated"))).toBe(false);
    expect(countsAsReviewRound(run("cancelled", "approve"))).toBe(false);
    expect(countsAsReviewRound(run("failed", "comment"))).toBe(false);
  });

  it("reviewRoundFor numbers the running review after earlier delivered rounds", () => {
    const store = {
      listRuns: () => [run("outdated", "request_changes"), run("outdated"), run("running")],
    } as unknown as Parameters<typeof reviewRoundFor>[0];
    expect(reviewRoundFor(store, "s1")).toBe(2);
  });
});
