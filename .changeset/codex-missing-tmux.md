---
"@aoagents/ao-plugin-agent-codex": patch
---

Recognize conclusive missing tmux server/session diagnostics in the Codex process
probe so lifecycle can finalize stale sessions. Preserve indeterminate results
for ambiguous command failures, timeouts, permission errors, and failed or empty
process-list probes.
