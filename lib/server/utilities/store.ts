import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRoot, listRoots, type RegistryEntry } from "@/lib/registry";
import { reflexHome } from "@/lib/reflex/home";
import { reflexRoot } from "@/lib/reflex/paths";
import {
  ManifestSchema,
  type InstallSpec,
  type InstalledUtility,
  type Manifest,
  type ServerAction,
  type UtilityScope,
} from "./types";

const DISCOVERED_ACTION_TIMEOUT_MS = 30_000;

/**
 * Merge hand-declared server actions with auto-discovered ones. A
 * top-level `actions/<name>.ts` file becomes an action named `<name>`
 * unless the basename starts with `_` (helper/private convention, e.g.
 * `_store.ts`, `_types.ts`) or it's already declared. Explicit
 * declarations are kept verbatim (custom timeoutMs survives).
 */
function mergeDiscoveredActions(
  declared: ServerAction[],
  relPaths: string[],
): ServerAction[] {
  const byName = new Map(declared.map((a) => [a.name, a]));
  for (const rel of relPaths) {
    const m = /^actions\/([^/_][^/]*)\.ts$/.exec(rel);
    if (!m) continue; // nested, non-.ts, or `_`-prefixed → skip
    const name = m[1]!;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) continue;
    if (byName.has(name)) continue; // explicit entry wins
    byName.set(name, {
      name,
      entry: rel,
      timeoutMs: DISCOVERED_ACTION_TIMEOUT_MS,
    });
  }
  return [...byName.values()];
}

/**
 * On-disk store for utilities. Two scopes:
 *   global  → ~/.reflex/utilities/<id>/
 *   project → <root>/.reflex/utilities/<id>/
 *
 * `installUtility` is idempotent on (scope, rootId?, id) — same id reinstalls
 * over the existing directory. The bundler is invoked separately by callers.
 */

const GLOBAL_DIR = path.join(reflexHome(), "utilities");

export function globalUtilitiesDir(): string {
  return GLOBAL_DIR;
}

export function projectUtilitiesDir(rootPath: string): string {
  return path.join(reflexRoot(rootPath), "utilities");
}

export function utilityDir(
  scope: UtilityScope,
  id: string,
  rootPath?: string,
): string {
  if (scope === "global") return path.join(GLOBAL_DIR, id);
  if (!rootPath) {
    throw new Error("project-scoped utility requires rootPath");
  }
  return path.join(projectUtilitiesDir(rootPath), id);
}

export function utilityFile(
  scope: UtilityScope,
  id: string,
  relPath: string,
  rootPath?: string,
): string {
  const dir = utilityDir(scope, id, rootPath);
  const abs = path.resolve(dir, relPath);
  const rel = path.relative(dir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`refused path outside utility dir: ${relPath}`);
  }
  return abs;
}

export interface ListOptions {
  /** When set, also include project utilities for this root. */
  rootId?: string;
  scope?: UtilityScope;
}

export async function listUtilities(
  options: ListOptions = {},
): Promise<InstalledUtility[]> {
  const out: InstalledUtility[] = [];
  if (!options.scope || options.scope === "global") {
    out.push(...(await readScope("global", GLOBAL_DIR)));
  }
  if (!options.scope || options.scope === "project") {
    const roots: RegistryEntry[] = options.rootId
      ? (await getRoot(options.rootId)
          .then((r) => (r ? [r] : []))
          .catch(() => []))
      : await listRoots().catch(() => []);
    for (const r of roots) {
      const dir = projectUtilitiesDir(r.path);
      out.push(
        ...(await readScope("project", dir, r.id)).map((u) => ({
          ...u,
          rootId: r.id,
        })),
      );
    }
  }
  return out;
}

