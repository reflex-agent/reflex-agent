"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { REFLEX_EVENTS, useReflexEvent } from "@/lib/client/events";
import type { DashboardSnapshot } from "@/lib/server/dashboard-actions";
import { DashboardActiveGoals } from "./dashboard-active-goals";
import { DashboardPendingApprovals } from "./dashboard-pending-approvals";
import { DashboardRecentKb } from "./dashboard-recent-kb";
import { DashboardAiSuggestions } from "./dashboard-ai-suggestions";
import { SuggestionsCard } from "./suggestions-card";
import { MemoryEditor } from "@/app/_components/memory/memory-editor";
import { WidgetsGrid } from "./widgets/widgets-grid";

interface Props {
  rootId: string;
  initialSnapshot: DashboardSnapshot;
}

/**
 * Client-side root of the project dashboard. The widget grid composes
 * system slots (the four built-in sections) and user-created widgets in
 * one unified, draggable, hideable list — order persists on disk in
 * `<root>/.reflex/dashboard-layout.json`.
 *
 * Subscribes to topicsChanged / kbChanged + a 30s tick (catches disk
 * events like pending-mcp-adds changes that don't go through the client
 * event bus).
 */
export function Dashboard({ rootId, initialSnapshot }: Props) {
  const t = useTranslations("roots");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initialSnapshot);
  const [refreshing, startRefresh] = useTransition();

  const refresh = useCallback(() => {
    startRefresh(async () => {
      try {
        const res = await fetch(`/api/roots/${rootId}/dashboard`, {
          cache: "no-store",
        });
        const data = (await res.json()) as {
          ok: boolean;
          snapshot?: DashboardSnapshot;
          error?: string;
        };
        if (!data.ok || !data.snapshot) {
          toast.error(data.error ?? t("dashboard.refreshFailed"));
          return;
        }
        setSnapshot(data.snapshot);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }, [rootId, t]);

  useReflexEvent(REFLEX_EVENTS.topicsChanged(rootId), refresh);
  useReflexEvent(REFLEX_EVENTS.kbChanged(rootId), refresh);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const systemRenderers: Record<string, React.ReactNode> = {
    "sys:active-goals": (
      <DashboardActiveGoals
        rootId={rootId}
        activeGoals={snapshot.activeGoals}
        runningAgents={snapshot.runningAgents}
      />
    ),
    "sys:pending": (
      <DashboardPendingApprovals
        rootId={rootId}
        items={snapshot.pendingApprovals}
      />
    ),
    "sys:recent-kb": (
      <DashboardRecentKb rootId={rootId} items={snapshot.recentKb} />
    ),
    "sys:ai-suggestions": (
      <DashboardAiSuggestions rootId={rootId} cache={snapshot.suggestions} />
    ),
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 space-y-5 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {t("dashboard.projectOverview")}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("dashboard.projectOverviewHint")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            className="gap-1 h-8"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            {t("dashboard.refresh")}
          </Button>
        </div>

        <SuggestionsCard rootId={rootId} />

        <WidgetsGrid
          rootId={rootId}
          widgets={snapshot.widgets}
          layout={snapshot.layout}
          systemRenderers={systemRenderers}
          snapshot={snapshot}
          onLayoutChanged={refresh}
        />

        <MemoryEditor
          scope="project"
          rootId={rootId}
          title={t("dashboard.memoryTitle")}
          description={t("dashboard.memoryHint")}
        />
      </div>
    </div>
  );
}
