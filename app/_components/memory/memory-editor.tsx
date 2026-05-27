"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  loadMemoryAction,
  saveMemoryFileAction,
  wipeMemoryAction,
  type MemoryFileSnapshot,
} from "@/lib/server/memory/actions";
import type { MemoryScope } from "@/lib/server/memory/types";

interface Props {
  scope: MemoryScope;
  rootId?: string;
  title: string;
  description: string;
  /** When true, show a subtle "Wipe all" button. Off for the project card. */
  allowWipe?: boolean;
}

export function MemoryEditor({
  scope,
  rootId,
  title,
  description,
  allowWipe,
}: Props) {
  const [files, setFiles] = useState<MemoryFileSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await loadMemoryAction(
      rootId ? { scope, rootId } : { scope },
    );
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setFiles(res.files);
  }, [scope, rootId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg">{title}</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          </div>
          {allowWipe && files.length > 0 && (
            <WipeButton scope={scope} rootId={rootId} onWiped={reload} />
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <p className="text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </p>
        ) : (
          <div className="space-y-4">
            {files.map((f) => (
              <FileRow
                key={f.file}
                snapshot={f}
                scope={scope}
                rootId={rootId}
                onSaved={(next) =>
                  setFiles((cur) =>
                    cur.map((s) => (s.file === next.file ? next : s)),
                  )
                }
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FileRow({
  snapshot,
  scope,
  rootId,
  onSaved,
}: {
  snapshot: MemoryFileSnapshot;
  scope: MemoryScope;
  rootId: string | undefined;
  onSaved: (next: MemoryFileSnapshot) => void;
}) {
  const [content, setContent] = useState(snapshot.content);
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    setContent(snapshot.content);
  }, [snapshot.content]);

  const trimmed = content.trim();
  const lines = trimmed ? trimmed.split("\n").length : 0;
  const overCap = lines > snapshot.cap;
  const nearCap = lines > snapshot.cap * 0.9;
  const dirty = content !== snapshot.content;

  const save = () => {
    if (overCap) {
      toast.error(
        `${snapshot.file} exceeds ${snapshot.cap}-line cap (${lines}). Trim before saving.`,
      );
      return;
    }
    startSaving(async () => {
      const res = await saveMemoryFileAction({
        scope,
        ...(rootId ? { rootId } : {}),
        file: snapshot.file,
        content: trimmed,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Save failed");
        return;
      }
      toast.success(`Saved ${snapshot.file}`);
      onSaved({ ...snapshot, content: trimmed, lines: res.lines });
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold">{snapshot.file}</span>
          <span className="text-xs text-muted-foreground">
            {snapshot.description}
          </span>
        </div>
        <span
          className={cn(
            "text-xs tabular-nums",
            overCap
              ? "text-destructive font-medium"
              : nearCap
                ? "text-amber-600"
                : "text-muted-foreground",
          )}
        >
          {lines}/{snapshot.cap}
        </span>
      </div>
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={Math.min(snapshot.cap + 2, Math.max(3, lines + 1))}
        placeholder="Empty"
        className="font-mono text-xs"
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant={dirty ? "default" : "ghost"}
          disabled={!dirty || saving || overCap}
          onClick={save}
        >
          {saving ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Save className="mr-1 h-3 w-3" />
          )}
          Save
        </Button>
      </div>
    </div>
  );
}

function WipeButton({
  scope,
  rootId,
  onWiped,
}: {
  scope: MemoryScope;
  rootId: string | undefined;
  onWiped: () => Promise<void>;
}) {
  const [wiping, startWiping] = useTransition();
  const click = () => {
    if (!confirm("Erase ALL memory at this scope? Cannot be undone.")) return;
    startWiping(async () => {
      const res = await wipeMemoryAction(
        rootId ? { scope, rootId } : { scope },
      );
      if (!res.ok) {
        toast.error(res.error ?? "Wipe failed");
        return;
      }
      toast.success("Memory wiped");
      await onWiped();
    });
  };
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={wiping}
      onClick={click}
      className="text-destructive hover:text-destructive"
    >
      <Trash2 className="mr-1 h-3 w-3" />
      Wipe all
    </Button>
  );
}
