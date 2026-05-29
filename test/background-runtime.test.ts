import { describe, it, expect } from "vitest";
import { BackgroundRuntime } from "@/lib/server/runtime/background-runtime";

describe("BackgroundRuntime", () => {
  it("fires jobs when their interval has elapsed (injected clock)", async () => {
    const rt = new BackgroundRuntime();
    let a = 0;
    let b = 0;
    rt.register({ id: "a", intervalMs: 1000, run: () => void a++ });
    rt.register({ id: "b", intervalMs: 5000, run: () => void b++ });

    await rt.tickOnce(0); // both fire (no prior run)
    expect([a, b]).toEqual([1, 1]);

    await rt.tickOnce(1000); // a due, b not
    expect([a, b]).toEqual([2, 1]);

    await rt.tickOnce(1500); // neither due
    expect([a, b]).toEqual([2, 1]);

    await rt.tickOnce(6000); // both due
    expect([a, b]).toEqual([3, 2]);
  });

  it("respects a seeded last-run (cold start doesn't immediately re-fire)", async () => {
    const rt = new BackgroundRuntime();
    let n = 0;
    rt.register({ id: "j", intervalMs: 1000, run: () => void n++ });
    rt.seedLastRun("j", 500);
    await rt.tickOnce(900); // 900-500 < 1000 → not due
    expect(n).toBe(0);
    await rt.tickOnce(1500); // 1500-500 >= 1000 → due
    expect(n).toBe(1);
  });

  it("is overlap-guarded: a slow tick blocks a concurrent one", async () => {
    const rt = new BackgroundRuntime();
    let running = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    rt.register({
      id: "slow",
      intervalMs: 0,
      run: async () => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await gate;
        running--;
      },
    });
    const first = rt.tickOnce(1);
    const second = rt.tickOnce(2); // should no-op while first is in flight
    await second; // returns immediately (guarded)
    release();
    await first;
    expect(maxConcurrent).toBe(1);
  });

  it("a throwing job is isolated and doesn't block others", async () => {
    const rt = new BackgroundRuntime();
    let ok = 0;
    rt.register({
      id: "boom",
      intervalMs: 0,
      run: () => {
        throw new Error("nope");
      },
    });
    rt.register({ id: "fine", intervalMs: 0, run: () => void ok++ });
    await rt.tickOnce(0);
    expect(ok).toBe(1);
  });

  it("rejects duplicate registration", () => {
    const rt = new BackgroundRuntime();
    rt.register({ id: "x", intervalMs: 1, run: () => {} });
    expect(() => rt.register({ id: "x", intervalMs: 1, run: () => {} })).toThrow(
      /already registered/,
    );
  });
});
