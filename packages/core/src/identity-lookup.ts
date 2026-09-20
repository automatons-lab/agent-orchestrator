/**
 * Identity lookup helpers (fork). Pure functions over the `identities:` map so
 * config validation and the runtime resolve references the same way.
 *
 * An identity is keyed by a free id (`neo`, `trinity-codex`); its GitHub login
 * is `githubUser` and defaults to the key. Roles reference an identity by key
 * (`identity: neo`); the legacy `githubUser: <login>` reference still resolves
 * when exactly one identity carries that login.
 */
import type { AgentProfileConfig, IdentityConfig } from "./types.js";

export type IdentityMap = Record<string, IdentityConfig>;
export type AgentProfileMap = Record<string, AgentProfileConfig>;

export interface ResolvedAgentRef {
  /** Agent plugin name (`codex`, `claude-code`, ...). */
  plugin: string;
  /** Key under `agents:` when `ref` named a profile. */
  profile?: string;
  /** The profile's settings (everything but `plugin`), empty for a bare plugin name. */
  config: Record<string, unknown>;
}

/**
 * What an `agent:` reference means: a key of `agents:` (profile: plugin +
 * settings) or, when no profile has that name, a bare agent plugin name.
 */
export function resolveAgentRef(agents: AgentProfileMap | undefined, ref: string): ResolvedAgentRef {
  const profile = agents?.[ref];
  if (!profile) return { plugin: ref, config: {} };
  const { plugin, ...config } = profile;
  return { plugin, profile: ref, config };
}

/** GitHub login of identity `key`: its `githubUser`, else the key itself. */
export function identityLogin(identities: IdentityMap | undefined, key: string): string {
  return identities?.[key]?.githubUser ?? key;
}

/**
 * Key of the identity `ref` names: `ref` itself when it is a key, else the
 * single identity whose login is `ref`. Undefined when nothing matches.
 * Throws when several identities share that login, because a login can no
 * longer tell them apart and the caller must use `identity: <key>`.
 */
export function findIdentityKey(identities: IdentityMap | undefined, ref: string): string | undefined {
  if (!identities) return undefined;
  if (identities[ref] !== undefined) return ref;
  const matches = Object.entries(identities)
    .filter(([, entry]) => entry.githubUser === ref)
    .map(([key]) => key);
  if (matches.length > 1) {
    throw new Error(
      `githubUser "${ref}" matches several identities (${matches.join(", ")}); ` +
        "reference one of them with identity: <key> instead",
    );
  }
  return matches[0];
}
