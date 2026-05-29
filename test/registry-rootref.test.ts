import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * rootRef dual-read (north-star Phase 6). A Space carries a path-independent
 * `ref` alongside the legacy path-derived `id`; getRoot resolves by either, and
 * updatePath moves the folder while preserving both — so id-keyed data
 * (topics/widgets/URLs) survives a move instead of orphaning. Uses a temp
 * REFLEX_HOME via dynamic import so it never touches the real registry.
 */
let home: string;
let reg: typeof import("@/lib/registry");

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "reflex-reg-"));
  process.env.REFLEX_HOME = home;
  reg = await import("@/lib/registry");
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("registry rootRef dual-read", () => {
  it("addRoot assigns both an id and a stable ref", async () => {
    const dir = await fs.mkdtemp(path.join(home, "space-"));
    const entry = await reg.addRoot(dir);
    expect(entry.id).toBe(reg.rootId(dir));
    expect(entry.ref).toMatch(/^[0-9a-f]{16}$/);
    expect(entry.ref).not.toBe(entry.id);
  });

  it("getRoot resolves by id OR ref", async () => {
    const dir = await fs.mkdtemp(path.join(home, "space-"));
    const entry = await reg.addRoot(dir);
    expect((await reg.getRoot(entry.id))?.path).toBe(entry.path);
    expect((await reg.getRoot(entry.ref!))?.path).toBe(entry.path);
    expect(await reg.getRoot("nonexistent")).toBeNull();
  });

  it("updatePath moves the folder but preserves id + ref (no orphan)", async () => {
    const dir = await fs.mkdtemp(path.join(home, "space-"));
    const entry = await reg.addRoot(dir);
    const newDir = await fs.mkdtemp(path.join(home, "moved-"));

    const moved = await reg.updatePath(entry.id, newDir);
    expect(moved).not.toBeNull();
    expect(moved!.id).toBe(entry.id); // identity preserved
    expect(moved!.ref).toBe(entry.ref); // identity preserved
    expect(moved!.path).toBe(path.resolve(newDir)); // path changed

    // Both the old id and the stable ref still resolve — to the NEW path.
    expect((await reg.getRoot(entry.id))?.path).toBe(path.resolve(newDir));
    expect((await reg.getRoot(entry.ref!))?.path).toBe(path.resolve(newDir));
  });

  it("newRef() is unique per call", () => {
    expect(reg.newRef()).not.toBe(reg.newRef());
  });

  it("backfills a ref for entries that predate rootRef, persisting it", async () => {
    // Simulate a legacy registry entry with no `ref`.
    const legacyDir = await fs.mkdtemp(path.join(home, "legacy-"));
    const regFile = path.join(home, "registry.json");
    await fs.writeFile(
      regFile,
      JSON.stringify({
        entries: [
          { id: "legacyid00000000", path: legacyDir, addedAt: new Date(0).toISOString() },
        ],
      }),
      "utf8",
    );
    const [entry] = await reg.listRoots(); // read → backfill
    expect(entry!.id).toBe("legacyid00000000");
    expect(entry!.ref).toMatch(/^[0-9a-f]{16}$/);
    // Persisted to disk (not just in-memory).
    const onDisk = JSON.parse(await fs.readFile(regFile, "utf8"));
    const persisted = onDisk.entries.find(
      (e: { id: string; ref?: string }) => e.id === "legacyid00000000",
    );
    expect(persisted.ref).toBe(entry!.ref);
    // And it resolves by that backfilled ref.
    expect((await reg.getRoot(entry!.ref!))?.id).toBe("legacyid00000000");
  });
});
