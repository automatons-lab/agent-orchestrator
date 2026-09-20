/**
 * Configuration loader — reads agent-orchestrator.yaml and validates with Zod.
 *
 * Minimal config that just works:
 *   projects:
 *     my-app:
 *       repo: org/repo
 *       path: ~/my-app
 *
 * Everything else has sensible defaults.
 */

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  ConfigNotFoundError,
  ProjectResolveError,
  type DegradedProjectEntry,
  type ExternalPluginEntryRef,
  type LoadedConfig,
  type OrchestratorConfig,
} from "./types.js";
import { generateSessionPrefix } from "./paths.js";
import { findIdentityKey, identityLogin, resolveAgentRef } from "./identity-lookup.js";
import { getDefaultRuntime } from "./platform.js";
import {
  getGlobalConfigPath,
  isCanonicalGlobalConfigPath,
  loadGlobalConfig,
} from "./global-config.js";
import { loadEffectiveProjectConfig } from "./project-resolver.js";
import { recordActivityEvent } from "./activity-events.js";

function inferScmPlugin(project: {
  repo?: string;
  scm?: Record<string, unknown>;
  tracker?: Record<string, unknown>;
}): "github" | "gitlab" {
  const scmPlugin = project.scm?.["plugin"];
  if (scmPlugin === "gitlab") {
    return "gitlab";
  }

  const scmHost = project.scm?.["host"];
  if (typeof scmHost === "string" && scmHost.toLowerCase().includes("gitlab")) {
    return "gitlab";
  }

  const trackerPlugin = project.tracker?.["plugin"];
  if (trackerPlugin === "gitlab") {
    return "gitlab";
  }

  const trackerHost = project.tracker?.["host"];
  if (typeof trackerHost === "string" && trackerHost.toLowerCase().includes("gitlab")) {
    return "gitlab";
  }

  return "github";
}

function classifyConfigShape(configPath: string): "wrapped" | "flat-or-nonobject" | "missing" {
  if (!existsSync(configPath)) {
    return "missing";
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  return parsed && typeof parsed === "object" && "projects" in (parsed as Record<string, unknown>)
    ? "wrapped"
    : "flat-or-nonobject";
}

function generateLegacyWrappedStorageKey(configPath: string, projectPath: string): string {
  const resolvedConfigPath = realpathSync(configPath);
  const configDir = dirname(resolvedConfigPath);
  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 12);
  return `${hash}-${basename(projectPath)}`;
}

function applyWrappedLocalStorageKeys(configPath: string, parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;

  const parsedObject = parsed as Record<string, unknown>;
  if (
    !("projects" in parsedObject) ||
    !parsedObject["projects"] ||
    typeof parsedObject["projects"] !== "object"
  ) {
    return parsed;
  }

  return {
    ...parsedObject,
    projects: Object.fromEntries(
      Object.entries(parsedObject["projects"] as Record<string, unknown>).map(
        ([projectId, value]) => {
          if (!value || typeof value !== "object") {
            return [projectId, value];
          }

          const project = value as Record<string, unknown>;
          if (typeof project["storageKey"] === "string" || typeof project["path"] !== "string") {
            return [projectId, value];
          }

          return [
            projectId,
            {
              ...project,
              storageKey: generateLegacyWrappedStorageKey(configPath, project["path"]),
            },
          ];
        },
      ),
    ),
  };
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

/**
 * Common validation for plugin config fields (tracker, scm, notifier).
 * Must have either plugin (for built-ins) or package/path (for external plugins).
 * Cannot have both package and path.
 */
function validatePluginConfigFields(
  value: { plugin?: string; package?: string; path?: string },
  ctx: z.RefinementCtx,
  configType: string,
): void {
  // Must have either plugin or package/path
  if (!value.plugin && !value.package && !value.path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${configType} config requires either 'plugin' (for built-ins) or 'package'/'path' (for external plugins)`,
    });
  }
  // Cannot have both package and path
  if (value.package && value.path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${configType} config cannot have both 'package' and 'path' - use one or the other`,
    });
  }
}

const ReactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  action: z.enum(["send-to-agent", "notify", "auto-merge"]).default("notify"),
  message: z.string().optional(),
  priority: z.enum(["urgent", "action", "warning", "info"]).optional(),
  retries: z.number().optional(),
  escalateAfter: z.union([z.number(), z.string()]).optional(),
  threshold: z.string().optional(),
  includeSummary: z.boolean().optional(),
  // z.object strips unknown keys, so every ReactionConfig field (types.ts)
  // must be declared here or it silently vanishes from parsed YAML.
  ignoreChecks: z.array(z.string()).optional(),
  maxRounds: z.number().optional(),
});

