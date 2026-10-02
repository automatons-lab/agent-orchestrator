import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as ChildProcess from "node:child_process";
import type * as Core from "@aoagents/ao-core";
import {
  createLifecycleManager,
  createSessionManager,
  createInitialCanonicalLifecycle,
  readCanonicalLifecycle,
  readMetadataRaw,
  updateMetadata,
  writeMetadata,
  getProjectSessionsDir,
  validateConfig,
  type Agent,
  type Runtime,
  type SCM,
  type Workspace,
  type PluginRegistry,
  type LifecycleManager,
  type OpenCodeSessionManager,
  type OrchestratorConfig,
  type PRState,
  type SessionKind,
} from "@aoagents/ao-core";
import { create as createCodexAgent } from "@aoagents/ao-plugin-agent-codex";
import { closeDb } from "../../../core/src/events-db.js";
import { reconcileProjectSupervisor } from "../../src/lib/project-supervisor.js";
import {
  isLifecycleWorkerRunning,
  stopAllLifecycleWorkers,
} from "../../src/lib/lifecycle-service.js";

// Keep the actual supervisor, worker timer, session listing and lifecycle pipeline.
// Use isolated config/plugins and stub writes to the daemon's running-state file.
const { mockExecFileAsync } = vi.hoisted(() => ({ mockExecFileAsync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  }),
}));
vi.mock("@aoagents/ao-core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  loadConfig: () => env.config,
  isWindows: () => false,
}));
vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => sessionManager,
  getLifecycleManager: async () => lifecycleManager,
}));
vi.mock("../../src/lib/running-state.js", () => ({
  addProjectToRunning: vi.fn(),
  removeProjectFromRunning: vi.fn(),
}));

let env: { config: OrchestratorConfig; sessionsDir: string; tmpDir: string };
let plugins: { runtime: Runtime; agent: Agent; workspace: Workspace };
let sessionManager: OpenCodeSessionManager;
let lifecycleManager: LifecycleManager;
let scm: SCM;

beforeEach(() => {
  mockExecFileAsync.mockReset();
  vi.useFakeTimers();
  const tmpDir = mkdtempSync(join(tmpdir(), "ao-supervisor-lifecycle-"));
  vi.stubEnv("HOME", tmpDir);
  vi.stubEnv("USERPROFILE", tmpDir);
  const config = validateConfig({
    defaults: { runtime: "mock", agent: "mock-agent", workspace: "mock-ws" },
    projects: {
      "my-app": { repo: "org/my-app", path: tmpDir, sessionPrefix: "app" },
    },
  });
  config.configPath = join(tmpDir, "agent-orchestrator.yaml");
  config.reactions = {};
  config.notificationRouting = { urgent: [], action: [], warning: [], info: [] };
  env = { config, sessionsDir: getProjectSessionsDir("my-app"), tmpDir };
  mkdirSync(env.sessionsDir, { recursive: true });
  plugins = {
    runtime: {
      name: "mock",
      create: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
      getOutput: vi.fn().mockResolvedValue(""),
      isAlive: vi.fn().mockResolvedValue(true),
    },
    agent: {
      name: "mock-agent",
      processName: "mock",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn().mockReturnValue({}),
      detectActivity: vi.fn().mockReturnValue("active"),
      getActivityState: vi.fn().mockResolvedValue({ state: "active", timestamp: new Date() }),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockResolvedValue(null),
    },
    workspace: {
      name: "mock-ws",
      create: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
  };
  scm = {
    name: "github",
    detectPR: vi.fn().mockResolvedValue(null),
    getPRState: vi.fn().mockResolvedValue("open"),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    getCIChecks: vi.fn().mockResolvedValue([]),
    getCISummary: vi.fn().mockResolvedValue("passing"),
    getReviews: vi.fn().mockResolvedValue([]),
    getReviewDecision: vi.fn().mockResolvedValue("none"),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getMergeability: vi.fn().mockResolvedValue({
      mergeable: false,
      ciPassing: true,
      approved: false,
      noConflicts: true,
      blockers: [],
    }),
  };
  const registry: PluginRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return plugins.runtime;
      if (slot === "agent") return plugins.agent;
      if (slot === "workspace") return plugins.workspace;
      if (slot === "scm") return scm;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
  };
  sessionManager = createSessionManager({ config: env.config, registry });
  lifecycleManager = createLifecycleManager({
    config: env.config,
    registry,
    sessionManager,
    projectId: "my-app",
  });
});

