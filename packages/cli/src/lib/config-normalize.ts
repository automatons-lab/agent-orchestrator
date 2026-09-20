/**
 * `ao config normalize` (fork): hoist behaviour that every project repeats
 * into `defaults:`, fold legacy project-level `agent`/`agentConfig` into the
 * `worker` role, turn `githubUser: <login>` references into `identity: <key>`
 * and move agent settings shared by every user of an identity into that
 * identity, drop registry-only keys the inline schema ignores, and remove
 * `git config user.*` steps made redundant by identities.
 *
 * Pure functions over parsed YAML objects; the command wraps them with file IO.
 */
import {
  DEFAULTABLE_PROJECT_KEYS,
  DEFAULTABLE_OBJECT_KEYS,
  validateConfig,
  type OrchestratorConfig,
} from "@aoagents/ao-core";

type Obj = Record<string, unknown>;

/** Keys the global registry writes that the inline project schema does not know. */
const REGISTRY_ONLY_PROJECT_KEYS = ["projectId", "source", "registeredAt"] as const;

const GIT_IDENTITY_STEP = /^\s*git\s+config\s+(--global\s+|--local\s+)?user\.(name|email)\b/;

const ROLE_KEYS = ["worker", "orchestrator", "reviewer"] as const;
type RoleKey = (typeof ROLE_KEYS)[number];
/** Role fields an identity can carry (`agent` is top-level, the rest live under `agentConfig`). */
const IDENTITY_AGENT_CONFIG_FIELDS = ["model", "reasoningEffort", "permissions"] as const;
type IdentityField = "agent" | (typeof IDENTITY_AGENT_CONFIG_FIELDS)[number];

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Subtree present with equal values in every object of `values`. */
function commonSubtree(values: unknown[]): unknown {
  if (values.length === 0) return undefined;
  const first = values[0];
  if (values.every((v) => isObj(v))) {
    const out: Obj = {};
    for (const key of Object.keys(first as Obj)) {
      const sub = commonSubtree(values.map((v) => (v as Obj)[key]));
      if (sub !== undefined) out[key] = sub;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return values.every((v) => deepEqual(v, first)) ? clone(first) : undefined;
}

/** Remove from `target` every leaf that equals the same path in `hoisted`. */
function stripHoisted(target: unknown, hoisted: unknown): unknown {
  if (isObj(target) && isObj(hoisted)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(target)) {
      const stripped = k in hoisted ? stripHoisted(v, hoisted[k]) : v;
      if (stripped !== undefined) out[k] = stripped;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return deepEqual(target, hoisted) ? undefined : target;
}

function mergeObj(base: unknown, over: unknown): Obj {
  const out: Obj = isObj(base) ? clone(base) : {};
  if (isObj(over)) {
    for (const [k, v] of Object.entries(over)) {
      out[k] = isObj(v) && isObj(out[k]) ? mergeObj(out[k], v) : clone(v);
    }
  }
  return out;
}

export interface NormalizeOptions {
  /** Fold project-level `agent`/`agentConfig` into the `worker` role. Default true. */
  foldLegacyAgent?: boolean;
  /** Drop `git config user.*` postCreate steps when the worker has an identity. Default true. */
  dropGitIdentitySteps?: boolean;
  /**
   * Rewrite `githubUser: <login>` references to `identity: <key>` and move
   * agent settings shared by every role block of an identity into it. Default true.
   */
  identityProfiles?: boolean;
}

interface RefBlock {
  block: Obj;
  where: string;
  role?: RoleKey;
  isDefault: boolean;
}

/** Key of the identity `ref` names: the key itself, or the single identity carrying that login. */
function identityKeyFor(identities: Obj, ref: string): string | undefined {
  if (isObj(identities[ref])) return ref;
  const matches = Object.entries(identities)
    .filter(([, entry]) => isObj(entry) && entry["githubUser"] === ref)
    .map(([key]) => key);
  return matches.length === 1 ? matches[0] : undefined;
}

function ownField(block: Obj, field: IdentityField): unknown {
  if (field === "agent") return block["agent"];
  const agentConfig = block["agentConfig"];
  return isObj(agentConfig) ? agentConfig[field] : undefined;
}

function deleteField(block: Obj, field: IdentityField): void {
  if (field === "agent") {
    delete block["agent"];
    return;
  }
  const agentConfig = block["agentConfig"];
  if (!isObj(agentConfig)) return;
  delete agentConfig[field];
  if (Object.keys(agentConfig).length === 0) delete block["agentConfig"];
}

function fieldPath(field: IdentityField): string {
  return field === "agent" ? "agent" : `agentConfig.${field}`;
}

/**
 * Identity profiles. Step 1 rewrites every `githubUser: <login>` reference on
 * role and scm blocks to `identity: <key>`. Step 2 moves `agent`,
 * `agentConfig.model`, `.reasoningEffort` and `.permissions` into an identity
 * when every role block that effectively uses that identity agrees on the
 * value (a project block inherits the defaults block of its role) and no
 * project block of the same role relies on that defaults value while using a
 * different identity. Effective behaviour is therefore unchanged; the command
 * verifies that with `diffEffectiveProjects`.
 */
function applyIdentityProfiles(doc: Obj, defaults: Obj, projects: Record<string, Obj>, changes: string[]): void {
  const identities = doc["identities"];
  if (!isObj(identities)) return;
  const blocks: RefBlock[] = [];
  const collect = (owner: Obj, prefix: string, isDefault: boolean): void => {
    if (isObj(owner["scm"])) blocks.push({ block: owner["scm"], where: `${prefix}.scm`, isDefault });
    for (const role of ROLE_KEYS) {
      if (isObj(owner[role])) blocks.push({ block: owner[role], where: `${prefix}.${role}`, role, isDefault });
    }
  };
  collect(defaults, "defaults", true);
  for (const [id, project] of Object.entries(projects)) {
    if (isObj(project)) collect(project, `projects.${id}`, false);
  }

  for (const { block, where } of blocks) {
    const login = block["githubUser"];
    if (typeof block["identity"] === "string") {
      if (login !== undefined) {
        delete block["githubUser"];
        changes.push(`${where}: dropped githubUser (identity ${block["identity"]} provides it)`);
      }
      continue;
    }
    if (typeof login !== "string") continue;
    const key = identityKeyFor(identities, login);
    if (key === undefined) continue;
    block["identity"] = key;
    delete block["githubUser"];
    changes.push(`${where}: githubUser ${login} → identity ${key}`);
  }

  // Step 2: per identity and role, every project is a user when its own block
  // (or, lacking one, the defaults block of that role) names the identity. A
  // project without its own value inherits the defaults block's value only
  // when that block names the same identity; otherwise the value belongs to
  // another identity's defaults and must stay where it is.
  for (const key of Object.keys(identities)) {
    const entry = identities[key];
    if (!isObj(entry)) continue;
    for (const role of ROLE_KEYS) {
      const defaultsBlock = isObj(defaults[role]) ? (defaults[role] as Obj) : undefined;
      const defaultsNamesKey = defaultsBlock?.["identity"] === key;
      const projectBlocks = Object.entries(projects)
        .filter(([, project]) => isObj(project))
        .map(([id, project]) => ({ id, block: isObj(project[role]) ? (project[role] as Obj) : undefined }));
      const users = projectBlocks.filter(({ block }) => (block?.["identity"] ?? defaultsBlock?.["identity"]) === key);
      const others = projectBlocks.filter(({ block }) => (block?.["identity"] ?? defaultsBlock?.["identity"]) !== key);
      if (users.length === 0 && !defaultsNamesKey) continue;
      for (const field of ["agent", ...IDENTITY_AGENT_CONFIG_FIELDS] as IdentityField[]) {
        const defaultsValue = defaultsNamesKey && defaultsBlock ? ownField(defaultsBlock, field) : undefined;
        const values =
          users.length > 0
            ? users.map(({ block }) => (block ? (ownField(block, field) ?? defaultsValue) : defaultsValue))
            : [defaultsValue];
        const value = values[0];
        if (value === undefined || !values.every((v) => deepEqual(v, value))) continue;
        if (defaultsValue !== undefined && !deepEqual(defaultsValue, value)) continue;
        if (entry[field] !== undefined && !deepEqual(entry[field], value)) continue;
        // Removing the value from the defaults block must not change a project
        // that runs as another identity but inherits this field from it.
        if (defaultsValue !== undefined && others.some(({ block }) => !block || ownField(block, field) === undefined)) continue;
        const sources: Array<{ where: string; block: Obj }> = [];
        if (defaultsValue !== undefined && defaultsBlock) sources.push({ where: `defaults.${role}`, block: defaultsBlock });
        for (const { id, block } of users) {
          if (block && ownField(block, field) !== undefined) sources.push({ where: `projects.${id}.${role}`, block });
        }
        if (entry[field] === undefined) {
          entry[field] = clone(value);
          changes.push(`identities.${key}.${field}: hoisted from ${sources.map((s) => s.where).join(", ")}`);
        }
        for (const source of sources) {
          deleteField(source.block, field);
          changes.push(`${source.where}.${fieldPath(field)}: removed (identity ${key} provides it)`);
        }
      }
    }
  }
}

export interface NormalizeResult {
  normalized: Obj;
  /** Human-readable log of what moved or was removed. */
  changes: string[];
}

export function normalizeConfigDocument(raw: Obj, options: NormalizeOptions = {}): NormalizeResult {
  const foldLegacy = options.foldLegacyAgent ?? true;
  const dropGitSteps = options.dropGitIdentitySteps ?? true;
  const identityProfiles = options.identityProfiles ?? true;
  const doc = clone(raw);
  const changes: string[] = [];
  const projects = isObj(doc["projects"]) ? (doc["projects"] as Record<string, Obj>) : {};
  const defaults: Obj = isObj(doc["defaults"]) ? (doc["defaults"] as Obj) : {};
  doc["defaults"] = defaults;

  for (const [id, project] of Object.entries(projects)) {
    if (!isObj(project)) continue;
    if (project["name"] === undefined && typeof project["displayName"] === "string") {
      project["name"] = project["displayName"];
      changes.push(`projects.${id}: displayName → name`);
    }
    for (const key of [...REGISTRY_ONLY_PROJECT_KEYS, "displayName"]) {
      if (key in project) {
        Reflect.deleteProperty(project, key);
        changes.push(`projects.${id}: dropped ${key} (not read by the inline config)`);
      }
    }
    if (foldLegacy && (project["agent"] !== undefined || project["agentConfig"] !== undefined)) {
      const worker: Obj = isObj(project["worker"]) ? (project["worker"] as Obj) : {};
      if (project["agent"] !== undefined) {
        if (worker["agent"] === undefined) worker["agent"] = project["agent"];
        delete project["agent"];
      }
      if (project["agentConfig"] !== undefined) {
        worker["agentConfig"] = mergeObj(project["agentConfig"], worker["agentConfig"]);
        delete project["agentConfig"];
      }
      project["worker"] = worker;
      changes.push(`projects.${id}: folded agent/agentConfig into worker`);
    }
  }

  if (identityProfiles) applyIdentityProfiles(doc, defaults, projects, changes);

  const hasIdentityRef = (block: unknown): boolean =>
    isObj(block) && (typeof block["identity"] === "string" || typeof block["githubUser"] === "string");
  const workerHasIdentity = (project: Obj): boolean =>
    hasIdentityRef(project["worker"]) || hasIdentityRef(defaults["worker"]);
  if (dropGitSteps) {
    for (const [id, project] of Object.entries(projects)) {
      const steps = project["postCreate"];
      if (!Array.isArray(steps) || !workerHasIdentity(project)) continue;
      const kept = steps.filter((s) => !(typeof s === "string" && GIT_IDENTITY_STEP.test(s)));
      if (kept.length !== steps.length) {
        if (kept.length > 0) project["postCreate"] = kept;
        else delete project["postCreate"];
        changes.push(`projects.${id}: removed ${steps.length - kept.length} git identity postCreate step(s) (identity provides GIT_AUTHOR_*)`);
      }
    }
    const dsteps = defaults["postCreate"];
    if (Array.isArray(dsteps) && hasIdentityRef(defaults["worker"])) {
      const kept = dsteps.filter((s) => !(typeof s === "string" && GIT_IDENTITY_STEP.test(s)));
      if (kept.length !== dsteps.length) {
        if (kept.length > 0) defaults["postCreate"] = kept;
        else delete defaults["postCreate"];
        changes.push(`defaults: removed ${dsteps.length - kept.length} git identity postCreate step(s)`);
      }
    }
  }

  const projectList = Object.values(projects).filter(isObj);
  if (projectList.length > 0) {
    for (const key of DEFAULTABLE_PROJECT_KEYS) {
      const isObjectKey = (DEFAULTABLE_OBJECT_KEYS as readonly string[]).includes(key);
      const values = projectList.map((p) => p[key]);
      // Values every project agrees on are safe to hoist even when defaults
      // already has the key: projects override defaults, so the effective
      // value stays what the projects had.
      const common =
        values.every((v) => v !== undefined)
          ? isObjectKey
            ? commonSubtree(values)
            : values.every((v) => deepEqual(v, values[0]))
              ? clone(values[0])
              : undefined
          : undefined;
      if (common !== undefined) {
        const next = isObjectKey ? mergeObj(defaults[key], common) : common;
        if (!deepEqual(next, defaults[key])) {
          defaults[key] = next;
          changes.push(`defaults.${key}: hoisted from ${projectList.length} project(s)`);
        }
      }
      const hoisted = defaults[key];
      if (hoisted === undefined) continue;
      for (const [id, project] of Object.entries(projects)) {
        if (!isObj(project) || project[key] === undefined) continue;
        const stripped = isObjectKey ? stripHoisted(project[key], hoisted) : (deepEqual(project[key], hoisted) ? undefined : project[key]);
        if (stripped === undefined) {
          Reflect.deleteProperty(project, key);
          changes.push(`projects.${id}.${key}: removed (equals defaults)`);
        } else if (isObjectKey && !deepEqual(stripped, project[key])) {
          project[key] = stripped;
          changes.push(`projects.${id}.${key}: kept only overrides`);
        }
      }
    }
  }
  if (Object.keys(defaults).length === 0) delete doc["defaults"];
  return { normalized: doc, changes };
}

export interface EffectiveDiffEntry {
  project: string;
  key: string;
  before: unknown;
  after: unknown;
}

/**
 * Compare the effective (post-validation) projects of two raw documents on
 * every inheritable key. An empty result means normalization preserved
 * behaviour exactly.
 */
export function diffEffectiveProjects(before: Obj, after: Obj): EffectiveDiffEntry[] {
  const a = validateConfig(before);
  const b = validateConfig(after);
  const out: EffectiveDiffEntry[] = [];
  const ids = new Set([...Object.keys(a.projects), ...Object.keys(b.projects)]);
  for (const id of ids) {
    const pa = a.projects[id] as unknown as Obj | undefined;
    const pb = b.projects[id] as unknown as Obj | undefined;
    for (const key of DEFAULTABLE_PROJECT_KEYS) {
      const va = pa?.[key];
      const vb = pb?.[key];
      if (!deepEqual(va, vb)) out.push({ project: id, key, before: va, after: vb });
    }
  }
  return out;
}

/** Fields of a validated config that are runtime-only and must not be printed. */
export function printableConfig(config: OrchestratorConfig): Obj {
  const out = clone(config as unknown as Obj);
  delete out["configPath"];
  delete out["_externalPluginEntries"];
  delete out["degradedProjects"];
  return out;
}
