---
"@aoagents/ao-core": patch
"@aoagents/ao-cli": patch
---

Keep reconciling sessions until canonical state reaches `done` or `terminated`, including recovery of existing sessions stuck in `detecting/runtime_lost` after runtime loss. Preserve the configured merge cleanup policy, including busy-worker grace periods and disabled automatic cleanup.