afterEach(() => {
  stopAllLifecycleWorkers();
  lifecycleManager.stop();
  vi.useRealTimers();
  closeDb();
  rmSync(env.tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  vi.unstubAllEnvs();
});

function seedSession(prState: PRState, kind: SessionKind = "worker"): void {
  const lifecycle = createInitialCanonicalLifecycle(kind);
  lifecycle.session.state = "idle";
  lifecycle.session.reason = "awaiting_external_review";
  lifecycle.session.startedAt = "2026-09-26T17:00:00.000Z";
  lifecycle.pr = {
    state: prState,
    reason: prState === "merged" ? "merged" : "review_pending",
    number: 4,
    url: "https://github.com/org/my-app/pull/4",
    lastObservedAt: "2026-09-26T18:15:42.000Z",
  };
  const runtimeHandle = { id: "app-1", runtimeName: plugins.runtime.name, data: {} };
  if (kind === "worker") {
    lifecycle.runtime.handle = runtimeHandle;
    lifecycle.runtime.state = "alive";
    lifecycle.runtime.reason = "process_running";
  }
  writeMetadata(env.sessionsDir, "app-1", {
    project: "my-app",
    role: kind,
    agent: plugins.agent.name,
    status: prState === "merged" ? "merged" : "review_pending",
    pr: lifecycle.pr.url ?? undefined,
    lifecycle: JSON.stringify(lifecycle),
    createdAt: "2026-09-26T17:00:00.000Z",
    ...(kind === "worker" ? { runtimeHandle } : {}),
  });
  vi.mocked(scm.getPRState).mockResolvedValue(prState);
}

describe("project supervisor and canonical lifecycle reconciliation", () => {
  it.each(["no server running on /tmp/tmux-1001/default\n", "can't find window: app-1\n"])(
    "finalizes a persisted Codex session through the real probe after tmux absence: %s",
    async (stderr) => {
      plugins.agent = createCodexAgent();
      plugins.runtime.name = "tmux";
      seedSession("open");
      vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
      mockExecFileAsync.mockRejectedValue(
        Object.assign(new Error(`Command failed: tmux list-panes\n${stderr}`), {
          code: 1,
          killed: false,
          signal: null,
          stdout: "",
          stderr,
        }),
      );

      await sessionManager.list("my-app");
      expect(readCanonicalLifecycle(env.sessionsDir, "app-1")?.session.state).toBe("detecting");
      await reconcileProjectSupervisor();
      expect(isLifecycleWorkerRunning("my-app")).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      const settled = readCanonicalLifecycle(env.sessionsDir, "app-1");
      expect(settled?.session).toMatchObject({
        state: "terminated",
        reason: "runtime_lost",
        startedAt: "2026-09-26T17:00:00.000Z",
        terminatedAt: expect.any(String),
      });
      expect(settled?.pr.state).toBe("open");
      expect(readMetadataRaw(env.sessionsDir, "app-1")).toMatchObject({
        createdAt: "2026-09-26T17:00:00.000Z",
        pr: "https://github.com/org/my-app/pull/4",
      });
      expect(plugins.runtime.destroy).not.toHaveBeenCalled();
      expect(plugins.workspace.destroy).not.toHaveBeenCalled();
      expect(scm.closePR).not.toHaveBeenCalled();
      expect(scm.mergePR).not.toHaveBeenCalled();

      await reconcileProjectSupervisor();
      expect(isLifecycleWorkerRunning("my-app")).toBe(false);
    },
  );

  it("preserves detecting metadata when the real Codex tmux probe is indeterminate", async () => {
    plugins.agent = createCodexAgent();
    plugins.runtime.name = "tmux";
    seedSession("open");
    const lifecycle = readCanonicalLifecycle(env.sessionsDir, "app-1");
    if (!lifecycle) throw new Error("Missing seeded lifecycle");
    lifecycle.session.state = "detecting";
    lifecycle.session.reason = "runtime_lost";
    lifecycle.runtime.state = "missing";
    lifecycle.runtime.reason = "tmux_missing";
    updateMetadata(env.sessionsDir, "app-1", {
      lifecycle: JSON.stringify(lifecycle),
      lifecycleEvidence: "previous_evidence",
      detectingAttempts: "2",
    });
    const before = readMetadataRaw(env.sessionsDir, "app-1");
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    mockExecFileAsync.mockRejectedValue(
      Object.assign(new Error("tmux permission denied"), {
        code: 1,
        killed: false,
        signal: null,
        stderr: "error connecting to /tmp/tmux-1001/default (Permission denied)\n",
      }),
    );

    await reconcileProjectSupervisor();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(readMetadataRaw(env.sessionsDir, "app-1")).toEqual(before);
    expect(isLifecycleWorkerRunning("my-app")).toBe(true);
    expect(plugins.runtime.destroy).not.toHaveBeenCalled();
    expect(plugins.workspace.destroy).not.toHaveBeenCalled();
  });

  it.each(["merged", "open"] as const)(
    "finalizes a persisted %s PR session after list enrichment and a cold supervisor start",
    async (prState) => {
      seedSession(prState);
      vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
      vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);
      vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
        state: "exited",
        timestamp: new Date(),
      });

      // The first list persists detecting; a later read overlays legacy killed.
      await sessionManager.list("my-app");
      const [listed] = await sessionManager.list("my-app");
      expect(listed?.status).toBe("killed");
      expect(listed?.lifecycle.session).toMatchObject({
        state: "detecting",
        reason: "runtime_lost",
        completedAt: null,
        terminatedAt: null,
      });
      expect(readCanonicalLifecycle(env.sessionsDir, "app-1")?.session.state).toBe("detecting");
      expect(lifecycleManager.getStates().size).toBe(0);

      await reconcileProjectSupervisor();
      expect(isLifecycleWorkerRunning("my-app")).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      const settled = readCanonicalLifecycle(env.sessionsDir, "app-1");
      expect(settled?.session).toMatchObject({
        state: "terminated",
        reason: "runtime_lost",
        startedAt: "2026-09-26T17:00:00.000Z",
        terminatedAt: expect.any(String),
      });
      expect(settled?.pr.state).toBe(prState);
      expect(readMetadataRaw(env.sessionsDir, "app-1")).toMatchObject({
        createdAt: "2026-09-26T17:00:00.000Z",
        pr: "https://github.com/org/my-app/pull/4",
      });
      expect(plugins.runtime.destroy).not.toHaveBeenCalled();
      expect(plugins.workspace.destroy).not.toHaveBeenCalled();

      await reconcileProjectSupervisor();
      expect(isLifecycleWorkerRunning("my-app")).toBe(false);
      const [finalSession] = await sessionManager.list("my-app");
      expect(finalSession?.status).toBe("killed");
      expect(finalSession?.lifecycle.session.state).toBe("terminated");
    },
  );

  it("keeps an attached worker reconciling when runtime loss still has conflicting evidence", async () => {
    seedSession("open");
    await reconcileProjectSupervisor();
    await vi.advanceTimersByTimeAsync(0);
    expect(isLifecycleWorkerRunning("my-app")).toBe(true);

    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    await reconcileProjectSupervisor();
    expect(isLifecycleWorkerRunning("my-app")).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readCanonicalLifecycle(env.sessionsDir, "app-1")?.session.state).toBe("detecting");
    expect(plugins.runtime.destroy).not.toHaveBeenCalled();

    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "exited",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readCanonicalLifecycle(env.sessionsDir, "app-1")?.session.state).toBe("terminated");
    await reconcileProjectSupervisor();
    expect(isLifecycleWorkerRunning("my-app")).toBe(false);
  });

  it("preserves the busy-worker grace period on a merged PR before cleanup", async () => {
    seedSession("merged");
    await reconcileProjectSupervisor();
    await vi.advanceTimersByTimeAsync(0);
    expect(isLifecycleWorkerRunning("my-app")).toBe(true);
    expect(readCanonicalLifecycle(env.sessionsDir, "app-1")?.session.state).toBe("idle");
    expect(plugins.runtime.destroy).not.toHaveBeenCalled();

    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readCanonicalLifecycle(env.sessionsDir, "app-1")?.session).toMatchObject({
      state: "terminated",
      reason: "pr_merged",
    });
    await reconcileProjectSupervisor();
    expect(isLifecycleWorkerRunning("my-app")).toBe(false);
  });

  it("keeps reconciling a merged session when automatic cleanup is disabled", async () => {
    seedSession("merged");
    env.config.lifecycle = { autoCleanupOnMerge: false };
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(),
    });

    await reconcileProjectSupervisor();
    await vi.advanceTimersByTimeAsync(30_000);
    await reconcileProjectSupervisor();

    expect(isLifecycleWorkerRunning("my-app")).toBe(true);
    expect(readCanonicalLifecycle(env.sessionsDir, "app-1")?.session).toMatchObject({
      state: "idle",
      reason: "merged_waiting_decision",
      terminatedAt: null,
    });
    expect(plugins.runtime.destroy).not.toHaveBeenCalled();
  });

  it.each(["open", "merged"] as const)(
    "reconciles a %s review-only session without probing or creating a worker runtime",
    async (prState) => {
      seedSession(prState, "review-only");
      await reconcileProjectSupervisor();
      expect(isLifecycleWorkerRunning("my-app")).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(readCanonicalLifecycle(env.sessionsDir, "app-1")?.session).toMatchObject({
        kind: "review-only",
        state: prState === "merged" ? "terminated" : "idle",
      });
      await reconcileProjectSupervisor();
      expect(isLifecycleWorkerRunning("my-app")).toBe(prState === "open");
      expect(plugins.runtime.isAlive).not.toHaveBeenCalled();
      expect(plugins.agent.isProcessRunning).not.toHaveBeenCalled();
      expect(plugins.runtime.create).not.toHaveBeenCalled();
      expect(plugins.runtime.destroy).not.toHaveBeenCalled();
      expect(plugins.workspace.destroy).not.toHaveBeenCalled();
    },
  );
});
