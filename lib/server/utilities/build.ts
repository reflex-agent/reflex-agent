import "server-only";
import * as esbuild from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { compile as compileTailwind } from "@tailwindcss/node";
import { HOST_UI_SOURCE } from "./host-ui-source";
import type { InstalledUtility, Manifest } from "./types";

// The only CDN host utilities may pull build-time deps from. esm.sh
// serves pre-built ESM (no install scripts) and supports ?external for
// React dedup. Everything is fetched at BUILD time and inlined into the
// bundle — nothing is loaded at runtime, so the iframe CSP stays
// `connect-src 'none'`.
const ESM_CDN_HOST = "esm.sh";
const ESM_FETCH_TIMEOUT_MS = 20_000;
const REACT_EXTERNAL = "react,react-dom,react-dom/client";

/**
 * Bundle a utility's source into a browser-side `bundle.js` and (if it
 * declares `serverActions`) a set of Node Worker bundles under `dist/actions/`.
 *
 * Import rules — enforced by a custom esbuild plugin:
 *   `react`, `react-dom` / `react-dom/client`  → external (provided by host bridge)
 *   `@host/ui`                                  → external (Reflex-provided primitives)
 *   `@host/api`                                 → external (window.reflex / worker bridge)
 *   anything else                               → build error
 *
 * The plugin blocks node-builtins (`fs`, `child_process`, …) and any
 * bare-specifier that isn't in the whitelist above.
 */

// We bundle React/ReactDOM into each utility for simplicity (~140KB ESM each;
// the iframe is the isolation boundary anyway). Only the Reflex-provided
// surface modules are external — resolved through an importmap in the
// iframe HTML.
const UI_EXTERNALS = ["@host/ui", "@host/api"];
// Worker bundles can't resolve `@host/api` as a Node package — Node has
// no idea what that is. Instead, we inline a virtual module via plugin
// that re-exports `globalThis.__reflexHost` (populated by
// worker-bootstrap.js). UI bundles still treat it as external because
// the iframe uses an importmap.
const ACTION_EXTERNALS: string[] = [];

/**
 * Bare-specifier imports the utility may use but that we resolve from
 * Reflex's own node_modules (utilities live outside Reflex's tree). Any
 * other bare import is rejected by the whitelist plugin.
 */
const REACT_RESOLVABLE = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  // Rendering libs commonly needed by utilities (markdown viewers,
  // GFM tables in articles, etc.). Bundled from Reflex's node_modules.
  "react-markdown",
  "remark-gfm",
  // Mermaid diagram rendering — utilities call `mermaid.run` on
  // <pre class="mermaid"> nodes after mount. Bundled per-utility; the
  // library is ~1.5MB minified but stays under the 5MB cap.
  "mermaid",
];

// Per-bundle cap. Generous enough for utilities that pull in heavy
// rendering libs (mermaid bundles ~20MB across all diagram chunks).
// Bundles are loaded ONCE per utility-open inside an iframe — the
// runtime cost is tolerable on modern hardware. Reduce if we ever see
// memory pressure.
const MAX_BUNDLE_BYTES = 40 * 1024 * 1024;

export interface BuildResult {
  uiBundleSize: number;
  actionBundles: Array<{ name: string; size: number }>;
}

