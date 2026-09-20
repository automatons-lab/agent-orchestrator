import { describe, expect, it } from "vitest";
import { getReviewBoardColumn, isFinishedReviewRun, type DashboardReviewRun } from "../review-types";

function makeRun(status: DashboardReviewRun["status"]): Pick<DashboardReviewRun, "status"> {
  return { status };
}

describe("getReviewBoardColumn", () => {
  it("maps reviewer run statuses into review board columns", () => {
    expect(getReviewBoardColumn(makeRun("queued"))).toBe("queued");
    expect(getReviewBoardColumn(makeRun("preparing"))).toBe("queued");
    expect(getReviewBoardColumn(makeRun("running"))).toBe("reviewing");
    expect(getReviewBoardColumn(makeRun("needs_triage"))).toBe("triage");
    expect(getReviewBoardColumn(makeRun("sent_to_agent"))).toBe("waiting");
    expect(getReviewBoardColumn(makeRun("waiting_update"))).toBe("waiting");
    expect(getReviewBoardColumn(makeRun("clean"))).toBe("clean");
    expect(getReviewBoardColumn(makeRun("failed"))).toBe("failed");
    expect(getReviewBoardColumn(makeRun("cancelled"))).toBe("failed");
    expect(getReviewBoardColumn(makeRun("outdated"))).toBe("outdated");
  });
});

describe("isFinishedReviewRun", () => {
  it("is true for settled runs whose worker session is terminal or gone", () => {
    expect(isFinishedReviewRun({ status: "clean", workerIsTerminal: true })).toBe(true);
    expect(isFinishedReviewRun({ status: "outdated", workerIsTerminal: true })).toBe(true);
    expect(isFinishedReviewRun({ status: "failed", workerIsTerminal: true })).toBe(true);
  });

  it("keeps runs visible while the worker is alive or the review is still executing", () => {
    expect(isFinishedReviewRun({ status: "clean", workerIsTerminal: false })).toBe(false);
    expect(isFinishedReviewRun({ status: "running", workerIsTerminal: true })).toBe(false);
    expect(isFinishedReviewRun({ status: "queued", workerIsTerminal: true })).toBe(false);
  });
});
