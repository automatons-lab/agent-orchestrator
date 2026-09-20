/**
 * Google Secret Manager token source (fork).
 *
 * `identities.<id>.tokenSecret` names a Secret Manager secret
 * (`projects/<project>/secrets/<name>[/versions/<version>]`). Before a command
 * that acts as an identity runs, `resolveIdentitySecrets` reads every secret
 * whose `tokenEnv` variable is unset and exports the value into the process
 * environment, so the rest of the code keeps reading tokens from `tokenEnv`
 * and child sessions keep receiving `GH_TOKEN` as before. Authentication uses
 * the GCE metadata server (the VM's service account); nothing is stored on
 * disk. Off GCE, export the variables by hand as before — a set variable
 * always wins over the secret.
 */
import type { OrchestratorConfig } from "./types.js";

/** `projects/<project id or number>/secrets/<name>` with an optional `/versions/<version>`. */
export const GCP_SECRET_NAME_RE =
  /^projects\/[A-Za-z0-9][A-Za-z0-9._-]*\/secrets\/[A-Za-z0-9_-]+(?:\/versions\/[A-Za-z0-9_-]+)?$/;

export const GCE_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const SECRET_MANAGER_BASE = "https://secretmanager.googleapis.com/v1";
const METADATA_TIMEOUT_MS = 5_000;
const SECRET_TIMEOUT_MS = 15_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SecretResolverDeps {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Override the metadata token endpoint (tests). Defaults honour `GCE_METADATA_HOST`. */
  metadataTokenUrl?: string;
}

/** "env" = the variable was already set; "secret-manager" = filled from the secret. */
export type IdentityTokenSource = "env" | "secret-manager";

export interface IdentitySecretResult {
  id: string;
  tokenEnv: string;
  tokenSecret: string;
  source: IdentityTokenSource;
}

/** Variables this process filled from Secret Manager (tokenEnv → secret name). */
const filledFromSecrets = new Map<string, string>();

/** Secret name a variable was filled from in this process, if any. Never the value. */
export function identityTokenSecretSource(tokenEnv: string): string | undefined {
  return filledFromSecrets.get(tokenEnv);
}

/** Test hook: forget which variables were filled from secrets. */
export function resetIdentitySecretRegistry(): void {
  filledFromSecrets.clear();
}

/** True when at least one identity declares `tokenSecret`. */
export function identitiesUsingSecrets(config: Pick<OrchestratorConfig, "identities">): boolean {
  return Object.values(config.identities ?? {}).some((entry) => entry.tokenSecret !== undefined);
}

export function metadataTokenUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = env["GCE_METADATA_HOST"];
  return host
    ? `http://${host}/computeMetadata/v1/instance/service-accounts/default/token`
    : GCE_METADATA_TOKEN_URL;
}

/** Access token of the VM's default service account, from the metadata server. */
export async function fetchGceAccessToken(deps: SecretResolverDeps = {}): Promise<string> {
  const fetchImpl = deps.fetch ?? fetch;
  const url = deps.metadataTokenUrl ?? metadataTokenUrl(deps.env);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `GCE metadata server unreachable at ${url} (${errorMessage(err)}); ` +
        "tokenSecret only resolves on a GCE VM with a service account",
    );
  }
  if (!response.ok) {
    throw new Error(`GCE metadata server returned HTTP ${response.status} for the service-account token`);
  }
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("GCE metadata server returned no access_token");
  }
  return body.access_token;
}

/** Full version resource name; bare secrets read `latest`. */
export function secretVersionName(secret: string): string {
  return secret.includes("/versions/") ? secret : `${secret}/versions/latest`;
}

/** Read one secret version. The value is trimmed (secrets added from files often end in a newline). */
export async function accessGcpSecret(
  secret: string,
  accessToken: string,
  deps: SecretResolverDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetch ?? fetch;
  const url = `${SECRET_MANAGER_BASE}/${secretVersionName(secret)}:access`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(SECRET_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Secret Manager request for ${secret} failed (${errorMessage(err)})`);
  }
  if (!response.ok) {
    const detail = await describeApiError(response);
    throw new Error(
      `Secret Manager returned HTTP ${response.status} for ${secret}${detail ? `: ${detail}` : ""}`,
    );
  }
  const body = (await response.json()) as { payload?: { data?: unknown } };
  const data = body.payload?.data;
  if (typeof data !== "string") {
    throw new Error(`Secret Manager returned no payload for ${secret}`);
  }
  const value = Buffer.from(data, "base64").toString("utf8").trim();
  if (value.length === 0) {
    throw new Error(`Secret Manager secret ${secret} is empty`);
  }
  return value;
}

async function describeApiError(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { status?: string; message?: string } };
    const parts = [body.error?.status, body.error?.message].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    return parts.length > 0 ? parts.join(": ") : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fill `tokenEnv` for every identity that declares `tokenSecret` and whose
 * variable is unset. A set variable is never overwritten (an explicit export
 * or the systemd EnvironmentFile wins) and values are never logged. One
 * metadata call serves all secrets; the first failure throws with the
 * identity id and secret name so `ao start` / `ao spawn` fail loudly.
 */
export async function resolveIdentitySecrets(
  config: Pick<OrchestratorConfig, "identities">,
  deps: SecretResolverDeps = {},
): Promise<IdentitySecretResult[]> {
  const env = deps.env ?? process.env;
  const pending: Array<{ id: string; tokenEnv: string; tokenSecret: string }> = [];
  const results: IdentitySecretResult[] = [];
  for (const [id, entry] of Object.entries(config.identities ?? {})) {
    if (entry.tokenSecret === undefined) continue;
    const current = env[entry.tokenEnv];
    if (typeof current === "string" && current.trim().length > 0) {
      results.push({
        id,
        tokenEnv: entry.tokenEnv,
        tokenSecret: entry.tokenSecret,
        source: filledFromSecrets.has(entry.tokenEnv) ? "secret-manager" : "env",
      });
      continue;
    }
    pending.push({ id, tokenEnv: entry.tokenEnv, tokenSecret: entry.tokenSecret });
  }
  if (pending.length === 0) return results;

  let accessToken: string;
  try {
    accessToken = await fetchGceAccessToken(deps);
  } catch (err) {
    const ids = pending.map((p) => p.id).join(", ");
    throw new Error(`Cannot resolve tokenSecret for ${ids}: ${errorMessage(err)}`);
  }
  const fetched = await Promise.all(
    pending.map(async (p) => {
      try {
        return { ...p, value: await accessGcpSecret(p.tokenSecret, accessToken, deps) };
      } catch (err) {
        throw new Error(`Identity "${p.id}": ${errorMessage(err)}`);
      }
    }),
  );
  for (const f of fetched) {
    env[f.tokenEnv] = f.value;
    filledFromSecrets.set(f.tokenEnv, f.tokenSecret);
    results.push({ id: f.id, tokenEnv: f.tokenEnv, tokenSecret: f.tokenSecret, source: "secret-manager" });
  }
  return results;
}
