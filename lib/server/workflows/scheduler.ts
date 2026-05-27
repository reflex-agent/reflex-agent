import "server-only";
import { listRoots, type RegistryEntry } from "@/lib/registry";
import { listWorkflows, listRuns } from "./store";
import { runWorkflow } from "./runner";
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

// Tracked across the whole process so HMR doesn't double-boot.
declare global {
  // eslint-disable-next-line no-var
  var __reflexWorkflowScheduler: SchedulerHandle | undefined;
}

interface SchedulerHandle {
  timer: ReturnType<typeof setInterval>;
  running: boolean;
  /** Per (rootId, workflowId) — wall clock of the last attempt the
   *  scheduler dispatched, regardless of run success. Falls back to the
   *  on-disk runs/<wfId>/*.json mtime when this in-memory map is cold. */
  lastFired: Map<string, number>;
}

function key(rootId: string, workflowId: string): string {
  return `${rootId}::${workflowId}`;
}

export function startScheduler(): void {
  if (globalThis.__reflexWorkflowScheduler) return;
  const handle: SchedulerHandle = {
    running: false,
    lastFired: new Map(),
    timer: setInterval(() => {
      void tick(handle);
    }, TICK_INTERVAL_MS),
  };
  // Fire once shortly after boot so the user doesn't wait a full minute
  // for the first pass on a freshly-started Reflex.
  setTimeout(() => void tick(handle), 5_000).unref?.();
  // Don't keep the Node process alive solely for this — when the server
  // shuts down the timer goes with it.
  handle.timer.unref?.();
  globalThis.__reflexWorkflowScheduler = handle;
}

export function stopScheduler(): void {
  const handle = globalThis.__reflexWorkflowScheduler;
  if (!handle) return;
  clearInterval(handle.timer);
  globalThis.__reflexWorkflowScheduler = undefined;
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
  } finally {
    handle.running = false;
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
