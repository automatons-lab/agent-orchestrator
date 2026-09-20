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
   * Rewrite `githubUser: <login>` references to `identity: <key>` and point
   * identities at the declared `agents:` profile their role blocks repeat. Default true.
   */
  identityProfiles?: boolean;
  /**
   * Also hoist a scalar/array value shared by every project that sets it
   * when some projects lack it. Those projects then inherit the value, so
   * their behaviour changes; the change log names them. Default false: the
   * command only prints a hint.
   */
  hoistMajority?: boolean;
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

/**
 * Identity and agent profiles. Step 1 rewrites every `githubUser: <login>`
 * reference on role and scm blocks to `identity: <key>`. Step 2 points each
 * identity at the declared `agents:` profile that matches the agent settings
 * of every role block using it and removes the now duplicated `agent` /
 * `agentConfig` fields. Effective behaviour is unchanged; the command verifies
 * that with `diffEffectiveProjects`.
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

  // Step 2: wire identities to declared agent profiles. For every identity
  // and role, every project is a user when its own block (or, lacking one,
  // the defaults block of that role) names the identity. When one declared
  // profile matches the effective agent settings of every user in every role
  // (plugin equal, each profile key equal; extra agentConfig keys stay as
  // overrides), the identity gets `agent: <profile>` and the duplicated fields
  // leave the blocks. A value inherited from the defaults block counts only
  // when that block names the same identity; removing a field from defaults
  // must not change a project that runs as another identity but inherits it.
  const agents = doc["agents"];
  if (!isObj(agents)) return;
  const profileKeys = (profile: Obj): string[] => Object.keys(profile).filter((k) => k !== "plugin");
  // A block's own agentConfig keys stay as overrides whatever the profile says;
  // keys it inherits must equal the profile's value or the behaviour would change.
  const profileMatches = (profile: Obj, e: { plugin: unknown; ownConfig: Obj; inheritedConfig: Obj }): boolean =>
    profile["plugin"] === e.plugin &&
    profileKeys(profile).every((k) => e.ownConfig[k] !== undefined || deepEqual(e.inheritedConfig[k], profile[k]));
  for (const key of Object.keys(identities)) {
    const entry = identities[key];
    if (!isObj(entry)) continue;
    const identityAgent = entry["agent"];
    if (identityAgent !== undefined && !isObj(agents[String(identityAgent)])) continue; // bare plugin: leave alone
    let candidates: string[] | undefined = identityAgent !== undefined ? [String(identityAgent)] : undefined;
    interface Source {
      where: string;
      block: Obj;
      inheritsAgent: boolean;
      inheritedConfigKeys: Set<string>;
    }
    const sources: Source[] = [];
    let usable = true;
    for (const role of ROLE_KEYS) {
      const defaultsBlock = isObj(defaults[role]) ? (defaults[role] as Obj) : undefined;
      const defaultsNamesKey = defaultsBlock?.["identity"] === key;
      const defaultsAgent = defaultsNamesKey && defaultsBlock ? defaultsBlock["agent"] : undefined;
      const defaultsConfig = defaultsNamesKey && defaultsBlock && isObj(defaultsBlock["agentConfig"]) ? (defaultsBlock["agentConfig"] as Obj) : {};
      const projectBlocks = Object.entries(projects)
        .filter(([, project]) => isObj(project))
        .map(([id, project]) => ({ id, block: isObj(project[role]) ? (project[role] as Obj) : undefined }));
      const users = projectBlocks.filter(({ block }) => (block?.["identity"] ?? defaultsBlock?.["identity"]) === key);
      const others = projectBlocks.filter(({ block }) => (block?.["identity"] ?? defaultsBlock?.["identity"]) !== key);
      if (users.length === 0 && !defaultsNamesKey) continue;
      const effectives = (users.length > 0 ? users : [{ block: undefined }]).map(({ block }) => {
        const ownAgent = block?.["agent"];
        if (ownAgent !== undefined && isObj(agents[String(ownAgent)])) return undefined; // already on a profile
        const ownConfig = block && isObj(block["agentConfig"]) ? (block["agentConfig"] as Obj) : {};
        return { plugin: ownAgent ?? defaultsAgent, ownConfig, inheritedConfig: defaultsConfig };
      });
      if (effectives.some((e) => e === undefined || e.plugin === undefined)) {
        usable = false;
        break;
      }
      const matching = Object.keys(agents).filter((name) => {
        const profile = agents[name];
        return isObj(profile) && effectives.every((e) => profileMatches(profile, e!));
      });
      candidates = candidates === undefined ? matching : candidates.filter((c) => matching.includes(c));
      if (candidates.length === 0) {
        usable = false;
        break;
      }
      // Fields the defaults block would lose must not be inherited by other-identity projects.
      if (defaultsNamesKey && defaultsBlock) {
        const inheritedByOthers = (field: string, inConfig: boolean): boolean =>
          others.some(({ block }) => {
            if (!block) return true;
            if (!inConfig) return block["agent"] === undefined;
            return !(isObj(block["agentConfig"]) && (block["agentConfig"] as Obj)[field] !== undefined);
          });
        const lost = [
          ...(defaultsAgent !== undefined && inheritedByOthers("agent", false) ? ["agent"] : []),
          ...Object.keys(defaultsConfig).filter((k) => inheritedByOthers(k, true)),
        ];
        if (lost.length > 0) {
          usable = false;
          break;
        }
        sources.push({ where: `defaults.${role}`, block: defaultsBlock, inheritsAgent: false, inheritedConfigKeys: new Set() });
      }
      for (const { id, block } of users) {
        if (!block) continue;
        sources.push({
          where: `projects.${id}.${role}`,
          block,
          inheritsAgent: block["agent"] === undefined,
          inheritedConfigKeys: new Set(Object.keys(defaultsConfig)),
        });
      }
    }
    if (!usable || candidates === undefined || candidates.length === 0 || sources.length === 0) continue;
    const best = [...candidates].sort((a, b) => {
      const diff = profileKeys(agents[b] as Obj).length - profileKeys(agents[a] as Obj).length;
      return diff !== 0 ? diff : a.localeCompare(b);
    })[0]!;
    const profile = agents[best] as Obj;
    if (entry["agent"] === undefined) {
      entry["agent"] = best;
      changes.push(`identities.${key}.agent: → ${best} (matches agents.${best})`);
    }
    for (const source of sources) {
      if (!source.inheritsAgent && source.block["agent"] === profile["plugin"]) {
        delete source.block["agent"];
        changes.push(`${source.where}.agent: removed (agents.${best} provides it)`);
      }
      const agentConfig = source.block["agentConfig"];
      if (!isObj(agentConfig)) continue;
      for (const k of profileKeys(profile)) {
        if (agentConfig[k] !== undefined && deepEqual(agentConfig[k], profile[k])) {
          delete agentConfig[k];
          changes.push(`${source.where}.agentConfig.${k}: removed (agents.${best} provides it)`);
        }
      }
      if (Object.keys(agentConfig).length === 0) delete source.block["agentConfig"];
    }
  }
}

export interface NormalizeResult {
  normalized: Obj;
  /** Human-readable log of what moved or was removed. */
  changes: string[];
  /** Things worth doing by hand that the normalizer refused to do silently. */
  hints: string[];
}

