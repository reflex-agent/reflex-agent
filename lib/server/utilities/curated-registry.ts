import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { reflexHome } from "@/lib/reflex/home";

/**
 * Curated catalogue of utilities Reflex blesses for one-tap install.
 * Two-tier source: inline baseline ships with the binary (offline-safe);
 * a daily fetch from `reflex-agent/utility-registry` raw content overlays
 * a newer list when the network's there. Either way the UI never sees
 * an empty grid on a fresh install.
 *
 * Each entry is a github-repo coordinate the existing
 * `installFromGithubAction` already understands — no new install path.
 */

export interface CuratedUtility {
  id: string;
  name: string;
  emoji: string;
  category: "finance" | "health" | "productivity" | "travel" | "study" | "creative" | "other";
  description: string;
  /** Form accepted by installFromGithubAction (e.g. "github:owner/repo@tag"). */
  github: string;
  /** Optional explicit scope hint; UI lets user override. */
  suggestedScope?: "global" | "project";
  /** Optional short author handle for the card. */
  author?: string;
}

const INLINE_BASELINE: CuratedUtility[] = [
  {
    id: "learn-anything",
    name: "Learn anything",
    emoji: "🎓",
    category: "study",
    description:
      "Universal AI tutor. Say \"I want to learn X\" — it builds a course for your level: syllabus, articles, videos, diagrams, quizzes, homework, and interactive drills.",
    github: "github:reflex-agent/rflx-learn-anything@v0.6.0",
    suggestedScope: "project",
    author: "reflex-agent",
  },
  {
    id: "task-board",
    name: "Task board",
    emoji: "📋",
    category: "productivity",
    description:
      "Kanban tracker with /task, /tasks, /take-task commands. Each code task gets its own git worktree on dispatch so parallel agents never collide. Auto-pickup, PR mode, pre/post hooks.",
    github: "github:reflex-agent/rflx-task-board@v0.7.1",
    suggestedScope: "project",
    author: "reflex-agent",
  },
];

const CACHE_PATH = path.join(reflexHome(), "curated-registry.json");
const REMOTE_URL =
  "https://raw.githubusercontent.com/reflex-agent/utility-registry/main/index.json";
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

interface CachedRegistry {
  fetchedAt: string;
  items: CuratedUtility[];
}

let inMemoryCache: CachedRegistry | null = null;

/**
 * Return the freshest registry available. Priority:
 *   1. in-process cache, if young (< 1h)
 *   2. on-disk cache, if young (< 24h)
 *   3. remote fetch with timeout — on success persist + memoise
 *   4. inline baseline
 *
 * Errors at any step fall through silently to the next source.
 */
export async function getCuratedRegistry(): Promise<CuratedUtility[]> {
  if (inMemoryCache && fresh(inMemoryCache, 60 * 60 * 1000)) {
    return inMemoryCache.items;
  }
  const disk = await readDiskCache();
  if (disk && fresh(disk, MAX_CACHE_AGE_MS)) {
    inMemoryCache = disk;
    return disk.items;
  }
  const remote = await fetchRemote();
  if (remote) {
    const cached: CachedRegistry = {
      fetchedAt: new Date().toISOString(),
      items: remote,
    };
    inMemoryCache = cached;
    void writeDiskCache(cached).catch(() => null);
    return remote;
  }
  // Disk cache could be stale but still better than empty — prefer it
  // over baseline when present.
  if (disk?.items.length) return disk.items;
  return INLINE_BASELINE;
}

function fresh(c: CachedRegistry, maxMs: number): boolean {
  return Date.now() - Date.parse(c.fetchedAt) < maxMs;
}

async function readDiskCache(): Promise<CachedRegistry | null> {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as CachedRegistry;
    if (Array.isArray(parsed.items) && typeof parsed.fetchedAt === "string") {
      return parsed;
    }
  } catch {
    /* missing / corrupt */
  }
  return null;
}

async function writeDiskCache(c: CachedRegistry): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(c, null, 2) + "\n", "utf8");
}

async function fetchRemote(): Promise<CuratedUtility[] | null> {
  try {
    const res = await fetch(REMOTE_URL, {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { items?: CuratedUtility[] };
    if (!Array.isArray(json.items)) return null;
    // Light validation — drop entries missing required fields.
    return json.items.filter(
      (it) =>
        typeof it.id === "string" &&
        typeof it.name === "string" &&
        typeof it.github === "string",
    );
  } catch {
    return null;
  }
}

export function inlineBaseline(): CuratedUtility[] {
  return INLINE_BASELINE;
}