const TrackerConfigSchema = z
  .object({
    plugin: z.string().optional(),
    package: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => validatePluginConfigFields(value, ctx, "Tracker"));

const SCMConfigSchema = z
  .object({
    plugin: z.string().optional(),
    package: z.string().optional(),
    path: z.string().optional(),
    /** Identity (key of `identities:`) the engine itself uses for SCM API calls (fork). */
    identity: z.string().optional(),
    /** Legacy reference by GitHub login; resolved to `identity` at validation (fork). */
    githubUser: z.string().optional(),
    webhook: z
      .object({
        enabled: z.boolean().default(true),
        path: z.string().optional(),
        secretEnvVar: z.string().optional(),
        signatureHeader: z.string().optional(),
        eventHeader: z.string().optional(),
        deliveryHeader: z.string().optional(),
        maxBodyBytes: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => validatePluginConfigFields(value, ctx, "SCM"));

const NotifierConfigSchema = z
  .object({
    plugin: z.string().optional(),
    package: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => validatePluginConfigFields(value, ctx, "Notifier"));

const ObservabilityConfigSchema = z
  .object({
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("warn"),
    stderr: z.boolean().default(false),
  })
  .default({});

const AgentPermissionSchema = z
  .enum(["permissionless", "default", "auto-edit", "suggest", "skip"])
  .default("permissionless")
  .transform((value) => (value === "skip" ? "permissionless" : value));

const AgentSpecificConfigSchema = z
  .object({
    permissions: AgentPermissionSchema,
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    orchestratorModel: z.string().optional(),
    opencodeSessionId: z.string().optional(),
  })
  .passthrough();

const RolePermissionSchema = z
  .union([z.enum(["permissionless", "default", "auto-edit", "suggest"]), z.literal("skip")])
  .optional();

const RoleAgentSpecificConfigSchema = z
  .object({
    permissions: RolePermissionSchema,
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    orchestratorModel: z.string().optional(),
    opencodeSessionId: z.string().optional(),
  })
  .passthrough();

/**
 * Per-role agent + identity settings. One shape for `worker`, `orchestrator`
 * and (with extras) `reviewer`, usable both under `defaults:` and per project.
 * Fork addition: `identity` names a key of the top-level `identities:` map; the
 * identity supplies `githubUser`, `agent` and `agentConfig.{model,
 * reasoningEffort, permissions}` unless the role sets them explicitly.
 * `githubUser: <login>` is the legacy reference and still resolves.
 */
const RoleConfigSchema = z.object({
  identity: z.string().optional(),
  githubUser: z.string().optional(),
  agent: z.string().optional(),
  agentConfig: RoleAgentSpecificConfigSchema.optional(),
});

/** Reviewer role: same as any role plus AO-native review loop knobs (fork). */
const ReviewerConfigSchema = RoleConfigSchema.extend({
  enabled: z.boolean().optional(),
  timeoutMinutes: z.number().int().positive().optional(),
  maxConcurrent: z.number().int().positive().optional(),
  postMode: z.enum(["live", "dry-run"]).optional(),
  rulesFile: z.string().optional(),
});

/** GitHub login syntax (alphanumerics and single hyphens, optional [bot] suffix). */
const IDENTITY_LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?(?:\[bot\])?$/;

/** Identity and agent-profile keys are free ids (`neo`, `codex-coder`); a login may end in `[bot]`. */
const IDENTITY_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}(?:\[bot\])?$/;
const AGENT_PROFILE_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

/**
 * One agent profile: the agent plugin plus the settings it runs with. Every
 * key but `plugin` becomes `agentConfig` of the roles that use the profile
 * (`model`, `reasoningEffort`, `permissions`, `sandbox`, ...), so a profile is
 * declared once and shared by identities, roles and projects.
 */
const AgentProfileSchema = z
  .object({
    plugin: z.string().min(1, "agents.<id>.plugin must name an agent plugin"),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    permissions: RolePermissionSchema,
    orchestratorModel: z.string().optional(),
  })
  .passthrough();

const AgentProfilesSchema = z
  .record(
    z.string().regex(AGENT_PROFILE_KEY_RE, "agents keys must match [a-zA-Z0-9][a-zA-Z0-9_.-]*"),
    AgentProfileSchema,
  )
  .default({});

/**
 * One identity: who a role is on GitHub and which agent profile it runs.
 * Tokens never live in the config file; `tokenEnv` names the environment
 * variable that carries them. Roles reference an identity by key and inherit
 * its login and agent, so each is declared once for every role and project.
 */
const IdentityConfigSchema = z
  .object({
    tokenEnv: z
      .string()
      .min(1, "identities.<id>.tokenEnv must name an environment variable"),
    /** GitHub login. Defaults to the identity key. */
    githubUser: z
      .string()
      .regex(IDENTITY_LOGIN_RE, "identities.<id>.githubUser must be a GitHub login")
      .optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    /** Key of `agents:` (or a bare agent plugin name) roles with this identity run. */
    agent: z.string().optional(),
  })
  .passthrough();

const IdentitiesSchema = z
  .record(
    z.string().regex(IDENTITY_KEY_RE, "identities keys must match [a-zA-Z0-9][a-zA-Z0-9_.-]*"),
    IdentityConfigSchema,
  )
  .superRefine((identities, ctx) => {
    for (const [id, entry] of Object.entries(identities)) {
      if (entry.githubUser === undefined && !IDENTITY_LOGIN_RE.test(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [id],
          message: `identities.${id}: the key is not a GitHub login, so githubUser is required`,
        });
      }
    }
  })
  .default({});

// Accept either flat string form (`owner/repo`) or the rich object form
// `{ owner, name, platform?, originUrl? }` that the dashboard auto-writes,
// and normalize both to a plain string. Keeps strict validation but no
// longer crashes status / loadConfig() when something — dashboard, manual
// edit, migration — leaves the rich shape on disk.
const RepoSchema = z
  .union([
    z.string(),
    z
      .object({
        owner: z.string(),
        name: z.string(),
        platform: z.string().optional(),
        originUrl: z.string().optional(),
      })
      .passthrough()
      .transform((v) => `${v.owner}/${v.name}`),
  ])
  .optional();

const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  repo: RepoSchema,
  path: z.string(),
  defaultBranch: z.string().default("main"),
  sessionPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "sessionPrefix must match [a-zA-Z0-9_-]+")
    .optional(),
  /** Per-project resolution failure captured without aborting global load. */
  resolveError: z.string().optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  workspace: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  tracker: TrackerConfigSchema.optional(),
  scm: SCMConfigSchema.optional(),
  symlinks: z.array(z.string()).optional(),
  postCreate: z.array(z.string()).optional(),
  agentConfig: AgentSpecificConfigSchema.default({}),
  orchestrator: RoleConfigSchema.optional(),
  worker: RoleConfigSchema.optional(),
  reviewer: ReviewerConfigSchema.optional(),
  reactions: z.record(ReactionConfigSchema.partial()).optional(),
  agentRules: z.string().optional(),
  agentRulesFile: z.string().optional(),
  branchNameTemplate: z.string().optional(),
  reviewers: z.array(z.string()).optional(),
  orchestratorRules: z.string().optional(),
  orchestratorSessionStrategy: z
    .enum(["reuse", "delete", "ignore", "delete-new", "ignore-new", "kill-previous"])
    .optional(),
  opencodeIssueSessionStrategy: z.enum(["reuse", "delete", "ignore"]).optional(),
});

