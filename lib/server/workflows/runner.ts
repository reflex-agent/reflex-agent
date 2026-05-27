import "server-only";
import crypto from "node:crypto";
import { getRoot } from "@/lib/registry";
import { pruneRuns, readWorkflow, writeRun } from "./store";
import { validateStepInput } from "./input-schemas";
import { renderParams } from "./template";
import { NODE_HANDLERS, type NodeContext } from "./nodes";
import type {
  StepRunResult,
  WorkflowDef,
  WorkflowRun,
} from "./types";

/**
 * Execute a workflow end-to-end. Returns the persisted run record (also
 * written to disk on every step boundary so the UI can poll for status).
 *
 * Sequential by design — no parallel branches, no conditional skipping
 * for v1. If a step fails, the run halts and is marked `failed`; later
 * steps stay `pending`. Run history pruning keeps the last 50 runs per
 * workflow.
 */
export async function runWorkflow(
  rootId: string,
  workflowId: string,
  initialInput?: unknown,
): Promise<{ ok: true; run: WorkflowRun } | { ok: false; error: string }> {
  const entry = await getRoot(rootId);
  if (!entry) return { ok: false, error: "Root not found" };
  // Project-stored workflows win; otherwise consult utility extensions
  // so a utility-provided workflow can be runWorkflow'd by id.
  let wf = await readWorkflow(entry.path, workflowId);
  if (!wf) {
    const { collectExtensions } = await import(
      "@/lib/server/utilities/extensions"
    );
    const ext = await collectExtensions({ rootId });
    wf = ext.workflows.find((w) => w.id === workflowId) ?? null;
  }
  if (!wf) return { ok: false, error: "Workflow not found" };

  const run: WorkflowRun = {
    id: newRunId(),
    workflowId: wf.id,
    workflowLabel: wf.label,
    status: "running",
    startedAt: new Date().toISOString(),
    steps: wf.steps.map((s) => ({ stepId: s.id, status: "pending" })),
    ...(initialInput !== undefined ? { initialInput } : {}),
  };
  await writeRun(entry.path, run);

  const stepOutputs: Record<string, { output: unknown }> = {};
  let prevOutput: unknown = initialInput;

  const ctx: NodeContext = {
    rootId,
    rootPath: entry.path,
    workflow: { id: wf.id, label: wf.label },
  };

  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i]!;
    const stepRun = run.steps[i]!;
    stepRun.status = "running";
    stepRun.startedAt = new Date().toISOString();
    await writeRun(entry.path, run);

    try {
      const handler = NODE_HANDLERS[step.kind];
      if (!handler) {
        throw new Error(`Unknown node kind: ${step.kind}`);
      }
      const rendered = renderParams(step.params, {
        prev: prevOutput,
        steps: stepOutputs,
        input: initialInput,
        workflow: { id: wf.id, label: wf.label },
      });
      // Validate + coerce per-kind. Throws on shape mismatch — caught by
      // the surrounding try and marks the step `failed` with a clear msg.
      const validated = validateStepInput(step.kind, rendered);
      stepRun.renderedParams = validated;
      const output = await handler(validated, ctx);
      stepRun.output = output;
      stepRun.status = "completed";
      stepRun.finishedAt = new Date().toISOString();
      stepOutputs[step.id] = { output };
      prevOutput = output;
    } catch (err) {
      stepRun.status = "failed";
      stepRun.error = err instanceof Error ? err.message : String(err);
      stepRun.finishedAt = new Date().toISOString();
      run.status = "failed";
      run.finishedAt = new Date().toISOString();
      await writeRun(entry.path, run);
      void pruneRuns(entry.path, wf.id);
      return { ok: true, run };
    }
    await writeRun(entry.path, run);
  }

  run.status = "completed";
  run.finishedAt = new Date().toISOString();
  await writeRun(entry.path, run);
  void pruneRuns(entry.path, wf.id);
  return { ok: true, run };
}

/**
 * Validate a workflow def before saving. Mostly catches obvious schema
 * mistakes from agent-emitted directives — the editor UI guards the
 * happy path.
 */
export function validateWorkflowDef(wf: WorkflowDef): string | null {
  if (!wf.id || typeof wf.id !== "string") return "id is required";
  if (!wf.label || typeof wf.label !== "string") return "label is required";
  if (!Array.isArray(wf.steps) || wf.steps.length === 0) {
    return "steps[] cannot be empty";
  }
  const ids = new Set<string>();
  for (const s of wf.steps) {
    if (!s.id) return "every step must have an id";
    if (ids.has(s.id)) return `Duplicate step id: ${s.id}`;
    ids.add(s.id);
    if (!NODE_HANDLERS[s.kind]) {
      return `Unknown step kind: ${s.kind}`;
    }
  }
  return null;
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = crypto.randomBytes(3).toString("hex");
  return `${stamp}-${rand}`;
}
