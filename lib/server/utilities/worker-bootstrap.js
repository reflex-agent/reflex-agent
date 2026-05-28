// Static entry for every utility server-action Worker. We hand-roll plain JS
// (no TS) so we don't need a build step for this file. It:
//   1. Sets up a `reflex` host stub that RPC-calls the parent thread.
//   2. Dynamically imports the action bundle.
//   3. Awaits the named export with the args + host, returns the result.
//   4. Times out and exits cleanly.
//
// The action bundle is built by lib/server/utilities/build.ts with
// `external: ["@host/api"]`, so the bundle has `import { reflex } from
// "@host/api"`. We intercept that via Node's loader hook (worker_threads
// resolveAliases) — but since we can't easily inject one, we expose the
// host via globalThis and rewrite the bundle's import at build time?
//
// Practical solution: the build step injects a small shim file at the top
// that aliases `@host/api` to `globalThis.__reflexHost`. See build.ts.
// This bootstrap just sets up that global.

// Node treats this file as ESM (package.json has "type": "module"), so we
// use top-level `import` instead of `require`.
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) {
  throw new Error("worker-bootstrap.js must be loaded as a worker_threads child");
}

const pending = new Map();
let nextRpcId = 1;

function rpc(method, args) {
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "host-rpc", id, method, args });
  });
}

// Callable proxy per level so both 2-level (kb.list) and 3-level
// (git.worktree.merge) host methods resolve. A flat one-level proxy
// turned `git.worktree` into a function whose `.merge` was undefined.
function node(path) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, key) {
      if (typeof key !== "string") return undefined;
      if (key === "then" || key === "catch" || key === "finally") {
        return undefined;
      }
      return node(path ? `${path}.${key}` : key);
    },
    apply(_t, _this, argList) {
      return rpc(path, argList[0]);
    },
  });
}

const reflex = new Proxy(
  {},
  {
    get(_target, namespace) {
      if (typeof namespace !== "string") return undefined;
      return node(namespace);
    },
  },
);

globalThis.__reflexHost = reflex;

parentPort.on("message", async (msg) => {
  if (msg && msg.type === "host-rpc-result") {
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.result);
    else slot.reject(new Error(msg.error || "rpc failed"));
    return;
  }
  if (msg && msg.type === "invoke") {
    try {
      const mod = await import(workerData.bundleUrl);
      const fn = mod[workerData.actionName] ?? mod.default;
      if (typeof fn !== "function") {
        throw new Error(
          `action "${workerData.actionName}" must export a function (named export or default)`,
        );
      }
      const result = await fn(msg.args, reflex);
      parentPort.postMessage({ type: "invoke-result", ok: true, result });
    } catch (err) {
      parentPort.postMessage({
        type: "invoke-result",
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }
});
