/**
 * Fork: keep test runs out of ~/.agent-orchestrator/observability. Every test
 * process that loads a config writes observability snapshots for that config's
 * path; without this, each temporary config leaves a `<hash>` directory behind.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env["AO_OBSERVABILITY_DIR"]?.trim()) {
  process.env["AO_OBSERVABILITY_DIR"] = mkdtempSync(join(tmpdir(), "ao-observability-tests-"));
}
