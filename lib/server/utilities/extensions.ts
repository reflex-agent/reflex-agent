import "server-only";
import { listUtilities } from "./store";
import type { Manifest } from "./types";
import type { WorkflowDef } from "@/lib/server/workflows/types";

/**
 * Aggregator over every installed utility's `manifest.extensions` in a
 * given Space — used by:
 *   - chatSystemPrompt → concat all `systemPromptAddendum` blocks
 *   - commands-registry → expose utility-declared slash commands
 *   - skills → expose utility-declared skills (loadSkill / listSkills)
 *
 * Cached for the lifetime of one request: utilities don't change
 * mid-turn, and listUtilities can be mildly expensive on a project with
 * many installs.
 */

export interface UtilityRef {
  utilityId: string;
  scope: "global" | "project";
}

type ManifestExtensions = NonNullable<Manifest["extensions"]>;
type ManifestSlashCommand = ManifestExtensions["slashCommands"][number];
type ManifestSkill = ManifestExtensions["skills"][number];

export type UtilitySlashCommand = ManifestSlashCommand & {
  utility: UtilityRef;
};

export type UtilitySkill = ManifestSkill & {
  utility: UtilityRef;
};

export interface UtilityPromptBlock {
  utility: UtilityRef;
  content: string;
}

export interface UtilityExtensions {
  slashCommands: UtilitySlashCommand[];
  skills: UtilitySkill[];
  promptBlocks: UtilityPromptBlock[];
  /** Workflows pulled from `manifest.extensions.workflows`, materialised
   *  with `createdAt`/`updatedAt` set to the install time. The scheduler
   *  and runner consume these the same way as project-stored workflows. */
  workflows: WorkflowDef[];
}

/**
 * Collect extensions from every utility installed at either:
 *   - this project's scope (rootId param), or
 *   - global scope (no rootId).
 *
 * Pass rootId when assembling chat context; both project + global
 * utilities apply.
 */
export async function collectExtensions(args: {
  rootId?: string;
}): Promise<UtilityExtensions> {
  const utils = await listUtilities(
    args.rootId ? { rootId: args.rootId } : {},
  ).catch(() => []);
  const slashCommands: UtilitySlashCommand[] = [];
  const skills: UtilitySkill[] = [];
  const promptBlocks: UtilityPromptBlock[] = [];
  const workflows: WorkflowDef[] = [];
  for (const u of utils) {
    const ext = u.manifest.extensions;
    if (!ext) continue;
    const ref: UtilityRef = {
      utilityId: u.manifest.id,
      scope: u.scope,
    };
    for (const cmd of ext.slashCommands ?? []) {
      slashCommands.push({ ...cmd, utility: ref });
    }
    for (const sk of ext.skills ?? []) {
      skills.push({ ...sk, utility: ref });
    }
    if (ext.systemPromptAddendum && ext.systemPromptAddendum.trim()) {
      promptBlocks.push({ utility: ref, content: ext.systemPromptAddendum });
    }
    const stamp = new Date().toISOString();
    for (const wf of ext.workflows ?? []) {
      workflows.push({
        id: wf.id,
        label: wf.label,
        ...(wf.description ? { description: wf.description } : {}),
        trigger: wf.trigger,
        steps: wf.steps.map((s) => ({
          id: s.id,
          kind: s.kind as WorkflowDef["steps"][number]["kind"],
          label: s.label,
          params: s.params,
        })),
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
  }
  return { slashCommands, skills, promptBlocks, workflows };
}
