import "server-only";
import path from "node:path";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import { reflexHome } from "@/lib/reflex/home";
import { writeJsonFile } from "@/lib/reflex/store/json-store";

/**
 * The single grant ledger for the Share Plane (see docs/sharing.md). Lives at
 * `<REFLEX_HOME>/grants.json` (mode 0600), modeled on `shares/store.ts`. A
 * grant is the ONLY thing that authorizes a consumer to read a provider's data
 * (DATA plane) or call a provider's exported verb (CAPABILITY plane). Grants
 * are created only by core on explicit user consent (install or just-in-time);
 * a producer never self-grants.
 */

export type SharePlane = "data" | "capability";

export interface Grant {
  id: string;
  /** Consumer utility id. */
  consumer: string;
  /** Provider utility id. */
  provider: string;
  plane: SharePlane;
  /** kind (data plane) | verb (capability plane). */
  selector: string;
  /** rootId the grant is scoped to, or "global". */
  scope: string;
  grantedAt: string;
  expiresAt?: string;
  revoked?: boolean;
}

interface GrantFile {
  version: number;
  grants: Grant[];
}

function grantsFile(): string {
  return path.join(reflexHome(), "grants.json");
}

async function readFile(): Promise<GrantFile> {
  try {
    const raw = await fs.readFile(grantsFile(), "utf8");
    const parsed = JSON.parse(raw) as GrantFile;
    if (parsed && Array.isArray(parsed.grants)) return parsed;
  } catch {
    /* missing / corrupt — start empty */
  }
  return { version: 1, grants: [] };
}

async function writeFile(file: GrantFile): Promise<void> {
  await writeJsonFile(grantsFile(), file, { mode: 0o600 });
}

function newGrantId(): string {
  return "g_" + crypto.randomBytes(8).toString("hex");
}

/** A grant is usable iff not revoked and not past its expiry. */
export function grantActive(g: Grant, now = Date.now()): boolean {
  if (g.revoked) return false;
  if (g.expiresAt && new Date(g.expiresAt).getTime() <= now) return false;
  return true;
}

/** A grant covers a target scope iff it is global or names the same rootId. */
export function grantCoversScope(g: Grant, scope: string): boolean {
  return g.scope === "global" || g.scope === scope;
}

export async function listGrants(): Promise<Grant[]> {
  return (await readFile()).grants;
}

export interface GrantView extends Grant {
  /** Derived: not revoked and not expired. */
  active: boolean;
}

/** Grants with a derived `active` flag — for the Settings → Sharing surface. */
export async function listGrantViews(): Promise<GrantView[]> {
  const now = Date.now();
  return (await listGrants()).map((g) => ({ ...g, active: grantActive(g, now) }));
}

/**
 * Resolve a live grant authorizing `consumer` to access `(provider, plane,
 * selector)` within `scope`. Returns null when none applies.
 */
export async function findGrant(q: {
  consumer: string;
  provider: string;
  plane: SharePlane;
  selector: string;
  scope: string;
}): Promise<Grant | null> {
  const now = Date.now();
  const grants = await listGrants();
  return (
    grants.find(
      (g) =>
        g.consumer === q.consumer &&
        g.provider === q.provider &&
        g.plane === q.plane &&
        g.selector === q.selector &&
        grantActive(g, now) &&
        grantCoversScope(g, q.scope),
    ) ?? null
  );
}

export async function createGrant(input: {
  consumer: string;
  provider: string;
  plane: SharePlane;
  selector: string;
  scope: string;
  expiresAt?: string;
}): Promise<Grant> {
  const file = await readFile();
  // Idempotent: reuse a live identical grant rather than stacking duplicates.
  const existing = file.grants.find(
    (g) =>
      g.consumer === input.consumer &&
      g.provider === input.provider &&
      g.plane === input.plane &&
      g.selector === input.selector &&
      g.scope === input.scope &&
      grantActive(g),
  );
  if (existing) return existing;
  const grant: Grant = {
    id: newGrantId(),
    consumer: input.consumer,
    provider: input.provider,
    plane: input.plane,
    selector: input.selector,
    scope: input.scope,
    grantedAt: new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  file.grants = [grant, ...file.grants];
  await writeFile(file);
  return grant;
}

export async function revokeGrant(id: string): Promise<boolean> {
  const file = await readFile();
  const g = file.grants.find((x) => x.id === id);
  if (!g || g.revoked) return false;
  g.revoked = true;
  await writeFile(file);
  return true;
}

/**
 * Drop every grant naming `utilityId` as consumer OR provider. Called on
 * uninstall so an orphaned grant can never authorize access to/from a utility
 * that no longer exists.
 */
export async function pruneGrantsForUtility(utilityId: string): Promise<number> {
  const file = await readFile();
  const before = file.grants.length;
  file.grants = file.grants.filter(
    (g) => g.consumer !== utilityId && g.provider !== utilityId,
  );
  const removed = before - file.grants.length;
  if (removed > 0) await writeFile(file);
  return removed;
}