/**
 * Project behaviour fields that may be set once under `defaults:` and
 * inherited by every project (fork). Identity fields (`name`, `path`, `repo`,
 * `defaultBranch`, `sessionPrefix`) are always per project.
 */
export const DEFAULTABLE_SCALAR_KEYS = [
  "runtime",
  "agent",
  "workspace",
  "agentRules",
  "agentRulesFile",
  "branchNameTemplate",
  "orchestratorRules",
  "orchestratorSessionStrategy",
  "opencodeIssueSessionStrategy",
] as const;
export const DEFAULTABLE_ARRAY_KEYS = ["symlinks", "postCreate", "reviewers"] as const;
export const DEFAULTABLE_OBJECT_KEYS = [
  "env",
  "tracker",
  "scm",
  "agentConfig",
  "orchestrator",
  "worker",
  "reviewer",
] as const;
export const DEFAULTABLE_PROJECT_KEYS = [
  ...DEFAULTABLE_SCALAR_KEYS,
  ...DEFAULTABLE_ARRAY_KEYS,
  ...DEFAULTABLE_OBJECT_KEYS,
] as const;
export const PROJECT_ONLY_KEYS = [
  "name",
  "repo",
  "path",
  "defaultBranch",
  "sessionPrefix",
  "resolveError",
  "enabled",
] as const;

const DefaultPluginsSchema = z.object({
  runtime: z.string().default(() => getDefaultRuntime()),
  agent: z.string().default("claude-code"),
  workspace: z.string().default("worktree"),
  notifiers: z.array(z.string()).default([]),
  // Role blocks (fork: full role shape incl. agentConfig + githubUser).
  orchestrator: RoleConfigSchema.optional(),
  worker: RoleConfigSchema.optional(),
  reviewer: ReviewerConfigSchema.optional(),
  // Every other behaviour field a project can inherit (fork).
  env: ProjectConfigSchema.shape.env,
  tracker: ProjectConfigSchema.shape.tracker,
  scm: ProjectConfigSchema.shape.scm,
  symlinks: ProjectConfigSchema.shape.symlinks,
  postCreate: ProjectConfigSchema.shape.postCreate,
  agentConfig: AgentSpecificConfigSchema.optional(),
  agentRules: ProjectConfigSchema.shape.agentRules,
  agentRulesFile: ProjectConfigSchema.shape.agentRulesFile,
  branchNameTemplate: ProjectConfigSchema.shape.branchNameTemplate,
  reviewers: ProjectConfigSchema.shape.reviewers,
  orchestratorRules: ProjectConfigSchema.shape.orchestratorRules,
  orchestratorSessionStrategy: ProjectConfigSchema.shape.orchestratorSessionStrategy,
  opencodeIssueSessionStrategy: ProjectConfigSchema.shape.opencodeIssueSessionStrategy,
});

const InstalledPluginConfigSchema = z
  .object({
    name: z.string(),
    source: z.enum(["registry", "npm", "local"]),
    package: z.string().optional(),
    version: z.string().optional(),
    path: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.source === "local" && !value.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "Local plugins require a path",
      });
    }

    if ((value.source === "registry" || value.source === "npm") && !value.package) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["package"],
        message: "Registry and npm plugins require a package name",
      });
    }
  });

const PowerConfigSchema = z
  .object({
    /**
     * Prevent macOS idle sleep while AO is running.
     * Uses `caffeinate -i -w <pid>` to hold an assertion.
     * Defaults to true on macOS, no-op on other platforms.
     */
    preventIdleSleep: z.boolean().default(process.platform === "darwin"),
  })
  .default({});

const DashboardConfigSchema = z.object({
  attentionZones: z.enum(["simple", "detailed"]).default("simple"),
});

const LifecycleConfigSchema = z
  .object({
    /**
     * When a session's PR is detected as merged, automatically tear down the
     * tmux runtime, remove the worktree, and archive the session metadata.
     * Defaults to true so `ao status` does not retain stale merged entries.
     */
    autoCleanupOnMerge: z.boolean().default(true),
    /**
     * Maximum time (ms) to wait after a session enters `merged` before forcing
     * cleanup regardless of agent activity. Defaults to 5 minutes. Use `0` to
     * disable the grace window (cleanup runs immediately even if the agent is
     * still active). Values between 1 and 9999 are rejected to catch the common
     * mistake of writing seconds (e.g. `5`) when milliseconds are expected.
     */
    mergeCleanupIdleGraceMs: z
      .number()
      .int()
      .nonnegative()
      .refine((v) => v === 0 || v >= 10_000, {
        message:
          "mergeCleanupIdleGraceMs is in milliseconds; values between 1 and 9999 are likely a units mistake (use 0 to disable the gate, or e.g. 10000 for 10s, 300000 for 5min)",
      })
      .default(300_000),
  })
  .default({});

