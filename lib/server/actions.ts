"use server";

import { promises as fs } from "node:fs";
import { revalidatePath } from "next/cache";
import { addRoot, markInitialized, removeRoot } from "@/lib/registry";
import { runInit } from "@/lib/reflex/commands/init";
import { loadSettings } from "@/lib/settings/store";
import { createTopic } from "@/lib/server/topics";
import { startOrchestratorTurn } from "@/lib/server/agents/start-turn";

export interface AddRootResult {
  ok: boolean;
  id?: string;
  /**
   * Topic id of the auto-spawned onboarding chat. Caller should redirect
   * to `/roots/${id}/chat/${onboardingTopicId}` so the user lands right
   * in the wizard conversation.
   */
  onboardingTopicId?: string;
  error?: string;
}

export async function addRootAction(absPath: string): Promise<AddRootResult> {
  try {
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      return { ok: false, error: `Not a directory: ${absPath}` };
    }
    const entry = await addRoot(absPath);
    revalidatePath("/");
    const onboardingTopicId = await spawnOnboardingTopic(entry).catch(
      () => undefined,
    );
    return {
      ok: true,
      id: entry.id,
      ...(onboardingTopicId ? { onboardingTopicId } : {}),
    };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

async function spawnOnboardingTopic(entry: {
  id: string;
  path: string;
}): Promise<string | undefined> {
  const settings = await loadSettings();
  const assignment = settings.assignments.chat;
  const firstMessage = "/skill space-onboarding";
  const topic = await createTopic({
    root: entry.path,
    firstMessage: "Space onboarding",
    harness: assignment.harness,
    model: assignment.model,
    language: settings.language,
  });
  const res = await startOrchestratorTurn({
    rootId: entry.id,
    topicId: topic.meta.id,
    message: firstMessage,
    attachments: [],
  });
  if ("error" in res) {
    // Topic created but agent didn't start — the user can still send a
    // message manually. Return the topicId so they land in it.
  }
  return topic.meta.id;
}

export interface RunInitResult {
  ok: boolean;
  error?: string;
}

export async function runInitAction(
  rootPath: string,
  rootIdValue: string,
  scaffoldOnly = false,
): Promise<RunInitResult> {
  try {
    const settings = await loadSettings();
    const analyze = settings.assignments.analyze;
    // Settings only knows about agentic harnesses for this task; if the user
    // somehow set a non-agentic one we fall back to per-root config.
    const harness =
      analyze.harness === "claude-code" || analyze.harness === "codex"
        ? analyze.harness
        : undefined;
    await runInit(rootPath, {
      scaffoldOnly,
      language: settings.language,
      ...(harness ? { harness } : {}),
      ...(harness ? { model: analyze.model } : {}),
    });
    if (!scaffoldOnly) await markInitialized(rootIdValue);
    revalidatePath("/");
    revalidatePath(`/roots/${rootIdValue}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

export interface RemoveRootResult {
  ok: boolean;
  error?: string;
}

export async function removeRootAction(
  id: string,
): Promise<RemoveRootResult> {
  try {
    await removeRoot(id);
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    try {
      const parsed: unknown = JSON.parse(err.message);
      if (Array.isArray(parsed)) {
        return parsed
          .map((e) => {
            if (typeof e === "object" && e !== null && "message" in e) {
              return String((e as { message: unknown }).message);
            }
            return String(e);
          })
          .join("; ");
      }
    } catch {
      // not JSON
    }
    return err.message;
  }
  return String(err);
}
