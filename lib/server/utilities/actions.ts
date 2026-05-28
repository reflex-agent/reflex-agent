"use server";

import { promises as fs } from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { getRoot, listRoots } from "@/lib/registry";
import { createTopic } from "@/lib/server/topics";
import { loadSettings } from "@/lib/settings/store";
import { startOrchestratorTurn } from "@/lib/server/agents/start-turn";
import { buildUtility } from "./build";
import {
  checkGithubUpdate,
  installFromGithubConfirmed,
  previewFromGithub,
  type GithubPreview,
} from "./github";
import {
  connectAndListTools,
  McpConfigSchema,
  type McpConfig,
  type McpToolSpec,
} from "./mcp";
import { generateMcpUtility } from "./mcp-generate";
import {
  getUtility,
  installUtility,
  listUtilities,
  removeUtility,
} from "./store";
import {
  deleteSecret,
  dropSecrets,
  listSecretKeys,
  setSecret,
} from "./secrets-store";
import { readAudit, type ReadAuditOptions } from "./audit";
import { ManifestSchema, type InstalledUtility, type Manifest, type UtilityScope } from "./types";

export type ListUtilitiesResult =
  | { ok: true; utilities: InstalledUtility[] }
  | { ok: false; error: string };

export async function listUtilitiesAction(args?: {
  rootId?: string;
  scope?: UtilityScope;
}): Promise<ListUtilitiesResult> {
  try {
    const utilities = await listUtilities(args ?? {});
    return { ok: true, utilities };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type GithubPreviewActionResult =
  | { ok: true; preview: GithubPreview }
  | { ok: false; error: string };

export async function githubPreviewAction(
  url: string,
): Promise<GithubPreviewActionResult> {
  const res = await previewFromGithub(url);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, preview: res.preview };
}

export type GithubInstallActionResult =
  | { ok: true; scope: UtilityScope; id: string }
  | { ok: false; error: string };

export async function githubInstallAction(args: {
  preview: GithubPreview;
  scope: UtilityScope;
  rootId?: string;
}): Promise<GithubInstallActionResult> {
  try {
    const out = await installFromGithubConfirmed(args);
    revalidatePath("/utilities");
    return { ok: true, scope: out.scope, id: out.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read-only listing of the curated catalogue (inline baseline + cached
 * remote fetch). Hot-path for the gallery — should be fast even when
 * offline.
 */
export async function listCuratedAction(): Promise<{
  items: Array<{
    id: string;
    name: string;
    emoji: string;
    category: string;
    description: string;
    github: string;
    suggestedScope?: "global" | "project";
    author?: string;
  }>;
}> {
  const { getCuratedRegistry } = await import("./curated-registry");
  const items = await getCuratedRegistry();
  return { items };
}

/**
 * One-tap install: preview + install in a single call. UI shows
 * permissions in a confirm dialog before calling this (preview returns
 * the manifest the user is about to accept).
 */
export async function installCuratedAction(args: {
  github: string;
  scope: UtilityScope;
  rootId?: string;
}): Promise<GithubInstallActionResult> {
  // `builtin:<id>@<ver>` short-circuits to the local repo installer —
  // no network, no GitHub. Same downstream code path (installUtility +
  // buildUtility) so post-install behaviour is identical.
  if (args.github.startsWith("builtin:")) {
    try {
      const { installFromBuiltin } = await import("./builtin-installer");
      const out = await installFromBuiltin({
        builtin: args.github,
        scope: args.scope,
        ...(args.rootId ? { rootId: args.rootId } : {}),
      });
      revalidatePath("/utilities");
      return { ok: true, scope: out.scope, id: out.id };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const preview = await previewFromGithub(args.github);
  if (!preview.ok) return { ok: false, error: preview.error };
  try {
    const out = await installFromGithubConfirmed({
      preview: preview.preview,
      scope: args.scope,
      ...(args.rootId ? { rootId: args.rootId } : {}),
    });
    revalidatePath("/utilities");
    return { ok: true, scope: out.scope, id: out.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Updates

export interface UpdateInfo {
  scope: UtilityScope;
  id: string;
  name: string;
  currentVersion: string;
  latestVersion: string;
  /** Where the update is sourced from — drives the apply path. */
  source: "builtin" | "github";
  /** Opaque ref the apply step uses (builtin spec string or github origin). */
  ref: string;
}

/**
 * Walk every installed utility and check whether the registry has a
 * newer version. Builtin: compare with `packages/utilities/<id>/manifest.json`.
 * GitHub: reuse the existing HEAD-sha probe in `checkGithubUpdate`.
 * Returns only the utilities that ACTUALLY need updating.
 */
export async function checkUtilityUpdatesAction(args?: {
  rootId?: string;
}): Promise<{ ok: true; updates: UpdateInfo[] } | { ok: false; error: string }> {
  try {
    const utils = await listUtilities({
      ...(args?.rootId ? { rootId: args.rootId } : {}),
    });
    const updates: UpdateInfo[] = [];
    for (const u of utils) {
      const origin = u.manifest.source?.origin ?? "";
      if (origin.startsWith("builtin:")) {
        const builtin = await checkBuiltinUpdate(
          u.manifest.id,
          u.manifest.version,
        );
        if (builtin) {
          updates.push({
            scope: u.scope,
            id: u.manifest.id,
            name: u.manifest.name,
            currentVersion: u.manifest.version,
            latestVersion: builtin.version,
            source: "builtin",
            ref: builtin.spec,
          });
        }
      } else if (origin.startsWith("github:")) {
        try {
          const { checkGithubUpdate } = await import("./github");
          const r = await checkGithubUpdate(u.scope, u.manifest.id, u.rootId);
          if (!r.upToDate && r.preview) {
            updates.push({
              scope: u.scope,
              id: u.manifest.id,
              name: u.manifest.name,
              currentVersion: u.manifest.version,
              latestVersion: r.preview.manifest.version,
              source: "github",
              ref: `github:${r.preview.source.owner}/${r.preview.source.repo}@${r.latestSha}`,
            });
          }
        } catch {
          /* offline or rate-limited — silent skip for this utility */
        }
      }
    }
    return { ok: true, updates };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkBuiltinUpdate(
  id: string,
  currentVersion: string,
): Promise<{ version: string; spec: string } | null> {
  try {
    const fsMod = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const manifestPath = pathMod.join(
      process.cwd(),
      "packages",
      "utilities",
      id,
      "manifest.json",
    );
    const raw = await fsMod.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as { id?: string; version?: string };
    if (!manifest.version || manifest.version === currentVersion) return null;
    return {
      version: manifest.version,
      spec: `builtin:${id}@${manifest.version}`,
    };
  } catch {
    return null;
  }
}

/**
 * Apply an update returned by `checkUtilityUpdatesAction`. Reinstall is
 * a file-by-file overwrite — the utility's `data/` sandbox dir survives,
 * KB entries authored by the utility survive (kept by id, not version).
 */
export async function applyUtilityUpdateAction(
  args: UpdateInfo & { rootId?: string },
): Promise<{ ok: true; newVersion: string } | { ok: false; error: string }> {
  try {
    const { withUpdateSnapshot } = await import("./transactional-update");

    // Resolve WHAT to install before the snapshot runs — it renames the
    // utility dir to `.bak` first, after which any lookup of the current
    // install (checkGithubUpdate → getUtility) would fail with "utility
    // not found". The github preview must be fetched while the dir still
    // exists.
    let applyFn: () => Promise<string>;
    if (args.source === "builtin") {
      applyFn = async () => {
        const { installFromBuiltin } = await import("./builtin-installer");
        const out = await installFromBuiltin({
          builtin: args.ref,
          scope: args.scope,
          ...(args.rootId ? { rootId: args.rootId } : {}),
        });
        return out.origin.split("@")[1] ?? args.latestVersion;
      };
    } else if (args.source === "github") {
      const { checkGithubUpdate, installFromGithubConfirmed } = await import(
        "./github"
      );
      const r = await checkGithubUpdate(args.scope, args.id, args.rootId);
      if (r.upToDate || !r.preview) {
        return { ok: true, newVersion: args.currentVersion };
      }
      const preview = r.preview;
      applyFn = async () => {
        await installFromGithubConfirmed({
          preview,
          scope: args.scope,
          ...(args.rootId ? { rootId: args.rootId } : {}),
        });
        return preview.manifest.version;
      };
    } else {
      throw new Error(`Unknown update source: ${args.source}`);
    }

    const newVersion = await withUpdateSnapshot(
      args.scope,
      args.id,
      args.rootId,
      applyFn,
    );
    revalidatePath("/utilities");
    if (args.rootId) revalidatePath(`/roots/${args.rootId}`);
    return { ok: true, newVersion };
  } catch (err) {
    // Backup has been restored by withUpdateSnapshot; surface the
    // underlying error verbatim so the user sees what actually broke.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Update rolled back — previous version restored. Error: ${truncate(msg, 600)}`,
    };
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

export async function removeUtilityAction(
  scope: UtilityScope,
  id: string,
  rootId?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await removeUtility(scope, id, rootId);
    await dropSecrets(scope, id, rootId);
    revalidatePath("/utilities");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function rebuildUtilityAction(
  scope: UtilityScope,
  id: string,
  rootId?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const util = await getUtility(scope, id, rootId);
    if (!util) return { ok: false, error: "utility not found" };
    await buildUtility(util);
    revalidatePath(`/utilities/${scope}/${id}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type CheckUpdateActionResult =
  | { ok: true; upToDate: boolean; currentSha?: string; latestSha?: string; preview?: GithubPreview }
  | { ok: false; error: string };

export async function checkUpdateAction(
  scope: UtilityScope,
  id: string,
  rootId?: string,
): Promise<CheckUpdateActionResult> {
  try {
    const res = await checkGithubUpdate(scope, id, rootId);
    return { ok: true, ...res };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readAuditAction(options?: ReadAuditOptions) {
  return readAudit(options ?? {});
}

export type McpPreviewActionResult =
  | {
      ok: true;
      serverName?: string;
      serverVersion?: string;
      tools: McpToolSpec[];
    }
  | { ok: false; error: string };

export async function mcpPreviewAction(
  rawConfig: unknown,
): Promise<McpPreviewActionResult> {
  const parsed = McpConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  try {
    const info = await connectAndListTools(parsed.data);
    return {
      ok: true,
      ...(info.name ? { serverName: info.name } : {}),
      ...(info.version ? { serverVersion: info.version } : {}),
      tools: info.tools,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface McpInstallActionArgs {
  scope: UtilityScope;
  rootId?: string;
  id: string;
  name: string;
  description?: string;
  config: McpConfig;
}

export async function mcpInstallAction(
  args: McpInstallActionArgs,
): Promise<{ ok: true; scope: UtilityScope; id: string } | { ok: false; error: string }> {
  try {
    const cfgParsed = McpConfigSchema.parse(args.config);
    const info = await connectAndListTools(cfgParsed);
    const generated = generateMcpUtility({
      id: args.id,
      name: args.name,
      description: args.description ?? info.name ?? "",
      tools: info.tools,
    });
    const manifest = ManifestSchema.parse(generated.manifest);
    const installed = await installUtility({
      scope: args.scope,
      ...(args.rootId ? { rootId: args.rootId } : {}),
      manifest,
      files: generated.files,
      source: {
        type: "mcp",
        origin: mcpOriginString(cfgParsed),
        fetchedAt: new Date().toISOString(),
        installedBy: "user",
      },
    });
    await fs.writeFile(
      path.join(installed.dir, "mcp.json"),
      JSON.stringify(cfgParsed, null, 2) + "\n",
      "utf8",
    );
    await buildUtility(installed);
    revalidatePath("/utilities");
    return { ok: true, scope: installed.scope, id: installed.manifest.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function mcpOriginString(c: McpConfig): string {
  if (c.transport === "stdio") {
    return `mcp:stdio:${c.command}${c.args.length ? " " + c.args.join(" ") : ""}`;
  }
  return `mcp:${c.transport}:${c.url}`;
}

/**
 * Spin up a fresh /goal-mode topic in the utility's home project, primed
 * with the utility's current source + a user instruction. The agent is
 * expected to emit a new `<<reflex:utility>>` marker that re-installs the
 * utility (same id → overwrite). Used by the "Edit" panel on the utility
 * detail page.
 */
export interface EditUtilityActionArgs {
  scope: UtilityScope;
  id: string;
  /** Optional override — falls back to utility's home project or first registered root. */
  rootId?: string;
  instruction: string;
}

export type EditUtilityActionResult =
  | { ok: true; rootId: string; topicId: string }
  | { ok: false; error: string };

export async function editUtilityAction(
  args: EditUtilityActionArgs,
): Promise<EditUtilityActionResult> {
  try {
    const util = await getUtility(args.scope, args.id, args.rootId);
    if (!util) return { ok: false, error: "utility not found" };
    if (!args.instruction.trim()) {
      return { ok: false, error: "instruction is empty" };
    }
    const targetRootId = await resolveHomeRootId(util, args.rootId);
    if (!targetRootId) {
      return {
        ok: false,
        error: "no project root available — register a root first",
      };
    }
    const root = await getRoot(targetRootId);
    if (!root) return { ok: false, error: "root not found" };
    const sourceFiles = await readUtilitySources(util.dir);
    const message = buildEditGoalMessage(util.manifest, util.dir, sourceFiles, args.instruction);

    const settings = await loadSettings();
    const assignment = settings.assignments.chat;
    const topic = await createTopic({
      root: root.path,
      firstMessage: `Edit: ${util.manifest.name}`,
      harness: assignment.harness,
      model: assignment.model,
      language: settings.language,
    });
    const turn = await startOrchestratorTurn({
      rootId: targetRootId,
      topicId: topic.meta.id,
      message,
    });
    if ("error" in turn) return { ok: false, error: turn.error };
    revalidatePath(`/roots/${targetRootId}`);
    return { ok: true, rootId: targetRootId, topicId: topic.meta.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function resolveHomeRootId(
  util: InstalledUtility,
  hint?: string,
): Promise<string | undefined> {
  if (util.rootId) return util.rootId;
  // Agent-installed utilities embed their home rootId in source.origin:
  // `agent:<rootId>:<topicId>:<agentId>`. Parse it out when present.
  const origin = util.manifest.source?.origin;
  if (origin?.startsWith("agent:")) {
    const parts = origin.split(":");
    if (parts.length >= 4) {
      const candidate = parts[1];
      const root = await getRoot(candidate!);
      if (root) return candidate;
    }
  }
  if (hint) {
    const r = await getRoot(hint);
    if (r) return hint;
  }
  const roots = await listRoots();
  return roots[0]?.id;
}

async function readUtilitySources(
  dir: string,
): Promise<Array<{ rel: string; content: string }>> {
  const out: Array<{ rel: string; content: string }> = [];
  const walk = async (d: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "data" || e.name === "dist" || e.name === "node_modules") continue;
      const abs = path.join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (
        /\.(tsx?|jsx?|md|json|css)$/.test(e.name) &&
        e.name !== "bundle.js" &&
        e.name !== "style.css"
      ) {
        const content = await fs.readFile(abs, "utf8");
        if (content.length < 32_000) out.push({ rel, content });
      }
    }
  };
  await walk(dir, "");
  return out;
}

function buildEditGoalMessage(
  manifest: Manifest,
  dir: string,
  files: Array<{ rel: string; content: string }>,
  instruction: string,
): string {
  const fileBlocks = files
    .map(
      (f) =>
        "### " +
        f.rel +
        "\n```" +
        languageOf(f.rel) +
        "\n" +
        f.content +
        "\n```",
    )
    .join("\n\n");
  return [
    `/goal Improve the Reflex utility "${manifest.name}" (id: ${manifest.id}).`,
    "",
    `Current utility directory on disk: \`${dir}\`.`,
    `Scope: ${manifest.source?.type ?? "agent"} -> manifest.id=${manifest.id}.`,
    "",
    "## What the user is asking",
    instruction.trim(),
    "",
    "## Current utility files",
    fileBlocks || "(no readable files)",
    "",
    "## What is required of you",
    "1. Read the files above and understand the current behaviour.",
    "2. Make the changes the user requested.",
    "3. Emit the updated utility via the `<<reflex:utility>>` marker with the same `id` and an incremented `version`. Reflex will reinstall it on top of the existing one and rebuild the bundle immediately.",
    "4. Verify the new bundle builds without errors and the UI reflects the requested change.",
    "5. When done, emit `<<reflex:kb>>{\"kind\":\"goal-completion\",...}` and the phrase `GOAL ACHIEVED` on a separate line.",
    "",
    "Imports: `react`/`react-dom`, `@host/api`, `@host/ui`, plus any npm package you declare in `manifest.dependencies` (bundled from esm.sh at build). An undeclared bare import is a build error. If the request requires something impossible — ask via `<<reflex:question>>`.",
  ].join("\n");
}

function languageOf(rel: string): string {
  if (rel.endsWith(".tsx")) return "tsx";
  if (rel.endsWith(".ts")) return "ts";
  if (rel.endsWith(".jsx")) return "jsx";
  if (rel.endsWith(".js")) return "js";
  if (rel.endsWith(".json")) return "json";
  if (rel.endsWith(".css")) return "css";
  if (rel.endsWith(".md")) return "md";
  return "";
}

export interface ListSecretsActionResult {
  ok: true;
  secrets: Array<{
    key: string;
    label: string;
    description: string;
    required: boolean;
    set: boolean;
  }>;
}

export async function listUtilitySecretsAction(args: {
  scope: UtilityScope;
  id: string;
  rootId?: string;
}): Promise<ListSecretsActionResult | { ok: false; error: string }> {
  try {
    const util = await getUtility(args.scope, args.id, args.rootId);
    if (!util) return { ok: false, error: "utility not found" };
    const declared = util.manifest.secrets ?? [];
    const filled = new Set(
      await listSecretKeys(args.scope, args.id, args.rootId),
    );
    return {
      ok: true,
      secrets: declared.map((s) => ({
        key: s.key,
        label: s.label,
        description: s.description,
        required: s.required,
        set: filled.has(s.key),
      })),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function setUtilitySecretAction(args: {
  scope: UtilityScope;
  id: string;
  rootId?: string;
  key: string;
  value: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const util = await getUtility(args.scope, args.id, args.rootId);
    if (!util) return { ok: false, error: "utility not found" };
    const declared = (util.manifest.secrets ?? []).find((s) => s.key === args.key);
    if (!declared) {
      return {
        ok: false,
        error: `secret "${args.key}" is not declared in manifest.secrets`,
      };
    }
    if (!args.value) {
      return { ok: false, error: "empty value — use delete instead" };
    }
    await setSecret(args.scope, args.id, args.key, args.value, args.rootId);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteUtilitySecretAction(args: {
  scope: UtilityScope;
  id: string;
  rootId?: string;
  key: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await deleteSecret(args.scope, args.id, args.key, args.rootId);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getManifestAction(
  scope: UtilityScope,
  id: string,
  rootId?: string,
): Promise<{ ok: boolean; manifest?: Manifest; error?: string }> {
  try {
    const u = await getUtility(scope, id, rootId);
    if (!u) return { ok: false, error: "utility not found" };
    return { ok: true, manifest: u.manifest };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
