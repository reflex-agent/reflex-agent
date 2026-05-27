import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listRoots, type RegistryEntry } from "@/lib/registry";
import { loadSettings } from "@/lib/settings/store";
import { quickComplete } from "@/lib/server/quick";
import { writeMemory } from "@/lib/server/memory/store";
import { reflexRoot } from "@/lib/reflex/paths";

/**
 * Built-in scheduled tasks that don't live inside any utility or
 * project. They share the workflow scheduler's tick loop but aren't
 * full WorkflowDef instances — each has its own implementation.
 *
 * Why not workflows? They cross project boundaries (memory-rollup
 * aggregates journals from every Space into ONE global file). The
 * workflow runner is per-root by design; bending it to be cross-root
 * would tangle more than it'd unify.
 */

export type SystemTrigger = "hourly" | "daily" | "weekly";

export interface SystemTask {
  id: string;
  label: string;
  trigger: SystemTrigger;
  run: () => Promise<{ ok: boolean; detail?: string }>;
}

export const SYSTEM_TASKS: SystemTask[] = [
  {
    id: "system:memory-rollup",
    label: "Memory rollup",
    trigger: "weekly",
    run: runMemoryRollup,
  },
];

export const SYSTEM_TASK_INTERVAL_MS: Record<SystemTrigger, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Memory rollup

const MAX_JOURNAL_ENTRIES_PER_ROOT = 14;
const MAX_OUTPUT_LINES = 25;

interface JournalEntry {
  rootName: string;
  date: string;
  title: string;
  body: string;
}

async function runMemoryRollup(): Promise<{ ok: boolean; detail?: string }> {
  const roots = await listRoots().catch(() => [] as RegistryEntry[]);
  const entries: JournalEntry[] = [];
  for (const root of roots) {
    const fromRoot = await readJournalEntries(root).catch(() => []);
    entries.push(...fromRoot);
  }
  if (entries.length < 4) {
    return {
      ok: true,
      detail: `${entries.length} journal entries across all roots — skipping rollup (need ≥4).`,
    };
  }
  // Newest first, cap so the prompt stays under ~12KB.
  entries.sort((a, b) => (a.date < b.date ? 1 : -1));
  const recent = entries.slice(0, 60);

  const prompt = [
    `You're summarising the user's last 7 days from their journal entries across every Reflex Space.`,
    `Output STRICT plain text. ≤${MAX_OUTPUT_LINES} lines. One fact per line, third-person about the user.`,
    `Cover: recurring themes, mood arc, unresolved threads, notable wins. Quote the user's own phrasing for one or two themes — sparingly. No greetings, no markdown headers, no preamble — straight into the bullets.`,
    `If the entries don't span 7 days yet, summarise what's there honestly.`,
    "",
    "## Journal entries (newest first)",
    ...recent.map(
      (e) => `### ${e.date} · ${e.rootName} · ${e.title}\n${trim(e.body, 400)}`,
    ),
  ].join("\n");

  try {
    const settings = await loadSettings();
    const reply = await quickComplete(settings.assignments.quick, prompt, {
      timeoutMs: 90_000,
    });
    const out = (reply ?? "").trim();
    if (!out) return { ok: false, detail: "empty completion" };
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, MAX_OUTPUT_LINES);
    const content = lines.join("\n");
    await writeMemory({ scope: "global" }, "RECENT", "replace", { content });
    return {
      ok: true,
      detail: `rolled up ${recent.length} entries from ${roots.length} Spaces`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readJournalEntries(root: RegistryEntry): Promise<JournalEntry[]> {
  const dir = path.join(reflexRoot(root.path), "journal");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
  files.sort().reverse(); // YYYY-MM-DD-slug.md → newer first
  files = files.slice(0, MAX_JOURNAL_ENTRIES_PER_ROOT);
  const rootName = path.basename(root.path) || root.id;
  const out: JournalEntry[] = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      const { title, date, body } = parseFrontmatter(raw);
      out.push({
        rootName,
        date: date ?? deriveDateFromName(f) ?? "",
        title: title ?? f,
        body,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function parseFrontmatter(
  raw: string,
): { title?: string; date?: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { body: raw.trim() };
  const fmText = m[1]!;
  const body = m[2]!.trim();
  const title = /^title:\s*(.+)$/m.exec(fmText)?.[1]?.replace(/^"|"$/g, "");
  const date = /^date:\s*(.+)$/m.exec(fmText)?.[1]?.replace(/^"|"$/g, "");
  return {
    ...(title ? { title: title.trim() } : {}),
    ...(date ? { date: date.trim() } : {}),
    body,
  };
}

function deriveDateFromName(name: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(name);
  return m ? m[1]! : null;
}

function trim(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
