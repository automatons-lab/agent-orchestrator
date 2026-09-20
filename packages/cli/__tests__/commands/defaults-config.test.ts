/** Fork: `ao defaults set|unset` document edits + validation. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentToJS, openConfigDocument, renderDocument, validateRendered } from "../../src/lib/config-edit.js";
import { applyDefaultsSet, applyDefaultsUnset, declaredDefaults } from "../../src/commands/defaults-config.js";
import { FIXTURE } from "../fixtures/config-edit-fixture.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ao-defaults-config-"));
  file = join(dir, "config-multi-projects.yaml");
  writeFileSync(file, FIXTURE, "utf-8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function defaultsOf(doc: ReturnType<typeof openConfigDocument>["doc"]): Record<string, any> {
  return documentToJS(doc)["defaults"] as Record<string, any>;
}

describe("ao defaults", () => {
  it("set writes a YAML-parsed value under defaults and every project inherits it", () => {
    const { doc } = openConfigDocument(file);
    expect(applyDefaultsSet(doc, "reviewer.enabled", "true")).toEqual(["defaults.reviewer.enabled = true"]);
    expect(defaultsOf(doc)["reviewer"]).toEqual({ identity: "trinity", enabled: true });
    const loaded = validateRendered(renderDocument(doc), file);
    expect(loaded.projects["app"]!.reviewer?.enabled).toBe(true);
    expect(loaded.projects["app"]!.reviewer?.agentProfile).toBe("codex-reviewer");
  });

  it("set keeps strings YAML rejects verbatim, creates missing maps, and takes extra --set/--unset", () => {
    const { doc } = openConfigDocument(file);
    const messages = applyDefaultsSet(doc, "branchNameTemplate", "{issue}-{slug}", {
      set: ["reviewer.timeoutMinutes=40", "worker.agentConfig.reasoningEffort=high"],
      unset: ["workspace"],
    });
    expect(messages).toEqual([
      'defaults.branchNameTemplate = "{issue}-{slug}"',
      "defaults.reviewer.timeoutMinutes = 40",
      'defaults.worker.agentConfig.reasoningEffort = "high"',
      "defaults.workspace: removed",
    ]);
    const block = defaultsOf(doc);
    expect(block["branchNameTemplate"]).toBe("{issue}-{slug}");
    expect(block["worker"]).toEqual({ identity: "neo", agentConfig: { reasoningEffort: "high" } });
    expect(block).not.toHaveProperty("workspace");
    const loaded = validateRendered(renderDocument(doc), file);
    expect(loaded.projects["app"]!.branchNameTemplate).toBe("{issue}-{slug}");
    expect(loaded.projects["app"]!.reviewer?.timeoutMinutes).toBe(40);
    expect(loaded.projects["app"]!.worker?.agentConfig?.["reasoningEffort"]).toBe("high");
  });

  it("set surfaces a schema rejection through validation and leaves the file untouched", () => {
    const { doc } = openConfigDocument(file);
    applyDefaultsSet(doc, "reviewer.timeoutMinutes", "-5");
    expect(() => validateRendered(renderDocument(doc), file)).toThrow();
    expect(readFileSync(file, "utf-8")).toBe(FIXTURE);
  });

  it("unset removes a key, refuses unknown keys and empty values, and show reads the declared block", () => {
    const { doc } = openConfigDocument(file);
    expect(applyDefaultsUnset(doc, "branchNameTemplate")).toEqual(["defaults.branchNameTemplate: removed"]);
    expect(() => applyDefaultsUnset(doc, "reviewer.nope")).toThrow(/defaults\.reviewer\.nope is not set/);
    expect(() => applyDefaultsSet(doc, "runtime", "   ")).toThrow(/empty value for defaults\.runtime/);
    const text = renderDocument(doc);
    validateRendered(text, file);
    writeFileSync(file, text, "utf-8");
    const declared = declaredDefaults(file);
    expect(declared.path).toBe(file);
    expect(declared.defaults).not.toHaveProperty("branchNameTemplate");
    expect(declared.defaults["runtime"]).toBe("tmux");
    expect(text).toContain("# the first project");
  });
});