const OrchestratorConfigSchema = z.object({
  $schema: z.string().optional(),
  port: z.number().int().default(3000),
  terminalPort: z.number().int().optional(),
  directTerminalPort: z.number().int().optional(),
  readyThresholdMs: z.number().int().nonnegative().default(300_000),
  power: PowerConfigSchema,
  lifecycle: LifecycleConfigSchema,
  observability: ObservabilityConfigSchema,
  defaults: DefaultPluginsSchema.default({}),
  /** Agent profiles referenced by `identities.<id>.agent` and role `agent` fields (fork). */
  agents: AgentProfilesSchema,
  /** Identities referenced by role and scm `identity` fields (fork). */
  identities: IdentitiesSchema,
  plugins: z.array(InstalledPluginConfigSchema).default([]),
  dashboard: DashboardConfigSchema.optional(),
  projects: z.record(
    z
      .string()
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        "Project ID must match [a-zA-Z0-9_-]+ (no dots, slashes, or special characters)",
      ),
    ProjectConfigSchema,
  ),
  notifiers: z.record(NotifierConfigSchema).default({}),
  notificationRouting: z.record(z.array(z.string())).default({}),
  reactions: z.record(ReactionConfigSchema).default({}),
});

// =============================================================================
// CONFIG LOADING
// =============================================================================

/** Expand ~ to home directory */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Expand all path fields in the config */
function expandPaths(config: OrchestratorConfig): OrchestratorConfig {
  for (const project of Object.values(config.projects)) {
    project.path = expandHome(project.path);
  }

  for (const plugin of config.plugins ?? []) {
    if (plugin.path) {
      plugin.path = expandHome(plugin.path);
    }
  }

  return config;
}

/**
 * Generate a temporary plugin name from a package or path specifier.
 * This name is used until the actual manifest.name is discovered during plugin loading.
 * Format: extract the plugin name from the package/path, removing common prefixes.
 * e.g., "@acme/ao-plugin-tracker-jira" -> "jira"
 * e.g., "@acme/ao-plugin-tracker-jira-cloud" -> "jira-cloud"
 * e.g., "./plugins/my-tracker" -> "my-tracker"
 * e.g., "my-tracker" (local path without slashes) -> "my-tracker"
 */
function generateTempPluginName(pkg?: string, path?: string): string {
  if (pkg) {
    // Extract package name without scope: "@acme/ao-plugin-tracker-jira" -> "ao-plugin-tracker-jira"
    const slashParts = pkg.split("/");
    const packageName = slashParts[slashParts.length - 1] ?? pkg;

    // Extract plugin name after ao-plugin-{slot}- prefix, preserving multi-word names like "jira-cloud"
    const prefixMatch = packageName.match(
      /^ao-plugin-(?:runtime|agent|workspace|tracker|scm|notifier|terminal)-(.+)$/,
    );
    if (prefixMatch?.[1]) {
      return prefixMatch[1];
    }

    // Non-standard package name (doesn't follow ao-plugin convention): use the full package name
    // to avoid collisions. "plugin" from "custom-tracker-plugin" would collide with other packages
    // that also end in "-plugin". The temp name is replaced with manifest.name after loading anyway.
    return packageName;
  }

  // Handle local paths: use the basename
  // ./plugins/my-tracker -> my-tracker
  // my-tracker -> my-tracker (no slashes is still a valid path)
  if (path) {
    const segments = path.split("/").filter((s) => s && s !== "." && s !== "..");
    return segments[segments.length - 1] ?? path;
  }

  return "unknown";
}

/**
 * Helper to process a single external plugin config entry.
 * Expands home paths, generates temp plugin name if needed, and returns the entry ref.
 */
function processExternalPluginConfig(
  pluginConfig: { plugin?: string; package?: string; path?: string },
  source: string,
  location: ExternalPluginEntryRef["location"],
  slot: ExternalPluginEntryRef["slot"],
): ExternalPluginEntryRef | null {
  if (!pluginConfig.package && !pluginConfig.path) return null;

  // Expand home paths (~/...) for consistency with config.plugins
  if (pluginConfig.path) {
    pluginConfig.path = expandHome(pluginConfig.path);
  }

  // Track if user explicitly specified plugin name (for validation)
  const userSpecifiedPlugin = pluginConfig.plugin;

  // If plugin name not specified, generate a temporary one from package/path
  if (!pluginConfig.plugin) {
    pluginConfig.plugin = generateTempPluginName(pluginConfig.package, pluginConfig.path);
  }

  return {
    source,
    location,
    slot,
    package: pluginConfig.package,
    path: pluginConfig.path,
    expectedPluginName: userSpecifiedPlugin,
  };
}

/**
 * Collect external plugin configs from tracker, scm, and notifier inline configs.
 * These will be auto-added to config.plugins for loading.
 *
 * Also sets a temporary plugin name on configs that only have package/path,
 * so that resolvePlugins() can look up the plugin by name.
 *
 * IMPORTANT: Only sets expectedPluginName when user explicitly specified `plugin`.
 * When plugin is auto-generated, expectedPluginName is left undefined so that
 * any manifest.name is accepted and the config is updated with it.
 */
export function collectExternalPluginConfigs(config: OrchestratorConfig): ExternalPluginEntryRef[] {
  const entries: ExternalPluginEntryRef[] = [];

  // Collect from project tracker and scm configs
  for (const [projectId, project] of Object.entries(config.projects)) {
    if (project.tracker) {
      const entry = processExternalPluginConfig(
        project.tracker,
        `projects.${projectId}.tracker`,
        { kind: "project", projectId, configType: "tracker" },
        "tracker",
      );
      if (entry) entries.push(entry);
    }

    if (project.scm) {
      const entry = processExternalPluginConfig(
        project.scm,
        `projects.${projectId}.scm`,
        { kind: "project", projectId, configType: "scm" },
        "scm",
      );
      if (entry) entries.push(entry);
    }
  }

  // Collect from global notifier configs
  for (const [notifierId, notifierConfig] of Object.entries(config.notifiers ?? {})) {
    if (notifierConfig) {
      const entry = processExternalPluginConfig(
        notifierConfig,
        `notifiers.${notifierId}`,
        { kind: "notifier", notifierId },
        "notifier",
      );
      if (entry) entries.push(entry);
    }
  }

  return entries;
}

