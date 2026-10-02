---
"@aoagents/ao-core": patch
---

Exclude AO workspace metadata through Git's local exclude file so claiming a PR works in repositories that do not ignore `.ao/`, including linked worktrees.
