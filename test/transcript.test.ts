import { describe, it, expect } from "vitest";
import { projectTranscript } from "@/lib/server/agents/transcript";
import type { AgentEvent } from "@/lib/server/agents/types";

const ev = (e: Partial<AgentEvent> & { type: string }): AgentEvent =>
  ({ agentId: "a", ts: "1970-01-01T00:00:00.000Z", seq: 0, ...e }) as AgentEvent;

describe("projectTranscript", () => {
  it("renders user + assistant turns, merging streamed deltas", () => {
    const out = projectTranscript([
      ev({ type: "user-message", text: "hello" }),
      ev({ type: "turn-start" }),
      ev({ type: "assistant-delta", text: "hi " }),
      ev({ type: "assistant-delta", text: "there" }),
      ev({ type: "turn-end" }),
    ]);
    expect(out).toBe("### user\nhello\n\n### assistant\nhi there");
  });

  it("starts a new assistant block per turn", () => {
    const out = projectTranscript([
      ev({ type: "user-message", text: "q1" }),
      ev({ type: "assistant-delta", text: "a1" }),
      ev({ type: "agent-end" }),
      ev({ type: "user-message", text: "q2" }),
      ev({ type: "assistant-delta", text: "a2" }),
    ]);
    expect(out).toBe(
      "### user\nq1\n\n### assistant\na1\n\n### user\nq2\n\n### assistant\na2",
    );
  });

  it("prepends the summary prefix verbatim", () => {
    const out = projectTranscript(
      [ev({ type: "user-message", text: "x" })],
      { summaryPrefix: "### context\nearlier\n\n" },
    );
    expect(out).toBe("### context\nearlier\n\n### user\nx");
  });

  it("ignores non-conversational events and empty logs", () => {
    expect(projectTranscript([])).toBe("");
    expect(
      projectTranscript([
        ev({ type: "tool-use", name: "x", input: {}, toolUseId: "t" }),
        ev({ type: "user-message", text: "u" }),
      ]),
    ).toBe("### user\nu");
  });
});
