import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { reflexHome } from "./reflex/home.js";
import { writeJsonFile } from "./reflex/store/json-store.js";

/**
 * Registry of Reflex-managed roots. Stored at `<REFLEX_HOME>/registry.json` so
 * it survives across web-UI sessions and is shared with the CLI if needed.
 */

const REGISTRY_DIR = reflexHome();
const REGISTRY_FILE = path.join(REGISTRY_DIR, "registry.json");

export interface RegistryEntry {
  /** Stable id derived from the absolute path (legacy; changes if re-added at
   *  a new path). Kept for back-compat — existing topics/widgets/URLs key on it. */
  id: string;
  /** Path-INDEPENDENT stable ref (rootRef dual-read). Survives a folder move
   *  via updatePath(). getRoot() resolves by id OR ref, so callers can migrate
   *  to the ref as the canonical id without breaking id-keyed data. */
  ref?: string;
  /** Absolute path on disk. */
  path: string;
  /** ISO timestamp when this root was added. */
  addedAt: string;
  /** ISO timestamp of the last completed `init` run, if any. */
  lastInitAt?: string;
}

interface RegistryFile {
  version: 1;
  entries: RegistryEntry[];
}

const EMPTY: RegistryFile = { version: 1, entries: [] };

/**
 * The "home" Space — a synthetic, always-present root that hosts the
 * global dispatcher chat (the central, never-ending thread shared with
 * Telegram). It lives at `<REFLEX_HOME>/home` but is NEVER added to the
 * registry file, so it stays out of `listRoots()` (and the sidebar
 * Spaces list). `getRoot(HOME_ROOT_ID)` resolves it directly.
 */
export const HOME_ROOT_ID = "home";

export function homeRootEntry(): RegistryEntry {
  return {
    id: HOME_ROOT_ID,
    path: path.join(reflexHome(), "home"),
    // Stable sentinel — never displayed, only used to satisfy the type.
    addedAt: "1970-01-01T00:00:00.000Z",
  };
}

export function isHomeRoot(id: string): boolean {
  return id === HOME_ROOT_ID;
}

export function rootId(absPath: string): string {
  return crypto
    .createHash("sha1")
    .update(path.resolve(absPath))
    .digest("hex")
    .slice(0, 16);
}

/** A path-independent stable ref (rootRef). Unlike rootId(), it does not change
 *  when the Space's folder moves. */
export function newRef(): string {
  return crypto.randomBytes(8).toString("hex");
}

async function readFile(): Promise<RegistryFile> {
  try {
    const raw = await fs.readFile(REGISTRY_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "entries" in parsed &&
      Array.isArray((parsed as { entries: unknown }).entries)
    ) {
      const file = parsed as RegistryFile;
      // rootRef migration (additive, self-healing): backfill a stable ref for
      // entries that predate it, so existing Spaces get a path-independent id.
      // Write-once — after backfill every entry has a ref, so no further writes.
      let changed = false;
      for (const e of file.entries) {
        if (!e.ref) {
          e.ref = newRef();
          changed = true;
        }
      }
      if (changed) {
        try {
          await writeJsonFile(REGISTRY_FILE, file);
        } catch {
          /* best-effort backfill; resolution still works by id */
        }
      }
      return file;
    }
    return EMPTY;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return EMPTY;
    }
    throw err;
  }
}

async function writeFile(file: RegistryFile): Promise<void> {
  await writeJsonFile(REGISTRY_FILE, file);
}

export async function listRoots(): Promise<RegistryEntry[]> {
  const file = await readFile();
  return [...file.entries].sort(
    (a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt),
  );
}

export async function getRoot(id: string): Promise<RegistryEntry | null> {
  if (id === HOME_ROOT_ID) return homeRootEntry();
  const file = await readFile();
  // rootRef dual-read: resolve by the legacy path-derived id OR the stable ref.
  return file.entries.find((e) => e.id === id || e.ref === id) ?? null;
}

export async function addRoot(absPath: string): Promise<RegistryEntry> {
  const resolved = path.resolve(absPath);
  const id = rootId(resolved);
  const file = await readFile();
  const existing = file.entries.find((e) => e.id === id);
  if (existing) return existing;
  const entry: RegistryEntry = {
    id,
    ref: newRef(),
    path: resolved,
    addedAt: new Date().toISOString(),
  };
  await writeFile({ ...file, entries: [...file.entries, entry] });
  return entry;
}

/**
 * Move a Space to a new path while preserving its identity — keeps `id` and
 * `ref` so topics/widgets/URLs that key on them keep resolving (rootRef). This
 * is the safe alternative to remove+re-add, which would mint a new id and
 * orphan everything. Backfills a `ref` if the entry predates rootRef.
 */
export async function updatePath(
  id: string,
  newPath: string,
): Promise<RegistryEntry | null> {
  const resolved = path.resolve(newPath);
  const file = await readFile();
  const idx = file.entries.findIndex((e) => e.id === id || e.ref === id);
  if (idx < 0) return null;
  const cur = file.entries[idx]!;
  const next: RegistryEntry = {
    ...cur,
    path: resolved,
    ...(cur.ref ? {} : { ref: newRef() }),
  };
  const updated = [...file.entries];
  updated[idx] = next;
  await writeFile({ ...file, entries: updated });
  return next;
}

export async function removeRoot(id: string): Promise<void> {
  const file = await readFile();
  await writeFile({
    ...file,
    entries: file.entries.filter((e) => e.id !== id),
  });
}

export async function markInitialized(id: string): Promise<void> {
  const file = await readFile();
  const idx = file.entries.findIndex((e) => e.id === id);
  if (idx < 0) return;
  const updated = [...file.entries];
  const existing = updated[idx]!;
  updated[idx] = { ...existing, lastInitAt: new Date().toISOString() };
  await writeFile({ ...file, entries: updated });
}
