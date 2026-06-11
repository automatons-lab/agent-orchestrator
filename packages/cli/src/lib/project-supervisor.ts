import {
  loadConfig,
  getGlobalConfigPath,
  isTerminalSession,
  createCorrelationId,
  createProjectObserver,
  ConfigNotFoundError,
  type OrchestratorConfig,
  type ProjectObserver,
} from "@aoagents/ao-core";
import { getSessionManager } from "./create-session-manager.js";
import {
  ensureLifecycleWorker,
  listLifecycleWorkers,
  stopLifecycleWorker,
} from "./lifecycle-service.js";
import { addProjectToRunning, removeProjectFromRunning } from "./running-state.js";

const DEFAULT_SUPERVISOR_INTERVAL_MS = 60_000;
const DEBUG = process.env.AO_DEBUG_SUPERVISOR === "1";
function debug(...args: unknown[]): void {
  if (DEBUG) console.log("[supervisor]", ...args);
}

interface SupervisorHandle {
  stop: () => void;
  reconcileNow: () => Promise<void>;
}

let activeSupervisor: SupervisorHandle | null = null;

type SupervisorConfigSource = "global" | "local-fallback";

interface LoadedSupervisorConfig {
  config: OrchestratorConfig;
  source: SupervisorConfigSource;
}

export interface ReconcileProjectSupervisorOptions {
  intervalMs?: number;
  /**
   * Resolved config path from the caller (typically `ao start`). When the
   * global config is missing, this is used as the explicit local-fallback
   * source. Without it the supervisor would fall back to a cwd-walk via
   * bare `loadConfig()`, which misses configs in `ao start <url>` /
   * `ao start <path>` first-run flows — there the resolved config can
   * live under the clone/target path while the daemon's cwd is somewhere
   * else. A bare cwd-walk in that case throws ConfigNotFoundError, which
   * `run()` silently swallows, leaving `running.projects` empty.
   */
  configPath?: string;
}

export interface StartProjectSupervisorOptions {
  intervalMs?: number;
  /** See {@link ReconcileProjectSupervisorOptions.configPath}. */
  configPath?: string;
}

function isMissingConfigError(error: unknown): boolean {
  if (error instanceof ConfigNotFoundError) return true;
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT" &&
    "path" in error &&
    error.path === getGlobalConfigPath()
  );
}

/** Load the supervisor config: prefer the global registry, fall back to the
 *  caller-resolved local config path (or cwd discovery when none provided).
 *  Returns the source so callers can gate authoritative actions (like the
 *  detach pass) on whether we're looking at the real registry. */
function loadSupervisorConfig(configPath?: string): LoadedSupervisorConfig {
  // Honor AO_CONFIG_PATH for non-canonical (single-file) setups so supervisor
  // sees the real configured projects. getGlobalConfigPath() only reads
  // AO_GLOBAL_CONFIG and falls back to ~/.agent-orchestrator/config.yaml,
  // which is wrong when the operator points AO at a renamed file via
  // AO_CONFIG_PATH (the path findConfigFile() also respects). The override
  // is the operator's authoritative project registry, so treat it as global.
  const envConfigPath = process.env["AO_CONFIG_PATH"];
  if (envConfigPath) {
    return { config: loadConfig(envConfigPath), source: "global" };
  }
  const globalConfigPath = getGlobalConfigPath();
  try {
    return { config: loadConfig(globalConfigPath), source: "global" };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      "path" in error &&
      error.path === globalConfigPath
    ) {
      const config = configPath ? loadConfig(configPath) : loadConfig();
      return { config, source: "local-fallback" };
    }
    throw error;
  }
}