/**
 * Generate InstalledPluginConfig entries from external plugin entries.
 * Merges with existing plugins, avoiding duplicates by package/path.
 */
function mergeExternalPlugins(
  existingPlugins: OrchestratorConfig["plugins"],
  externalEntries: ExternalPluginEntryRef[],
): OrchestratorConfig["plugins"] {
  const plugins = [...(existingPlugins ?? [])];
  const seen = new Set<string>();

  // Track existing plugins by package/path
  for (const plugin of plugins) {
    if (plugin.package) seen.add(`package:${plugin.package}`);
    if (plugin.path) seen.add(`path:${plugin.path}`);
  }

  // Add external entries that aren't already present, or enable if disabled
  for (const entry of externalEntries) {
    const key = entry.package ? `package:${entry.package}` : `path:${entry.path}`;
    if (seen.has(key)) {
      // If the existing plugin is disabled but there's an inline reference, enable it
      const existingPlugin = plugins.find(
        (p) =>
          (entry.package && p.package === entry.package) || (entry.path && p.path === entry.path),
      );
      if (existingPlugin && existingPlugin.enabled === false) {
        existingPlugin.enabled = true;
      }
      continue;
    }
    seen.add(key);

    // Generate a temporary name - will be replaced with manifest.name during loading
    const tempName = entry.expectedPluginName ?? generateTempPluginName(entry.package, entry.path);

    plugins.push({
      name: tempName,
      source: entry.package ? "npm" : "local",
      package: entry.package,
      path: entry.path,
      enabled: true,
    });
  }

  return plugins;
}

/** Apply defaults to project configs */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfigValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => cloneConfigValue(v)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneConfigValue(v);
    return out as T;
  }
  return value;
}

/**
 * Deep-merge `override` over `base`: plain objects merge key by key, arrays
 * and primitives from `override` replace, `undefined` overrides are skipped.
 */
export function mergeConfigValues<T>(base: T | undefined, override: T | undefined): T | undefined {
  if (override === undefined) return base === undefined ? undefined : cloneConfigValue(base);
  if (base === undefined) return cloneConfigValue(override);
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = cloneConfigValue(base);
    for (const [k, v] of Object.entries(override)) {
      if (v === undefined) continue;
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeConfigValues(out[k], v) : cloneConfigValue(v);
    }
    return out as T;
  }
  return cloneConfigValue(override);
}

/**
 * Inherit behaviour fields from `defaults:` into every project (fork).
 * Scalars/arrays: project wins when set, else the default. Objects
 * (`agentConfig`, `worker`, `reviewer`, `scm`, ...): deep-merged, project keys win.
 * Runs before applyProjectDefaults so inferred scm/tracker plugins still apply
 * when neither side names one.
 */
function applyBehaviorDefaults(config: OrchestratorConfig): OrchestratorConfig {
  const defaults = (config.defaults ?? {}) as unknown as Record<string, unknown>;
  if (typeof defaults["agentRulesFile"] === "string") {
    defaults["agentRulesFile"] = expandHome(defaults["agentRulesFile"] as string);
  }
  for (const project of Object.values(config.projects)) {
    const target = project as unknown as Record<string, unknown>;
    for (const key of [...DEFAULTABLE_SCALAR_KEYS, ...DEFAULTABLE_ARRAY_KEYS]) {
      if (target[key] === undefined && defaults[key] !== undefined) {
        target[key] = cloneConfigValue(defaults[key]);
      }
    }
    for (const key of DEFAULTABLE_OBJECT_KEYS) {
      const merged = mergeConfigValues(withoutInheritedIdentityRef(defaults[key], target[key]), target[key]);
      if (merged !== undefined) target[key] = merged;
    }
    if (typeof target["agentRulesFile"] === "string") {
      target["agentRulesFile"] = expandHome(target["agentRulesFile"] as string);
    }
    const reviewer = target["reviewer"];
    if (isPlainObject(reviewer) && typeof reviewer["rulesFile"] === "string") {
      reviewer["rulesFile"] = expandHome(reviewer["rulesFile"]);
    }
  }
  return config;
}

const IDENTITY_REF_KEYS = ["identity", "githubUser"] as const;

/**
 * When a project block (`worker`, `scm`, ...) names its own identity, by key
 * or by login, the defaults' reference must not leak into the merge: otherwise
 * `defaults.worker.identity: neo` plus `projects.x.worker.githubUser: trinity`
 * would look like a contradiction instead of an override.
 */
function withoutInheritedIdentityRef(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return base;
  if (!IDENTITY_REF_KEYS.some((k) => typeof override[k] === "string")) return base;
  const out: Record<string, unknown> = { ...base };
  for (const k of IDENTITY_REF_KEYS) delete out[k];
  return out;
}

/**
 * Resolve the identity reference of one role or scm block: `identity: <key>`
 * (or the legacy `githubUser: <login>`) is checked and both fields are filled.
 * Returns the identity key, or undefined when the block names none.
 */
