import "server-only";
import { listRoots, type RegistryEntry } from "@/lib/registry";
import { listWorkflows, listRuns } from "./store";
import { runWorkflow } from "./runner";
import { SYSTEM_TASKS, SYSTEM_TASK_INTERVAL_MS } from "./system-tasks";
import { backgroundRuntime } from "@/lib/server/runtime/background-runtime";
import type { WorkflowDef, WorkflowTrigger } from "./types";

/**
 * Durable background scheduler.
 *
 * Lives as a singleton on the Reflex server process. Wakes once a
 * minute; for every workflow whose `trigger` is hourly/daily/weekly,
 * checks the latest run record. If enough time has elapsed since the
 * last completed run (or no run exists at all), fires the workflow.
 *
 * Runs scoped per project — `listRoots()` enumerates registered Spaces,
 * we walk each. Failures inside one workflow never block the rest.
 *
 * Boots lazily on the first import. Stops cleanly on `process.exit`.
 */

const TICK_INTERVAL_MS = 60_000; // every minute
// Map a trigger word to the interval (ms) the scheduler waits between runs.
// `manual` workflows are never fired by this loop — they only run when
// the user (or another piece of code) explicitly calls `runWorkflow`.
const INTERVAL_MS: Record<WorkflowTrigger, number | null> = {
  manual: null,
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

interface SchedulerHandle {
  running: boolean;
  /** Per (rootId, workflowId) — wall clock of the last attempt the
   *  scheduler dispatched, regardless of run success. Falls back to the
   *  on-disk runs/<wfId>/*.json mtime when this in-memory map is cold. */
  lastFired: Map<string, number>;
}

function key(rootId: string, workflowId: string): string {
  return `${rootId}::${workflowId}`;
}

export const WORKFLOW_JOB_ID = "workflow-scheduler";

/**
 * Register the workflow / system-task / dispatcher-compaction pass on the
 * shared BackgroundRuntime (Phase 5 — one loop for all periodic work).
 * Idempotent. The runtime owns the timer + overlap guard; the per-(root,
 * workflow) `lastFired` cadence map lives on a module handle so individual
 * trigger intervals (hourly/daily/weekly) are preserved.
 */
export function startScheduler(): void {
  const rt = backgroundRuntime();
  if (rt.has(WORKFLOW_JOB_ID)) return;
  const handle: SchedulerHandle = { running: false, lastFired: new Map() };
  rt.register({
    id: WORKFLOW_JOB_ID,
    intervalMs: TICK_INTERVAL_MS,
    run: () => tick(handle),
  });
}

async function tick(handle: SchedulerHandle): Promise<void> {
  if (handle.running) return; // overlap-guard — long workflow doesn't queue ticks
  handle.running = true;
  try {
    const roots = await listRoots().catch(() => [] as RegistryEntry[]);
    for (const root of roots) {
      try {
        await processRoot(handle, root);
      } catch (err) {
        console.error(
          `[scheduler] root ${root.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await processSystemTasks(handle);
    // Fold the idle dispatcher thread into its rolling summary. Self-gates
    // on idle time + already-compacted, so running every tick is cheap.
    try {
      const { compactDispatcherIfIdle } = await import(
        "@/lib/server/home/dispatcher"
      );
      await compactDispatcherIfIdle();
    } catch (err) {
      console.error(
        `[scheduler] dispatcher compaction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } finally {
    handle.running = false;
  }
}

async function processSystemTasks(handle: SchedulerHandle): Promise<void> {
  for (const task of SYSTEM_TASKS) {
    const interval = SYSTEM_TASK_INTERVAL_MS[task.trigger];
    if (!interval) continue;
    const k = `__system__::${task.id}`;
    const last = handle.lastFired.get(k) ?? null;
    if (last !== null && Date.now() - last < interval) continue;
    handle.lastFired.set(k, Date.now());
    try {
      const res = await task.run();
      if (!res.ok && res.detail) {
        console.warn(`[scheduler] ${task.id} returned non-ok: ${res.detail}`);
      }
    } catch (err) {
      console.error(
        `[scheduler] ${task.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function processRoot(
  handle: SchedulerHandle,
  root: RegistryEntry,
): Promise<void> {
  // Combine project-stored workflows with utility-provided ones (lazy
  // import to avoid a hard dep when the scheduler is the only consumer
  // — and to keep build-time graph small).
  const projectWorkflows = await listWorkflows(root.path).catch(() => []);
  const utilityWorkflows = await loadUtilityWorkflows(root.id);
  const workflows = mergeWorkflows(projectWorkflows, utilityWorkflows);

  for (const wf of workflows) {
    const interval = INTERVAL_MS[wf.trigger];
    if (!interval) continue;
    if (wf.enabled === false) continue;
    const k = key(root.id, wf.id);
    const last = handle.lastFired.get(k) ?? (await diskLastRun(root.path, wf.id));
    if (last !== null && Date.now() - last < interval) continue;

    // Mark the attempt BEFORE running so a slow workflow doesn't trigger
    // a duplicate on the next tick.
    handle.lastFired.set(k, Date.now());
    try {
      await runWorkflow(root.id, wf.id);
    } catch (err) {
      console.error(
        `[scheduler] ${root.id}/${wf.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function diskLastRun(
  rootPath: string,
  workflowId: string,
): Promise<number | null> {
  const runs = await listRuns(rootPath, workflowId, 1).catch(() => []);
  if (runs.length === 0) return null;
  const t = Date.parse(runs[0]!.startedAt);
  return Number.isFinite(t) ? t : null;
}

async function loadUtilityWorkflows(rootId: string): Promise<WorkflowDef[]> {
  try {
    const { collectExtensions } = await import("../utilities/extensions");
    const ext = await collectExtensions({ rootId });
    return ext.workflows ?? [];
  } catch {
    return [];
  }
}

function mergeWorkflows(
  project: WorkflowDef[],
  utility: WorkflowDef[],
): WorkflowDef[] {
  // Project workflows override utility-provided ones on id collision —
  // user explicitly authored their own copy.
  const seen = new Set(project.map((w) => w.id));
  return [...project, ...utility.filter((w) => !seen.has(w.id))];
}