export function normalizeConfigDocument(raw: Obj, options: NormalizeOptions = {}): NormalizeResult {
  const foldLegacy = options.foldLegacyAgent ?? true;
  const dropGitSteps = options.dropGitIdentitySteps ?? true;
  const identityProfiles = options.identityProfiles ?? true;
  const hoistMajority = options.hoistMajority ?? false;
  const doc = clone(raw);
  const changes: string[] = [];
  const hints: string[] = [];
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
      } else if (!isObjectKey) {
        // Majority case: every project that sets the key agrees, some lack it.
        // Hoisting would change the projects without it (they would inherit
        // the value instead of the built-in fallback or the current default),
        // so it only happens on request; otherwise say what is going on.
        // Objects are left alone: a partial overlap has no single "value".
        const entries = Object.entries(projects).filter((e): e is [string, Obj] => isObj(e[1]));
        const present = entries.filter(([, p]) => p[key] !== undefined);
        const missing = entries.filter(([, p]) => p[key] === undefined).map(([id]) => id);
        const shared = present[0]?.[1][key];
        if (
          present.length >= 2 &&
          missing.length > 0 &&
          present.every(([, p]) => deepEqual(p[key], shared)) &&
          !deepEqual(defaults[key], shared)
        ) {
          const count = `${present.length} of ${entries.length} project(s)`;
          if (hoistMajority) {
            defaults[key] = clone(shared);
            changes.push(`defaults.${key}: hoisted from ${count}; now also applies to ${missing.join(", ")}`);
          } else {
            const current = defaults[key] === undefined ? "no default" : `default ${JSON.stringify(defaults[key])}`;
            hints.push(
              `defaults.${key}: ${count} share ${JSON.stringify(shared)} (${current}), missing in ${missing.join(", ")} ` +
                "— not hoisted because that would change them; set it there or pass --hoist-majority",
            );
          }
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
  return { normalized: doc, changes, hints };
}

/** Fields validation derives (`agentProfile`) are bookkeeping, not behaviour. */
function withoutDerived(value: unknown): unknown {
  if (!isObj(value)) return value;
  const { agentProfile: _ignored, ...rest } = value;
  return rest;
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
      const va = withoutDerived(pa?.[key]);
      const vb = withoutDerived(pb?.[key]);
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
