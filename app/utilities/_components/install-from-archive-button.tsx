"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileArchive, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Install a utility from a local `.zip`. Posts the archive to
 * `/api/utilities/install-archive`; the server unzips, validates the
 * manifest, and builds. Global scope only for now (mirrors the GitHub
 * button's current limitation).
 */
export function InstallFromArchiveButton() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, startInstall] = useTransition();
  const [, setTick] = useState(0);
  const router = useRouter();

  const onPick = (file: File) => {
    startInstall(async () => {
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("scope", "global");
        const res = await fetch("/api/utilities/install-archive", {
          method: "POST",
          body: form,
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          id?: string;
          error?: string;
        };
        if (!res.ok || !body.ok) {
          toast.error(body.error ?? `HTTP ${res.status}`);
          return;
        }
        toast.success(`Installed: ${body.id}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setTick((n) => n + 1);
      }
    });
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <FileArchive className="mr-2 h-4 w-4" />
        )}
        Install from zip
      </Button>
    </>
  );
}
