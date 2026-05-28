/**
 * Next.js server instrumentation hook. Next calls `register()` once on server
 * startup, before any request is handled — the deterministic boot path for
 * background workers, versus the `app/layout.tsx` render side-effect which only
 * fires on the first browser request (so a Telegram-only user who never opens
 * the web UI would otherwise get a server with no poller).
 *
 * IMPORTANT — runtime guard shape: Next compiles this file for BOTH the nodejs
 * and edge runtimes. The boot graph reaches the agent runtime → execa →
 * cross-spawn → node builtins (child_process/fs/path), which the edge runtime
 * cannot resolve. The POSITIVE `=== "nodejs"` block lets webpack constant-fold
 * `process.env.NEXT_RUNTIME` and dead-code-eliminate the dynamic import out of
 * the edge build entirely. An early `!== "nodejs"` return does NOT get DCE'd
 * and pulls node builtins into the edge bundle (build failure).
 *
 * Phase 0: additive + idempotent. Until this hook is proven to fire under
 * `reflex start`'s programmatic `createServer` + `next()` AND soaked, the
 * layout.tsx boot and the `warmup` self-ping in commands/start.ts stay.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootWorkers } = await import("./lib/server/instrumentation");
    await bootWorkers();
  }
}
