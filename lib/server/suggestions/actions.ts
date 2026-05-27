"use server";

import { revalidatePath } from "next/cache";
import { getRoot } from "@/lib/registry";
import {
  listPendingSuggestions,
  markApproved,
  markRejected,
  type Suggestion,
} from "./store";
import { startTopicAction } from "@/lib/server/topic-actions";
import { writeMemory } from "@/lib/server/memory/store";

export type ListSuggestionsResult =
  | { ok: true; items: Suggestion[] }
  | { ok: false; error: string };

export async function listSuggestionsAction(
  rootId: string,
): Promise<ListSuggestionsResult> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const items = await listPendingSuggestions(entry.path);
    return { ok: true, items };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type ApproveSuggestionResult =
  | { ok: true; topicId: string }
  | { ok: false; error: string };

export async function approveSuggestionAction(args: {
  rootId: string;
  suggestionId: string;
}): Promise<ApproveSuggestionResult> {
  try {
    const entry = await getRoot(args.rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const items = await listPendingSuggestions(entry.path);
    const s = items.find((it) => it.id === args.suggestionId);
    if (!s) return { ok: false, error: "Suggestion not found or already actioned" };
    const startRes = await startTopicAction(args.rootId, s.prompt, []);
    if (!startRes.ok) return { ok: false, error: startRes.error ?? "topic start failed" };
    await markApproved(entry.path, s.id, startRes.topicId);
    revalidatePath(`/roots/${args.rootId}`);
    return { ok: true, topicId: startRes.topicId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type RejectSuggestionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function rejectSuggestionAction(args: {
  rootId: string;
  suggestionId: string;
}): Promise<RejectSuggestionResult> {
  try {
    const entry = await getRoot(args.rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const items = await listPendingSuggestions(entry.path);
    const s = items.find((it) => it.id === args.suggestionId);
    if (!s) return { ok: false, error: "Suggestion not found" };
    // Record the rejection in project AVOID so the agent doesn't propose
    // the same thing again. Short, terse — one line.
    const line = `Rejected suggestion: "${s.title}" (${s.kind})`;
    await writeMemory(
      { scope: "project", rootPath: entry.path },
      "AVOID",
      "append",
      { content: line },
    );
    await markRejected(entry.path, s.id);
    revalidatePath(`/roots/${args.rootId}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
