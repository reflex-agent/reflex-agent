"use server";

import { revalidatePath } from "next/cache";
import { getRoot } from "@/lib/registry";
import {
  deleteWorkflow,
  listRuns,
  listWorkflows,
  readWorkflow,
  writeWorkflow,
} from "./store";
import { runWorkflow, validateWorkflowDef } from "./runner";
import type {
  WorkflowDef,
  WorkflowRun,
  WorkflowStep,
} from "./types";

/**
 * Client-callable wrappers for the workflows surface. Editor uses these
 * for save/run/delete; the chat-driven create path goes through the
 * `<<reflex:workflow-create>>` directive instead, so this file doesn't
 * own a "create" entry point — only updates.
 */

export type WorkflowListResult =
  | { ok: true; workflows: WorkflowDef[] }
  | { ok: false; error: string };

export async function listWorkflowsAction(
  rootId: string,
): Promise<WorkflowListResult> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const projectWorkflows = await listWorkflows(entry.path);
    const { collectExtensions } = await import(
      "@/lib/server/utilities/extensions"
    );
    const ext = await collectExtensions({ rootId });
    const seen = new Set(projectWorkflows.map((w) => w.id));
    const merged = [
      ...projectWorkflows,
      ...ext.workflows.filter((w) => !seen.has(w.id)),
    ];
    return { ok: true, workflows: merged };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readWorkflowAction(
  rootId: string,
  wfId: string,
): Promise<{ ok: true; workflow: WorkflowDef } | { ok: false; error: string }> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const wf = await readWorkflow(entry.path, wfId);
    if (!wf) return { ok: false, error: "Not found" };
    return { ok: true, workflow: wf };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Save a workflow def edited by the user. Stamps `updatedAt`; preserves
 * `createdAt` if the workflow already exists. Steps are validated before
 * write — invalid ones fail loudly so the editor can show the error
 * inline.
 */
export async function saveWorkflowAction(
  rootId: string,
  wf: WorkflowDef,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const existing = await readWorkflow(entry.path, wf.id);
    const merged: WorkflowDef = {
      ...wf,
      createdAt: existing?.createdAt ?? wf.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const err = validateWorkflowDef(merged);
    if (err) return { ok: false, error: err };
    await writeWorkflow(entry.path, merged);
    revalidatePath(`/roots/${rootId}/workflows`);
    revalidatePath(`/roots/${rootId}/workflows/${wf.id}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Toggle a workflow's scheduler-enabled flag. Project-stored workflows
 * persist the change; utility-provided workflows are read-only so the
 * UI surfaces a friendlier error in that case.
 */
export async function setWorkflowEnabledAction(
  rootId: string,
  wfId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const wf = await readWorkflow(entry.path, wfId);
    if (!wf) {
      return {
        ok: false,
        error:
          "Workflow lives in a utility manifest — uninstall or fork it to disable.",
      };
    }
    await writeWorkflow(entry.path, {
      ...wf,
      enabled,
      updatedAt: new Date().toISOString(),
    });
    revalidatePath(`/roots/${rootId}/workflows`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteWorkflowAction(
  rootId: string,
  wfId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    await deleteWorkflow(entry.path, wfId);
    revalidatePath(`/roots/${rootId}/workflows`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Manual trigger. Fires the workflow, blocks until the run completes
 * (or fails), then returns the run record. UI polls the runs list for
 * live status if it wants to show progress mid-flight.
 */
export async function runWorkflowAction(
  rootId: string,
  wfId: string,
  initialInput?: unknown,
): Promise<{ ok: true; run: WorkflowRun } | { ok: false; error: string }> {
  return runWorkflow(rootId, wfId, initialInput);
}

export async function listRunsAction(
  rootId: string,
  wfId: string,
): Promise<{ ok: true; runs: WorkflowRun[] } | { ok: false; error: string }> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const runs = await listRuns(entry.path, wfId);
    return { ok: true, runs };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reorder a single step within a workflow. Convenience for the editor
 * up/down arrows so it doesn't have to ship the whole def every click.
 */
export async function moveWorkflowStepAction(
  rootId: string,
  wfId: string,
  stepId: string,
  direction: "up" | "down",
): Promise<{ ok: boolean; error?: string }> {
  try {
    const entry = await getRoot(rootId);
    if (!entry) return { ok: false, error: "Root not found" };
    const wf = await readWorkflow(entry.path, wfId);
    if (!wf) return { ok: false, error: "Not found" };
    const idx = wf.steps.findIndex((s: WorkflowStep) => s.id === stepId);
    if (idx < 0) return { ok: false, error: "Step not found" };
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= wf.steps.length) return { ok: true };
    const next = [...wf.steps];
    const a = next[idx]!;
    const b = next[target]!;
    next[idx] = b;
    next[target] = a;
    wf.steps = next;
    wf.updatedAt = new Date().toISOString();
    await writeWorkflow(entry.path, wf);
    revalidatePath(`/roots/${rootId}/workflows/${wfId}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