function resolveIdentityRef(
  config: OrchestratorConfig,
  block: Record<string, unknown>,
  where: string,
): string | undefined {
  const identities = config.identities ?? {};
  const known = Object.keys(identities);
  const describeKnown =
    known.length > 0 ? `Declared identities: ${known.join(", ")}` : "No identities are declared under `identities:`";
  const ref = typeof block["identity"] === "string" ? block["identity"] : undefined;
  const login = typeof block["githubUser"] === "string" ? block["githubUser"] : undefined;
  let key: string | undefined;
  if (ref !== undefined) {
    if (identities[ref] === undefined) {
      throw new Error(`${where} references unknown identity "${ref}". ${describeKnown}.`);
    }
    key = ref;
  } else if (login !== undefined) {
    key = findIdentityKey(identities, login);
    if (key === undefined) {
      throw new Error(`${where} references unknown githubUser "${login}". ${describeKnown}.`);
    }
  } else {
    return undefined;
  }
  const entryLogin = identityLogin(identities, key);
  if (login !== undefined && login !== entryLogin) {
    throw new Error(
      `${where}: githubUser "${login}" does not match identity "${key}" (login ${entryLogin}); ` +
        "drop githubUser or reference the right identity",
    );
  }
  block["identity"] = key;
  block["githubUser"] = entryLogin;
  return key;
}

/**
 * Resolve the agent of one role block: the block's own `agent` reference, else
 * the identity's. A reference naming a key of `agents:` expands to that
 * profile's plugin plus its settings under `agentConfig` (the block's own
 * `agentConfig` keys win); anything else is taken as a bare plugin name.
 */
function resolveRoleAgent(
  config: OrchestratorConfig,
  block: Record<string, unknown>,
  identityKey: string | undefined,
): void {
  const own = typeof block["agent"] === "string" ? block["agent"] : undefined;
  const inherited = identityKey !== undefined ? config.identities?.[identityKey]?.agent : undefined;
  const ref = own ?? inherited;
  if (ref === undefined) return;
  const resolved = resolveAgentRef(config.agents, ref);
  block["agent"] = resolved.plugin;
  if (resolved.profile === undefined) return;
  block["agentProfile"] = resolved.profile;
  if (Object.keys(resolved.config).length > 0) {
    block["agentConfig"] = mergeConfigValues(resolved.config, block["agentConfig"]);
  }
}

/**
 * Expand identity and agent-profile references (fork). Runs after defaults
 * were merged into the projects so a project's own `identity` / `agent` wins
 * over the defaults', and before anything reads `githubUser` / `agent` /
 * `agentConfig` off a role. Also rejects a project that would review its own
 * PRs: worker and an enabled reviewer must be different GitHub users.
 */
function applyIdentityProfiles(config: OrchestratorConfig): OrchestratorConfig {
  const defaults = config.defaults as unknown as Record<string, unknown> | undefined;
  const resolveOwner = (owner: Record<string, unknown>, prefix: string): void => {
    const scm = owner["scm"];
    if (isPlainObject(scm)) resolveIdentityRef(config, scm, `${prefix}.scm`);
    for (const role of ["worker", "orchestrator", "reviewer"] as const) {
      const block = owner[role];
      if (!isPlainObject(block)) continue;
      const identityKey = resolveIdentityRef(config, block, `${prefix}.${role}`);
      resolveRoleAgent(config, block, identityKey);
    }
  };
  if (defaults) resolveOwner(defaults, "defaults");
  for (const [id, project] of Object.entries(config.projects)) {
    resolveOwner(project as unknown as Record<string, unknown>, `projects.${id}`);
    const workerLogin = project.worker?.githubUser;
    const reviewerLogin = project.reviewer?.githubUser;
    if (project.reviewer?.enabled && workerLogin !== undefined && workerLogin === reviewerLogin) {
      throw new Error(
        `projects.${id}: worker and reviewer use the same githubUser "${workerLogin}"; ` +
          "GitHub does not allow approving your own pull request, so the reviewer needs a different identity.",
      );
    }
  }
  return config;
}

function applyProjectDefaults(config: OrchestratorConfig): OrchestratorConfig {
  for (const [id, project] of Object.entries(config.projects)) {
    // Derive name from project ID if not set
    if (!project.name) {
      project.name = id;
    }

    // Derive session prefix from the project path basename if not set.
    // This preserves the long-standing semantics on this branch, where
    // `/repos/integrator` becomes `int` regardless of the config key.
    if (!project.sessionPrefix) {
      project.sessionPrefix = generateSessionPrefix(basename(project.path));
    }

    const inferredPlugin = inferScmPlugin(project);

    // Infer SCM from repo if not set
    if (!project.scm && project.repo?.includes("/")) {
      project.scm = { plugin: inferredPlugin };
    }

    // Infer tracker from repo if not set (default to github issues)
    if (!project.tracker && project.repo?.includes("/")) {
      project.tracker = { plugin: inferredPlugin };
    }
  }

  return config;
}

/** Validate project uniqueness and session prefix collisions */
function validateProjectUniqueness(config: OrchestratorConfig): void {
  const projectIds = new Set<string>();

  for (const [projectId] of Object.entries(config.projects)) {
    if (projectIds.has(projectId)) {
      throw new Error(
        `Duplicate project ID detected: "${projectId}"\n` +
          `Each project entry must use a unique registry key.`,
      );
    }
    projectIds.add(projectId);
  }

  // Check for duplicate session prefixes
  const prefixes = new Set<string>();
  const prefixToProject: Record<string, string> = {};

  for (const [projectId, project] of Object.entries(config.projects)) {
    const prefix = project.sessionPrefix || generateSessionPrefix(projectId);

    if (prefixes.has(prefix)) {
      const firstProjectKey = prefixToProject[prefix];
      throw new Error(
        `Duplicate session prefix detected: "${prefix}"\n` +
          `Projects "${firstProjectKey}" and "${projectId}" would generate the same prefix.\n\n` +
          `To fix this, add an explicit sessionPrefix to one of these projects:\n\n` +
          `projects:\n` +
          `  ${firstProjectKey}:\n` +
          `    path: ${config.projects[firstProjectKey]?.path}\n` +
          `    sessionPrefix: ${prefix}1  # Add explicit prefix\n` +
          `  ${projectId}:\n` +
          `    path: ${project.path}\n` +
          `    sessionPrefix: ${prefix}2  # Add explicit prefix\n`,
      );
    }

    prefixes.add(prefix);
    prefixToProject[prefix] = projectId;
  }
}

