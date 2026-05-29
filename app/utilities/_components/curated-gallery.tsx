"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Download, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  installCuratedAction,
  listCuratedAction,
} from "@/lib/server/utilities/actions";

interface CuratedItem {
  id: string;
  name: string;
  emoji: string;
  category: string;
  description: string;
  github: string;
  suggestedScope?: "global" | "project";
  author?: string;
}

const CATEGORY_KEY: Record<string, string> = {
  finance: "utilities.curated.catFinance",
  health: "utilities.curated.catHealth",
  productivity: "utilities.curated.catProductivity",
  travel: "utilities.curated.catTravel",
  study: "utilities.curated.catStudy",
  creative: "utilities.curated.catCreative",
  other: "utilities.curated.catOther",
};

interface SpaceOpt {
  id: string;
  label: string;
}

/**
 * Curated catalogue of utilities. Click "Install" → one-shot
 * preview+install behind the scenes (no GitHub URL dialog). Installed
 * utilities are detected via the rendered list reload after success.
 *
 * Project-scoped utilities need a target rootId. If exactly one Space
 * exists, we auto-pick it; otherwise the user gets a tiny picker before
 * the install fires.
 */
export function CuratedGallery({
  installedGlobal,
  installedSpaces,
  spaces,
}: {
  /** Ids of globally-installed utilities. */
  installedGlobal: string[];
  /** Per project-utility id → rootIds it's installed in. */
  installedSpaces: Record<string, string[]>;
  spaces: SpaceOpt[];
}) {
  const router = useRouter();
  const t = useTranslations("app");
  const [items, setItems] = useState<CuratedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [installing, startInstall] = useTransition();
  const [pickerForId, setPickerForId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await listCuratedAction();
        if (!cancelled) setItems(r.items);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => set.add(i.category));
    return ["all", ...Array.from(set).sort()];
  }, [items]);

  const visible =
    filter === "all" ? items : items.filter((i) => i.category === filter);

  const doInstall = (item: CuratedItem, rootId?: string) => {
    setActive(item.id);
    startInstall(async () => {
      const scope = item.suggestedScope ?? "global";
      const r = await installCuratedAction({
        github: item.github,
        scope,
        ...(scope === "project" && rootId ? { rootId } : {}),
      });
      setActive(null);
      setPickerForId(null);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const spaceLabel = rootId
        ? spaces.find((s) => s.id === rootId)?.label
        : undefined;
      toast.success(
        spaceLabel
          ? t("utilities.curated.installedToastIn", { name: item.name, space: spaceLabel })
          : t("utilities.curated.installedToast", { name: item.name }),
      );
      router.refresh();
    });
  };

  const handleInstallClick = (item: CuratedItem) => {
    const scope = item.suggestedScope ?? "global";
    if (scope === "global") {
      doInstall(item);
      return;
    }
    // project scope: need a rootId.
    if (spaces.length === 0) {
      toast.error(t("utilities.curated.needSpace"));
      return;
    }
    if (spaces.length === 1) {
      doInstall(item, spaces[0]!.id);
      return;
    }
    // Multiple — open inline picker.
    setPickerForId((cur) => (cur === item.id ? null : item.id));
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("utilities.curated.loading")}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("utilities.curated.empty")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Sparkles className="h-3 w-3 text-violet-600" />
        <span className="text-[11px] text-muted-foreground mr-2">
          {t("utilities.curated.categoryLabel")}
        </span>
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setFilter(c)}
            className={
              "rounded-full px-2 py-0.5 text-[11px] " +
              (filter === c
                ? "bg-violet-600 text-white"
                : "border bg-card hover:bg-accent")
            }
          >
            {c === "all"
              ? t("utilities.curated.categoryAll")
              : CATEGORY_KEY[c]
                ? t(CATEGORY_KEY[c])
                : c}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((item) => {
          const scope = item.suggestedScope ?? "global";
          const doneSpaces = installedSpaces[item.id] ?? [];
          // Project utilities are per-Space: "installed" (button retired) only
          // once every Space has it. A global utility is installed once.
          const installed =
            scope === "global"
              ? installedGlobal.includes(item.id)
              : spaces.length > 0 && spaces.every((s) => doneSpaces.includes(s.id));
          const busy = active === item.id && installing;
          return (
            <Card key={item.id} className="group">
              <CardContent className="pt-4 pb-4 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="text-2xl leading-none">{item.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{item.name}</div>
                    <div className="text-[10px] text-muted-foreground font-mono truncate">
                      {item.author ? `${item.author}/` : ""}
                      {item.id}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    {CATEGORY_KEY[item.category]
                      ? t(CATEGORY_KEY[item.category])
                      : item.category}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {item.description}
                </p>
                <div className="pt-1">
                  {installed ? (
                    <button
                      type="button"
                      disabled
                      className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-emerald-700 cursor-default"
                    >
                      <Check className="h-3 w-3" />
                      {t("utilities.curated.installed")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleInstallClick(item)}
                      disabled={busy || installing}
                      className="inline-flex items-center gap-1 rounded bg-violet-600 px-2 py-1 text-xs text-white hover:bg-violet-700 disabled:opacity-50"
                    >
                      {busy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : item.suggestedScope === "project" &&
                        spaces.length > 1 ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <Download className="h-3 w-3" />
                      )}
                      {item.suggestedScope === "project" && spaces.length > 1
                        ? t("utilities.curated.intoSpace")
                        : t("utilities.curated.install")}
                    </button>
                  )}
                  {pickerForId === item.id && (
                    <ul className="mt-2 rounded-md border bg-popover shadow-sm divide-y">
                      {spaces.map((s) => {
                        const here = doneSpaces.includes(s.id);
                        return (
                          <li key={s.id}>
                            <button
                              type="button"
                              onClick={() => !here && doInstall(item, s.id)}
                              disabled={here || busy || installing}
                              className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-accent disabled:hover:bg-transparent inline-flex items-center gap-1.5"
                            >
                              {here ? (
                                <Check className="h-3 w-3 text-emerald-600" />
                              ) : (
                                <Download className="h-3 w-3 text-violet-600" />
                              )}
                              <span className="truncate">{s.label}</span>
                              {here && (
                                <span className="ml-auto text-[10px] text-emerald-700">
                                  {t("utilities.curated.installed")}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                      <li>
                        <button
                          type="button"
                          onClick={() => setPickerForId(null)}
                          className="w-full text-left px-2.5 py-1.5 text-[10px] text-muted-foreground hover:bg-accent"
                        >
                          {t("utilities.curated.cancel")}
                        </button>
                      </li>
                    </ul>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
