import { type NextRequest } from "next/server";
import { validateConfiguredProject, validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import {
  AmbiguousSessionError,
  SessionActiveError,
  SessionNotFoundError,
  recordActivityEvent,
} from "@aoagents/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

/**
 * POST /api/sessions/:id/prune — Permanently remove ONE terminal session:
 * reclaim validated leftovers, delete its metadata, invalidate caches. Refuses
 * active sessions (409). An optional `{ projectId }` body disambiguates a
 * session id that exists in multiple projects. Activity-event history and any
 * GitHub PRs/issues/branches are preserved.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  const body = (await request.json().catch(() => null)) as { projectId?: unknown } | null;
  let bodyProjectId: string | undefined;
  if (body && body.projectId !== undefined) {
    if (typeof body.projectId !== "string") {
      return jsonWithCorrelation({ error: "projectId must be a string" }, { status: 400 }, correlationId);
    }
    bodyProjectId = body.projectId;
  }

  try {
    const { config, sessionManager } = await getServices();
    if (bodyProjectId) {
      const projErr = validateConfiguredProject(config.projects, bodyProjectId);
      if (projErr) {
        return jsonWithCorrelation({ error: projErr }, { status: 400 }, correlationId);
      }
    }
    const result = await sessionManager.prune(id, { projectId: bodyProjectId });
    const projectId = result.projectId ?? bodyProjectId ?? resolveProjectIdForSessionId(config, id);
    recordApiObservation({
      config,
      method: "POST",
      path: "/api/sessions/[id]/prune",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId,
      sessionId: id,
    });
    recordActivityEvent({
      projectId,
      sessionId: id,
      source: "api",
      kind: "api.session_prune_requested",
      summary: `session prune requested: ${id}`,
      data: { pruned: result.pruned, alreadyAbsent: result.alreadyAbsent },
    });
    return jsonWithCorrelation(
      { ok: true, sessionId: id, ...result },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    if (err instanceof AmbiguousSessionError) {
      return jsonWithCorrelation(
        { error: err.message, projectIds: err.projectIds },
        { status: 409 },
        correlationId,
      );
    }
    if (err instanceof SessionActiveError) {
      return jsonWithCorrelation({ error: err.message }, { status: 409 }, correlationId);
    }
    const { config } = await getServices().catch(() => ({ config: undefined }));
    const projectId = config ? resolveProjectIdForSessionId(config, id) : undefined;
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/[id]/prune",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId: id,
        reason: err instanceof Error ? err.message : "Failed to prune session",
      });
    }
    const msg = err instanceof Error ? err.message : "Failed to prune session";
    recordActivityEvent({
      projectId,
      sessionId: id,
      source: "api",
      kind: "api.session_prune_failed",
      level: "error",
      summary: `session prune failed: ${msg}`,
      data: { reason: msg },
    });
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
