"use server";

import { promises as fs } from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { getRoot } from "@/lib/registry";
import { reflexRoot } from "@/lib/reflex/paths";
import { writeKbEntry } from "./agents/kb-writer";
import { listTopics } from "./topics";
import { deleteTopicAction } from "./topic-actions";
import { agentManager } from "./agents/manager";
import { listSkills, type SkillMeta } from "./skills";
import { COMMANDS, type CommandDef } from "./agents/commands-registry";

/**
 * Server-side handlers for "direct" slash commands — the ones that don't
 * round-trip through an agent. The client form intercepts these before
 * calling the chat /send endpoint and routes here.
 */

export type CommandResult =
  | { ok: true; message?: string; redirectTo?: string }
  | { ok: false; error: string };

/**
 * `/remember <text>` — turn the message body into a quick KB note. We use
 * a generic kind="note"; the orchestrator's KB curator can re-classify
 * later. Empty text → error (the palette should prevent submission anyway).
 */
export async function rememberAction(
  rootId: string,
  text: string,
): Promise<CommandResult> {
  try {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "Empty — nothing to remember." };
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const firstLine = trimmed.split(/\r?\n/, 1)[0]!.trim();
    const title =
      firstLine.length > 80 ? firstLine.slice(0, 77).trimEnd() + "…" : firstLine;
    const result = await writeKbEntry({
      rootPath: entry.path,
      directive: {
        kind: "note",
        title,
        body: trimmed,
      },
    });
    revalidatePath(`/roots/${rootId}`);
    return {
      ok: true,
      message: `Saved to ${result.relPath}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * `/delete-topic` — delete the current topic. Caller passes topicId from
 * the chat URL. Wraps existing deleteTopicAction (which stops agents,
 * unlinks .md + .events.jsonl, revalidates).
 */
export async function deleteCurrentTopicCommand(
  rootId: string,
  topicId: string,
): Promise<CommandResult> {
  const r = await deleteTopicAction(rootId, topicId);
  if (!r.ok) return { ok: false, error: r.error ?? "Failed" };
  return { ok: true, redirectTo: `/roots/${rootId}`, message: "Topic deleted" };
}

/**
 * `/clear-project` — wipe everything inside `<root>/.reflex/`:
 *   - all topics (.md + .events.jsonl)
 *   - all widgets + layout
 *   - all KB markdown files
 *
 * The root registry entry itself is preserved (the project stays in the
 * sidebar, just empty). UI calls this only after the user passed a
 * double-confirm with a typed phrase.
 *
 * IMPLEMENTATION: walks `.reflex/`, removes every `.md` and `.events.jsonl`
 * and the topics/widgets folders + dashboard-layout.json. We do NOT
 * `rm -rf .reflex` because user might have manually placed files (like
 * git-ignored config). Conservative cleanup.
 */
export async function clearProjectAction(
  rootId: string,
): Promise<CommandResult> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const scope = reflexRoot(entry.path);

    // Stop every running agent on every topic so nothing recreates the
    // event log while we're deleting.
    const topics = await listTopics(entry.path);
    for (const t of topics) {
      await agentManager.stopTopic(t.meta.id).catch(() => undefined);
    }

    // Wipe widgets + layout (whole folder + the layout file are owned
    // by Reflex).
    await rmIfExists(path.join(scope, "widgets"));
    await rmIfExists(path.join(scope, "dashboard-layout.json"));
    await rmIfExists(path.join(scope, "topics"));

    // Wipe markdown files at every depth. Skip directories we don't
    // recognise (user's manual data, like a `notes/` folder).
    await wipeMarkdown(scope);

    revalidatePath(`/roots/${rootId}`);
    return {
      ok: true,
      redirectTo: `/roots/${rootId}`,
      message: "Project cleared. Starting fresh.",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function rmIfExists(p: string): Promise<void> {
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
}

async function wipeMarkdown(dir: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      await wipeMarkdown(abs);
      // Best-effort: clean up now-empty dirs.
      try {
        const left = await fs.readdir(abs);
        if (left.length === 0) await fs.rmdir(abs);
      } catch {
        /* nope */
      }
      continue;
    }
    if (e.name.toLowerCase().endsWith(".md")) {
      await fs.unlink(abs).catch(() => undefined);
    }
  }
}

/**
 * `/help` — return a metadata list of all commands. UI renders it as a
 * popover. Skills appear separately under their own section.
 */
export async function helpAction(): Promise<{
  ok: true;
  commands: CommandDef[];
  skills: SkillMeta[];
}> {
  const skills = await listSkills();
  return { ok: true, commands: COMMANDS, skills };
}

/**
 * Slash-palette feed for the chat input. Returns built-in commands
 * plus every command declared by utilities installed in this Space
 * (via `manifest.extensions.slashCommands`). Built-ins always win on
 * trigger collision.
 */
export async function listAvailableSlashCommandsAction(args: {
  rootId?: string;
}): Promise<{ ok: true; commands: CommandDef[] }> {
  const { collectExtensions } = await import("./utilities/extensions");
  const ext = await collectExtensions(
    args.rootId ? { rootId: args.rootId } : {},
  );
  const utilityCommands: CommandDef[] = ext.slashCommands.map((c) => ({
    id: `${c.utility.utilityId}:${c.id}`,
    trigger: c.trigger,
    label: c.label,
    description: c.description,
    kind: c.kind,
    usage: c.usage,
    allowEmpty: c.allowEmpty,
    icon: c.icon,
  }));
  const triggers = new Set(COMMANDS.map((c) => c.trigger));
  const merged = [
    ...COMMANDS,
    ...utilityCommands.filter((c) => !triggers.has(c.trigger)),
  ];
  return { ok: true, commands: merged };
}

/**
 * `/util [fuzzy]` — open an installed utility. Looks across global + the
 * current project. Matching strategy: exact id wins; otherwise
 * case-insensitive substring on id OR name. Single match returns a
 * deep-link; multiple matches return a candidate list for the UI to
 * render as a picker. Empty fuzzy → full list.
 */
export type OpenUtilityResult =
  | { ok: true; kind: "redirect"; url: string }
  | {
      ok: true;
      kind: "choices";
      items: Array<{
        url: string;
        id: string;
        name: string;
        scope: "global" | "project";
      }>;
    }
  | { ok: false; error: string };

export async function openUtilityAction(
  rootId: string,
  fuzzy: string,
): Promise<OpenUtilityResult> {
  const { listUtilities } = await import("./utilities/store");
  const utils = await listUtilities({ rootId });
  const trimmed = fuzzy.trim().toLowerCase();
  const items = utils.map((u) => ({
    id: u.manifest.id,
    name: u.manifest.name,
    scope: u.scope,
    rootId: u.rootId,
  }));
  const toUrl = (u: (typeof items)[number]): string => {
    const qs = u.rootId ? `?rootId=${encodeURIComponent(u.rootId)}` : "";
    return `/utilities/${u.scope}/${u.id}${qs}`;
  };
  if (!trimmed) {
    if (items.length === 0) {
      return { ok: false, error: "No mini-apps installed yet." };
    }
    return {
      ok: true,
      kind: "choices",
      items: items.map((u) => ({
        url: toUrl(u),
        id: u.id,
        name: u.name,
        scope: u.scope,
      })),
    };
  }
  const exact = items.find((u) => u.id.toLowerCase() === trimmed);
  if (exact) return { ok: true, kind: "redirect", url: toUrl(exact) };
  const matches = items.filter(
    (u) =>
      u.id.toLowerCase().includes(trimmed) ||
      u.name.toLowerCase().includes(trimmed),
  );
  if (matches.length === 1)
    return { ok: true, kind: "redirect", url: toUrl(matches[0]!) };
  if (matches.length === 0) {
    return {
      ok: false,
      error: `Nothing found for "${fuzzy}". Installed: ${items.length}.`,
    };
  }
  return {
    ok: true,
    kind: "choices",
    items: matches.map((u) => ({
      url: toUrl(u),
      id: u.id,
      name: u.name,
      scope: u.scope,
    })),
  };
}
