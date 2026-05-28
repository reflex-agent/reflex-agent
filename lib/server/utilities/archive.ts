import "server-only";
import { unzipSync } from "fflate";
import { ManifestSchema, type UtilityScope } from "./types";
import { installUtility } from "./store";
import { buildUtility } from "./build";

/**
 * Install a utility from an uploaded `.zip`. Mirrors the github path but
 * the bytes come from the archive instead of the GitHub API.
 *
 * Safety:
 *  - per-file + total size caps
 *  - path-traversal is rejected (also re-checked by InstallFilesSchema in
 *    installUtility, but we fail early with a clearer message)
 *  - a single wrapping top-level folder is stripped (zipping a directory
 *    usually nests everything under `<name>/`)
 *  - build artefacts / vcs dirs are skipped
 */

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const SKIP_TOP_DIRS = new Set(["dist", "node_modules", ".git", "data"]);

export interface InstallArchiveResult {
  scope: UtilityScope;
  id: string;
}

export async function installFromArchive(args: {
  zip: Uint8Array;
  scope: UtilityScope;
  rootId?: string;
}): Promise<InstallArchiveResult> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(args.zip);
  } catch (err) {
    throw new Error(
      `not a valid zip archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Drop directory entries and compute the names we keep.
  const names = Object.keys(entries).filter((n) => !n.endsWith("/"));
  if (names.length === 0) throw new Error("archive is empty");

  // Strip a single wrapping folder if every entry sits under it.
  const prefix = commonTopFolder(names);

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const files: Record<string, string> = {};
  let total = 0;
  for (const name of names) {
    const rel = (prefix ? name.slice(prefix.length) : name).replace(/^\/+/, "");
    if (!rel) continue;
    const top = rel.split("/")[0]!;
    if (SKIP_TOP_DIRS.has(top)) continue;
    if (rel.startsWith("/") || rel.includes("..")) {
      throw new Error(`unsafe path in archive: ${rel}`);
    }
    const bytes = entries[name]!;
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error(`file ${rel} exceeds ${MAX_FILE_BYTES} bytes`);
    }
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`archive exceeds ${MAX_TOTAL_BYTES} bytes total`);
    }
    files[rel] = decoder.decode(bytes);
  }

  const manifestText = files["manifest.json"];
  if (!manifestText) {
    throw new Error("archive has no manifest.json at its root");
  }
  let manifest;
  try {
    manifest = ManifestSchema.parse(JSON.parse(manifestText));
  } catch (err) {
    throw new Error(
      `invalid manifest.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const installed = await installUtility({
    scope: args.scope,
    ...(args.rootId ? { rootId: args.rootId } : {}),
    manifest,
    files,
    source: {
      type: "archive",
      origin: `archive:${manifest.id}@${manifest.version}`,
      fetchedAt: new Date().toISOString(),
      installedBy: "archive-installer",
    },
  });
  await buildUtility(installed);
  return { scope: installed.scope, id: installed.manifest.id };
}

/**
 * If every entry shares one top-level folder (e.g. `my-util/...`), return
 * that prefix (incl. trailing slash) so it can be stripped. Otherwise "".
 */
function commonTopFolder(names: string[]): string {
  const first = names[0]!;
  const slash = first.indexOf("/");
  if (slash < 0) return "";
  const candidate = first.slice(0, slash + 1);
  return names.every((n) => n.startsWith(candidate)) ? candidate : "";
}
