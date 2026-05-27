"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IMAGE_FORMATS,
  LANGUAGE_PRESETS,
  TASK_IDS,
  TASK_LABELS,
  type HarnessId,
  type ImageFormat,
  type Settings,
  type TaskId,
} from "@/lib/settings";
import { PromptTemplatesEditor } from "./prompt-templates-editor";
import { McpServersSection } from "./mcp-servers-section";
import { OAuthProvidersSection } from "./oauth-providers-section";
import { MemoryEditor } from "@/app/_components/memory/memory-editor";
import { GeminiSection } from "./gemini-section";
import { ImageSearchSection } from "./image-search-section";
import { MapServicesSection } from "./map-services-section";
import { NgrokSection } from "./ngrok-section";
import type { ModelInfo, ProbeResult } from "@/lib/harnesses/types";
import {
  listModelsAction,
  probeHarnessAction,
  saveSettingsAction,
} from "@/lib/server/settings-actions";

interface Props {
  initialSettings: Settings;
  harnesses: Array<{
    id: HarnessId;
    label: string;
    supports: TaskId[];
  }>;
}

export function SettingsForm({ initialSettings, harnesses }: Props) {
  const t = useTranslations("settings");
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [models, setModels] = useState<Record<HarnessId, ModelInfo[] | null>>({
    "claude-code": null,
    codex: null,
    ollama: null,
  });
  const [modelErrors, setModelErrors] = useState<
    Record<HarnessId, string | null>
  >({
    "claude-code": null,
    codex: null,
    ollama: null,
  });
  const [loading, setLoading] = useState<Record<HarnessId, boolean>>({
    "claude-code": false,
    codex: false,
    ollama: false,
  });
  const [probes, setProbes] = useState<Record<HarnessId, ProbeResult | null>>({
    "claude-code": null,
    codex: null,
    ollama: null,
  });
  const [saving, startSaving] = useTransition();

  const refreshModels = useCallback(async (id: HarnessId) => {
    setLoading((l) => ({ ...l, [id]: true }));
    setModelErrors((e) => ({ ...e, [id]: null }));
    const res = await listModelsAction(id);
    setLoading((l) => ({ ...l, [id]: false }));
    if (res.ok) {
      setModels((m) => ({ ...m, [id]: res.models }));
    } else {
      setModelErrors((e) => ({ ...e, [id]: res.error }));
      setModels((m) => ({ ...m, [id]: [] }));
    }
  }, []);

  const refreshProbe = useCallback(async (id: HarnessId) => {
    const r = await probeHarnessAction(id);
    setProbes((p) => ({ ...p, [id]: r }));
  }, []);

  useEffect(() => {
    // Probe + load each harness's models on mount so the dropdowns start
    // populated with the live picture.
    harnesses.forEach((h) => {
      void refreshProbe(h.id);
      void refreshModels(h.id);
    });
  }, [harnesses, refreshProbe, refreshModels]);

  const setOllamaUrl = (url: string) => {
    setSettings((s) => ({
      ...s,
      harnesses: {
        ...s.harnesses,
        ollama: { ...s.harnesses.ollama, baseUrl: url },
      },
    }));
  };

  const toggleEnabled = (id: HarnessId, enabled: boolean) => {
    setSettings((s) => ({
      ...s,
      harnesses: {
        ...s.harnesses,
        [id]: { ...s.harnesses[id], enabled },
      },
    }));
  };

  const updateAssignment = (
    task: TaskId,
    patch: Partial<{
      harness: HarnessId;
      model: string;
      allowedTools: string[];
    }>,
  ) => {
    setSettings((s) => ({
      ...s,
      assignments: {
        ...s.assignments,
        [task]: { ...s.assignments[task], ...patch },
      },
    }));
  };

  const router = useRouter();
  const save = () => {
    startSaving(async () => {
      const res = await saveSettingsAction(settings);
      if (!res.ok) {
        toast.error(res.error ?? t("form.saveFailedFallback"));
        return;
      }
      toast.success(t("form.savedToast"));
      // Re-render server components so a language change takes effect.
      router.refresh();
    });
  };

  const setLanguage = (v: string) => {
    setSettings((s) => ({ ...s, language: v }));
  };

  const updateImageProcessing = (
    patch: Partial<Settings["imageProcessing"]>,
  ) => {
    setSettings((s) => ({
      ...s,
      imageProcessing: { ...s.imageProcessing, ...patch },
    }));
  };

  const LANGUAGE_LABELS: Record<string, string> = {
    en: "English",
    ru: "Русский",
  };

  const isAdvanced = settings.uiMode === "advanced";
  const toggleAdvanced = () => {
    const next: Settings = {
      ...settings,
      uiMode: isAdvanced ? "simple" : "advanced",
    };
    setSettings(next);
    // Persist immediately so the toggle survives a navigation away.
    void saveSettingsAction(next);
  };

  return (
    <div className="space-y-8">
      <Card className="border-violet-200 dark:border-violet-900/50 bg-violet-50/40 dark:bg-violet-950/20">
        <CardContent className="pt-5 pb-5 flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium">
              {isAdvanced ? t("uiMode.advancedTitle") : t("uiMode.simpleTitle")}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isAdvanced
                ? t("uiMode.advancedHint")
                : t("uiMode.simpleHint")}
            </p>
          </div>
          <Button
            type="button"
            variant={isAdvanced ? "outline" : "default"}
            size="sm"
            onClick={toggleAdvanced}
          >
            {isAdvanced ? t("uiMode.switchToSimple") : t("uiMode.switchToAdvanced")}
          </Button>
        </CardContent>
      </Card>
      <section>
        <h2 className="text-lg font-semibold mb-3">Memory</h2>
        <MemoryEditor
          scope="global"
          title="What Reflex remembers about you"
          description="These files are loaded into every chat so the agent has context. Edit any line directly, or let the agent maintain them as you talk."
          allowWipe
        />
      </section>
      <section>
        <h2 className="text-lg font-semibold mb-3">Interface &amp; content language</h2>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground mb-3">
              Switches the UI and the language the agent writes in. Code,
              paths, and quoted source stay verbatim.
            </p>
            <div className="max-w-xs">
              <Select
                value={
                  (LANGUAGE_PRESETS as readonly string[]).includes(
                    settings.language,
                  )
                    ? settings.language
                    : "en"
                }
                onValueChange={(v) => setLanguage(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_PRESETS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {LANGUAGE_LABELS[p] ?? p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">{t("imageProcessing.title")}</h2>
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm">
                  {t.rich("imageProcessing.description", {
                    dir: (chunks) => (
                      <code className="font-mono text-xs">{chunks}</code>
                    ),
                  })}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t("imageProcessing.hint")}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Label htmlFor="img-enabled" className="text-xs">
                  {t("imageProcessing.enabledLabel")}
                </Label>
                <Switch
                  id="img-enabled"
                  checked={settings.imageProcessing.enabled}
                  onCheckedChange={(v) =>
                    updateImageProcessing({ enabled: v })
                  }
                />
              </div>
            </div>
            <div
              className={
                settings.imageProcessing.enabled
                  ? "space-y-4"
                  : "space-y-4 opacity-50 pointer-events-none"
              }
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("imageProcessing.maxDimensionLabel")}
                  </Label>
                  <span className="font-mono text-xs">
                    {settings.imageProcessing.maxDimension}px
                  </span>
                </div>
                <Slider
                  min={256}
                  max={8192}
                  step={64}
                  value={[settings.imageProcessing.maxDimension]}
                  onValueChange={(v) =>
                    updateImageProcessing({ maxDimension: v[0] ?? 2000 })
                  }
                />
                <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                  <span>256</span>
                  <span>2048</span>
                  <span>4096</span>
                  <span>8192</span>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("imageProcessing.qualityLabel")}
                  </Label>
                  <span className="font-mono text-xs">
                    {settings.imageProcessing.quality}
                  </span>
                </div>
                <Slider
                  min={40}
                  max={100}
                  step={1}
                  value={[settings.imageProcessing.quality]}
                  onValueChange={(v) =>
                    updateImageProcessing({ quality: v[0] ?? 85 })
                  }
                />
              </div>
              <div className="max-w-xs">
                <Label className="text-xs text-muted-foreground">{t("imageProcessing.formatLabel")}</Label>
                <Select
                  value={settings.imageProcessing.format}
                  onValueChange={(v) =>
                    updateImageProcessing({ format: v as ImageFormat })
                  }
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {IMAGE_FORMATS.map((f) => (
                      <SelectItem key={f} value={f}>
                        <span className="font-mono">{f}</span>
                        <span className="ml-2 text-muted-foreground text-xs">
                          {f === "auto"
                            ? t("imageProcessing.format.auto")
                            : f === "jpeg"
                              ? t("imageProcessing.format.jpeg")
                              : f === "webp"
                                ? t("imageProcessing.format.webp")
                                : t("imageProcessing.format.original")}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {isAdvanced && (
      <section>
        <h2 className="text-lg font-semibold mb-3">Harnesses</h2>
        <div className="grid gap-4">
          {harnesses.map((h) => {
            const probe = probes[h.id];
            const enabled = settings.harnesses[h.id].enabled;
            return (
              <Card key={h.id}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        {h.label}
                        <ProbeBadge probe={probe} />
                      </CardTitle>
                      <CardDescription>
                        {probe ? probe.detail : "checking…"}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-3">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void refreshProbe(h.id);
                          void refreshModels(h.id);
                        }}
                        disabled={loading[h.id]}
                      >
                        <RefreshCw
                          className={`mr-1 h-4 w-4 ${
                            loading[h.id] ? "animate-spin" : ""
                          }`}
                        />
                        Refresh
                      </Button>
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`enable-${h.id}`} className="text-xs">
                          enabled
                        </Label>
                        <Switch
                          id={`enable-${h.id}`}
                          checked={enabled}
                          onCheckedChange={(v) => toggleEnabled(h.id, v)}
                        />
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {h.id === "ollama" && (
                    <div className="mb-3 flex items-center gap-2 max-w-md">
                      <Label
                        htmlFor="ollama-url"
                        className="text-xs w-24 shrink-0"
                      >
                        Base URL
                      </Label>
                      <Input
                        id="ollama-url"
                        value={settings.harnesses.ollama.baseUrl}
                        onChange={(e) => setOllamaUrl(e.target.value)}
                        placeholder="http://localhost:11434"
                        className="font-mono text-xs"
                      />
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Models loaded:{" "}
                    {loading[h.id] ? (
                      <span>
                        <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                        loading…
                      </span>
                    ) : modelErrors[h.id] ? (
                      <span className="text-destructive">
                        {modelErrors[h.id]}
                      </span>
                    ) : (
                      `${models[h.id]?.length ?? 0}`
                    )}
                    {(models[h.id]?.length ?? 0) > 0 && (
                      <span className="ml-2">
                        ({models[h.id]?.[0]?.source})
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>
      )}

      {isAdvanced && (
      <section>
        <h2 className="text-lg font-semibold mb-3">Task assignments</h2>
        <div className="grid gap-4">
          {TASK_IDS.map((task) => {
            const assignment = settings.assignments[task];
            const eligibleHarnesses = harnesses.filter(
              (h) =>
                h.supports.includes(task) && settings.harnesses[h.id].enabled,
            );
            const harnessModels = models[assignment.harness] ?? [];
            const modelSource = harnessModels[0]?.source;
            return (
              <Card key={task}>
                <CardHeader>
                  <CardTitle className="text-base">
                    {TASK_LABELS[task].title}
                  </CardTitle>
                  <CardDescription>{TASK_LABELS[task].help}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-col md:flex-row md:items-end gap-3">
                    <div className="flex-1 max-w-[200px]">
                      <Label className="text-xs text-muted-foreground">
                        Harness
                      </Label>
                      <Select
                        value={assignment.harness}
                        onValueChange={(v) =>
                          updateAssignment(task, {
                            harness: v as HarnessId,
                            // Reset model when harness changes.
                            model: models[v as HarnessId]?.[0]?.id ?? "",
                          })
                        }
                      >
                        <SelectTrigger className="mt-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {eligibleHarnesses.map((h) => (
                            <SelectItem key={h.id} value={h.id}>
                              {h.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-muted-foreground">
                          Model
                        </Label>
                        {modelSource && (
                          <Badge
                            variant={
                              modelSource === "live" ? "default" : "secondary"
                            }
                            className="text-[10px] uppercase"
                          >
                            {modelSource}
                          </Badge>
                        )}
                      </div>
                      {harnessModels.length > 0 ? (
                        <Select
                          value={assignment.model}
                          onValueChange={(v) =>
                            updateAssignment(task, { model: v })
                          }
                        >
                          <SelectTrigger className="mt-1">
                            <SelectValue placeholder="select model" />
                          </SelectTrigger>
                          <SelectContent>
                            {harnessModels.map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                <span className="font-mono">{m.id}</span>
                                {m.size && (
                                  <span className="ml-2 text-muted-foreground text-xs">
                                    {m.size}
                                  </span>
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={assignment.model}
                          onChange={(e) =>
                            updateAssignment(task, { model: e.target.value })
                          }
                          placeholder="model id"
                          className="mt-1 font-mono text-xs"
                        />
                      )}
                    </div>
                  </div>
                  {assignment.harness === "claude-code" && (
                    <ToolsPolicyEditor
                      tools={assignment.allowedTools}
                      onChange={(v) =>
                        updateAssignment(task, { allowedTools: v })
                      }
                    />
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-3">Gemini</h2>
        <GeminiSection />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">{t("imageSearch.title")}</h2>
        <ImageSearchSection />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">{t("oauth.title")}</h2>
        <p className="text-sm text-muted-foreground mb-3">
          {t.rich("oauth.description", {
            code: (chunks) => <code>{chunks}</code>,
            uri: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
        <OAuthProvidersSection />
      </section>

      {isAdvanced && (
      <section>
        <h2 className="text-lg font-semibold mb-3">{t("mcpServers.title")}</h2>
        <p className="text-sm text-muted-foreground mb-3">
          {t.rich("mcpServers.description", {
            code: (chunks) => <code>{chunks}</code>,
            path: (chunks) => <code>{chunks}</code>,
          })}
        </p>
        <McpServersSection />
      </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-3">{t("mapServices.title")}</h2>
        <p className="text-sm text-muted-foreground mb-3">
          {t("mapServices.description")}
        </p>
        <MapServicesSection
          settings={settings}
          onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">{t("ngrok.title")}</h2>
        <p className="text-sm text-muted-foreground mb-3">
          {t("ngrok.description")}
        </p>
        <NgrokSection
          settings={settings}
          onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        />
      </section>

      {isAdvanced && (
      <section>
        <h2 className="text-lg font-semibold mb-3">Prompt templates</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Stored on disk under <code>~/.reflex/prompts/</code>. Edit here or
          directly in any editor. Use <code>{"{{language}}"}</code>,{" "}
          <code>{"{{scope}}"}</code>, etc. — variable list is shown per
          template.
        </p>
        <PromptTemplatesEditor />
      </section>
      )}

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" /> Save settings
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

const CLAUDE_TOOL_SUGGESTIONS = [
  "Read",
  "Write",
  "Edit",
  "LS",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "Task",
  "NotebookEdit",
];

function ToolsPolicyEditor({
  tools,
  onChange,
}: {
  tools: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useTranslations("settings");
  const remove = (tool: string) => onChange(tools.filter((x) => x !== tool));
  const add = (tool: string) => {
    const v = tool.trim();
    if (!v) return;
    if (tools.includes(v)) return;
    onChange([...tools, v]);
  };
  const [draft, setDraft] = useState("");
  const inactive = CLAUDE_TOOL_SUGGESTIONS.filter((tool) => !tools.includes(tool));
  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <Label className="text-xs text-muted-foreground">
          Allowed tools (claude-code)
        </Label>
        <span className="text-[10px] text-muted-foreground">
          {t("toolsPolicy.noToolsHint")}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tools.length === 0 && (
          <span className="text-[11px] italic text-muted-foreground">
            {t("toolsPolicy.usingDefaults")}
          </span>
        )}
        {tools.map((tool) => (
          <Badge key={tool} variant="secondary" className="gap-1 font-mono">
            {tool}
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => remove(tool)}
            >
              ×
            </button>
          </Badge>
        ))}
      </div>
      {inactive.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {inactive.map((tool) => (
            <button
              key={tool}
              type="button"
              onClick={() => add(tool)}
              className="text-[11px] font-mono rounded px-1.5 py-0.5 border border-dashed border-muted-foreground/40 text-muted-foreground hover:border-foreground hover:text-foreground"
            >
              + {tool}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          add(draft);
          setDraft("");
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("toolsPolicy.customToolPlaceholder")}
          className="h-7 text-xs font-mono"
        />
        <Button type="submit" size="sm" variant="ghost" className="h-7">
          +
        </Button>
      </form>
    </div>
  );
}

function ProbeBadge({ probe }: { probe: ProbeResult | null }) {
  if (!probe) {
    return (
      <Badge variant="outline" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" /> checking
      </Badge>
    );
  }
  if (probe.available) {
    return (
      <Badge variant="default" className="gap-1 bg-emerald-600">
        <CheckCircle2 className="h-3 w-3" /> available
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="gap-1">
      <AlertCircle className="h-3 w-3" /> unavailable
    </Badge>
  );
}
