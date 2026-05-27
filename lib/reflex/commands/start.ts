import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

interface StartOptions {
  port: number;
  host: string;
  open: boolean;
}

export async function runStart(opts: StartOptions): Promise<void> {
  const pkgRoot = await findPackageRoot();
  await assertBuilt(pkgRoot);

  // Lazy-import to avoid pulling Next into CLI-only commands.
  const nextMod = (await import("next")) as unknown as {
    default: (opts: { dev: boolean; dir: string }) => {
      prepare(): Promise<void>;
      getRequestHandler(): (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
      ) => Promise<void>;
    };
  };
  const app = nextMod.default({ dev: false, dir: pkgRoot });
  await app.prepare();
  const handler = app.getRequestHandler();

  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const url = `http://${displayHost(opts.host)}:${opts.port}`;
      process.stdout.write(`Reflex running at ${url}\n`);
      if (opts.open) openBrowser(url);
    });
    const shutdown = (signal: NodeJS.Signals) => {
      process.stdout.write(`\n[reflex] ${signal} received, stopping…\n`);
      server.close(() => resolve());
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function findPackageRoot(): Promise<string> {
  // dist/lib/reflex/commands/start.js → repo root is 4 levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..");
}

async function assertBuilt(pkgRoot: string): Promise<void> {
  const required = path.join(pkgRoot, ".next", "BUILD_ID");
  try {
    await fs.access(required);
  } catch {
    throw new Error(
      `Reflex web bundle not found at ${pkgRoot}/.next. If running from source, run \`pnpm run build\` first.`,
    );
  }
}

function displayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "localhost";
  return host;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Browser launch is best-effort.
  }
}
