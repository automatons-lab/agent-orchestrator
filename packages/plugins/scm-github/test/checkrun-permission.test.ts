/**
 * Fine-grained PATs cannot expand CheckRun nodes: the batch enrichment must
 * keep the partial GraphQL data (rollup state) instead of failing the batch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Core from "@aoagents/ao-core";

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof Core>();
  return { ...actual, recordActivityEvent: vi.fn() };
});

import { recordActivityEvent } from "@aoagents/ao-core";
import {
  _resetCheckRunPermissionWarnedForTesting,
  clearETagCache,
  clearPRMetadataCache,
  enrichSessionsPRBatch,
  isCheckRunPermissionError,
  setExecFileAsync,
} from "../src/graphql-batch.js";

const pr = {
  owner: "automatons-lab",
  repo: "review-sandbox",
  number: 2,
  url: "https://github.com/automatons-lab/review-sandbox/pull/2",
  title: "t",
  branch: "b",
  baseBranch: "main",
  isDraft: false,
};

const forbidden = {
  type: "FORBIDDEN",
  path: ["pr0", "pullRequest", "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes", 0],
  message: "Resource not accessible by personal access token",
};

function graphqlBody(errors: unknown[]): string {
  return JSON.stringify({
    data: {
      pr0: {
        pullRequest: {
          title: "t",
          state: "OPEN",
          additions: 1,
          deletions: 0,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "BLOCKED",
          reviewDecision: "REVIEW_REQUIRED",
          headRefName: "b",
          headRefOid: "995172eb838705dffa8ca8b1cb8195ebe89eaea0",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: "SUCCESS",
                    contexts: { nodes: [null], pageInfo: { hasNextPage: false } },
                  },
                },
              },
            ],
          },
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-09-20T00:00:00Z" },
    },
    ...(errors.length > 0 ? { errors } : {}),
  });
}

function installGhMock(errors: unknown[], opts: { rejectGraphql?: boolean } = {}) {
  setExecFileAsync(vi.fn(async (_file: string, args: string[]) => {
    if (args.includes("graphql")) {
      const stdout = `HTTP/2.0 200 OK\r\nEtag: W/"gql"\r\n\r\n${graphqlBody(errors)}`;
      if (opts.rejectGraphql) {
        // gh exits 1 when the response has `errors`; the body is still on stdout.
        throw Object.assign(new Error("Command failed: gh api graphql"), {
          stdout,
          stderr: "gh: Resource not accessible by personal access token",
          code: 1,
        });
      }
      return { stdout, stderr: "" };
    }
    // Guard 1: PR list with ETag
    return { stdout: `HTTP/2.0 200 OK\r\nEtag: W/"list"\r\n\r\n[{"number":2}]`, stderr: "" };
  }) as never);
}

describe("check-run permission tolerance", () => {
  beforeEach(() => {
    clearETagCache();
    clearPRMetadataCache();
    _resetCheckRunPermissionWarnedForTesting();
    vi.mocked(recordActivityEvent).mockClear();
  });

  it("classifies FORBIDDEN on statusCheckRollup.contexts as tolerable, other errors not", () => {
    expect(isCheckRunPermissionError(forbidden)).toBe(true);
    expect(isCheckRunPermissionError({ ...forbidden, type: undefined })).toBe(true);
    expect(isCheckRunPermissionError({ type: "FORBIDDEN", path: ["pr0", "pullRequest"], message: "x" })).toBe(false);
    expect(isCheckRunPermissionError({ type: "NOT_FOUND", path: ["pr0", "pullRequest", "contexts"], message: "Could not resolve" })).toBe(false);
  });

  it("keeps the partial batch data and derives ciStatus from the rollup state", async () => {
    installGhMock([forbidden]);
    const { enrichment: map } = await enrichSessionsPRBatch([pr], undefined, ["automatons-lab/review-sandbox"]);
    const data = map.get("automatons-lab/review-sandbox#2");
    expect(data).toBeDefined();
    expect(data?.ciStatus).toBe("passing");
    expect(data?.reviewDecision).toBe("pending");
    expect(data?.headSha).toBe("995172eb838705dffa8ca8b1cb8195ebe89eaea0");
    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "scm.checks_permission_missing", level: "warn" }),
    );
    // warned once per process
    await enrichSessionsPRBatch([pr], undefined, ["automatons-lab/review-sandbox"]);
    expect(vi.mocked(recordActivityEvent).mock.calls.filter((c) => c[0]?.kind === "scm.checks_permission_missing")).toHaveLength(1);
  });

  it("recovers the partial body when gh exits non-zero because of the tolerable error", async () => {
    installGhMock([forbidden], { rejectGraphql: true });
    const { enrichment } = await enrichSessionsPRBatch([pr], undefined, ["automatons-lab/review-sandbox"]);
    expect(enrichment.get("automatons-lab/review-sandbox#2")?.ciStatus).toBe("passing");
  });

  it("still fails the batch on any other GraphQL error", async () => {
    installGhMock([{ type: "NOT_FOUND", path: ["pr0"], message: "Could not resolve to a Repository" }]);
    const { enrichment: map } = await enrichSessionsPRBatch([pr], undefined, ["automatons-lab/review-sandbox"]);
    expect(map.get("automatons-lab/review-sandbox#2")).toBeUndefined();
  });
});
