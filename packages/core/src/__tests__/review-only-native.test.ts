import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { createSessionManager } from "../session-manager.js";
import { executeNativeReview } from "../native-review.js";
import type * as NativeReview from "../native-review.js";
import {
  createMockRegistry,
  createMockSCM,
  setupTestContext,
  teardownTestContext,
  type TestContext,
} from "./test-utils.js";

vi.mock("../native-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof NativeReview>()),
  executeNativeReview: vi.fn(async (context, run) => {
    const completed = context.store.updateRun(run.id, { status: "clean" });
    return { run: completed };
  }),
}));

describe("native reviews for external PR sessions", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = setupTestContext();
    vi.mocked(executeNativeReview).mockClear();
  });
  afterEach(() => teardownTestContext(ctx));

  it("waits for CI, then reviews each PR head with reviewer identity and no worker", async () => {
    ctx.config.projects["my-app"]!.reviewer = {
      enabled: true,
      agent: "mock-agent",
      githubUser: "trinity-automaton",
    };
    ctx.mockAgent.getReviewCommand = vi.fn().mockReturnValue("review");
    const pr = {
      number: 42,
      url: "https://github.com/org/my-app/pull/42",
      title: "External",
      owner: "org",
      repo: "my-app",
      branch: "external",
      baseBranch: "release",
      isDraft: false,
    };
    let headSha = "a".repeat(40);
    let ciStatus = "pending";
    const scm = createMockSCM({
      resolvePR: vi.fn().mockResolvedValue(pr),
      requestReviewers: vi.fn(),
      enrichSessionsPRBatch: vi.fn(
        async () =>
          new Map([
            [
              "org/my-app#42",
              { state: "open", ciStatus, reviewDecision: "approved", mergeable: true, headSha },
            ],
          ]),
      ) as ReturnType<typeof createMockSCM>["enrichSessionsPRBatch"],
    });
    const registry = createMockRegistry({
      runtime: ctx.mockRuntime,
      agent: ctx.mockAgent,
      workspace: ctx.mockWorkspace,
      scm,
    });
    const sm = createSessionManager({ config: ctx.config, registry });
    const session = await sm.review!("my-app", "42");
    const lm = createLifecycleManager({ config: ctx.config, registry, sessionManager: sm });
    await lm.check(session.id);
    expect(executeNativeReview).not.toHaveBeenCalled();
    ciStatus = "passing";
    await lm.check(session.id);
    expect(executeNativeReview).toHaveBeenCalledTimes(1);
    expect(executeNativeReview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reviewer: expect.objectContaining({ githubUser: "trinity-automaton", agent: "mock-agent" }),
        session: expect.objectContaining({
          runtimeHandle: null,
          workspacePath: null,
          pr: expect.objectContaining({ baseBranch: "release" }),
        }),
      }),
      expect.objectContaining({ targetSha: headSha }),
    );
    await lm.check(session.id);
    expect(executeNativeReview).toHaveBeenCalledTimes(1);
    headSha = "b".repeat(40);
    await lm.check(session.id);
    expect(executeNativeReview).toHaveBeenCalledTimes(2);
    expect(executeNativeReview).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ targetSha: headSha }),
    );
    expect(ctx.mockRuntime.create).not.toHaveBeenCalled();
    expect(ctx.mockRuntime.sendMessage).not.toHaveBeenCalled();
  });
});
