#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "../lib/reflex/commands/init.js";
import { runWatch } from "../lib/reflex/commands/watch.js";
import { runChat } from "../lib/reflex/commands/chat.js";
import { runStart } from "../lib/reflex/commands/start.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json",
);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };

const program = new Command();
program
  .name("reflex")
  .description("Local-first knowledge base built by an agent.")
  .version(pkg.version);

program
  .command("init")
  .description("Scaffold .reflex/ and run the initial agent pass over <dir>.")
  .argument("<dir>", "Project directory")
  .option("--scaffold-only", "Create .reflex/ and config but skip the agent pass")
  .action(async (dir: string, opts: { scaffoldOnly?: boolean }) => {
    await runInit(dir, { scaffoldOnly: !!opts.scaffoldOnly });
  });

program
  .command("watch")
  .description("Watch <dir> and refresh the KB on changes (debounced).")
  .argument("<dir>", "Project directory")
  .action(async (dir: string) => {
    const handle = await runWatch(dir);
    const shutdown = async (signal: NodeJS.Signals) => {
      process.stdout.write(`\n[reflex] ${signal} received, stopping…\n`);
      await handle.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("chat")
  .description("Open a chat scoped to <dir>'s knowledge base.")
  .argument("<dir>", "Folder inside an initialized Reflex root")
  .action(async (dir: string) => {
    await runChat(dir);
  });

program
  .command("start")
  .description("Launch the Reflex web UI on http://localhost:3210.")
  .option("-p, --port <port>", "Port to listen on", "3210")
  .option("-h, --host <host>", "Host to bind to", "127.0.0.1")
  .option("--no-open", "Don't open the browser automatically")
  .action(async (opts: { port: string; host: string; open: boolean }) => {
    await runStart({ port: Number(opts.port), host: opts.host, open: opts.open });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`reflex: ${formatError(err)}\n`);
  process.exit(1);
});

function formatError(err: unknown): string {
  if (err instanceof Error) {
    // zod errors stringify as a JSON array — extract messages.
    try {
      const parsed: unknown = JSON.parse(err.message);
      if (Array.isArray(parsed)) {
        return parsed
          .map((e) => {
            if (typeof e === "object" && e !== null && "message" in e) {
              return String((e as { message: unknown }).message);
            }
            return String(e);
          })
          .join("; ");
      }
    } catch {
      // not JSON — fall through
    }
    return err.message;
  }
  return String(err);
}
