import "server-only";
import type { AgentEvent } from "./types";

/**
 * The single projection of an event log into a prompt transcript (north-star
 * Phase 3). Both `buildTranscript` (manager.ts) and `renderTranscript`
 * (start-turn.ts) carried a byte-identical copy of this loop; they now delegate
 * here. Pure (events in, string out) so the dispatcher rolling-summary prefix
 * and any covered-history slicing are the caller's concern, passed via opts.
 */
export interface ProjectTranscriptOptions {
  /** Prepended verbatim (e.g. the dispatcher's rolling summary block). */
  summaryPrefix?: string;
}

export function projectTranscript(
  events: AgentEvent[],
  opts: ProjectTranscriptOptions = {},
): string {
  const lines: string[] = [];
  let current: { role: "user" | "assistant"; text: string } | null = null;
  const flush = () => {
    if (!current) return;
    lines.push(`### ${current.role}\n${current.text.trim()}`);
    current = null;
  };
  for (const ev of events) {
    if (ev.type === "user-message") {
      flush();
      current = { role: "user", text: ev.text };
      flush();
    } else if (ev.type === "assistant-delta") {
      if (!current || current.role !== "assistant") {
        flush();
        current = { role: "assistant", text: "" };
      }
      current.text += ev.text;
    } else if (ev.type === "turn-end" || ev.type === "agent-end") {
      flush();
    }
  }
  flush();
  return (opts.summaryPrefix ?? "") + lines.join("\n\n");
}
