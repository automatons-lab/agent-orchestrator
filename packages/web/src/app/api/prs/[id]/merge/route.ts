import { type NextRequest } from "next/server";
import { recordActivityEvent, type OrchestratorConfig } from "@aoagents/ao-core";
import { getServices, getSCM } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

/** POST /api/prs/:id/merge — Merge a PR
 *
 * Disambiguation: PR numbers are unique per repository, not across the
 * portfolio. When multiple projects each have their own PR #N, the route
 * needs help picking the right session. Callers should pass either
 * `?projectId=<id>` (preferred) or `?sessionId=<id>` as a query param.
 * Without disambiguation, the handler falls back to non-terminal sessions
 * with an open PR — and 409s if the resulting set is still ambiguous so
 * the operator notices instead of silently merging the wrong PR.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return jsonWithCorrelation({ error: "Invalid PR number" }, { status: 400 }, correlationId);
  }
  const prNumber = Number(id);
  const owner = _request.nextUrl.searchParams.get("owner") ?? undefined;
  const repo = _request.nextUrl.searchParams.get("repo") ?? undefined;

  const prMatches = (p: { number: number; owner?: string; repo?: string }) =>
    p.number === prNumber &&
    (!owner || p.owner?.toLowerCase() === owner.toLowerCase()) &&
    (!repo || p.repo?.toLowerCase() === repo.toLowerCase());

  let configForObservation: OrchestratorConfig | undefined;
  let projectId: string | undefined;
  let sessionId: string | undefined;

  // Disambiguators from the request URL — projectId is preferred.
  const url = new URL(_request.url);
  const projectIdFilter = url.searchParams.get("projectId");
  const sessionIdFilter = url.searchParams.get("sessionId");

  try {
    const { config, registry, sessionManager } = await getServices();
    configForObservation = config;
    const sessions = await sessionManager.list();

    let candidates = sessions.filter(
      (s) => (s.pr && prMatches(s.pr)) || (s.prs ?? []).some(prMatches),
    );
    if (sessionIdFilter) {
      candidates = candidates.filter((s) => s.id === sessionIdFilter);
    } else if (projectIdFilter) {
      candidates = candidates.filter((s) => s.projectId === projectIdFilter);
    }
    if (candidates.length === 0) {
      return jsonWithCorrelation({ error: "PR not found" }, { status: 404 }, correlationId);
    }

    // No explicit disambiguation: prefer non-terminal sessions with a non-
    // closed PR so we don't accidentally re-target a long-merged sibling PR
    // in another repo. PR numbers collide across the portfolio (each repo
    // numbers its PRs from 1) — without this filter, the wrong session can
    // be picked and the route returns 409 "PR is merged, not open" against
    // the actually-open PR the operator was trying to merge.
    let session: (typeof candidates)[number] | undefined;
    if (candidates.length === 1) {
      session = candidates[0];
    } else {
      const TERMINAL_LIFECYCLE = new Set(["killed", "merged", "cleanup", "terminated", "errored", "done"]);
      const live = candidates.filter((s) => {
        const lifecycleState = s.lifecycle?.session?.state;
        const prState = s.lifecycle?.pr?.state;
        return !TERMINAL_LIFECYCLE.has(lifecycleState ?? "") && prState !== "merged" && prState !== "closed";
      });
      if (live.length === 1) {
        session = live[0];
      } else {
        // Still ambiguous — refuse rather than guess.
        return jsonWithCorrelation(
          {
            error: `PR #${prNumber} is ambiguous across projects; pass ?projectId=<id> or ?sessionId=<id>`,
            candidates: candidates.map((s) => ({
              sessionId: s.id,
              projectId: s.projectId,
              lifecycleState: s.lifecycle?.session?.state ?? null,
              prState: s.lifecycle?.pr?.state ?? null,
            })),
          },
          { status: 409 },
          correlationId,
        );
      }
    }
    const targetPR =
      session?.pr && prMatches(session.pr)
        ? session.pr
        : (session?.prs ?? []).find(prMatches);
    if (!session || !targetPR) {
      return jsonWithCorrelation({ error: "PR not found" }, { status: 404 }, correlationId);
    }
    projectId = session.projectId;
    sessionId = session.id;

    const project = config.projects[session.projectId];
    const scm = getSCM(registry, project);
    if (!scm) {
      return jsonWithCorrelation(
        { error: "No SCM plugin configured for this project" },
        { status: 500 },
        correlationId,
      );
    }

    // Validate PR is in a mergeable state
    const state = await scm.getPRState(targetPR);
    if (state !== "open") {
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "api",
        kind: "api.pr_merge_rejected",
        level: "warn",
        summary: `PR ${prNumber} merge rejected: state is ${state}`,
        data: { prNumber, prState: state, statusCode: 409 },
      });
      return jsonWithCorrelation(
        { error: `PR is ${state}, not open` },
        { status: 409 },
        correlationId,
      );
    }

    const mergeability = await scm.getMergeability(targetPR);
    if (!mergeability.mergeable) {
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "api",
        kind: "api.pr_merge_rejected",
        level: "warn",
        summary: `PR ${prNumber} merge rejected: not mergeable`,
        data: { prNumber, blockers: mergeability.blockers, statusCode: 422 },
      });
      return jsonWithCorrelation(
        { error: "PR is not mergeable", blockers: mergeability.blockers },
        { status: 422 },
        correlationId,
      );
    }

    await scm.mergePR(targetPR, "squash");
    recordApiObservation({
      config,
      method: "POST",
      path: "/api/prs/[id]/merge",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: session.projectId,
      sessionId: session.id,
      data: { prNumber },
    });
    recordActivityEvent({
      projectId: session.projectId,
      sessionId: session.id,
      source: "api",
      kind: "api.pr_merge_requested",
      summary: `PR ${prNumber} merge requested`,
      data: { prNumber, method: "squash" },
    });
    return jsonWithCorrelation(
      { ok: true, prNumber, method: "squash" },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    const config =
      configForObservation ?? (await getServices().catch(() => ({ config: undefined }))).config;
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/prs/[id]/merge",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId,
        reason: err instanceof Error ? err.message : "Failed to merge PR",
        data: { prNumber },
      });
    }
    const reason = err instanceof Error ? err.message : "Failed to merge PR";
    recordActivityEvent({
      projectId,
      sessionId,
      source: "api",
      kind: "api.pr_merge_failed",
      level: "error",
      summary: `PR ${prNumber} merge failed: ${reason}`,
      data: { prNumber, reason },
    });
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to merge PR" },
      { status: 500 },
      correlationId,
    );
  }
}