export async function buildUtility(
  utility: InstalledUtility,
): Promise<BuildResult> {
  const { manifest, dir } = utility;
  const uiEntry = path.join(dir, manifest.ui);
  const uiOut = path.join(dir, "bundle.js");
  const deps = manifest.dependencies ?? {};
  const esmCacheDir = path.join(dir, "dist", ".esm-cache");

  await assertFileExists(uiEntry, "ui");

  // Synthetic bootstrap: import the user's UI, mount its default export into
  // `#root` if one is exported. Utilities written by the agent typically
  // `export default function Foo() {...}` and expect the host to mount it;
  // utilities that already self-mount (e.g. via `createRoot(...).render(...)`)
  // simply won't have a default export, so the bootstrap is a no-op for them.
  const uiBase = "./" + path.basename(manifest.ui).replace(/\.(tsx?|jsx?)$/, "");
  const bootstrap = `import * as __user from ${JSON.stringify(uiBase)};
import { createElement } from "react";
import { createRoot } from "react-dom/client";
const __root = typeof document !== "undefined"
  ? document.getElementById("root")
  : null;
const __Component = (__user && typeof __user === "object")
  ? (__user["default"] ?? __user["App"])
  : null;
if (__root && typeof __Component === "function") {
  createRoot(__root).render(createElement(__Component));
}
`;

  const uiResult = await esbuild.build({
    stdin: {
      contents: bootstrap,
      resolveDir: dir,
      sourcefile: "_reflex-bootstrap.tsx",
      loader: "tsx",
    },
    outfile: uiOut,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify: false,
    write: true,
    sourcemap: "inline",
    external: UI_EXTERNALS,
    plugins: [
      esmCdnPlugin({ deps, cacheDir: esmCacheDir, target: "browser" }),
      importWhitelistPlugin([...UI_EXTERNALS, ...REACT_RESOLVABLE]),
    ],
    logLevel: "silent",
  });
  ensureBuildOk(uiResult, "UI bundle");

  const uiStat = await fs.stat(uiOut);
  if (uiStat.size > MAX_BUNDLE_BYTES) {
    throw new Error(
      `UI bundle too large: ${uiStat.size} bytes (cap ${MAX_BUNDLE_BYTES})`,
    );
  }

  await buildTailwindStylesheet(utility);

  const actionBundles: BuildResult["actionBundles"] = [];
  if (manifest.serverActions.length > 0) {
    const actionsOutDir = path.join(dir, "dist", "actions");
    await fs.mkdir(actionsOutDir, { recursive: true });
    for (const a of manifest.serverActions) {
      const entry = path.join(dir, a.entry);
      await assertFileExists(entry, `action ${a.name}`);
      const outfile = path.join(actionsOutDir, `${a.name}.js`);
      const r = await esbuild.build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "es2022",
        minify: false,
        write: true,
        sourcemap: "inline",
        external: ACTION_EXTERNALS,
        plugins: [
          hostApiVirtualPlugin(),
          esmCdnPlugin({ deps, cacheDir: esmCacheDir, target: "node" }),
          importWhitelistPlugin([...ACTION_EXTERNALS, "@host/api"]),
        ],
        logLevel: "silent",
      });
      ensureBuildOk(r, `action ${a.name}`);
      const stat = await fs.stat(outfile);
      if (stat.size > MAX_BUNDLE_BYTES) {
        throw new Error(
          `action ${a.name} bundle too large: ${stat.size}`,
        );
      }
      actionBundles.push({ name: a.name, size: stat.size });
    }
  }

  return { uiBundleSize: uiStat.size, actionBundles };
}

function ensureBuildOk(
  result: esbuild.BuildResult,
  what: string,
): void {
  if (result.errors && result.errors.length > 0) {
    const msg = result.errors
      .map((e) => `${e.location?.file}:${e.location?.line ?? "?"}: ${e.text}`)
      .join("\n");
    throw new Error(`esbuild failed for ${what}:\n${msg}`);
  }
}

async function assertFileExists(p: string, label: string): Promise<void> {
  try {
    await fs.access(p);
  } catch {
    throw new Error(`${label} entry not found: ${p}`);
  }
}

/**
 * Compile a per-utility Tailwind v4 stylesheet covering exactly the classes
 * the utility (and the host-ui primitives it pulls in) uses. Written to
 * `<dir>/style.css` and served by the `/style.css` route. The candidate set
 * is extracted with a permissive tokenizer; Tailwind drops anything it can't
 * resolve as a class.
 */
