import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  CapabilityRegistry,
  type CapabilityContext,
  type SyncCapability,
  type InteractiveDirective,
} from "@/lib/server/capabilities/registry";

const ctx: CapabilityContext = { caller: "agent", topicId: "t" };

describe("CapabilityRegistry", () => {
  it("invokes a sync capability and validates input", async () => {
    const reg = new CapabilityRegistry();
    const cap: SyncCapability<{ n: number }, number> = {
      kind: "sync",
      id: "math.double",
      input: z.object({ n: z.number() }),
      run: ({ n }) => n * 2,
    };
    reg.register(cap);

    expect(await reg.invoke("math.double", { n: 21 }, ctx)).toBe(42);
    await expect(reg.invoke("math.double", { n: "x" }, ctx)).rejects.toThrow();
  });

  it("opens + resolves an interactive directive out-of-band", async () => {
    const reg = new CapabilityRegistry();
    const resolved: Array<{ requestId: string; answer: unknown }> = [];
    const cap: InteractiveDirective<{ prompt: string }, string> = {
      kind: "interactive",
      id: "ask",
      open: ({ prompt }) => ({ requestId: `req-${prompt.length}` }),
      resolve: (requestId, answer) => {
        resolved.push({ requestId, answer });
      },
      idempotencyKey: ({ prompt }) => `ask:${prompt}`,
    };
    reg.register(cap);

    const { requestId } = await reg.open("ask", { prompt: "hi?" }, ctx);
    expect(requestId).toBe("req-3");
    await reg.resolve("ask", requestId, "yes", ctx);
    expect(resolved).toEqual([{ requestId: "req-3", answer: "yes" }]);
    expect(reg.idempotencyKey("ask", { prompt: "hi?" }, ctx)).toBe("ask:hi?");
  });

  it("enforces the kind boundary and unknown ids", async () => {
    const reg = new CapabilityRegistry();
    reg.register({ kind: "sync", id: "s", run: () => 1 });
    reg.register({
      kind: "interactive",
      id: "i",
      open: () => ({ requestId: "r" }),
      resolve: () => {},
    });

    await expect(reg.invoke("i", {}, ctx)).rejects.toThrow(/interactive/);
    await expect(reg.open("s", {}, ctx)).rejects.toThrow(/sync/);
    await expect(reg.invoke("nope", {}, ctx)).rejects.toThrow(/unknown/);
    expect(() => reg.register({ kind: "sync", id: "s", run: () => 2 })).toThrow(
      /already registered/,
    );
  });

  it("describe() lists a sorted catalog with audit defaults", () => {
    const reg = new CapabilityRegistry();
    reg.register({ kind: "sync", id: "b.sync", run: () => 0, doc: "b" });
    reg.register({
      kind: "interactive",
      id: "a.ask",
      open: () => ({ requestId: "r" }),
      resolve: () => {},
    });
    expect(reg.describe()).toEqual([
      { id: "a.ask", kind: "interactive", audit: "always" },
      { id: "b.sync", kind: "sync", audit: "event", doc: "b" },
    ]);
  });
});
