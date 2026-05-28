import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendEvent,
  appendEventSeq,
  readEvents,
  nextSeq,
} from "@/lib/server/agents/events-log";
import type { AgentEvent } from "@/lib/server/agents/types";

/**
 * Phase-1 regression suite for per-topic seq assignment (north-star risk #1).
 *
 * `appendEventSeq` is the single seq authority: a synchronous in-memory
 * read-and-increment + serialized append, so concurrent writers in a process
 * always get strictly-increasing, unique, contiguous seqs and lines never
 * interleave. The Phase-0 tripwire DOCUMENTED the old race; these now ASSERT
 * the fix. (The legacy `nextSeq()` + `appendEvent()` pattern is still racy by
 * design — kept here as the contrast that motivates the authority.)
 */
describe("seq authority — appendEventSeq", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "reflex-seq-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const ev = (i: number): AgentEvent =>
    ({
      type: "system",
      text: `e${i}`,
      agentId: "x",
      ts: new Date(0).toISOString(),
      seq: 0, // ignored — appendEventSeq assigns it
    }) as AgentEvent;

  it("assigns unique, contiguous seqs under heavy concurrency", async () => {
    const topicId = "t";
    const N = 32;

    const assigned = await Promise.all(
      Array.from({ length: N }, (_, i) => appendEventSeq(root, topicId, ev(i))),
    );

    const returnedSeqs = assigned.map((e) => e.seq).sort((a, b) => a - b);
    expect(returnedSeqs).toEqual(Array.from({ length: N }, (_, i) => i));

    // And the same is true of what actually landed on disk.
    const onDisk = (await readEvents(root, topicId)).map((e) => e.seq);
    expect(new Set(onDisk).size).toBe(N); // all unique
    expect([...onDisk].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i),
    );
  });

  it("serializes appends — every line is intact (no interleaving)", async () => {
    const topicId = "t";
    const N = 40;
    await Promise.all(
      Array.from({ length: N }, (_, i) => appendEventSeq(root, topicId, ev(i))),
    );
    // readEvents skips malformed lines; if appends interleaved we'd lose some.
    expect((await readEvents(root, topicId)).length).toBe(N);
  });

  it("seeds the counter from an existing log (continues past last seq)", async () => {
    const topicId = "t";
    // Simulate prior history written before this process started.
    await appendEvent(root, topicId, { ...ev(0), seq: 0 });
    await appendEvent(root, topicId, { ...ev(1), seq: 1 });
    await appendEvent(root, topicId, { ...ev(2), seq: 2 });

    const first = await appendEventSeq(root, topicId, ev(3));
    const second = await appendEventSeq(root, topicId, ev(4));
    expect(first.seq).toBe(3);
    expect(second.seq).toBe(4);
  });
});

describe("legacy nextSeq() — deprecated, racy (motivates the authority)", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "reflex-seq-legacy-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("concurrent nextSeq() returns colliding seqs (do not append with this)", async () => {
    const topicId = "t";
    await appendEvent(root, topicId, {
      type: "system",
      text: "seed",
      agentId: "x",
      ts: new Date(0).toISOString(),
      seq: 0,
    } as AgentEvent);

    const seqs = await Promise.all(
      Array.from({ length: 8 }, () => nextSeq(root, topicId)),
    );
    expect(new Set(seqs).size).toBeLessThan(seqs.length); // they collide
  });
});
