"use server";

import { listGrantViews, revokeGrant, type GrantView } from "./grant-store";
import { listProviders, type ProviderEntry } from "./provider-directory";

/**
 * Server actions for the Settings → Sharing surface (docs/sharing.md, Stage 4).
 * Thin wrappers over the grant ledger + provider directory so a UI can show
 * every live cross-utility grant and revoke any of them, and browse what each
 * installed utility provides. Grants are created elsewhere (install / JIT
 * consent) — never here — keeping core the sole, consented broker.
 */

export async function listGrantsAction(): Promise<GrantView[]> {
  return listGrantViews();
}

export async function revokeGrantAction(id: string): Promise<{ ok: boolean }> {
  return { ok: await revokeGrant(id) };
}

export async function listProvidersAction(): Promise<ProviderEntry[]> {
  return listProviders();
}
