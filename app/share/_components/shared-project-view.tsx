import { LayoutDashboard, Share2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { DashboardLayout, WidgetRecord } from "@/lib/server/widgets/types";
import { ReadonlyWidget } from "./readonly-widget";

/**
 * Read-only project dashboard view. We don't reuse the full Dashboard
 * component because it carries client-side interactivity (drag, resize,
 * scheduler hooks) we explicitly don't want on a public link. Instead we
 * render a flat list of the user's widgets with the same kind-specific
 * renderers but `readonly: true`.
 *
 * System widgets (sys:*) are intentionally skipped — they expose internal
 * project state (pending approvals, AI suggestions) that's not safe to
 * surface publicly.
 */
export async function SharedProjectView({
  rootPath,
  widgets,
  layout,
}: {
  rootPath: string;
  widgets: WidgetRecord[];
  layout: DashboardLayout;
}) {
  const t = await getTranslations("app");
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const ordered = layout.order
    .filter((id) => !id.startsWith("sys:"))
    .map((id) => byId.get(id))
    .filter((w): w is WidgetRecord => !!w);
  return (
    <main className="min-h-screen bg-muted/20 px-4 py-8">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-wider">
            <Share2 className="h-3 w-3" />
            Reflex Share · Project dashboard (read-only)
          </div>
          <h1 className="mt-1 text-lg font-semibold flex items-center gap-2">
            <LayoutDashboard className="h-4 w-4 text-violet-600 shrink-0" />
            {rootPath.split("/").pop()}
          </h1>
          <p className="text-xs text-muted-foreground font-mono truncate">
            {rootPath}
          </p>
        </header>
        {ordered.length === 0 ? (
          <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground text-center">
            {t("share.project.noPublicWidgets")}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {ordered.map((w) => (
              <article
                key={w.id}
                className="rounded-lg border bg-card p-4 shadow-sm"
              >
                <header className="mb-2">
                  <h2 className="text-sm font-medium">{w.title}</h2>
                  {w.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {w.description}
                    </p>
                  )}
                </header>
                <ReadonlyWidget kind={w.kind} data={w.data} />
              </article>
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground text-center">
          {t("share.project.footer")}
        </p>
      </div>
    </main>
  );
}
