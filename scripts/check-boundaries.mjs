#!/usr/bin/env node
// Import-direction boundary check for the Reflex Kernel (north-star plan §0).
//
// The kernel is a modular monolith with four layers and a one-way import rule:
//
//   Layer 1  SpaceStore           lib/reflex/store/**, lib/reflex/{ids,paths}.ts
//   Layer 2  CapabilityRegistry   lib/server/capabilities/**
//   Layer 3  TurnEngine/EventBus  lib/server/agents/{bus,turn-engine,directives}/**
//   (Layer 4  surfaces            app/api/**, notify/**, headless, share)
//
//   Allowed import direction: 4 -> 3 -> 2 -> 1   (never the reverse)
//
// A file in a kernel layer must NOT import from a HIGHER kernel layer. Only the
// NEW kernel directories are classified, so legacy code (manager.ts et al.) is
// grandfathered until it is refactored into a layer — meaning this gate stays
// green today and enforces the rule on every Phase-1+ kernel module as it lands.
//
// Dependency-free on purpose (devDeps shouldn't bloat an npm-distributed app).
// Run: `node scripts/check-boundaries.mjs`  /  `pnpm run lint:boundaries`

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// Each layer lists path prefixes (relative to repo root). A trailing "/" means
// "directory prefix"; otherwise an exact file. Order doesn't matter — longest
// match wins.
const LAYERS = [
  { layer: 1, name: "SpaceStore", paths: ["lib/reflex/store/", "lib/reflex/ids.ts", "lib/reflex/paths.ts"] },
  { layer: 2, name: "CapabilityRegistry", paths: ["lib/server/capabilities/"] },
  {
    layer: 3,
    name: "TurnEngine/EventBus",
    paths: [
      "lib/server/agents/bus/",
      "lib/server/agents/turn-engine/",
      "lib/server/agents/directives/",
    ],
  },
];

/** Classify a repo-relative path into a kernel layer number, or null. */
function layerOf(rel) {
  let best = null;
  let bestLen = -1;
  for (const { layer, paths } of LAYERS) {
    for (const p of paths) {
      const isDir = p.endsWith("/");
      const match = isDir ? rel.startsWith(p) : rel === p;
      if (match && p.length > bestLen) {
        best = layer;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** All files belonging to any classified layer. */
async function collectKernelFiles() {
  const out = [];
  const seen = new Set();
  for (const { paths } of LAYERS) {
    for (const p of paths) {
      const abs = path.join(ROOT, p);
      if (p.endsWith("/")) {
        await walk(abs, out, seen);
      } else if (await exists(abs)) {
        push(out, seen, abs);
      }
    }
  }
  return out;
}

async function walk(dir, out, seen) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist yet (kernel not built there) — fine
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, out, seen);
    else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) push(out, seen, abs);
  }
}

function push(out, seen, abs) {
  if (seen.has(abs)) return;
  seen.add(abs);
  out.push(abs);
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

const IMPORT_RE =
  /(?:import|export)(?:[\s\S]*?from\s*|\s+)["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

/** Resolve an import specifier to a repo-relative path, or null if external. */
function resolveSpecifier(fromAbs, spec) {
  let relTarget;
  if (spec.startsWith("@/")) {
    relTarget = spec.slice(2);
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    const abs = path.resolve(path.dirname(fromAbs), spec);
    relTarget = path.relative(ROOT, abs);
  } else {
    return null; // bare specifier (node:, npm package) — external
  }
  return relTarget.split(path.sep).join("/");
}

async function main() {
  const files = await collectKernelFiles();
  const violations = [];

  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    const fromLayer = layerOf(rel);
    if (fromLayer == null) continue;
    const src = await fs.readFile(abs, "utf8");
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      const target = resolveSpecifier(abs, spec);
      if (!target) continue;
      const toLayer = layerOf(target);
      if (toLayer == null) continue; // importing legacy/unclassified — allowed for now
      if (toLayer > fromLayer) {
        violations.push(
          `  ${rel} (L${fromLayer}) -> ${target} (L${toLayer})  [lower layer must not import higher]`,
        );
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `✗ import-boundary check: ${violations.length} violation(s)\n` +
        violations.join("\n"),
    );
    process.exit(1);
  }
  console.log(
    `✓ import-boundary check: ${files.length} kernel-layer file(s), 0 violations`,
  );
}

main().catch((err) => {
  console.error("boundary check failed:", err);
  process.exit(1);
});
