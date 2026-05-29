import "server-only";

/**
 * BackgroundRuntime (north-star Phase 5) — one registry + one ticking loop for
 * every periodic job. Today there are three near-identical loops (the workflow
 * scheduler, the widget-refresh scheduler, dispatcher compaction) each with
 * their own setInterval, overlap-guard, and listRoots() walk; they collapse
 * onto this. Jobs register `{ id, intervalMs, run }`; one timer fires due jobs.
 *
 * The tick logic is `tickOnce(now)` — pure of timers and injectable, so the
 * cadence is unit-testable without real time. last-run is in-memory but
 * `seedLastRun` lets a caller prime it from disk so a cold start respects
 * intervals (no thundering herd of "everything fires at boot").
 */
export interface BackgroundJob {
  id: string;
  intervalMs: number;
  run(): Promise<void> | void;
}

export class BackgroundRuntime {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly lastRun = new Map<string, number>();
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  register(job: BackgroundJob): void {
    if (this.jobs.has(job.id)) {
      throw new Error(`background job already registered: ${job.id}`);
    }
    this.jobs.set(job.id, job);
  }

  /** Prime a job's last-run (e.g. from on-disk run history) so a fresh process
   *  doesn't immediately re-fire a job that ran recently before restart. */
  seedLastRun(id: string, at: number): void {
    this.lastRun.set(id, at);
  }

  jobIds(): string[] {
    return [...this.jobs.keys()].sort();
  }

  /**
   * Run every job whose interval has elapsed as of `now`. Overlap-guarded: if a
   * previous tick is still in flight this returns immediately (a long job never
   * stacks ticks). A job that throws is logged and never blocks the others;
   * its last-run is still advanced (mark-before-run) so a persistently-failing
   * job can't busy-loop.
   */
  async tickOnce(now: number): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const job of this.jobs.values()) {
        const last = this.lastRun.get(job.id);
        if (last !== undefined && now - last < job.intervalMs) continue;
        this.lastRun.set(job.id, now);
        try {
          await job.run();
        } catch (err) {
          console.error(
            `[background-runtime] job ${job.id} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Start the ticking loop (idempotent). `.unref()`'d so it never holds the
   *  process open. */
  start(tickMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tickOnce(Date.now());
    }, tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __reflexBackgroundRuntime: BackgroundRuntime | undefined;
}

export function backgroundRuntime(): BackgroundRuntime {
  return (globalThis.__reflexBackgroundRuntime ??= new BackgroundRuntime());
}
