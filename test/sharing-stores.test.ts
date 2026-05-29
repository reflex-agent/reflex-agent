import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Share Plane substrate (docs/sharing.md): the grant ledger + provider
 * directory. REFLEX_HOME is pointed at a temp dir and the modules are
 * dynamically imported so the real ~/.reflex stores are never touched.
 */

let home: string;

async function freshHome() {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "reflex-share-"));
  process.env.REFLEX_HOME = home;
}

beforeEach(freshHome);
afterAll(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true });
});

describe("grant-store", () => {
  it("creates, finds, and respects scope", async () => {
    const gs = await import("@/lib/server/utilities/grant-store");
    const g = await gs.createGrant({
      consumer: "writer-studio",
      provider: "task-board",
      plane: "data",
      selector: "task",
      scope: "root-1",
    });
    expect(g.id).toMatch(/^g_/);

    // exact match within scope
    expect(
      await gs.findGrant({
        consumer: "writer-studio",
        provider: "task-board",
        plane: "data",
        selector: "task",
        scope: "root-1",
      }),
    ).not.toBeNull();

    // wrong scope → no match (scope containment)
    expect(
      await gs.findGrant({
        consumer: "writer-studio",
        provider: "task-board",
        plane: "data",
        selector: "task",
        scope: "root-2",
      }),
    ).toBeNull();

    // wrong selector / plane → no match
    expect(
      await gs.findGrant({
        consumer: "writer-studio",
        provider: "task-board",
        plane: "data",
        selector: "note",
        scope: "root-1",
      }),
    ).toBeNull();
  });

  it("global grants cover any scope", async () => {
    const gs = await import("@/lib/server/utilities/grant-store");
    await gs.createGrant({
      consumer: "w",
      provider: "p",
      plane: "capability",
      selector: "markDone",
      scope: "global",
    });
    expect(
      await gs.findGrant({
        consumer: "w",
        provider: "p",
        plane: "capability",
        selector: "markDone",
        scope: "any-root",
      }),
    ).not.toBeNull();
  });

  it("is idempotent and revocable", async () => {
    const gs = await import("@/lib/server/utilities/grant-store");
    const a = await gs.createGrant({
      consumer: "w",
      provider: "p",
      plane: "data",
      selector: "task",
      scope: "global",
    });
    const b = await gs.createGrant({
      consumer: "w",
      provider: "p",
      plane: "data",
      selector: "task",
      scope: "global",
    });
    expect(b.id).toBe(a.id); // reused, not stacked
    expect((await gs.listGrants()).length).toBe(1);

    expect(await gs.revokeGrant(a.id)).toBe(true);
    expect(
      await gs.findGrant({
        consumer: "w",
        provider: "p",
        plane: "data",
        selector: "task",
        scope: "global",
      }),
    ).toBeNull();
  });

  it("treats expired grants as inactive", async () => {
    const gs = await import("@/lib/server/utilities/grant-store");
    await gs.createGrant({
      consumer: "w",
      provider: "p",
      plane: "data",
      selector: "task",
      scope: "global",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(
      await gs.findGrant({
        consumer: "w",
        provider: "p",
        plane: "data",
        selector: "task",
        scope: "global",
      }),
    ).toBeNull();
  });

  it("listGrantViews derives an active flag (revoked/expired -> false)", async () => {
    const gs = await import("@/lib/server/utilities/grant-store");
    const live = await gs.createGrant({ consumer: "w", provider: "p", plane: "data", selector: "task", scope: "global" });
    const expired = await gs.createGrant({
      consumer: "w",
      provider: "q",
      plane: "data",
      selector: "task",
      scope: "global",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await gs.revokeGrant(live.id);
    const views = await gs.listGrantViews();
    expect(views.find((v) => v.id === live.id)?.active).toBe(false); // revoked
    expect(views.find((v) => v.id === expired.id)?.active).toBe(false); // expired
  });

  it("prunes all grants touching an uninstalled utility", async () => {
    const gs = await import("@/lib/server/utilities/grant-store");
    await gs.createGrant({ consumer: "w", provider: "p", plane: "data", selector: "task", scope: "global" });
    await gs.createGrant({ consumer: "p", provider: "q", plane: "data", selector: "note", scope: "global" });
    const removed = await gs.pruneGrantsForUtility("p");
    expect(removed).toBe(2); // p appears as provider in #1 and consumer in #2
    expect((await gs.listGrants()).length).toBe(0);
  });
});

describe("provider-directory", () => {
  it("records providers and assigns first-claim-wins ownership", async () => {
    const pd = await import("@/lib/server/utilities/provider-directory");
    await pd.rebuildProviderDirectory([
      {
        id: "task-board",
        scope: "project",
        rootId: "root-1",
        version: "1.0.0",
        provides: {
          data: [{ kind: "task", read: true }],
          capabilities: [
            { verb: "markDone", action: "markTaskDone", sideEffects: true, confirm: false, input: {}, output: {} },
          ],
        },
      },
      // a second utility that also claims "task" — must NOT steal ownership
      { id: "other", scope: "global", version: "0.1.0", provides: { data: [{ kind: "task", read: true }] } },
    ]);

    expect(await pd.getKindOwner("task")).toBe("task-board");
    expect(await pd.getKindOwner("unclaimed")).toBeNull();

    const all = await pd.listProviders();
    expect(all.map((p) => p.provider).sort()).toEqual(["other", "task-board"]);
    expect((await pd.listProviders({ verb: "markDone" })).map((p) => p.provider)).toEqual(["task-board"]);

    const cap = await pd.findProviderCapability("task-board", "markDone", "root-1");
    expect(cap?.capability.action).toBe("markTaskDone");
  });

  it("keeps ownership stable across rebuilds and releases it on uninstall", async () => {
    const pd = await import("@/lib/server/utilities/provider-directory");
    const tb = {
      id: "task-board",
      scope: "global" as const,
      version: "1.0.0",
      provides: { data: [{ kind: "task", read: true }] },
    };
    const other = {
      id: "other",
      scope: "global" as const,
      version: "1.0.0",
      provides: { data: [{ kind: "task", read: true }] },
    };
    // task-board claims first
    await pd.rebuildProviderDirectory([tb, other]);
    expect(await pd.getKindOwner("task")).toBe("task-board");
    // rebuild with task-board still present → owner unchanged
    await pd.rebuildProviderDirectory([other, tb]);
    expect(await pd.getKindOwner("task")).toBe("task-board");
    // task-board uninstalled → ownership transfers to the remaining claimant
    await pd.rebuildProviderDirectory([other]);
    expect(await pd.getKindOwner("task")).toBe("other");
    // nobody provides it → released
    await pd.rebuildProviderDirectory([]);
    expect(await pd.getKindOwner("task")).toBeNull();
  });

  it("skips utilities that provide nothing", async () => {
    const pd = await import("@/lib/server/utilities/provider-directory");
    await pd.rebuildProviderDirectory([
      { id: "plain", scope: "global", version: "1.0.0" },
      { id: "plain2", scope: "global", version: "1.0.0", provides: { data: [], capabilities: [] } },
    ]);
    expect(await pd.listProviders()).toEqual([]);
  });
});