async function buildTailwindStylesheet(
  utility: InstalledUtility,
): Promise<void> {
  const { dir } = utility;
  const sourceFiles = await listSourceFiles(dir);
  const candidates = new Set<string>();
  for (const f of sourceFiles) {
    const content = await fs.readFile(f, "utf8");
    for (const tok of extractClassCandidates(content)) candidates.add(tok);
  }
  for (const tok of extractClassCandidates(HOST_UI_SOURCE)) candidates.add(tok);

  const compiler = await compileTailwind(
    `@import "tailwindcss";\n`,
    {
      base: process.cwd(),
      onDependency: () => {},
    },
  );
  const css = compiler.build([...candidates]);
  await fs.writeFile(path.join(dir, "style.css"), css, "utf8");
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "data" || e.name === "dist" || e.name === "node_modules") {
          continue;
        }
        await walk(p);
      } else if (/\.(tsx?|jsx?|html|css|md)$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * Split a source string into tokens that could be Tailwind class candidates.
 * Permissive — anything not matched by Tailwind is silently dropped during
 * compilation. Splits on common JS/JSX/HTML delimiters and keeps tokens that
 * look like class-name fragments (letters, digits, `-_:./[]%@&`).
 */
function extractClassCandidates(text: string): string[] {
  return text
    .split(/[\s"'`{}();,<>=]+/)
    .filter((t) => t.length > 0 && /^[a-zA-Z@!-]/.test(t));
}

/**
 * Resolve a bare specifier (a package name or `pkg/subpath`) by walking
 * Reflex's own `node_modules` tree manually.
 *
 * We can't use Node's `createRequire` here: Next.js's server bundle replaces
 * `node:module`'s `createRequire` with a webpack shim that returns
 * `undefined`. Building a real `require` is more trouble than it's worth for
 * the tiny set of specifiers utilities are allowed to import (just the React
 * runtime modules), so we resolve them directly:
 *
 *   1. Split the spec into `<pkg>` and `<subpath>`.
 *   2. Read `<cwd>/node_modules/<pkg>/package.json` (pnpm puts a symlink
 *      there pointing at the real `.pnpm/...` copy).
 *   3. Apply the `exports` map (browser condition) if present, else fall
 *      back to `main` or `index.js`.
 *
 * This deliberately implements only the slice of the resolution algorithm
 * we need; if the whitelist ever grows beyond React, revisit.
 */
/**
 * Override map for packages whose default entry pulls in many tiny
 * transitive deps that we can't easily bundle (e.g. mermaid's
 * mermaid.core.mjs imports `d3`/`dompurify`/`stylis`/`es-toolkit` as
 * unbundled externals). Each entry points at a pre-bundled file that
 * already inlines everything.
 */
const REFLEX_RESOLVE_OVERRIDES: Record<string, string> = {
  mermaid: "dist/mermaid.esm.min.mjs",
};

function reflexResolve(spec: string): string | null {
  const parts = spec.split("/");
  const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const rest = spec.startsWith("@") ? parts.slice(2) : parts.slice(1);
  const subpath = rest.length > 0 ? "./" + rest.join("/") : ".";
  const pkgDir = path.join(process.cwd(), "node_modules", pkg);
  // Short-circuit for packages whose default entry imports unbundleable
  // peer deps. Always wins over package.exports for the "." subpath.
  if (subpath === "." && pkg && REFLEX_RESOLVE_OVERRIDES[pkg]) {
    const abs = path.join(pkgDir, REFLEX_RESOLVE_OVERRIDES[pkg]);
    if (existsSync(abs)) return abs;
  }
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  let pkgJson: { main?: string; module?: string; exports?: unknown };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch {
    return null;
  }
  const resolved = resolveExports(pkgJson.exports, subpath);
  if (resolved !== null) {
    const abs = path.join(pkgDir, resolved);
    return existsSync(abs) ? abs : null;
  }
  if (subpath === ".") {
    const entry = pkgJson.module ?? pkgJson.main ?? "index.js";
    const abs = path.join(pkgDir, entry);
    return existsSync(abs) ? abs : null;
  }
  for (const ext of ["", ".js", ".mjs", ".cjs"]) {
    const abs = path.join(pkgDir, subpath.slice(2) + ext);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Tiny `exports`-field resolver. Handles strings, conditional objects, and
 * subpath maps — enough to pick the right React entry point. We prefer the
 * `browser` / `import` / `default` conditions in that order (utility code
 * runs in an iframe).
 */
function resolveExports(exp: unknown, subpath: string): string | null {
  if (exp == null) return null;
  if (typeof exp === "string") return subpath === "." ? exp : null;
  if (typeof exp !== "object") return null;
  const obj = exp as Record<string, unknown>;
  const hasSubpathKeys = Object.keys(obj).some((k) => k.startsWith("."));
  if (hasSubpathKeys) {
    const direct = obj[subpath];
    if (direct !== undefined) return pickCondition(direct);
    return null;
  }
  return subpath === "." ? pickCondition(obj) : null;
}

function pickCondition(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  for (const key of ["browser", "import", "module", "default", "require"]) {
    if (key in obj) {
      const v = pickCondition(obj[key]);
      if (v) return v;
    }
  }
  return null;
}

/**
 * Combined import gate. For each bare specifier:
 *   1. Local / absolute paths → pass through.
 *   2. `node:*` → reject.
 *   3. `@host/*` → external (resolved at runtime via importmap).
 *   4. React family → resolved to an absolute path inside Reflex's node_modules.
 *   5. Anything else → reject with a helpful message.
 */
/**
 * Worker-side virtual module for `@host/api`. Replaces the bare import
 * with a synthetic source that pulls every method off
 * `globalThis.__reflexHost` — populated by `worker-bootstrap.js`. Same
 * shape as the iframe-side proxy in `app/api/utilities/.../host-api.mjs`
 * so utility authors don't notice the difference between worker and
 * iframe execution context.
 */
function hostApiVirtualPlugin(): esbuild.Plugin {
  return {
    name: "reflex-host-api-virtual",
    setup(build) {
      build.onResolve({ filter: /^@host\/api$/ }, (args) => ({
        path: args.path,
        namespace: "reflex-host-api",
      }));
      build.onLoad(
        { filter: /.*/, namespace: "reflex-host-api" },
        () => ({
          contents:
            "const h = globalThis.__reflexHost;\n" +
            "if (!h) throw new Error('@host/api not available — worker not bootstrapped?');\n" +
            "export const reflex = h;\n" +
            "export const llm = h.llm;\n" +
            "export const kb = h.kb;\n" +
            "export const fs = h.fs;\n" +
            "export const web = h.web;\n" +
            "export const audit = h.audit;\n" +
            "export const actions = h.actions;\n" +
            "export const mcp = h.mcp;\n" +
            "export const secrets = h.secrets;\n" +
            "export const agent = h.agent;\n" +
            "export const workflow = h.workflow;\n" +
            "export const cards = h.cards;\n" +
            "export default h;\n",
          loader: "js",
        }),
      );
    },
  };
}

/**
 * Resolve + bundle a utility's declared third-party deps from esm.sh at
 * build time. Runs BEFORE the whitelist plugin so declared deps are
 * claimed (and undeclared bare imports still fall through to the
 * whitelist's hard error).
 *
 *   - utility source imports a declared dep (`dayjs` / `dayjs/plugin/x`)
 *     → rewrite to `https://esm.sh/dayjs@<ver>/...?external=react,...`
 *   - esm.sh modules import other `https://esm.sh/...` (transitive)
 *     → fetched recursively, all inlined.
 *   - esm.sh modules import bare `react`/`react-dom*` (kept external via
 *     `?external`) → resolved to the host React so there's ONE React.
 *
 * Fetched bytes are cached under `<dir>/dist/.esm-cache/<sha>.js` so
 * rebuilds are offline + deterministic.
 */
function esmCdnPlugin(args: {
  deps: Record<string, string>;
  cacheDir: string;
  target: "browser" | "node";
}): esbuild.Plugin {
  const { deps, cacheDir, target } = args;
  const reactSet = new Set(REACT_RESOLVABLE);

  const depUrl = (spec: string): string | null => {
    // spec is `pkg` or `pkg/sub` (or `@scope/pkg[/sub]`).
    const parts = spec.split("/");
    const pkg = spec.startsWith("@")
      ? parts.slice(0, 2).join("/")
      : parts[0]!;
    const ver = deps[pkg];
    if (!ver) return null;
    const sub = spec.slice(pkg.length); // "" or "/sub"
    const targetParam = target === "node" ? "&target=node" : "";
    return `https://${ESM_CDN_HOST}/${pkg}@${ver}${sub}?external=${REACT_EXTERNAL}${targetParam}`;
  };

  return {
    name: "reflex-esm-cdn",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (a) => {
        // Absolute CDN URL (top-level or transitive) — only esm.sh.
        if (/^https?:\/\//.test(a.path)) {
          let host: string;
          try {
            host = new URL(a.path).host;
          } catch {
            return null;
          }
          if (host !== ESM_CDN_HOST) {
            return {
              errors: [
                { text: `refusing non-esm.sh URL import: ${a.path}` },
              ],
            };
          }
          return { path: a.path, namespace: "esm-cdn" };
        }
        // Imports coming FROM a fetched CDN module.
        if (a.namespace === "esm-cdn") {
          // Relative → resolve against the importer URL.
          if (a.path.startsWith(".") || a.path.startsWith("/")) {
            const abs = new URL(a.path, a.importer).href;
            return { path: abs, namespace: "esm-cdn" };
          }
          // Host React kept external by ?external — unify with host copy.
          if (reactSet.has(a.path)) {
            const resolved = reflexResolve(a.path);
            if (resolved) return { path: resolved };
          }
          // Any other bare import the CDN left unresolved → route to esm.sh.
          return {
            path: `https://${ESM_CDN_HOST}/${a.path}?external=${REACT_EXTERNAL}${
              target === "node" ? "&target=node" : ""
            }`,
            namespace: "esm-cdn",
          };
        }
        // Utility source importing a declared dependency.
        if (
          !a.path.startsWith(".") &&
          !a.path.startsWith("/") &&
          !path.isAbsolute(a.path) &&
          !a.path.startsWith("@host/") &&
          !a.path.startsWith("node:")
        ) {
          const url = depUrl(a.path);
          if (url) return { path: url, namespace: "esm-cdn" };
        }
        return null; // fall through to the whitelist plugin
      });

      build.onLoad({ filter: /.*/, namespace: "esm-cdn" }, async (a) => {
        const contents = await fetchCached(a.path, cacheDir);
        return { contents, loader: "js", resolveDir: cacheDir };
      });
    },
  };
}

async function fetchCached(url: string, cacheDir: string): Promise<string> {
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 32);
  const cacheFile = path.join(cacheDir, `${hash}.js`);
  try {
    return await fs.readFile(cacheFile, "utf8");
  } catch {
    /* miss — fetch below */
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(ESM_FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(
      `couldn't fetch dependency from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`couldn't fetch dependency from ${url}: HTTP ${res.status}`);
  }
  const text = await res.text();
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cacheFile, text, "utf8");
  return text;
}

function importWhitelistPlugin(allowed: readonly string[]): esbuild.Plugin {
  const allowSet = new Set(allowed);
  const reactSet = new Set(REACT_RESOLVABLE);
  const nodeModulesDir = path.join(process.cwd(), "node_modules");
  return {
    name: "reflex-import-whitelist",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // Imports originating from inside Reflex's own node_modules are
        // transitive deps of the whitelisted packages (e.g. `scheduler`
        // pulled in by `react-dom`). Let esbuild resolve them normally —
        // the whitelist only constrains the utility's own source code.
        const fromVendor =
          args.importer.startsWith(nodeModulesDir + path.sep) ||
          args.importer.includes(path.sep + "node_modules" + path.sep);
        if (fromVendor) return null;

        if (
          args.path.startsWith(".") ||
          args.path.startsWith("/") ||
          path.isAbsolute(args.path)
        ) {
          return null;
        }
        if (args.path.startsWith("node:")) {
          return {
            errors: [
              {
                text: `import "${args.path}" is not allowed in utility code`,
              },
            ],
          };
        }
        if (!allowSet.has(args.path)) {
          return {
            errors: [
              {
                text: `import "${args.path}" is not in the allowed list: ${Array.from(
                  allowSet,
                ).join(", ")}`,
              },
            ],
          };
        }
        if (args.path.startsWith("@host/")) {
          return { path: args.path, external: true };
        }
        if (reactSet.has(args.path)) {
          const resolved = reflexResolve(args.path);
          if (resolved) return { path: resolved };
          return {
            errors: [
              {
                text: `could not resolve "${args.path}" from Reflex node_modules`,
              },
            ],
          };
        }
        return null;
      });
    },
  };
}

/** Convenience: rebuild and persist; used by /actions/rebuild and watcher. */
export async function rebuildUtility(
  utility: InstalledUtility,
): Promise<BuildResult> {
  return buildUtility(utility);
}

export function uiBundlePath(dir: string): string {
  return path.join(dir, "bundle.js");
}

export function actionBundlePath(dir: string, name: string): string {
  return path.join(dir, "dist", "actions", `${name}.js`);
}
