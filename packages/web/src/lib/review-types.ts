import type { CodeReviewRunSummary } from "@aoagents/ao-core";

export type ReviewBoardColumn =
  | "queued"
  | "reviewing"
  | "triage"
  | "waiting"
  | "clean"
  | "failed"
  | "outdated";

/**
 * Dashboard row for a review run. Inherits every store field, including the
 * AO-native review details (fork): verdict, round, agent, githubUser,
 * githubReviewUrl, tmuxName, postMode.
 */
export interface DashboardReviewRun extends CodeReviewRunSummary {
  projectName: string;
  workerTitle: string | null;
  workerBranch: string | null;
  workerPrUrl: string | null;
  workerStatus: string | null;
  workerActivity: string | null;
  workerRuntimeState: string | null;
  workerHasRuntime: boolean;
}

export interface ReviewWorkerOption {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  branch: string | null;
  status: string;
  activity: string | null;
  runtimeState: string | null;
  hasRuntime: boolean;
  prNumber: number | null;
  prUrl: string | null;
}

export const REVIEW_BOARD_COLUMNS: ReviewBoardColumn[] = [
  "queued",
  "reviewing",
  "triage",
  "waiting",
  "clean",
  "failed",
  "outdated",
];

export const REVIEW_COLUMN_LABELS: Record<ReviewBoardColumn, string> = {
  queued: "Queued",
  reviewing: "Reviewing",
  triage: "Triage",
  waiting: "Waiting",
  clean: "Clean",
  failed: "Failed",
  outdated: "Outdated",
};

export function getReviewBoardColumn(run: Pick<DashboardReviewRun, "status">): ReviewBoardColumn {
  switch (run.status) {
    case "queued":
    case "preparing":
      return "queued";
    case "running":
      return "reviewing";
    case "needs_triage":
      return "triage";
    case "sent_to_agent":
    case "waiting_update":
      return "waiting";
    case "clean":
      return "clean";
    case "failed":
    case "cancelled":
      return "failed";
    case "outdated":
      return "outdated";
  }
}

export type ReviewVerdict = NonNullable<CodeReviewRunSummary["verdict"]>;

export const REVIEW_VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: "Approved",
  request_changes: "Changes requested",
  comment: "Commented",
};

export function formatReviewVerdict(verdict: ReviewVerdict | undefined): string {
  return verdict ? REVIEW_VERDICT_LABELS[verdict] : "—";
}

/** True when a run carries any AO-native review detail worth a dedicated row. */
export function hasNativeReviewDetails(
  run: Pick<DashboardReviewRun, "verdict" | "round" | "agent" | "githubUser" | "githubReviewUrl">,
): boolean {
  return Boolean(run.verdict || run.round !== undefined || run.agent || run.githubUser || run.githubReviewUrl);
}
