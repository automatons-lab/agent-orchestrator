---
"@aoagents/ao-core": minor
"@aoagents/ao-cli": minor
"@aoagents/ao-web": minor
---

Reconcile terminal sessions whose PR is still open, align the dashboard with `ao status`, and add exact-session prune.

**Root cause.** When a session's runtime died while its PR was still open (e.g. persisted `open` + `merge_ready`), the session became terminal but its PR was never re-read: `lifecycle-manager.pollAll()` excludes terminal sessions, so an external merge/close was never observed and `autoCleanupOnMerge` never fired. Meanwhile the dashboard's attention model used a narrower "done" predicate than core `isTerminalSession`, so a dead-but-mergeable session kept rendering as an active "Ready to merge" card — inconsistent with `ao status`, which correctly showed zero active sessions.

**Fixes.**
- **core (lifecycle):** a bounded, SCM-read-only reconciler now re-checks terminal sessions that still have an open tracked PR (per-session exponential backoff). When every PR is observed merged/closed it persists the canonical PR truth atomically and hands off to idempotent cleanup. It never restores, restarts, or messages the worker and never runs live-worker reactions.
- **core (session manager):** new `reclaimLeftovers()` idempotently tears down a terminal session's leftover runtime/workspace/agent-mapping (validated against AO-managed roots) without rewriting its terminal reason or deleting metadata; new `prune()` permanently removes ONE terminal session (metadata + validated leftovers + cache invalidation), refusing active sessions and disambiguating duplicate ids across projects. Activity-event history and GitHub PRs/issues/branches are always preserved.
- **web:** the dashboard's terminal classification now matches core `isTerminalSession`/`ao status`, so terminal sessions never surface as active Ready/mergeable cards or attention items — they render their canonical terminal state and live in the Done / Terminated view, with a new **Remove** (prune) action and `POST /api/sessions/:id/prune` route.
- **cli:** new `ao session prune <session>` (supports `<project>:<session>`, `-p/--project`, `-y/--yes`).
