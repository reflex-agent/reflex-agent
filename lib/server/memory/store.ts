import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { reflexHome } from "@/lib/reflex/home";
import { loadSettings } from "@/lib/settings/store";
import { quickComplete } from "@/lib/server/quick";
import {
  FILE_CAPS,
  FILE_DESCRIPTIONS,
  MEMORY_FILES,
  type MemoryFile,
  type MemoryOp,
  type MemoryScope,
} from "./types";

/**
 * Global memory lives at `$REFLEX_HOME/memory/<FILE>.md`.
 * Project memory lives at `<root>/.reflex/memory/<FILE>.md`.
 *
 * Reads silently return null when the file is missing — empty memory is
 * a valid state, not an error.
 *
 * Writes enforce per-file line caps. Caller can request a fallback to
 * compaction (auto-compact path); store returns a typed result either way
 * so the marker handler can surface the right confirmation card.
 */

export interface MemoryReadResult {
  file: MemoryFile;
  content: string | null;
  lines: number;
}

export interface MemoryWriteResult {
  ok: boolean;
  file: MemoryFile;
  lines: number;
  cap: number;
  error?: string;
}

interface ScopeContext {
  scope: MemoryScope;
  rootPath?: string;
}

function memoryDir(ctx: ScopeContext): string {
  if (ctx.scope === "global") {
    return path.join(reflexHome(), "memory");
  }
  if (!ctx.rootPath) {
    throw new Error("project memory requires rootPath");
  }
  return path.join(ctx.rootPath, ".reflex", "memory");
}

function filePath(ctx: ScopeContext, file: MemoryFile): string {
  return path.join(memoryDir(ctx), `${file}.md`);
}

function countLines(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

export async function readMemoryFile(
  ctx: ScopeContext,
  file: MemoryFile,
): Promise<MemoryReadResult> {
  try {
    const raw = await fs.readFile(filePath(ctx, file), "utf8");
    const trimmed = raw.replace(/\s+$/, "");
    return { file, content: trimmed || null, lines: countLines(trimmed) };
  } catch {
    return { file, content: null, lines: 0 };
  }
}

export async function loadMemory(
  ctx: ScopeContext,
): Promise<Record<MemoryFile, MemoryReadResult>> {
  const entries = await Promise.all(
    MEMORY_FILES.map((f) => readMemoryFile(ctx, f)),
  );
  const out = {} as Record<MemoryFile, MemoryReadResult>;
  for (const r of entries) out[r.file] = r;
  return out;
}

async function writeFileSafe(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

/**
 * Append, replace, or remove a line from a memory file. Returns
 * `{ ok: false, error: "cap-exceeded" }` when an append would push the
 * file past its line cap. The caller (or marker handler) is expected
 * to retry through `writeMemoryWithCompaction` if auto-compact is
 * desired.
 */
export async function writeMemory(
  ctx: ScopeContext,
  file: MemoryFile,
  op: MemoryOp,
  args: { content?: string; match?: string } = {},
): Promise<MemoryWriteResult> {
  const cap = FILE_CAPS[file];
  const path_ = filePath(ctx, file);
  const current = await readMemoryFile(ctx, file);

  if (op === "replace") {
    const next = (args.content ?? "").trim();
    if (!next) {
      await fs
        .unlink(path_)
        .catch(() => null);
      return { ok: true, file, lines: 0, cap };
    }
    const lines = countLines(next);
    if (lines > cap) {
      return {
        ok: false,
        file,
        lines,
        cap,
        error: "cap-exceeded",
      };
    }
    await writeFileSafe(path_, next);
    return { ok: true, file, lines, cap };
  }

  if (op === "remove") {
    if (!current.content) return { ok: true, file, lines: 0, cap };
    const match = (args.match ?? "").trim();
    if (!match) {
      return {
        ok: false,
        file,
        lines: current.lines,
        cap,
        error: "match-required",
      };
    }
    const kept = current.content
      .split("\n")
      .filter((line) => !line.includes(match));
    const joined = kept.join("\n").trim();
    if (!joined) {
      await fs.unlink(path_).catch(() => null);
      return { ok: true, file, lines: 0, cap };
    }
    await writeFileSafe(path_, joined);
    return { ok: true, file, lines: countLines(joined), cap };
  }

  // op === "append"
  const addition = (args.content ?? "").trim();
  if (!addition) {
    return { ok: false, file, lines: current.lines, cap, error: "empty-content" };
  }
  const additionLines = addition.split("\n").length;
  if (current.lines + additionLines <= cap) {
    const next = current.content
      ? `${current.content.trim()}\n${addition}`
      : addition;
    await writeFileSafe(path_, next);
    return { ok: true, file, lines: countLines(next), cap };
  }
  // Cap would be exceeded — auto-compact the file once via quickComplete,
  // then retry the append. If compaction still doesn't fit, the append
  // is dropped (we don't loop).
  const compacted = await compactFile(file, current.content ?? "", addition);
  if (!compacted) {
    return { ok: false, file, lines: current.lines, cap, error: "compact-failed" };
  }
  await writeFileSafe(path_, compacted);
  return { ok: true, file, lines: countLines(compacted), cap };
}

/**
 * Ask the user-configured `quick` model to compress an existing memory
 * file plus a pending new entry down to ≤cap lines, keeping every
 * distinct fact. Returns the new file content or null on failure.
 */
async function compactFile(
  file: MemoryFile,
  current: string,
  addition: string,
): Promise<string | null> {
  const cap = FILE_CAPS[file];
  try {
    const settings = await loadSettings();
    const assignment = settings.assignments.quick;
    const prompt = [
      `You compress a Reflex memory file. The file is ${file}.md — ${FILE_DESCRIPTIONS[file]}.`,
      `Hard rule: the OUTPUT MUST BE ≤${cap} lines.`,
      "Merge the new entry into the existing content. Keep every distinct fact. Drop duplicates and obsolete entries. Tighten wording but DO NOT invent facts. One line per fact. Plain text, no markdown headers, no surrounding quotes, no commentary — just the new file contents.",
      "",
      "## Existing file",
      current.trim() || "(empty)",
      "",
      "## New entry to merge in",
      addition.trim(),
    ].join("\n");
    const reply = await quickComplete(assignment, prompt, { timeoutMs: 45_000 });
    const cleaned = stripFences(reply).trim();
    if (!cleaned) return null;
    // Enforce cap by truncation as a last safety net.
    const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.slice(0, cap).join("\n");
  } catch {
    return null;
  }
}

function stripFences(s: string): string {
  const m = /^```(?:\w+)?\n([\s\S]*?)\n```\s*$/.exec(s.trim());
  return m ? m[1]! : s;
}
