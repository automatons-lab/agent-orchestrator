import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionManager } from "../../session-manager.js";
import { listMetadata, readMetadataRaw, writeMetadata } from "../../metadata.js";
import { setupTestContext, teardownTestContext, type TestContext } from "../test-utils.js";

describe("review-only sessions", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = setupTestContext();
  });
  afterEach(() => teardownTestContext(ctx));

  function setup() {
    const pr = {
      number: 42,
      url: "https://github.com/org/my-app/pull/42",
      title: "External PR",
      owner: "org",
      repo: "my-app",
      branch: "external",
      baseBranch: "release",
      isDraft: true,
    };
    const scm = {
      resolvePR: vi.fn().mockResolvedValue(pr),
      getPRState: vi.fn().mockResolvedValue("open"),
      checkoutPR: vi.fn(),
    };
    const originalGet = ctx.mockRegistry.get;
    ctx.mockRegistry.get = vi.fn((slot, name) =>
      slot === "scm" ? scm : originalGet(slot, name),
    ) as typeof originalGet;
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    return { sm, scm, pr };
  }

  it("registers, reloads, and kills without worker resources or workspace fallback", async () => {
    const { sm, scm } = setup();
    const session = await sm.review!("my-app", "42");
    expect(session.lifecycle.session.kind).toBe("review-only");
    for (const loaded of [session, await sm.get(session.id), ...(await sm.list())]) {
      expect(loaded?.runtimeHandle).toBeNull();
      expect(loaded?.workspacePath).toBeNull();
      expect(loaded?.pr?.baseBranch).toBe("release");
      expect(loaded?.pr?.isDraft).toBe(true);
      expect(loaded?.lifecycle.session.kind).toBe("review-only");
    }
    await expect(sm.send(session.id, "fix CI")).rejects.toThrow(/review-only/);
    await expect(sm.restore(session.id)).rejects.toThrow(/review-only/);
    await expect(sm.claimPR(session.id, "43")).rejects.toThrow(/review-only/);
    await sm.kill(session.id, { purgeOpenCode: true });
    expect(JSON.parse(readMetadataRaw(ctx.sessionsDir, session.id)!.lifecycle).session.state).toBe(
      "terminated",
    );
    expect(ctx.mockRuntime.create).not.toHaveBeenCalled();
    expect(ctx.mockRuntime.isAlive).not.toHaveBeenCalled();
    expect(ctx.mockRuntime.destroy).not.toHaveBeenCalled();
    expect(ctx.mockWorkspace.create).not.toHaveBeenCalled();
    expect(ctx.mockWorkspace.destroy).not.toHaveBeenCalled();
    expect(scm.checkoutPR).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/another-owner/my-app/pull/42",
    "https://github.com/org/another-repo/pull/42",
    "https://github.com/another-owner/another-repo/pull/42",
  ])("rejects a foreign resolved URL before probing state: %s", async (url) => {
    const { sm, scm, pr } = setup();
    // gh can resolve a URL outside --repo, while the plugin still labels the
    // PR's owner/repo using the configured project. The URL is authoritative.
    scm.resolvePR.mockResolvedValue({ ...pr, url });
    await expect(sm.review!("my-app", url)).rejects.toThrow(/does not belong to.*org\/my-app/);
    expect(scm.getPRState).not.toHaveBeenCalled();
    expect(listMetadata(ctx.sessionsDir)).toEqual([]);
    expect(ctx.mockRuntime.create).not.toHaveBeenCalled();
    expect(ctx.mockWorkspace.create).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/org/my-app/pull/42",
    "https://github.example.com/ORG/MY-APP/pull/42",
    "https://gitlab.com/Org/My-App/-/merge_requests/42",
  ])("accepts a matching resolved repository regardless of case: %s", async (url) => {
    const { sm, scm, pr } = setup();
    scm.resolvePR.mockResolvedValue({ ...pr, url });
    const session = await sm.review!("my-app", url);
    expect(session.pr?.url).toBe(url);
    expect(scm.getPRState).toHaveBeenCalledOnce();
  });

  it("allows only one concurrent registration of the same PR", async () => {
    const { sm } = setup();
    const other = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    const results = await Promise.allSettled([
      sm.review!("my-app", "42"),
      other.review!("my-app", "42"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await sm.list()).toHaveLength(1);
  });

  it("can register again after cleanup, preserving terminal history", async () => {
    const { sm } = setup();
    const first = await sm.review!("my-app", "42");
    await sm.kill(first.id);
    const next = await sm.review!("my-app", "42");
    expect(next.id).not.toBe(first.id);
    expect(next.lifecycle.session.kind).toBe("review-only");
  });

  it("rejects closed PRs and existing active owners before registration", async () => {
    const { sm, scm, pr } = setup();
    scm.getPRState.mockResolvedValueOnce("closed");
    await expect(sm.review!("my-app", "42")).rejects.toThrow(/closed/);
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/worker",
      branch: "external",
      status: "pr_open",
      project: "my-app",
      pr: pr.url,
    });
    await expect(sm.review!("my-app", "42")).rejects.toThrow(/already/);
  });
});
