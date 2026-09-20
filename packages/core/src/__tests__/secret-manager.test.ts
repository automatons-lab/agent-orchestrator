/** Fork: identity tokens from Google Secret Manager (`identities.<id>.tokenSecret`). */
import { describe, it, expect, beforeEach } from "vitest";
import { validateConfig } from "../config.js";
import { applyEngineIdentity, checkIdentities, resolveIdentity, roleIdentityEnvironment } from "../identities.js";
import {
  GCP_SECRET_NAME_RE,
  accessGcpSecret,
  fetchGceAccessToken,
  identitiesUsingSecrets,
  identityTokenSecretSource,
  resetIdentitySecretRegistry,
  resolveIdentitySecrets,
  secretVersionName,
} from "../secret-manager.js";

const NEO_SECRET = "projects/636504915845/secrets/github-token-neo";
const TRI_SECRET = "projects/636504915845/secrets/github-token-trinity/versions/7";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fake metadata server + Secret Manager. Values are strings; numbers are HTTP error codes. */
function fakeFetch(secrets: Record<string, string | number>, calls: string[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes("/computeMetadata/")) {
      expect(headers["Metadata-Flavor"]).toBe("Google");
      return jsonResponse(200, { access_token: "ya29.test", expires_in: 3599, token_type: "Bearer" });
    }
    expect(headers["Authorization"]).toBe("Bearer ya29.test");
    const name = /\/v1\/(.+):access$/.exec(url)?.[1] ?? "";
    const entry = secrets[name];
    if (entry === undefined) {
      return jsonResponse(404, { error: { code: 404, status: "NOT_FOUND", message: `Secret [${name}] not found` } });
    }
    if (typeof entry === "number") {
      return jsonResponse(entry, { error: { code: entry, status: "PERMISSION_DENIED", message: "Permission denied" } });
    }
    return jsonResponse(200, { name, payload: { data: Buffer.from(entry, "utf8").toString("base64") } });
  };
}

function config(identities: Record<string, Record<string, unknown>>) {
  return validateConfig({
    identities,
    defaults: {
      scm: { plugin: "github", identity: "neo" },
      worker: { identity: "neo" },
      reviewer: { identity: "trinity", enabled: true },
    },
    projects: {
      app: { path: "/repos/app", repo: "org/app", defaultBranch: "main", sessionPrefix: "app" },
    },
  });
}

const IDENTITIES = {
  neo: { githubUser: "neo-automaton", tokenEnv: "NEO_GITHUB_TOKEN", tokenSecret: NEO_SECRET },
  trinity: { githubUser: "trinity-automaton", tokenEnv: "TRINITY_GITHUB_TOKEN", tokenSecret: TRI_SECRET },
};

beforeEach(() => resetIdentitySecretRegistry());

describe("secret names", () => {
  it("accepts project ids and numbers with an optional version", () => {
    expect(GCP_SECRET_NAME_RE.test(NEO_SECRET)).toBe(true);
    expect(GCP_SECRET_NAME_RE.test(TRI_SECRET)).toBe(true);
    expect(GCP_SECRET_NAME_RE.test("projects/my-proj.1/secrets/x_y-z")).toBe(true);
    expect(GCP_SECRET_NAME_RE.test("github-token-neo")).toBe(false);
    expect(GCP_SECRET_NAME_RE.test("projects/p/secrets/")).toBe(false);
    expect(GCP_SECRET_NAME_RE.test("projects/p/secrets/x/versions/")).toBe(false);
  });

  it("reads latest unless a version is named", () => {
    expect(secretVersionName(NEO_SECRET)).toBe(`${NEO_SECRET}/versions/latest`);
    expect(secretVersionName(TRI_SECRET)).toBe(TRI_SECRET);
  });

  it("config validation rejects malformed tokenSecret", () => {
    expect(() =>
      config({ neo: { githubUser: "neo-automaton", tokenEnv: "NEO_GITHUB_TOKEN", tokenSecret: "github-token-neo" } }),
    ).toThrow(/tokenSecret must be projects\/<project>\/secrets\/<name>/);
  });
});

