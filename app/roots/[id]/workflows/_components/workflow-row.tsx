"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { setWorkflowEnabledAction } from "@/lib/server/workflows/actions";

/**
 * Render a single row on the workflows list with the runtime info the
 * server gathered (last run, next expected fire, enabled flag). The
 * enabled toggle is the only interactive bit — everything else stays
 * server-rendered. Utility-sourced workflows show a "from <id>" badge
 * and the toggle is read-only (uninstall or fork to disable).
 */
export interface WorkflowRowProps {
  rootId: string;
  wf: {
    id: string;
    label: string;
    description?: string;
    trigger: "manual" | "hourly" | "daily" | "weekly";
    stepCount: number;
    enabled: boolean;
    lastRun: {
      startedAt: string;
      status: "running" | "completed" | "failed" | "cancelled";
    } | null;
    nextRunAt: string | null;
    source: "project" | "utility";
    utilityId?: string;
  };
  href: string;
}

export function WorkflowRow({ rootId, wf, href }: WorkflowRowProps) {
  const [enabled, setEnabled] = useState(wf.enabled);
  const [pending, start] = useTransition();
  const editable = wf.source === "project" && wf.trigger !== "manual";

  const toggle = (next: boolean) => {
    setEnabled(next);
    start(async () => {
      const res = await setWorkflowEnabledAction(rootId, wf.id, next);
      if (!res.ok) {
        setEnabled(!next);
        toast.error(res.error ?? "Couldn't change enabled state");
      } else {
        toast.success(next ? "Scheduler resumed" : "Scheduler paused");
      }
    });
  };

  return (
    <div className="rounded-md border bg-card hover:bg-accent/30 transition px-4 py-3">
      <div className="flex items-start gap-3">
        <Workflow className="h-4 w-4 mt-0.5 shrink-0 text-violet-600" />
        <a href={href} className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{wf.label}</span>
            <Badge variant="outline" className="text-[10px]">
              {wf.trigger}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {wf.stepCount} {wf.stepCount === 1 ? "step" : "steps"}
            </Badge>
            {wf.source === "utility" && (
              <Badge
                variant="outline"
                className="text-[10px] border-violet-300 text-violet-700"
              >
                from {wf.utilityId ?? "utility"}
              </Badge>
            )}
            {wf.trigger !== "manual" && !enabled && (
              <Badge
                variant="outline"
                className="text-[10px] border-amber-300 text-amber-700"
              >
                paused
              </Badge>
            )}
          </div>
          {wf.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {wf.description}
            </p>
          )}
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground mt-1 font-mono">
            <span>{wf.id}</span>
            {wf.lastRun && (
              <span>
                last: {timeAgo(wf.lastRun.startedAt)} ·{" "}
                <span
                  className={
                    wf.lastRun.status === "failed"
                      ? "text-destructive"
                      : wf.lastRun.status === "running"
                        ? "text-amber-700"
                        : ""
                  }
                >
                  {wf.lastRun.status}
                </span>
              </span>
            )}
            {wf.nextRunAt && enabled && (
              <span>next: {timeUntil(wf.nextRunAt)}</span>
            )}
          </div>
        </a>
        {wf.trigger !== "manual" && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] text-muted-foreground">
              {enabled ? "on" : "off"}
            </span>
            <Switch
              checked={enabled}
              onCheckedChange={toggle}
              disabled={!editable || pending}
              aria-label="Toggle scheduler"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function timeUntil(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "due";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}
