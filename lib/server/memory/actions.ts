"use server";

import {
  FILE_CAPS,
  FILE_DESCRIPTIONS,
  MEMORY_FILES,
  TIER_BY_FILE,
  isMemoryFile,
  isMemoryScope,
  type MemoryFile,
  type MemoryScope,
} from "./types";
import { loadMemory, writeMemory } from "./store";
import { getRoot } from "@/lib/registry";

export interface MemoryFileSnapshot {
  file: MemoryFile;
  content: string;
  lines: number;
  cap: number;
  tier: 1 | 2 | 3;
  description: string;
}

export type LoadMemoryResult =
  | { ok: true; files: MemoryFileSnapshot[] }
  | { ok: false; error: string };

async function resolveRoot(
  scope: MemoryScope,
  rootId?: string,
): Promise<string | undefined> {
  if (scope === "global") return undefined;
  if (!rootId) throw new Error("project memory requires rootId");
  const entry = await getRoot(rootId);
  if (!entry) throw new Error(`unknown root: ${rootId}`);
  return entry.path;
}

export async function loadMemoryAction(args: {
  scope: MemoryScope;
  rootId?: string;
}): Promise<LoadMemoryResult> {
  try {
    if (!isMemoryScope(args.scope)) {
      return { ok: false, error: "invalid scope" };
    }
    const rootPath = await resolveRoot(args.scope, args.rootId);
    const data = await loadMemory(
      rootPath
        ? { scope: "project", rootPath }
        : { scope: "global" },
    );
    const files: MemoryFileSnapshot[] = MEMORY_FILES.map((f) => ({
      file: f,
      content: data[f].content ?? "",
      lines: data[f].lines,
      cap: FILE_CAPS[f],
      tier: TIER_BY_FILE[f],
      description: FILE_DESCRIPTIONS[f],
    }));
    return { ok: true, files };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type SaveMemoryResult =
  | { ok: true; lines: number; cap: number }
  | { ok: false; error: string; lines?: number; cap?: number };

export async function saveMemoryFileAction(args: {
  scope: MemoryScope;
  rootId?: string;
  file: string;
  content: string;
}): Promise<SaveMemoryResult> {
  try {
    if (!isMemoryScope(args.scope)) return { ok: false, error: "invalid scope" };
    if (!isMemoryFile(args.file)) return { ok: false, error: "invalid file" };
    const rootPath = await resolveRoot(args.scope, args.rootId);
    const ctx = rootPath
      ? ({ scope: "project", rootPath } as const)
      : ({ scope: "global" } as const);
    const res = await writeMemory(ctx, args.file, "replace", {
      content: args.content,
    });
    if (!res.ok) {
      return {
        ok: false,
        error: res.error ?? "write failed",
        lines: res.lines,
        cap: res.cap,
      };
    }
    return { ok: true, lines: res.lines, cap: res.cap };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function wipeMemoryAction(args: {
  scope: MemoryScope;
  rootId?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!isMemoryScope(args.scope)) return { ok: false, error: "invalid scope" };
    const rootPath = await resolveRoot(args.scope, args.rootId);
    const ctx = rootPath
      ? ({ scope: "project", rootPath } as const)
      : ({ scope: "global" } as const);
    for (const f of MEMORY_FILES) {
      await writeMemory(ctx, f, "replace", { content: "" });
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