describe("resolveIdentitySecrets", () => {
  it("fills unset variables from Secret Manager with one metadata call", async () => {
    const calls: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    const fetch = fakeFetch({ [`${NEO_SECRET}/versions/latest`]: "ghp_neo\n", [TRI_SECRET]: "ghp_tri" }, calls);
    const results = await resolveIdentitySecrets(config(IDENTITIES), { fetch, env });

    expect(env["NEO_GITHUB_TOKEN"]).toBe("ghp_neo");
    expect(env["TRINITY_GITHUB_TOKEN"]).toBe("ghp_tri");
    expect(results).toEqual([
      { id: "neo", tokenEnv: "NEO_GITHUB_TOKEN", tokenSecret: NEO_SECRET, source: "secret-manager" },
      { id: "trinity", tokenEnv: "TRINITY_GITHUB_TOKEN", tokenSecret: TRI_SECRET, source: "secret-manager" },
    ]);
    expect(calls.filter((u) => u.includes("/computeMetadata/"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes(":access"))).toHaveLength(2);
    expect(identityTokenSecretSource("NEO_GITHUB_TOKEN")).toBe(NEO_SECRET);
    expect(identityTokenSecretSource("OTHER")).toBeUndefined();
  });

  it("never overwrites a set variable and does not call the network when nothing is missing", async () => {
    const calls: string[] = [];
    const env: NodeJS.ProcessEnv = { NEO_GITHUB_TOKEN: "ghp_local", TRINITY_GITHUB_TOKEN: "ghp_local2" };
    const results = await resolveIdentitySecrets(config(IDENTITIES), { fetch: fakeFetch({}, calls), env });
    expect(calls).toEqual([]);
    expect(env["NEO_GITHUB_TOKEN"]).toBe("ghp_local");
    expect(results.map((r) => r.source)).toEqual(["env", "env"]);
  });

  it("only fetches the missing ones", async () => {
    const calls: string[] = [];
    const env: NodeJS.ProcessEnv = { NEO_GITHUB_TOKEN: "ghp_local" };
    const fetch = fakeFetch({ [TRI_SECRET]: "ghp_tri" }, calls);
    const results = await resolveIdentitySecrets(config(IDENTITIES), { fetch, env });
    expect(calls.filter((u) => u.includes(":access"))).toEqual([
      `https://secretmanager.googleapis.com/v1/${TRI_SECRET}:access`,
    ]);
    expect(results).toEqual([
      { id: "neo", tokenEnv: "NEO_GITHUB_TOKEN", tokenSecret: NEO_SECRET, source: "env" },
      { id: "trinity", tokenEnv: "TRINITY_GITHUB_TOKEN", tokenSecret: TRI_SECRET, source: "secret-manager" },
    ]);
  });

  it("ignores identities without tokenSecret", async () => {
    const calls: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    const cfg = config({
      neo: { githubUser: "neo-automaton", tokenEnv: "NEO_GITHUB_TOKEN" },
      trinity: { githubUser: "trinity-automaton", tokenEnv: "TRINITY_GITHUB_TOKEN" },
    });
    expect(identitiesUsingSecrets(cfg)).toBe(false);
    expect(identitiesUsingSecrets(config(IDENTITIES))).toBe(true);
    expect(await resolveIdentitySecrets(cfg, { fetch: fakeFetch({}, calls), env })).toEqual([]);
    expect(calls).toEqual([]);
    expect(env["NEO_GITHUB_TOKEN"]).toBeUndefined();
  });

  it("names the identity and secret on an API error and leaves the environment untouched", async () => {
    const env: NodeJS.ProcessEnv = {};
    const fetch = fakeFetch({ [`${NEO_SECRET}/versions/latest`]: 403, [TRI_SECRET]: "ghp_tri" });
    await expect(resolveIdentitySecrets(config(IDENTITIES), { fetch, env })).rejects.toThrow(
      /Identity "neo": Secret Manager returned HTTP 403 for projects\/636504915845\/secrets\/github-token-neo: PERMISSION_DENIED: Permission denied/,
    );
    expect(env["NEO_GITHUB_TOKEN"]).toBeUndefined();
    expect(env["TRINITY_GITHUB_TOKEN"]).toBeUndefined();
    expect(identityTokenSecretSource("TRINITY_GITHUB_TOKEN")).toBeUndefined();
  });

  it("explains an unreachable metadata server and lists the identities", async () => {
    const env: NodeJS.ProcessEnv = {};
    const fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(resolveIdentitySecrets(config(IDENTITIES), { fetch, env })).rejects.toThrow(
      /Cannot resolve tokenSecret for neo, trinity: GCE metadata server unreachable at http:\/\/metadata\.google\.internal\/.*ECONNREFUSED.*only resolves on a GCE VM/,
    );
  });

  it("rejects an empty secret and a payload-less response", async () => {
    const empty = fakeFetch({ [`${NEO_SECRET}/versions/latest`]: "  \n" });
    await expect(accessGcpSecret(NEO_SECRET, "ya29.test", { fetch: empty })).rejects.toThrow(/is empty/);
    const bare = async () => jsonResponse(200, { name: "x" });
    await expect(accessGcpSecret(NEO_SECRET, "ya29.test", { fetch: bare })).rejects.toThrow(/no payload/);
  });

  it("honours GCE_METADATA_HOST and rejects a token-less metadata reply", async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      return jsonResponse(200, {});
    };
    await expect(fetchGceAccessToken({ fetch, env: { GCE_METADATA_HOST: "169.254.169.254" } })).rejects.toThrow(
      /no access_token/,
    );
    expect(calls).toEqual(["http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token"]);
  });
});

