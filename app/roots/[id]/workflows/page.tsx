import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, LayoutDashboard, Workflow } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { getRoot } from "@/lib/registry";
import { listWorkflows, listRuns } from "@/lib/server/workflows/store";
import { collectExtensions } from "@/lib/server/utilities/extensions";
import { listUtilities } from "@/lib/server/utilities/store";
import type { WorkflowDef, WorkflowTrigger } from "@/lib/server/workflows/types";
import { WorkflowRow } from "./_components/workflow-row";

const INTERVAL_MS: Record<WorkflowTrigger, number | null> = {
  manual: null,
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

interface ProjectProvenance {
  source: "project";
}
interface UtilityProvenance {
  source: "utility";
  utilityId: string;
}
type Provenance = ProjectProvenance | UtilityProvenance;

export default async function WorkflowsListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const entry = await getRoot(id);
  if (!entry) notFound();
  const t = await getTranslations("roots");

  // Project + utility workflows + per-workflow run history. We need
  // provenance per workflow so the row shows "from <utility>" and the
  // toggle stays read-only for utility-sourced entries.
  const projectWorkflows = await listWorkflows(entry.path);
  const ext = await collectExtensions({ rootId: entry.id });
  const projectIds = new Set(projectWorkflows.map((w) => w.id));

  const installed = await listUtilities({ rootId: entry.id }).catch(() => []);
  const utilityProvenance = new Map<string, string>();
  for (const u of installed) {
    for (const w of u.manifest.extensions?.workflows ?? []) {
      if (!projectIds.has(w.id)) utilityProvenance.set(w.id, u.manifest.id);
    }
  }

  const combined: Array<{ wf: WorkflowDef; prov: Provenance }> = [
    ...projectWorkflows.map((wf) => ({
      wf,
      prov: { source: "project" } as Provenance,
    })),
    ...ext.workflows
      .filter((w) => !projectIds.has(w.id))
      .map((wf) => ({
        wf,
        prov: {
          source: "utility",
          utilityId: utilityProvenance.get(wf.id) ?? "utility",
        } as Provenance,
      })),
  ];

  const enriched = await Promise.all(
    combined.map(async ({ wf, prov }) => {
      const runs = await listRuns(entry.path, wf.id, 1).catch(() => []);
      const last = runs[0] ?? null;
      const interval = INTERVAL_MS[wf.trigger];
      const enabled = wf.enabled !== false;
      let nextRunAt: string | null = null;
      if (interval && enabled) {
        const baseline = last ? Date.parse(last.startedAt) : Date.now();
        nextRunAt = new Date(baseline + interval).toISOString();
      }
      return {
        id: wf.id,
        label: wf.label,
        ...(wf.description ? { description: wf.description } : {}),
        trigger: wf.trigger,
        stepCount: wf.steps.length,
        enabled,
        lastRun: last
          ? { startedAt: last.startedAt, status: last.status }
          : null,
        nextRunAt,
        ...(prov.source === "utility"
          ? { source: "utility" as const, utilityId: prov.utilityId }
          : { source: "project" as const }),
      };
    }),
  );

  return (
    <main className="flex-1 flex flex-col min-h-0">
      <header className="border-b px-6 py-4 flex items-center gap-4">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href={`/roots/${entry.id}`}>
            <LayoutDashboard className="mr-1 h-4 w-4" />{" "}
            {t("workflowsList.backToDashboard")}
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/">
            <ArrowLeft className="mr-1 h-4 w-4" /> Roots
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-medium flex items-center gap-2">
            <Workflow className="h-4 w-4 text-violet-600" /> Workflows
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("workflowsList.subtitle")}
          </p>
        </div>
      </header>
      <Separator />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-6 max-w-4xl mx-auto space-y-3">
          {enriched.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground space-y-2">
              <p>{t("workflowsList.empty")}</p>
              <p className="text-xs">
                {t("workflowsList.exampleIntro")}{" "}
                <em>{t("workflowsList.example")}</em>
              </p>
            </div>
          ) : (
            enriched.map((row) => (
              <WorkflowRow
                key={row.id}
                rootId={entry.id}
                wf={row}
                href={`/roots/${entry.id}/workflows/${row.id}`}
              />
            ))
          )}
        </div>
      </div>
    </main>
  );
}
