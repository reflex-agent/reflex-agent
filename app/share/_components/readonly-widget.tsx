"use client";

import { renderWidget } from "@/app/roots/[id]/_components/widgets/registry";

/**
 * Client boundary for rendering a real widget on a public share page.
 * `renderWidget` uses a hook (next-intl), so it must run inside a client
 * component. `readonly` mutes every interactive affordance (drag, delete,
 * action buttons) — a share link is display-only. No rootId is threaded
 * because no action can fire in readonly mode.
 */
export function ReadonlyWidget({
  kind,
  data,
}: {
  kind: string;
  data: unknown;
}) {
  return renderWidget("", kind, data, { readonly: true });
}