describe("identities with tokenSecret", () => {
  it("report the token source and secret once resolved", async () => {
    const env: NodeJS.ProcessEnv = {};
    const cfg = config(IDENTITIES);
    const fetch = fakeFetch({ [`${NEO_SECRET}/versions/latest`]: "ghp_neo", [TRI_SECRET]: "ghp_tri" });
    await resolveIdentitySecrets(cfg, { fetch, env });

    const neo = resolveIdentity(cfg, "neo", env);
    expect(neo).toMatchObject({ id: "neo", token: "ghp_neo", tokenSecret: NEO_SECRET, tokenSource: "secret-manager" });
    expect(applyEngineIdentity(cfg, env)).toEqual({
      login: "neo-automaton",
      applied: true,
      reason: `GH_TOKEN exported from NEO_GITHUB_TOKEN (Secret Manager ${NEO_SECRET})`,
    });
    expect(roleIdentityEnvironment(cfg, cfg.projects["app"]!, "reviewer", env)["GH_TOKEN"]).toBe("ghp_tri");

    const checks = await checkIdentities(cfg, { env, verifyLogin: false });
    expect(checks.map((c) => [c.id, c.tokenSource, c.tokenSecret, c.ok])).toEqual([
      ["neo", "secret-manager", NEO_SECRET, true],
      ["trinity", "secret-manager", TRI_SECRET, true],
    ]);
  });

  it("report env as the source when the variable was set by hand", async () => {
    const env: NodeJS.ProcessEnv = { NEO_GITHUB_TOKEN: "ghp_local" };
    const cfg = config(IDENTITIES);
    expect(resolveIdentity(cfg, "neo", env)).toMatchObject({ tokenSource: "env", tokenSecret: NEO_SECRET });
    expect(applyEngineIdentity(cfg, env).reason).toBe("GH_TOKEN exported from NEO_GITHUB_TOKEN");
  });

  it("mention the secret when the token is still missing", async () => {
    const env: NodeJS.ProcessEnv = {};
    const cfg = config(IDENTITIES);
    expect(resolveIdentity(cfg, "neo", env)?.tokenSource).toBeUndefined();
    expect(applyEngineIdentity(cfg, env).reason).toBe(
      `environment variable NEO_GITHUB_TOKEN is not set and Secret Manager secret ${NEO_SECRET} was not resolved (needs the GCE metadata server, or export the variable)`,
    );
    expect(() => roleIdentityEnvironment(cfg, cfg.projects["app"]!, "worker", env)).toThrow(
      /Identity "neo": environment variable NEO_GITHUB_TOKEN is not set and Secret Manager secret projects\/636504915845\/secrets\/github-token-neo was not resolved/,
    );
    const checks = await checkIdentities(cfg, { env, verifyLogin: false });
    expect(checks[0]).toMatchObject({ id: "neo", tokenPresent: false, ok: false, tokenSecret: NEO_SECRET });
    expect(checks[0]!.problem).toMatch(/Secret Manager secret .* was not resolved/);
  });
});
