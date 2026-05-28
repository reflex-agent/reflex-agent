"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Github,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  githubInstallAction,
  githubPreviewAction,
  type GithubInstallActionResult,
} from "@/lib/server/utilities/actions";
import type {
  Manifest,
  Permissions,
  UtilityScope,
} from "@/lib/server/utilities/types";

interface PreviewState {
  source: { owner: string; repo: string; ref: string; sha: string };
  manifest: Manifest;
  files: Record<string, string>;
  sizes: Record<string, number>;
}

export function InstallFromGithubButton() {
  const t = useTranslations("app");
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [scope, setScope] = useState<UtilityScope>("global");
  const [previewing, startPreview] = useTransition();
  const [installing, startInstall] = useTransition();
  const router = useRouter();

  const fetchPreview = () => {
    if (!url.trim()) return;
    startPreview(async () => {
      const res = await githubPreviewAction(url.trim());
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setPreview(res.preview as PreviewState);
    });
  };

  const install = () => {
    if (!preview) return;
    startInstall(async () => {
      const res: GithubInstallActionResult = await githubInstallAction({
        preview: preview as Parameters<typeof githubInstallAction>[0]["preview"],
        scope,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(t("utilities.github.installedToast", { id: res.id }));
      setOpen(false);
      setUrl("");
      setPreview(null);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Github className="mr-2 h-4 w-4" /> {t("utilities.github.installButton")}
      </Button>
    );
  }

  return (
    <Card className="fixed inset-x-4 top-16 z-50 mx-auto max-w-2xl shadow-2xl sm:inset-x-auto sm:right-6">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Github className="h-4 w-4" /> {t("utilities.github.cardTitle")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("utilities.github.cardSubtitle")}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setPreview(null);
            setUrl("");
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            fetchPreview();
          }}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("utilities.github.urlPlaceholder")}
            className="font-mono text-xs"
          />
          <Button type="submit" disabled={previewing || !url.trim()}>
            {previewing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("utilities.github.requesting")}
              </>
            ) : (
              t("utilities.github.getPreview")
            )}
          </Button>
        </form>

        {preview && (
          <div className="space-y-3 rounded-md border p-4 bg-muted/30">
            <div className="flex items-baseline gap-3 flex-wrap">
              <div className="text-base font-semibold">{preview.manifest.name}</div>
              <Badge variant="outline" className="font-mono text-[10px]">
                v{preview.manifest.version}
              </Badge>
              <Badge variant="secondary" className="font-mono text-[10px]">
                github:{preview.source.owner}/{preview.source.repo}@
                {preview.source.sha.slice(0, 7)}
              </Badge>
            </div>
            {preview.manifest.author && (
              <p className="text-xs text-muted-foreground">
                {t("utilities.github.author", { author: preview.manifest.author })}
              </p>
            )}
            {preview.manifest.description && (
              <p className="text-sm">{preview.manifest.description}</p>
            )}

            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                <ShieldAlert className="h-3 w-3" /> {t("utilities.github.permissionsTitle")}
              </div>
              <PermissionsView permissions={preview.manifest.permissions} />
            </div>

            {preview.manifest.dependencies &&
              Object.keys(preview.manifest.dependencies).length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                    {t("utilities.github.dependenciesTitle")}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(preview.manifest.dependencies).map(
                      ([pkg, ver]) => (
                        <Badge
                          key={pkg}
                          variant="outline"
                          className="font-mono text-[10px]"
                        >
                          {pkg}@{ver}
                        </Badge>
                      ),
                    )}
                  </div>
                </div>
              )}

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {t("utilities.github.filesInRepo", { count: Object.keys(preview.files).length })}
              </summary>
              <ul className="mt-1 font-mono text-[11px] space-y-0.5">
                {Object.entries(preview.sizes).map(([name, size]) => (
                  <li key={name} className="flex justify-between gap-3">
                    <span className="truncate">{name}</span>
                    <span className="text-muted-foreground shrink-0">
                      {formatSize(size)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>

            <div className="flex items-center gap-3 pt-2 border-t">
              <div className="flex-1">
                <Label className="text-xs">{t("utilities.github.installInto")}</Label>
                <Select
                  value={scope}
                  onValueChange={(v) => setScope(v as UtilityScope)}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">
                      {t("utilities.github.globalOption")}
                    </SelectItem>
                    <SelectItem value="project" disabled>
                      {t("utilities.github.projectOption")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={install}
                disabled={installing}
                size="lg"
                className="self-end"
              >
                {installing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("utilities.github.installing")}
                  </>
                ) : (
                  <>
                    <ShieldCheck className="mr-2 h-4 w-4" /> {t("utilities.github.installButtonShort")}
                  </>
                )}
              </Button>
            </div>
            <div className="flex items-start gap-2 text-[11px] text-muted-foreground rounded bg-amber-100/40 border border-amber-200 px-2 py-1.5">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-amber-700" />
              <span>
                {t("utilities.github.warning")}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PermissionsView({ permissions }: { permissions: Permissions }) {
  const t = useTranslations("app");
  const chips: { label: string; severity: "info" | "warn" | "danger" }[] = [];
  if (permissions.llm?.tasks?.length) {
    chips.push({
      label: `llm: ${permissions.llm.tasks.join(", ")}`,
      severity: "info",
    });
  }
  if (permissions.kb?.read) chips.push({ label: "kb.read", severity: "info" });
  if (permissions.kb?.write)
    chips.push({ label: "kb.write", severity: "warn" });
  if (permissions.fs?.sandbox)
    chips.push({ label: "fs (sandbox)", severity: "info" });
  if (permissions.web?.fetch?.domains?.length) {
    chips.push({
      label: `web.fetch → ${permissions.web.fetch.domains.join(", ")}`,
      severity: "warn",
    });
  }
  if (permissions.web?.search)
    chips.push({ label: "web.search", severity: "warn" });
  if (permissions.audit?.write)
    chips.push({ label: "audit.write", severity: "info" });
  if (permissions.workers?.enabled)
    chips.push({ label: "workers (server actions)", severity: "danger" });
  if (chips.length === 0) {
    return (
      <span className="text-xs italic text-muted-foreground">
        {t("utilities.github.noPermissions")}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <Badge
          key={c.label}
          variant="outline"
          className={
            c.severity === "danger"
              ? "border-destructive text-destructive"
              : c.severity === "warn"
                ? "border-amber-600 text-amber-700"
                : ""
          }
        >
          {c.label}
        </Badge>
      ))}
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