async function readScope(
  scope: UtilityScope,
  baseDir: string,
  rootId?: string,
): Promise<InstalledUtility[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstalledUtility[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(baseDir, e.name);
    const manifest = await readManifest(dir);
    if (!manifest) continue;
    out.push({
      scope,
      ...(rootId ? { rootId } : {}),
      dir,
      manifest,
      bundleAvailable: await pathExists(path.join(dir, "bundle.js")),
    });
  }
  return out;
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
    const parsed = ManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function getUtility(
  scope: UtilityScope,
  id: string,
  rootId?: string,
): Promise<InstalledUtility | null> {
  let baseDir: string;
  let resolvedRootId: string | undefined;
  if (scope === "global") {
    baseDir = GLOBAL_DIR;
  } else {
    if (!rootId) return null;
    const root = await getRoot(rootId).catch(() => null);
    if (!root) return null;
    baseDir = projectUtilitiesDir(root.path);
    resolvedRootId = root.id;
  }
  const dir = path.join(baseDir, id);
  const manifest = await readManifest(dir);
  if (!manifest) return null;
  return {
    scope,
    ...(resolvedRootId ? { rootId: resolvedRootId } : {}),
    dir,
    manifest,
    bundleAvailable: await pathExists(path.join(dir, "bundle.js")),
  };
}

/** Resolve a utility, project taking precedence over global on id collision. */
export async function resolveUtility(
  id: string,
  rootId?: string,
): Promise<InstalledUtility | null> {
  if (rootId) {
    const proj = await getUtility("project", id, rootId);
    if (proj) return proj;
  }
  return getUtility("global", id);
}

export async function installUtility(
  spec: InstallSpec,
): Promise<InstalledUtility> {
  if (spec.manifest.id !== spec.manifest.id.toLowerCase()) {
    throw new Error("manifest.id must be lowercase kebab-case");
  }
  // Resolve target dir
  let rootPath: string | undefined;
  if (spec.scope === "project") {
    if (!spec.rootId) {
      throw new Error("project-scoped install requires rootId");
    }
    const root = await getRoot(spec.rootId);
    if (!root) throw new Error(`unknown rootId: ${spec.rootId}`);
    rootPath = root.path;
  }
  const dir = utilityDir(spec.scope, spec.manifest.id, rootPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, "data"), { recursive: true });

  // Materialize files (skip manifest.json — we write the validated one below).
  for (const [rel, content] of Object.entries(spec.files)) {
    if (rel === "manifest.json") continue;
    const abs = utilityFile(spec.scope, spec.manifest.id, rel, rootPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  const manifestWithSource: Manifest = {
    ...spec.manifest,
    source: spec.source,
    // Auto-discover server actions: any top-level `actions/<name>.ts`
    // (excluding `_`-prefixed helper files) becomes an action without
    // being hand-listed. Explicit manifest entries win (so authors can
    // override timeoutMs). The expanded list is persisted to the stored
    // manifest.json so every downstream reader (build, host-api dispatch,
    // worker pool) keeps reading `serverActions` unchanged.
    serverActions: mergeDiscoveredActions(
      spec.manifest.serverActions,
      Object.keys(spec.files),
    ),
  };
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifestWithSource, null, 2) + "\n",
    "utf8",
  );

  // Auto-seed the dashboard card if the utility declared one. The widget
  // goes into `hidden` so the user explicitly pins it from the library —
  // matches the chat-created widget behaviour, avoids surprise pinning.
  if (
    spec.scope === "project" &&
    spec.rootId &&
    rootPath &&
    manifestWithSource.card
  ) {
    try {
      await seedUtilityCardWidget(
        rootPath,
        spec.scope,
        manifestWithSource,
      );
    } catch (err) {
      // Card seeding is best-effort — never block install.
      console.error("[utility install] card seed failed:", err);
    }
  }

  return {
    scope: spec.scope,
    ...(spec.rootId ? { rootId: spec.rootId } : {}),
    dir,
    manifest: manifestWithSource,
    bundleAvailable: false,
  };
}

/**
 * Create (or refresh) a `utility-card` widget record bound to the given
 * utility. New widgets land in the layout's `hidden` list — same draft
 * behaviour as chat-emitted widgets, so they show up in the library and
 * the user explicitly pins them to the dashboard.
 */
async function seedUtilityCardWidget(
  rootPath: string,
  scope: UtilityScope,
  manifest: Manifest,
): Promise<void> {
  if (!manifest.card) return;
  const {
    buildRecord,
    readLayout,
    reconcileLayout,
    writeLayout,
    writeWidget,
    listWidgets,
  } = await import("@/lib/server/widgets/store");
  const { SYSTEM_WIDGET_IDS } = await import("@/lib/server/widgets/types");
  const widgetId = `utility:${manifest.id}`;
  const record = buildRecord({
    id: widgetId,
    title: manifest.card.title ?? manifest.name,
    ...(manifest.card.description
      ? { description: manifest.card.description }
      : {}),
    // When the card declares a live `action`, carry its cadence onto the
    // widget so the background scheduler refreshes it. `isDue` reads
    // `refresh`; without it the card only updates on dashboard view.
    ...(manifest.card.action && manifest.card.refresh
      ? { refresh: manifest.card.refresh }
      : {}),
    payload: {
      kind: "utility-card",
      data: {
        utilityId: manifest.id,
        utilityScope: scope,
        inner: {
          kind: manifest.card.kind,
          data: manifest.card.data,
          ...(manifest.card.title ? { title: manifest.card.title } : {}),
          ...(manifest.card.description
            ? { description: manifest.card.description }
            : {}),
        },
      },
    },
  });
  await writeWidget(rootPath, record);
  const layout = await readLayout(rootPath);
  // First install → drop into hidden so the user pins it deliberately.
  // Re-install of an already-placed widget leaves its current position.
  if (!layout.order.includes(widgetId) && !layout.hidden.includes(widgetId)) {
    layout.hidden = [...layout.hidden, widgetId];
  }
  const records = await listWidgets(rootPath);
  const reconciled = reconcileLayout(
    layout,
    records.map((r) => r.id),
    SYSTEM_WIDGET_IDS,
  );
  await writeLayout(rootPath, reconciled);
}

export async function removeUtility(
  scope: UtilityScope,
  id: string,
  rootId?: string,
): Promise<void> {
  let rootPath: string | undefined;
  if (scope === "project") {
    if (!rootId) throw new Error("project-scoped remove requires rootId");
    const root = await getRoot(rootId);
    if (!root) return;
    rootPath = root.path;
  }
  const dir = utilityDir(scope, id, rootPath);
  await fs.rm(dir, { recursive: true, force: true });
}
