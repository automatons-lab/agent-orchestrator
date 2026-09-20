/** Fork: preAction hook that fills identity tokens from Secret Manager. */
import { describe, it, expect } from "vitest";
import { Command } from "commander";
import type { OrchestratorConfig } from "@aoagents/ao-core";
import {
  IDENTITY_COMMANDS,
  preloadIdentitySecrets,
  topLevelCommandName,
} from "../../src/lib/identity-secrets.js";

const SECRET = "projects/636504915845/secrets/github-token-neo";

function configWith(identities: Record<string, unknown>): OrchestratorConfig {
  return { identities, defaults: {}, projects: {} } as unknown as OrchestratorConfig;
}

describe("topLevelCommandName", () => {
  it("returns the first-level command for nested actions and undefined for the root", () => {
    const program = new Command("ao");
    const spawn = program.command("spawn");
    const review = program.command("review");
    const run = review.command("run");
    expect(topLevelCommandName(spawn)).toBe("spawn");
    expect(topLevelCommandName(run)).toBe("review");
    expect(topLevelCommandName(program)).toBeUndefined();
  });

  it("lists the identity-using commands and leaves worker-side ones out", () => {
    for (const name of ["start", "spawn", "review", "session", "doctor"]) {
      expect(IDENTITY_COMMANDS.has(name)).toBe(true);
    }
    for (const name of ["acknowledge", "report", "config", "config-help", "completion"]) {
      expect(IDENTITY_COMMANDS.has(name)).toBe(false);
    }
  });
});

describe("preloadIdentitySecrets", () => {
  it("does nothing for commands that never use identities", async () => {
    let loaded = 0;
    const result = await preloadIdentitySecrets("report", {
      loadConfig: () => {
        loaded++;
        return configWith({ neo: { tokenEnv: "NEO_GITHUB_TOKEN", tokenSecret: SECRET } });
      },
      resolve: async () => {
        throw new Error("must not resolve");
      },
    });
    expect(result).toEqual([]);
    expect(loaded).toBe(0);
  });

  it("leaves config problems to the command itself", async () => {
    const result = await preloadIdentitySecrets("spawn", {
      loadConfig: () => {
        throw new Error("no config");
      },
      resolve: async () => {
        throw new Error("must not resolve");
      },
    });
    expect(result).toEqual([]);
  });

  it("skips the lookup when no identity declares tokenSecret", async () => {
    let resolved = 0;
    const result = await preloadIdentitySecrets("start", {
      loadConfig: () => configWith({ neo: { tokenEnv: "NEO_GITHUB_TOKEN" } }),
      resolve: async () => {
        resolved++;
        return [];
      },
    });
    expect(result).toEqual([]);
    expect(resolved).toBe(0);
  });

  it("resolves for identity-using commands and surfaces resolver failures", async () => {
    const config = configWith({ neo: { tokenEnv: "NEO_GITHUB_TOKEN", tokenSecret: SECRET } });
    const seen: OrchestratorConfig[] = [];
    const result = await preloadIdentitySecrets("review", {
      loadConfig: () => config,
      resolve: async (c) => {
        seen.push(c);
        return [{ id: "neo", tokenEnv: "NEO_GITHUB_TOKEN", tokenSecret: SECRET, source: "secret-manager" }];
      },
    });
    expect(seen).toEqual([config]);
    expect(result).toEqual([
      { id: "neo", tokenEnv: "NEO_GITHUB_TOKEN", tokenSecret: SECRET, source: "secret-manager" },
    ]);
    await expect(
      preloadIdentitySecrets("doctor", {
        loadConfig: () => config,
        resolve: async () => {
          throw new Error('Identity "neo": Secret Manager returned HTTP 403');
        },
      }),
    ).rejects.toThrow(/Identity "neo": Secret Manager returned HTTP 403/);
  });
});
