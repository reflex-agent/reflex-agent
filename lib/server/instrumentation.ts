import "server-only";

/**
 * Boot the background workers (workflow scheduler + Telegram poller) once at
 * server startup. Lazy-imported from the root `instrumentation.ts` hook so the
 * worker modules never enter the client/edge bundle graph.
 *
 * Both boot fns are idempotent — guarded by `globalThis.__reflex*` singletons —
 * so this co-exists safely with the `app/layout.tsx` render-time boot. During
 * Phase 0 both paths run; the layout side-effect is removed only once the
 * instrumentation hook is proven to fire under `reflex start`'s programmatic
 * custom server (the GO/NO-GO spike).
 */
export async function bootWorkers(): Promise<void> {
  const { startScheduler } = await import("@/lib/server/workflows/scheduler");
  const { startTelegramPoller } = await import("@/lib/server/notify/telegram");
  startScheduler();
  startTelegramPoller();
  console.log("[instrumentation] background workers booted at startup");
}
