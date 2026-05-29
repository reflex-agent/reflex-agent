"use client";

import { useEffect, useState, useTransition } from "react";
import { AudioLines, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getSettingsAction, saveTtsAction } from "@/lib/server/settings-actions";
import { listGeminiModelsAction } from "@/lib/server/youtube-actions";

// Static lists (kept client-side; the server gemini-tts module is server-only).
const VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];
// Fallback when the live model list can't be fetched (no key yet). The real
// list is pulled from Gemini `models.list` and filtered to TTS models, so new
// versions show up without a code change.
const FALLBACK_MODELS = [
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
];

type Provider = "system" | "gemini";

/**
 * Text-to-speech provider for produced audio ("озвучь …"). System `say` is
 * free/offline (default); Gemini sounds better with selectable voices but is
 * billed to the user's Gemini key.
 */
export function TtsSection() {
  const [provider, setProvider] = useState<Provider>("system");
  const [voice, setVoice] = useState("Kore");
  const [model, setModel] = useState(FALLBACK_MODELS[0]!);
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
  const [loaded, setLoaded] = useState(false);
  const [saving, startSave] = useTransition();

  useEffect(() => {
    void (async () => {
      const r = await getSettingsAction();
      if (r.ok && r.settings?.tts) {
        setProvider(r.settings.tts.provider);
        setVoice(r.settings.tts.geminiVoice);
        setModel(r.settings.tts.geminiModel);
      }
      setLoaded(true);
    })();
  }, []);

  // Pull the live Gemini model list (filtered to TTS) once Gemini is selected,
  // so the dropdown tracks Google's current versions instead of a hardcoded
  // set. Falls back to FALLBACK_MODELS when no key / fetch fails.
  useEffect(() => {
    if (provider !== "gemini") return;
    void (async () => {
      // refresh:true — always pull the freshest list so newly-shipped TTS
      // models (e.g. gemini-3.1-flash-tts-preview) show up immediately.
      const r = await listGeminiModelsAction(true);
      if (!r.ok) return; // no key yet → keep fallback list
      const tts = r.models.map((m) => m.id).filter((id) => /tts/i.test(id));
      if (tts.length > 0) setModels(tts);
    })();
  }, [provider]);

  const persist = (next: {
    provider: Provider;
    geminiVoice: string;
    geminiModel: string;
  }) => {
    startSave(async () => {
      const r = await saveTtsAction(next);
      if (!r.ok) {
        toast.error(r.error ?? "Failed to save");
        return;
      }
      toast.success("TTS settings saved");
    });
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AudioLines className="h-4 w-4" />
          <span>Text-to-speech</span>
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>
        <p className="text-xs text-muted-foreground">
          Voice used for audio the agent produces (e.g. when you ask it to
          &ldquo;озвучь …&rdquo;). The system voice is free and offline; Gemini
          sounds better with selectable voices.
        </p>

        <div className="space-y-1.5">
          <Label className="text-xs">Provider</Label>
          <Select
            value={provider}
            onValueChange={(v) => {
              const p = v as Provider;
              setProvider(p);
              persist({ provider: p, geminiVoice: voice, geminiModel: model });
            }}
            disabled={!loaded || saving}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System — macOS say (free)</SelectItem>
              <SelectItem value="gemini">Gemini — high quality (paid)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {provider === "gemini" && (
          <div className="space-y-3 border-t pt-3">
            <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Gemini TTS is <strong>billed to your Gemini API key — not
                free</strong> (per-character pricing). Needs a key saved in
                Settings → Gemini above.
              </span>
            </p>
            <div className="space-y-1">
              <Label className="text-xs">Voice</Label>
              <Select
                value={voice}
                onValueChange={(v) => {
                  setVoice(v);
                  persist({ provider, geminiVoice: v, geminiModel: model });
                }}
                disabled={!loaded || saving}
              >
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOICES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Model</Label>
              <Select
                value={model}
                onValueChange={(m) => {
                  setModel(m);
                  persist({ provider, geminiVoice: voice, geminiModel: m });
                }}
                disabled={!loaded || saving}
              >
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...new Set([model, ...models].filter(Boolean))].map((m) => (
                    <SelectItem key={m} value={m}>
                      <span className="font-mono text-xs">{m}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