function reportProjectSupervisorError(
  observer: ProjectObserver,
  projectId: string,
  reason: string,
  error: unknown,
): void {
  observer.setHealth({
    surface: "project-supervisor.reconcile",
    status: "warn",
    projectId,
    correlationId: createCorrelationId("project-supervisor"),
    reason,
    details: {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

export async function reconcileProjectSupervisor(
  options: ReconcileProjectSupervisorOptions = {},
): Promise<void> {
  const { config, source } = loadSupervisorConfig(options.configPath);
  const observer = createProjectObserver(config, "project-supervisor");
  const configuredProjectIds = new Set(Object.keys(config.projects));

  debug(
    `reconcile start: configured=[${[...configuredProjectIds].join(",")}] attached=[${listLifecycleWorkers().join(",")}] source=${source}`,
  );

  // Only the authoritative global registry can declare a project "removed".
  // On a local fallback (e.g. global config was deleted while the daemon is
  // already supervising multiple projects) the loaded config likely doesn't
  // enumerate every supervised project — running the detach pass would kill
  // unrelated lifecycle workers. Pre-fallback behavior was a no-op on
  // missing global; preserve that property for the detach pass specifically.
  if (source === "global") {
    const activeProjectIds = new Set(listLifecycleWorkers());
    for (const projectId of activeProjectIds) {
      if (!configuredProjectIds.has(projectId)) {
        try {
          debug(`detaching ${projectId} (no longer in config)`);
          stopLifecycleWorker(projectId);
          await removeProjectFromRunning(projectId);
        } catch (error) {
          debug(`detach ${projectId} failed:`, error);
          reportProjectSupervisorError(
            observer,
            projectId,
            "Failed to detach lifecycle worker for removed project",
            error,
          );
        }
      }
    }
  }

  for (const projectId of configuredProjectIds) {
    try {
      const sm = await getSessionManager(config);
      const sessions = await sm.list(projectId);
      const nonTerminal = sessions.filter((s) => !isTerminalSession(s));
      const hasNonTerminalSession = nonTerminal.length > 0;
      const isAttached = listLifecycleWorkers().includes(projectId);

      debug(
        `${projectId}: sessions=${sessions.length} nonTerminal=${nonTerminal.length} attached=${isAttached}` +
          (nonTerminal.length
            ? ` ids=[${nonTerminal.map((s) => s.id).join(",")}]`
            : ""),
      );

      if (hasNonTerminalSession) {
        if (!isAttached) {
          debug(`${projectId}: ensureLifecycleWorker (intervalMs=${options.intervalMs ?? "default"})`);
          const status = await ensureLifecycleWorker(config, projectId, options.intervalMs);
          debug(`${projectId}: ensureLifecycleWorker result running=${status.running} started=${status.started}`);
        }
        await addProjectToRunning(projectId);
      } else if (isAttached) {
        debug(`${projectId}: stopping lifecycle worker (no non-terminal sessions)`);
        stopLifecycleWorker(projectId);
        await removeProjectFromRunning(projectId);
      }
    } catch (error) {
      debug(`${projectId}: reconcile error:`, error);
      reportProjectSupervisorError(
        observer,
        projectId,
        "Failed to reconcile lifecycle worker for project",
        error,
      );
      // Best-effort per project: a broken project must not block others from reconciling.
    }
  }

  debug(`reconcile end: now-attached=[${listLifecycleWorkers().join(",")}]`);
}

export async function startProjectSupervisor(
  options: StartProjectSupervisorOptions = {},
): Promise<SupervisorHandle> {
  if (activeSupervisor) return activeSupervisor;

  const intervalMs = options.intervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS;
  const configPath = options.configPath;

  let reconciling = false;
  let pending = false;
  let stopped = false;
  let waiters: Array<() => void> = [];

  const run = async (runOptions: { swallowErrors?: boolean } = {}): Promise<void> => {
    if (stopped) return;
    if (reconciling) {
      pending = true;
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }

    reconciling = true;
    try {
      do {
        pending = false;
        try {
          await reconcileProjectSupervisor({ intervalMs, configPath });
        } catch (error) {
          if (isMissingConfigError(error)) return;
          if (!runOptions.swallowErrors) throw error;
          // Best-effort background loop: transient config/state errors should not crash ao start.
        }
      } while (pending && !stopped);
    } finally {
      reconciling = false;
      const pendingWaiters = waiters;
      waiters = [];
      for (const resolve of pendingWaiters) resolve();
    }
  };

  const timer = setInterval(() => {
    void run({ swallowErrors: true });
  }, intervalMs);
  timer.unref?.();

  const handle: SupervisorHandle = {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      activeSupervisor = null;
    },
    reconcileNow: run,
  };
  activeSupervisor = handle;

  try {
    await run();
  } catch (error) {
    handle.stop();
    throw error;
  }
  return handle;
}

export function stopProjectSupervisor(): void {
  activeSupervisor?.stop();
}
