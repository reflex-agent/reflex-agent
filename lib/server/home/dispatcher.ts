import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { HOME_ROOT_ID, homeRootEntry } from "@/lib/registry";
import { createTopic, getTopic } from "@/lib/server/topics";
import { loadSettings } from "@/lib/settings/store";

/**
 * The dispatcher — a single, never-ending chat that lives in the
 * synthetic "home" Space. It's the central thread the user talks to from
 * the web home page AND from Telegram; both surfaces open this same
 * topic, so the conversation is continuous across devices.
 *
 * Its id is pinned in `<home>/dispatcher.json` so every entry point
 * resolves the same topic. Created lazily on first use.
 */

interface DispatcherState {
  topicId?: string;
  /** Rolling-summary bookkeeping (idle compaction). */
  summaryCoveredCount?: number;
  summaryAt?: string;
}

function statePath(): string {
  return path.join(homeRootEntry().path, "dispatcher.json");
}

function summaryPath(): string {
  return path.join(homeRootEntry().path, "dispatcher-summary.md");
}

async function readState(): Promise<DispatcherState> {
  try {
    return JSON.parse(await fs.readFile(statePath(), "utf8")) as DispatcherState;
  } catch {
    return {};
  }
}

async function writeState(state: DispatcherState): Promise<void> {
  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
}

export interface DispatcherHandle {
  rootId: string;
  rootPath: string;
  topicId: string;
}

/** Resolve (or lazily create) the one dispatcher topic. */
export async function getDispatcherTopic(): Promise<DispatcherHandle> {
  const home = homeRootEntry();
  const state = await readState();
  if (state.topicId) {
    const existing = await getTopic(home.path, state.topicId).catch(() => null);
    if (existing) {
      return { rootId: HOME_ROOT_ID, rootPath: home.path, topicId: state.topicId };
    }
  }
  const settings = await loadSettings();
  const a = settings.assignments.chat;
  const topic = await createTopic({
    root: home.path,
    firstMessage: "Dispatcher",
    harness: a.harness,
    model: a.model,
    language: settings.language,
  });
  await writeState({ ...state, topicId: topic.meta.id });
  return { rootId: HOME_ROOT_ID, rootPath: home.path, topicId: topic.meta.id };
}

// ---------------------------------------------------------------------------
// Idle compaction. The dispatcher thread is never-ending, so its prompt
// would grow without bound. When it's gone quiet (>IDLE_MS since the last
// event) we fold everything except the last KEEP_TURNS events into a
// rolling summary file. renderTranscript (home root) prepends that
// summary + renders only the uncovered tail — so the canonical
// events.jsonl is NEVER mutated (safe), but the prompt stays bounded.

const IDLE_MS = 10 * 60_000;
const KEEP_EVENTS = 12;

export interface DispatcherSummary {
  text: string;
  coveredCount: number;
}

/** For renderTranscript: the rolling summary + how many leading events it covers. */
export async function getDispatcherSummary(
  topicId: string,
): Promise<DispatcherSummary | null> {
  const state = await readState();
  if (state.topicId !== topicId || !state.summaryCoveredCount) return null;
  try {
    const text = await fs.readFile(summaryPath(), "utf8");
    if (!text.trim()) return null;
    return { text: text.trim(), coveredCount: state.summaryCoveredCount };
  } catch {
    return null;
  }
}

/**
 * Refresh the rolling summary if the dispatcher has been idle for
 * IDLE_MS and there's new uncovered history. Self-gating: re-running
 * while still idle is a no-op (covered count already == len-KEEP).
 * Called from the scheduler tick.
 */
export async function compactDispatcherIfIdle(): Promise<void> {
  const state = await readState();
  if (!state.topicId) return;
  const home = homeRootEntry();
  const { readEvents } = await import("@/lib/server/agents/events-log");
  const events = await readEvents(home.path, state.topicId);
  const cut = events.length - KEEP_EVENTS;
  if (cut <= 1) return; // not enough history to bother
  if ((state.summaryCoveredCount ?? 0) >= cut) return; // already compacted this window

  const last = events[events.length - 1];
  const lastTs = last ? Date.parse(last.ts) : 0;
  if (!Number.isFinite(lastTs) || Date.now() - lastTs < IDLE_MS) return; // still active

  // Build a plain transcript of the to-be-covered prefix.
  const lines: string[] = [];
  for (const ev of events.slice(0, cut)) {
    if (ev.type === "user-message") lines.push(`User: ${ev.text}`);
    else if (ev.type === "assistant-delta") {
      const prevIsAssistant = lines[lines.length - 1]?.startsWith("Reflex:");
      if (prevIsAssistant) lines[lines.length - 1] += ev.text;
      else lines.push(`Reflex: ${ev.text}`);
    }
  }
  const transcript = lines.join("\n").slice(0, 24_000);
  if (!transcript.trim()) {
    await writeState({ ...state, summaryCoveredCount: cut, summaryAt: new Date().toISOString() });
    return;
  }

  const { loadSettings } = await import("@/lib/settings/store");
  const { quickComplete } = await import("@/lib/server/quick");
  const settings = await loadSettings();
  const prior = await fs.readFile(summaryPath(), "utf8").catch(() => "");
  const prompt = [
    "You maintain a rolling summary of an ongoing dispatcher conversation.",
    "Rewrite the summary so it captures durable context: who/what was discussed, decisions, open threads, things to follow up. Plain text, ≤25 lines, no preamble.",
    "",
    "## Current summary",
    prior.trim() || "(none yet)",
    "",
    "## New conversation since then",
    transcript,
  ].join("\n");
  try {
    const reply = await quickComplete(settings.assignments.quick, prompt, {
      timeoutMs: 60_000,
    });
    const text = (reply ?? "").trim();
    if (!text) return;
    await fs.mkdir(path.dirname(summaryPath()), { recursive: true });
    await fs.writeFile(summaryPath(), text + "\n", "utf8");
    await writeState({
      ...state,
      summaryCoveredCount: cut,
      summaryAt: new Date().toISOString(),
    });
  } catch {
    /* leave summary as-is; retry next idle window */
  }
}
