"use server";

import path from "node:path";
import { promises as fs } from "node:fs";
import { getRoot } from "@/lib/registry";
import { listKbFiles, type KbFileMeta } from "./kb";
import { listTopics, type TopicSummary } from "./topics";
import { eventsLogPath } from "./agents/events-log";
import { listUtilities } from "./utilities/store";
import { loadMemory } from "./memory/store";
import { MEMORY_FILES, FILE_DESCRIPTIONS } from "./memory/types";

/**
 * Server actions used by the persistent app sidebar to lazy-load a project's
 * KB tree and topic list on expand. Keep these snappy — they run on every
 * expand click.
 */

export interface SidebarSection {
  /** Path relative to .reflex/ (POSIX). */
  rel: string;
  /** Human-readable label (file title from frontmatter or filename). */
  label: string;
  /** True if this is a directory grouping; otherwise it's a file leaf. */
  isDir: boolean;
  /** For files only: full rel path to use when opening. */
  fileRel?: string;
  /** Direct children for a directory; max 2 levels deep here. */
  children?: SidebarSection[];
}

export type SidebarKbResult =
  | { ok: true; sections: SidebarSection[] }
  | { ok: false; error: string };

export async function loadKbSectionsAction(
  rootId: string,
): Promise<SidebarKbResult> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const files = await listKbFiles(entry.path);
    return { ok: true, sections: buildSidebarTree(files) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SidebarTopic {
  id: string;
  title: string;
  updatedAt: string;
}

export type SidebarTopicsResult =
  | { ok: true; topics: SidebarTopic[] }
  | { ok: false; error: string };

export async function loadTopicsAction(
  rootId: string,
): Promise<SidebarTopicsResult> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const topics = await listTopics(entry.path);
    // Conversations are USER topics only: drop utility helper chats
    // (`helperFor`), task-bound chats (`taskId`), and anything with no
    // real exchange yet. Helper threads move under their utility node;
    // task threads belong to the task-board.
    const userTopics = topics.filter(
      (t) => !t.meta.helperFor && !t.meta.taskId,
    );
    const withContent = await filterNonEmpty(entry.path, userTopics);
    return {
      ok: true,
      topics: withContent.map((t) => ({
        id: t.meta.id,
        title: t.meta.title,
        updatedAt: t.meta.updatedAt,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * A topic counts as non-empty when it has real content in either store:
 * the legacy `.md` body (`preview`) or the `.events.jsonl` log. We check
 * the events file by size rather than parsing — a non-zero file means at
 * least one event was appended, which only happens once an exchange
 * starts. Freshly-created-but-abandoned topics have neither.
 */
async function filterNonEmpty(
  rootPath: string,
  topics: TopicSummary[],
): Promise<TopicSummary[]> {
  const checks = await Promise.all(
    topics.map(async (t) => {
      if (t.preview.trim()) return true;
      try {
        const stat = await fs.stat(eventsLogPath(rootPath, t.meta.id));
        return stat.size > 0;
      } catch {
        return false;
      }
    }),
  );
  return topics.filter((_, i) => checks[i]);
}

// ---------------------------------------------------------------------------
// Utilities (with their helper threads) for the sidebar tree.

export interface SidebarUtilityThread {
  id: string;
  title: string;
  updatedAt: string;
}

export interface SidebarUtility {
  id: string;
  name: string;
  /** "global" | "project" — for building the /utilities/<scope>/<id> link. */
  scope: "global" | "project";
  /** Present only for project-scoped utilities; needed in the link query. */
  rootId?: string;
  /** Lucide icon name ("lucide:Boxes") or data URL, if the manifest set one. */
  icon?: string;
  /** Helper conversations bound to this utility (non-empty only). */
  threads: SidebarUtilityThread[];
}

export type SidebarUtilitiesResult =
  | { ok: true; utilities: SidebarUtility[] }
  | { ok: false; error: string };

export async function loadSidebarUtilitiesAction(
  rootId: string,
): Promise<SidebarUtilitiesResult> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    // Global utilities + this project's local ones.
    const utils = await listUtilities({ rootId });
    // All topics once; bucket helper threads by utilityId.
    const topics = await listTopics(entry.path);
    const helpersByUtility = new Map<string, TopicSummary[]>();
    for (const t of topics) {
      const uid = t.meta.helperFor;
      if (!uid) continue;
      const list = helpersByUtility.get(uid) ?? [];
      list.push(t);
      helpersByUtility.set(uid, list);
    }

    const out: SidebarUtility[] = [];
    for (const u of utils) {
      const rawThreads = helpersByUtility.get(u.manifest.id) ?? [];
      const threads = await filterNonEmpty(entry.path, rawThreads);
      out.push({
        id: u.manifest.id,
        name: u.manifest.name,
        scope: u.scope,
        ...(u.rootId ? { rootId: u.rootId } : {}),
        ...(u.manifest.icon ? { icon: u.manifest.icon } : {}),
        threads: threads.map((t) => ({
          id: t.meta.id,
          title: t.meta.title,
          updatedAt: t.meta.updatedAt,
        })),
      });
    }
    // Stable order: alphabetical by name.
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, utilities: out };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Memory files for the sidebar tree. Project scope only — global memory
// lives in /settings and isn't tied to a Space.

export interface SidebarMemoryFile {
  file: string;
  description: string;
  lines: number;
  empty: boolean;
}

export type SidebarMemoryResult =
  | { ok: true; files: SidebarMemoryFile[] }
  | { ok: false; error: string };

export async function loadSidebarMemoryAction(
  rootId: string,
): Promise<SidebarMemoryResult> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const data = await loadMemory({ scope: "project", rootPath: entry.path });
    const files: SidebarMemoryFile[] = MEMORY_FILES.map((f) => ({
      file: f,
      description: FILE_DESCRIPTIONS[f],
      lines: data[f].lines,
      empty: !data[f].content,
    }));
    return { ok: true, files };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface KbInput {
  rel: string;
  meta: KbFileMeta;
}

function buildSidebarTree(files: KbInput[]): SidebarSection[] {
  // Root-level INDEX.md, then top-level directories. Inside each top-level
  // dir we surface its INDEX.md first and direct children (one level deep);
  // deeper nesting collapses to the directory page.
  const rootFiles: SidebarSection[] = [];
  const dirs = new Map<string, KbInput[]>();
  for (const f of files) {
    const parts = f.rel.split("/");
    if (parts.length === 1) {
      rootFiles.push(toLeaf(f));
      continue;
    }
    const dir = parts[0]!;
    const list = dirs.get(dir) ?? [];
    list.push(f);
    dirs.set(dir, list);
  }
  const out: SidebarSection[] = [];
  // Root-level files first, INDEX.md pinned.
  rootFiles.sort(byFilenameWithIndexFirst);
  out.push(...rootFiles);
  // Then directories alphabetical.
  const dirNames = [...dirs.keys()].sort();
  for (const dir of dirNames) {
    const items = dirs.get(dir) ?? [];
    const children = items
      .map((f) => {
        const parts = f.rel.split("/");
        // Only show one nesting level inside the sidebar; deeper nesting
        // shows as the deepest leaf's filename.
        const tail = parts.slice(1).join("/");
        return {
          rel: f.rel,
          label: f.meta.title ?? path.basename(tail),
          isDir: false,
          fileRel: f.rel,
        } satisfies SidebarSection;
      })
      .sort((a, b) =>
        path.basename(a.rel) === "INDEX.md"
          ? -1
          : path.basename(b.rel) === "INDEX.md"
            ? 1
            : a.label.localeCompare(b.label),
      );
    // Use the dir's INDEX.md title (if present) as the section label.
    const idx = children.find((c) => path.basename(c.rel) === "INDEX.md");
    const label = idx?.label ?? dir;
    out.push({
      rel: `${dir}/`,
      label,
      isDir: true,
      children,
    });
  }
  return out;
}

function toLeaf(f: KbInput): SidebarSection {
  return {
    rel: f.rel,
    label: f.meta.title ?? f.rel,
    isDir: false,
    fileRel: f.rel,
  };
}

function byFilenameWithIndexFirst(
  a: SidebarSection,
  b: SidebarSection,
): number {
  const aBase = path.basename(a.rel);
  const bBase = path.basename(b.rel);
  if (aBase === "INDEX.md") return -1;
  if (bBase === "INDEX.md") return 1;
  return a.label.localeCompare(b.label);
}