/**
 * Sentinel string for the default `bugbot-comments` reaction message.
 * The lifecycle dispatcher replaces this exact value with a formatted listing
 * of the actual automated comments + correct-API guidance (see #895). If a
 * project customizes the message in their YAML, the dispatcher leaves it alone.
 */
export const DEFAULT_BUGBOT_COMMENTS_MESSAGE =
  "Automated review comments found on your PR. Fix the issues flagged by the bot.";

/** Apply default reactions */
function applyDefaultReactions(config: OrchestratorConfig): OrchestratorConfig {
  const defaults: Record<string, (typeof config.reactions)[string]> = {
    "pr-closed": {
      auto: true,
      action: "notify",
      priority: "action",
      message:
        "A PR was closed without merging. Decide whether to learn from the closure, resume the work, or terminate the session.",
    },
    "ci-failed": {
      auto: true,
      action: "send-to-agent",
      retries: 2,
      escalateAfter: 2,
    },
    "changes-requested": {
      auto: true,
      action: "send-to-agent",
      message:
        "There are new review comments on your PR requesting changes.",
      escalateAfter: "30m",
    },
    "bugbot-comments": {
      auto: true,
      action: "send-to-agent",
      message: "Automated review comments found on your PR. Details will follow shortly.",
      escalateAfter: "30m",
    },
    "merge-conflicts": {
      auto: true,
      action: "send-to-agent",
      message: "Your branch has merge conflicts. Rebase on the default branch and resolve them.",
      escalateAfter: "15m",
    },
    "approved-and-green": {
      auto: false,
      action: "notify",
      priority: "action",
      message: "PR is ready to merge",
    },
    "agent-idle": {
      auto: true,
      action: "send-to-agent",
      message:
        "You appear to be idle. If your task is not complete, continue working — write the code, commit, push, and create a PR. If you are blocked, explain what is blocking you.",
      retries: 2,
      escalateAfter: "15m",
    },
    "agent-stuck": {
      auto: true,
      action: "notify",
      priority: "urgent",
      threshold: "10m",
    },
    "agent-needs-input": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "agent-exited": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "all-complete": {
      auto: true,
      action: "notify",
      priority: "info",
      includeSummary: true,
    },
  };

  // Merge defaults with user-specified reactions (user wins per field).
  // Fork patch: merge per reaction key, not per map entry. A YAML override such
  // as `changes-requested: { auto: true, action: send-to-agent, maxRounds: 6 }`
  // used to replace the whole default entry, silently dropping `message` and
  // making every send-to-agent dispatch for that key fail.
  const merged: typeof config.reactions = { ...defaults };
  for (const [key, override] of Object.entries(config.reactions ?? {})) {
    if (!override) continue;
    merged[key] = { ...(defaults[key] ?? {}), ...override };
  }
  config.reactions = merged;

  return config;
}

/**
 * Search for config file in standard locations.
 *
 * Search order:
 * 1. AO_CONFIG_PATH environment variable (if set)
 * 2. Search up directory tree from CWD (like git)
 * 3. Explicit startDir (if provided)
 * 4. Home directory locations
 */
