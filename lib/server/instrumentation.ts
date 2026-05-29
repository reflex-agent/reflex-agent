import "server-only";

/**
 * Boot the background workers once at server startup. Lazy-imported from the
 * root `instrumentation.ts` hook so the worker modules never enter the client/
 * edge bundle graph, and so they boot exactly ONCE in the single API-serving
 * process (not per `next dev` render-worker).
 *
 * The periodic jobs (workflow + system-tasks + dispatcher-compaction, and
 * widget-refresh) register on the shared BackgroundRuntime; we then start its
 * single ticking loop and fire one immediate tick so the first pass runs at
 * boot rather than after a full interval. The Telegram poller runs its own
 * long-poll loop (not interval-based) and stays separate.
 */
export async function bootWorkers(): Promise<void> {
  const { startScheduler } = await import("@/lib/server/workflows/scheduler");
  const { startWidgetScheduler } = await import(
    "@/lib/server/widgets/scheduler"
  );
  const { startTelegramPoller } = await import("@/lib/server/notify/telegram");
  const { backgroundRuntime } = await import(
    "@/lib/server/runtime/background-runtime"
  );

  startScheduler(); // registers the workflow job
  startWidgetScheduler(); // registers the widget-refresh job

  const rt = backgroundRuntime();
  rt.start(60_000); // one loop drives all registered jobs
  void rt.tickOnce(Date.now()); // immediate first pass (widget job is seeded, so it waits)

  startTelegramPoller();
  console.log("[instrumentation] background workers booted at startup");
}
