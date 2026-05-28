import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendEvent,
  readEvents,
  nextSeq,
} from "@/lib/server/agents/events-log";
import type { AgentEvent } from "@/lib/server/agents/types";

/**
 * Phase-0 tripwire for the north-star plan's #1 risk: the per-topic seq
 * assignment is NOT concurrency-safe. `nextSeq()` re-reads the whole log and
 * returns `last.seq + 1`; `emit()`/`relay.ts` then append with no lock
 * between the read and the append. Two concurrent writers read the same
 * length and mint the SAME seq — duplicate seqs, which break SSE `?since=`
 * replay and the Telegram delivery cursor.
 *
 * These tests DOCUMENT the current (buggy) behavior so it is pinned and
 * visible. When Phase 1 lands the TurnBus (a single synchronous seq
 * authority for all writers), the assertions below FLIP — the tests will go
 * red and must be rewritten to assert uniqueness. That red is the intended
 * signal that the fix landed.
 */
describe("events-log seq assignment under concurrency (Phase-0 tripwire)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "reflex-seq-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const ev = (i: number, seq: number): AgentEvent =>
    ({
      type: "system",
      text: `e${i}`,
      agentId: "x",
      ts: new Date(0).toISOString(),
      seq,
    }) as AgentEvent;

  it("concurrent nextSeq() returns colliding seqs (TurnBus fixes this in Phase 1)", async () => {
    const topicId = "t";
    await appendEvent(root, topicId, ev(0, 0)); // seed: last seq = 0

    // Eight callers ask for the next seq concurrently. With no lock, they all
    // observe the same last line and all return 1.
    const seqs = await Promise.all(
      Array.from({ length: 8 }, () => nextSeq(root, topicId)),
    );

    const unique = new Set(seqs);
    // CURRENT behavior: every caller minted the same seq.
    expect(unique.size).toBeLessThan(seqs.length);
    // (Phase-1 target: `expect(unique.size).toBe(seqs.length)`.)
  });

  it("concurrent read-then-append yields a non-contiguous seq sequence", async () => {
    const topicId = "t";
    const N = 16;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        (async () => {
          const seq = await nextSeq(root, topicId);
          await appendEvent(root, topicId, ev(i, seq));
        })(),
      ),
    );

    const seqs = (await readEvents(root, topicId)).map((e) => e.seq);
    const unique = new Set(seqs);
    // CURRENT behavior: collisions, so distinct seqs < total appended events.
    // (Phase-1 target: a contiguous 0..N-1 with no duplicates.)
    expect(unique.size).toBeLessThan(seqs.length);
  });
});
