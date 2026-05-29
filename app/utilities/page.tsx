import Link from "next/link";
import { Boxes, FolderPlus, Github, Shield, Trash2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { listUtilities } from "@/lib/server/utilities/store";
import { listRoots } from "@/lib/registry";
import { InstallFromGithubButton } from "./_components/install-from-github-button";
import { InstallFromArchiveButton } from "./_components/install-from-archive-button";
import { InstallFromMcpButton } from "./_components/install-from-mcp-button";
import { InstallViaAgentButton } from "./_components/install-via-agent-button";
import { RemoveUtilityButton } from "./_components/remove-utility-button";
import { CuratedGallery } from "./_components/curated-gallery";
import { loadSettings } from "@/lib/settings/store";

export const dynamic = "force-dynamic";

export default async function UtilitiesPage() {
  const [utilities, settings, roots, t] = await Promise.all([
    listUtilities({}),
    loadSettings(),
    listRoots(),
    getTranslations("app"),
  ]);
  const globals = utilities.filter((u) => u.scope === "global");
  const projects = utilities.filter((u) => u.scope === "project");
  // Install state is per-scope: a global utility is installed once; a project
  // utility is installed PER Space, so the gallery keeps offering it for the
  // Spaces that don't have it yet.
  const installedGlobal = globals.map((u) => u.manifest.id);
  const installedSpaces: Record<string, string[]> = {};
  for (const u of projects) {
    if (!u.rootId) continue;
    (installedSpaces[u.manifest.id] ??= []).push(u.rootId);
  }
  const spaces = roots.map((r) => ({
    id: r.id,
    label: r.path.split("/").filter(Boolean).pop() ?? r.path,
  }));
  const advanced = settings.uiMode === "advanced";
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <header className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t("utilities.title")}</h1>
          <p className="text-muted-foreground mt-1">
            {t("utilities.subtitle")}
          </p>
        </div>
        {advanced && (
          <div className="flex flex-wrap gap-2">
            <InstallFromGithubButton />
            <InstallFromArchiveButton />
            <InstallFromMcpButton />
            <InstallViaAgentButton />
          </div>
        )}
      </header>

      <section className="mb-8 space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">{t("utilities.catalogTitle")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("utilities.catalogSubtitle")}
        </p>
        <CuratedGallery
          installedGlobal={installedGlobal}
          installedSpaces={installedSpaces}
          spaces={spaces}
        />
      </section>

      <Separator className="my-6" />

      <Section
        title={t("utilities.installedTitle")}
        hint={t("utilities.installedHint", { count: utilities.length })}
        utilities={[...projects, ...globals]}
      />
      {advanced && (
        <>
          <Separator className="my-8" />
          <Section
            title={t("utilities.globalTitle")}
            hint={t("utilities.globalHint")}
            utilities={globals}
          />
          <Separator className="my-8" />
          {/* projectHint uses t.raw: it has a literal "<root>" that ICU
              MessageFormat would otherwise read as an unclosed tag. */}
          <Section
            title={t("utilities.projectTitle")}
            hint={String(t.raw("utilities.projectHint"))}
            utilities={projects}
          />
        </>
      )}
    </main>
  );
}

async function Section({
  title,
  hint,
  utilities,
}: {
  title: string;
  hint: string;
  utilities: Awaited<ReturnType<typeof listUtilities>>;
}) {
  const t = await getTranslations("app");
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {utilities.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t("utilities.empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {utilities.map((u) => (
            <Card key={`${u.scope}:${u.rootId ?? ""}:${u.manifest.id}`} className="group">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Boxes className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{u.manifest.name}</span>
                  <Badge variant="outline" className="ml-auto font-mono text-[10px]">
                    v{u.manifest.version}
                  </Badge>
                </CardTitle>
                <CardDescription className="line-clamp-2">
                  {u.manifest.description || t("utilities.noDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2 text-xs">
                {u.manifest.source?.origin?.startsWith("github:") && (
                  <Badge variant="secondary" className="gap-1">
                    <Github className="h-3 w-3" />
                    {u.manifest.source.origin.slice(7, u.manifest.source.origin.indexOf("@"))}
                  </Badge>
                )}
                {u.manifest.source?.type === "mcp" && (
                  <Badge variant="secondary">MCP</Badge>
                )}
                {u.manifest.source?.type === "agent" && (
                  <Badge variant="outline">{t("utilities.createdByAgent")}</Badge>
                )}
                {!u.bundleAvailable && (
                  <Badge variant="destructive" className="gap-1">
                    <Shield className="h-3 w-3" /> bundle missing
                  </Badge>
                )}
                {(u.manifest.serverActions?.length ?? 0) > 0 && (
                  <Badge variant="outline">
                    workers: {u.manifest.serverActions.length}
                  </Badge>
                )}
                <div className="ml-auto flex gap-1">
                  <Button asChild size="sm" variant="default">
                    <Link href={`/utilities/${u.scope}/${u.manifest.id}${u.rootId ? `?rootId=${u.rootId}` : ""}`}>
                      {t("utilities.openButton")}
                    </Link>
                  </Button>
                  <RemoveUtilityButton
                    scope={u.scope}
                    id={u.manifest.id}
                    name={u.manifest.name}
                    {...(u.rootId ? { rootId: u.rootId } : {})}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
