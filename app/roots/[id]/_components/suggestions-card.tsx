"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Boxes,
  Check,
  Lightbulb,
  LayoutGrid,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
  Telescope,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  approveSuggestionAction,
  listSuggestionsAction,
  rejectSuggestionAction,
} from "@/lib/server/suggestions/actions";
import type { Suggestion } from "@/lib/server/suggestions/store";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<Suggestion["kind"], typeof Lightbulb> = {
  utility: Boxes,
  research: Telescope,
  widget: LayoutGrid,
  goal: Target,
  skill: Sparkles,
};

const KIND_TONE: Record<Suggestion["kind"], string> = {
  utility: "text-emerald-600",
  research: "text-violet-600",
  widget: "text-blue-600",
  goal: "text-amber-600",
  skill: "text-pink-600",
};

interface Props {
  rootId: string;
}

export function SuggestionsCard({ rootId }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, "approve" | "reject" | null>>(
    {},
  );
  const [refreshing, startRefreshing] = useTransition();

  const load = useCallback(async () => {
    const res = await listSuggestionsAction(rootId);
    setLoading(false);
    if (!res.ok) return;
    setItems(res.items);
  }, [rootId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Poll every 30s so freshly-emitted onboarding suggestions land
    // without a hard refresh.
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const onApprove = (s: Suggestion) => {
    setBusy((b) => ({ ...b, [s.id]: "approve" }));
    void (async () => {
      const res = await approveSuggestionAction({
        rootId,
        suggestionId: s.id,
      });
      setBusy((b) => ({ ...b, [s.id]: null }));
      if (!res.ok) {
        toast.error(res.error ?? "Failed to start topic");
        return;
      }
      toast.success(`Started: ${s.title}`);
      setItems((cur) => cur.filter((x) => x.id !== s.id));
      router.push(`/roots/${rootId}/chat/${res.topicId}`);
    })();
  };

  const onReject = (s: Suggestion) => {
    setBusy((b) => ({ ...b, [s.id]: "reject" }));
    void (async () => {
      const res = await rejectSuggestionAction({
        rootId,
        suggestionId: s.id,
      });
      setBusy((b) => ({ ...b, [s.id]: null }));
      if (!res.ok) {
        toast.error(res.error ?? "Failed to reject");
        return;
      }
      toast.success(`Dismissed: ${s.title}`);
      setItems((cur) => cur.filter((x) => x.id !== s.id));
    })();
  };

  if (loading) return null;
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-amber-500" />
            Suggestions
            <Badge variant="secondary" className="ml-1">
              {items.length}
            </Badge>
          </CardTitle>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => startRefreshing(() => load())}
            disabled={refreshing}
            className="h-7 gap-1"
          >
            <RefreshCw
              className={cn("h-3 w-3", refreshing && "animate-spin")}
            />
            Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Hypotheses the agent put together from the onboarding chat. Approve
          to start a topic; dismiss to drop it (and remember you said no).
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((s) => {
          const Icon = KIND_ICON[s.kind] ?? Lightbulb;
          const action = busy[s.id];
          return (
            <div
              key={s.id}
              className="flex items-start gap-3 rounded-md border p-3"
            >
              <Icon className={cn("h-4 w-4 mt-1 shrink-0", KIND_TONE[s.kind])} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium text-sm">{s.title}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {s.kind}
                  </Badge>
                </div>
                {s.description && (
                  <p className="text-xs text-muted-foreground mt-1 leading-snug">
                    {s.description}
                  </p>
                )}
                {s.prompt && (
                  <code className="block mt-1 text-[10px] font-mono text-muted-foreground/70 truncate">
                    {s.prompt}
                  </code>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  disabled={!!action}
                  onClick={() => onApprove(s)}
                  className="h-8 gap-1"
                >
                  {action === "approve" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!!action}
                  onClick={() => onReject(s)}
                  className="h-8 gap-1 text-muted-foreground hover:text-destructive"
                >
                  {action === "reject" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                  Dismiss
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
