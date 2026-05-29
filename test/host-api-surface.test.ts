import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Golden snapshot of the host-api method surface (north-star Phase 0 gate for
 * Phase 4). Utility bundles call these ids by string through the generated
 * `reflex.*` proxy; already-installed bundles pin them. When Phase 4 makes the
 * proxy + this id set come from `CapabilityRegistry.describe()`, this snapshot
 * proves the set is reproduced byte-identically — a silent rename would break
 * every installed utility. Extracted from source (no import, so we don't drag
 * the host-api's node-only deps into the test runtime).
 */

const SRC = fileURLToPath(
  new URL("../lib/server/utilities/host-api.ts", import.meta.url),
);

function extractMethodIds(): string[] {
  const src = readFileSync(SRC, "utf8");
  // Phase 4: dispatch is a data table (HOST_METHODS) — extract its keys.
  const start = src.indexOf("export const HOST_METHODS");
  const end = src.indexOf("\n};", start);
  const block = start >= 0 && end > start ? src.slice(start, end) : "";
  const ids = new Set<string>();
  const re = /"([^"]+)":\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) ids.add(m[1]!);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

// FROZEN — changing this set is a breaking change to the utility ABI. If a
// method is genuinely added/removed, update this list IN THE SAME COMMIT and
// note the migration for installed bundles.
const FROZEN_METHOD_IDS = [
  "actions.invoke",
  "agent.invoke",
  "audit.log",
  "capabilities.invoke",
  "capabilities.listProviders",
  "cards.update",
  "fs.list",
  "fs.read",
  "fs.write",
  "git.hasGhCli",
  "git.hasRemote",
  "git.isRepo",
  "git.worktree.create",
  "git.worktree.list",
  "git.worktree.merge",
  "git.worktree.remove",
  "images.attach",
  "images.generate",
  "images.pickBest",
  "images.search",
  "kb.add",
  "kb.list",
  "kb.read",
  "kb.scopedList",
  "kb.scopedRead",
  "llm.complete",
  "mcp.call",
  "mcp.listServers",
  "mcp.listTools",
  "mermaid.validate",
  "secrets.get",
  "secrets.list",
  "sessions.search",
  "tasks.complete",
  "tasks.create",
  "tasks.delete",
  "tasks.dispatch",
  "tasks.get",
  "tasks.list",
  "tasks.observe",
  "tasks.update",
  "web.fetch",
  "web.search",
  "workflow.list",
  "workflow.read",
  "workflow.run",
].sort((a, b) => a.localeCompare(b));

describe("host-api method surface (utility ABI golden snapshot)", () => {
  it("matches the frozen id set exactly", () => {
    expect(extractMethodIds()).toEqual(FROZEN_METHOD_IDS);
  });
});

/**
 * Security regression: tasks.* and git.worktree.* spawn subprocess agents and
 * mutate the user's real git repo. They are gated by a real permission slot
 * (permissions.tasks / permissions.worktree) at dispatchHostCall — fix B,
 * which replaced the original task-board-only id-gate. A regression here = any
 * installed utility regains the privilege-escalation path. Source-extracted
 * (no import) to match the snapshot test above.
 */
function extractGatedMethods(): string[] {
  const src = readFileSync(SRC, "utf8");
  const start = src.indexOf("const SENSITIVE_METHOD_SLOTS");
  const end = src.indexOf("};", start);
  const block = start >= 0 && end > start ? src.slice(start, end) : "";
  const ids = new Set<string>();
  // method key -> slot value ("tasks.*" | "worktree")
  const re = /"([^"]+)":\s*"(?:tasks\.|worktree)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) ids.add(m[1]!);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

describe("host-api sensitive-capability gate (security)", () => {
  it("gates exactly every tasks.* and git.worktree.* method", () => {
    const expected = FROZEN_METHOD_IDS.filter(
      (id) => id.startsWith("tasks.") || id.startsWith("git.worktree."),
    );
    expect(extractGatedMethods()).toEqual(expected);
  });

  it("leaves read-only git.isRepo / hasRemote / hasGhCli ungated", () => {
    const gated = new Set(extractGatedMethods());
    expect(gated.has("git.isRepo")).toBe(false);
    expect(gated.has("git.hasRemote")).toBe(false);
    expect(gated.has("git.hasGhCli")).toBe(false);
  });

  it("enforces the gate via a permission slot, not a hard-coded id", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/SENSITIVE_METHOD_SLOTS\[method\]/);
    expect(src).toMatch(/hasSensitiveSlot\(/);
    // keeps an explicit back-compat shim for an un-upgraded task-board
    expect(src).toMatch(/isLegacyTaskBoard\(/);
  });
});
