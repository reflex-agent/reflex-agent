"use server";

import { listSkills } from "@/lib/server/skills";
import { listUtilities } from "@/lib/server/utilities/store";
import { getRoot } from "@/lib/registry";

/**
 * Inline-arg suggestions for slash commands. After the user types
 * `/cmd <space>`, the chat input asks for items matching the partial
 * payload. Returns `{ ok: false, supported: false }` when the command
 * has no provider (UI then leaves the user typing freeform).
 */

export interface ArgItem {
  value: string;
  label: string;
  description?: string;
}

export type ArgProviderResult =
  | { ok: true; supported: true; items: ArgItem[] }
  | { ok: true; supported: false }
  | { ok: false; error: string };

export async function listCommandArgsAction(args: {
  commandId: string;
  query: string;
  rootId?: string;
}): Promise<ArgProviderResult> {
  try {
    const q = (args.query ?? "").trim().toLowerCase();
    switch (args.commandId) {
      case "skill": {
        const root = args.rootId ? await getRoot(args.rootId) : null;
        const skills = await listSkills(root?.path);
        const items = skills
          .map((s) => ({
            value: s.id,
            label: s.title,
            description: `${s.scope === "project" ? "[project] " : s.scope === "global" ? "[global] " : ""}${s.description}`,
          }))
          .filter((it) => matches(it, q));
        return { ok: true, supported: true, items };
      }
      case "util": {
        const utils = await listUtilities(
          args.rootId ? { rootId: args.rootId } : {},
        );
        const items = utils.map((u) => ({
          value: u.manifest.id,
          label: u.manifest.name,
          description: u.manifest.description,
        }));
        return {
          ok: true,
          supported: true,
          items: items.filter((it) => matches(it, q)),
        };
      }
      default:
        return { ok: true, supported: false };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function matches(item: ArgItem, q: string): boolean {
  if (!q) return true;
  return (
    item.value.toLowerCase().includes(q) ||
    item.label.toLowerCase().includes(q) ||
    (item.description?.toLowerCase().includes(q) ?? false)
  );
}