export function findConfigFile(startDir?: string): string | null {
  // 1. Check environment variable override
  if (process.env["AO_CONFIG_PATH"]) {
    const envPath = resolve(process.env["AO_CONFIG_PATH"]);
    if (existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Search up directory tree from CWD (like git)
  const searchUpTree = (dir: string): string | null => {
    const configFiles = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];

    for (const filename of configFiles) {
      const configPath = resolve(dir, filename);
      if (!existsSync(configPath)) continue;
      return configPath;
    }

    const parent = resolve(dir, "..");
    if (parent === dir) {
      // Reached root
      return null;
    }

    return searchUpTree(parent);
  };

  const cwd = process.cwd();
  const foundInTree = searchUpTree(cwd);
  if (foundInTree) {
    return foundInTree;
  }

  // 3. Check explicit startDir if provided
  if (startDir) {
    const files = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];
    for (const filename of files) {
      const path = resolve(startDir, filename);
      if (!existsSync(path)) continue;
      return path;
    }
  }

  // 4. Check global config path (new hybrid mode: ~/.agent-orchestrator/config.yaml)
  //    This takes priority over legacy home-directory locations so that users who
  //    have migrated to the hybrid model always load from the canonical global path.
  const globalConfigPath = getGlobalConfigPath();
  if (existsSync(globalConfigPath)) {
    return globalConfigPath;
  }

  // 5. Legacy home directory locations (backward compatibility)
  const homePaths = [
    resolve(homedir(), ".agent-orchestrator.yaml"),
    resolve(homedir(), ".agent-orchestrator.yml"),
    resolve(homedir(), ".config", "agent-orchestrator", "config.yaml"),
  ];

  for (const path of homePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function buildEffectiveConfigFromFlatLocalPath(
  configPath: string,
  _localParsed: unknown,
): LoadedConfig | null {
  const globalConfigPath = getGlobalConfigPath();
  const globalConfig = loadGlobalConfig(globalConfigPath);
  if (!globalConfig) return null;

  const canonicalProjectDir = (() => {
    try {
      return realpathSync(resolve(dirname(configPath)));
    } catch {
      return resolve(dirname(configPath));
    }
  })();
  const entry = Object.entries(globalConfig.projects).find(([, project]) => {
    if (typeof project.path !== "string") return false;
    try {
      return realpathSync(resolve(project.path)) === canonicalProjectDir;
    } catch {
      return resolve(project.path) === canonicalProjectDir;
    }
  });
  if (!entry) return null;

  const [projectId] = entry;
  const project = loadEffectiveProjectConfig(projectId, globalConfig, globalConfigPath);
  const config = validateConfig({
    port: globalConfig.port,
    terminalPort: globalConfig.terminalPort,
    directTerminalPort: globalConfig.directTerminalPort,
    readyThresholdMs: globalConfig.readyThresholdMs,
    observability: globalConfig.observability,
    defaults: globalConfig.defaults,
    notifiers: globalConfig.notifiers,
    notificationRouting: globalConfig.notificationRouting,
    reactions: globalConfig.reactions,
    projects: {
      [projectId]: {
        ...project,
      },
    },
  });
  return { ...config, degradedProjects: {} };
}

function buildEffectiveConfigFromGlobalConfigPath(configPath: string): LoadedConfig | null {
  const globalConfig = loadGlobalConfig(configPath);
  if (!globalConfig) return null;

  const projects: Record<string, OrchestratorConfig["projects"][string]> = {};
  const degradedProjects: Record<string, DegradedProjectEntry> = {};

  for (const [projectId, entry] of Object.entries(globalConfig.projects)) {
    try {
      projects[projectId] = loadEffectiveProjectConfig(projectId, globalConfig, configPath);
    } catch (error) {
      if (!(error instanceof ProjectResolveError)) {
        throw error;
      }
      degradedProjects[projectId] = {
        projectId,
        path: entry.path,
        resolveError: error.message,
      };
      if (error.reasonKind === "malformed" || error.reasonKind === "invalid") {
        continue;
      }
      recordActivityEvent({
        projectId,
        source: "config",
        kind: "config.project_resolve_failed",
        level: "error",
        summary: `project ${projectId} failed to resolve`,
        data: { path: entry.path, error: error.message },
      });
    }
  }

  const config = validateConfig({
    port: globalConfig.port,
    terminalPort: globalConfig.terminalPort,
    directTerminalPort: globalConfig.directTerminalPort,
    readyThresholdMs: globalConfig.readyThresholdMs,
    observability: globalConfig.observability,
    defaults: globalConfig.defaults,
    notifiers: globalConfig.notifiers,
    notificationRouting: globalConfig.notificationRouting,
    reactions: globalConfig.reactions,
    projects,
  });
  return { ...config, degradedProjects };
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Find config file path (exported for use in hash generation) */
export function findConfig(startDir?: string): string | null {
  return findConfigFile(startDir);
}

/** Load and validate config from a YAML file */
export function loadConfig(configPath?: string): LoadedConfig {
  // Priority: 1. Explicit param, 2. Search (including AO_CONFIG_PATH env var)
  // findConfigFile treats AO_CONFIG_PATH as authoritative when present.
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new ConfigNotFoundError();
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const shape = classifyConfigShape(path);
  const isCanonicalGlobalConfig = isCanonicalGlobalConfigPath(path);
  const normalizedParsed =
    !isCanonicalGlobalConfig && shape === "wrapped"
      ? applyWrappedLocalStorageKeys(path, parsed)
      : parsed;
  const config = isCanonicalGlobalConfig
    ? (buildEffectiveConfigFromGlobalConfigPath(path) ?? validateConfig(normalizedParsed))
    : shape === "wrapped"
      ? validateConfig(normalizedParsed)
      : (buildEffectiveConfigFromFlatLocalPath(path, normalizedParsed) ??
        validateConfig(normalizedParsed));

  // Set the config path in the config object for hash generation
  config.configPath = path;
  if (!("degradedProjects" in config)) {
    (config as LoadedConfig).degradedProjects = {};
  }

  return config as LoadedConfig;
}

/** Load config and return both config and resolved path */
export function loadConfigWithPath(configPath?: string): {
  config: LoadedConfig;
  path: string;
} {
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new ConfigNotFoundError();
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const shape = classifyConfigShape(path);
  const isCanonicalGlobalConfig = isCanonicalGlobalConfigPath(path);
  const normalizedParsed =
    !isCanonicalGlobalConfig && shape === "wrapped"
      ? applyWrappedLocalStorageKeys(path, parsed)
      : parsed;
  const config = isCanonicalGlobalConfig
    ? (buildEffectiveConfigFromGlobalConfigPath(path) ?? validateConfig(normalizedParsed))
    : shape === "wrapped"
      ? validateConfig(normalizedParsed)
      : (buildEffectiveConfigFromFlatLocalPath(path, normalizedParsed) ??
        validateConfig(normalizedParsed));

  // Set the config path in the config object for hash generation
  config.configPath = path;
  if (!("degradedProjects" in config)) {
    (config as LoadedConfig).degradedProjects = {};
  }

  return { config: config as LoadedConfig, path };
}

/** Validate a raw config object */
export function validateConfig(raw: unknown): OrchestratorConfig {
  const validated = OrchestratorConfigSchema.parse(raw);

  let config = validated as unknown as OrchestratorConfig;
  config = expandPaths(config);
  config = applyBehaviorDefaults(config);
  config = applyIdentityProfiles(config);
  config = applyProjectDefaults(config);
  config = applyDefaultReactions(config);

  // Collect external plugin configs from inline tracker/scm/notifier configs
  // and merge them into config.plugins for loading
  const externalPluginEntries = collectExternalPluginConfigs(config);
  if (externalPluginEntries.length > 0) {
    config.plugins = mergeExternalPlugins(config.plugins, externalPluginEntries);
    // Store entries for manifest validation during plugin loading
    config._externalPluginEntries = externalPluginEntries;
  }

  // Validate project uniqueness and prefix collisions
  validateProjectUniqueness(config);

  return config;
}

/** Get the default config (useful for first-run setup) */
export function getDefaultConfig(): OrchestratorConfig {
  return validateConfig({
    projects: {},
  });
}
