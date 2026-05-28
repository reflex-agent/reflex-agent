import { NextResponse } from "next/server";

export const dynamic = "force-static";
export const runtime = "nodejs";

/**
 * Importmap-served module that the utility code resolves `@host/api` to.
 * Exposes `reflex.<namespace>.<method>(args)` — each call posts a message to
 * the parent, which routes to /host and posts the response back.
 */
const SOURCE = `const pending = new Map();
let nextId = 1;
window.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "host-rpc-result") return;
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.ok) slot.resolve(msg.result);
  else slot.reject(new Error(msg.error || "host call failed"));
});

function rpc(method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      window.parent.postMessage({ type: "host-rpc", id, method, args }, "*");
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

// Each node is a CALLABLE proxy: invoking it fires an RPC for its dotted
// path, while property access descends one level. This is what makes
// BOTH \`reflex.kb.list(args)\` (2-level) and
// \`reflex.git.worktree.merge(args)\` (3-level) work — a flat one-level
// proxy turned \`git.worktree\` into a function whose \`.merge\` was
// undefined, so 3-level calls silently threw.
function node(path) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, key) {
      if (typeof key !== "string") return undefined;
      // Don't masquerade as a thenable — otherwise \`await someNamespace\`
      // (or a stray await on a non-leaf) would hang.
      if (key === "then" || key === "catch" || key === "finally") {
        return undefined;
      }
      return node(path ? path + "." + key : key);
    },
    apply(_t, _this, argList) {
      return rpc(path, argList[0]);
    },
  });
}

function ns(namespace) {
  return node(namespace);
}

// Top-level Proxy: any namespace is resolved dynamically so adding a new
// host namespace on the server doesn't require redeploying the proxy.
// Explicit named exports below give static IDE hints to utility authors.
export const reflex = new Proxy({}, {
  get(_target, namespace) {
    if (typeof namespace !== "string") return undefined;
    return node(namespace);
  },
});
export const llm = ns("llm");
export const kb = ns("kb");
export const fs = ns("fs");
export const web = ns("web");
export const audit = ns("audit");
export const actions = ns("actions");
export const mcp = ns("mcp");
export const secrets = ns("secrets");
export const agent = ns("agent");
export const workflow = ns("workflow");
`;

export async function GET(): Promise<Response> {
  return new NextResponse(SOURCE, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
