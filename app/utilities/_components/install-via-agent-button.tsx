"use client";

import { useState } from "react";
import { Bot, Check, Copy, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * For arbitrary GitHub repos that aren't already Reflex utilities, the
 * pragmatic adapter is "ask an agent to wrap it." This button just prepares
 * a prompt with the right `<<reflex:utility>>` instructions and lets the
 * user paste it into any project chat — the agent will analyse the repo,
 * generate a Reflex-compatible wrapper, and emit the install directive.
 */
export function InstallViaAgentButton() {
  const t = useTranslations("app");
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);

  // Use t.raw (no ICU parsing): the prompt body intentionally contains
  // `<<reflex:utility>>{...}` / `<<reflex:question>>` markers and literal
  // braces that ICU MessageFormat would reject (INVALID_TAG). Interpolate
  // {url} ourselves.
  const prompt = String(t.raw("utilities.viaAgent.promptBody")).replace(
    /\{url\}/g,
    url.trim() || "<github URL here>",
  );

  const copy = async () => {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    toast.success(t("utilities.viaAgent.promptCopied"));
    setTimeout(() => setCopied(false), 1500);
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} variant="outline" className="gap-2">
        <Bot className="h-4 w-4" />
        {t("utilities.viaAgent.button")}
      </Button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-6">
      <Card className="w-full max-w-2xl">
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              {t("utilities.viaAgent.cardTitle")}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {t("utilities.viaAgent.cardSubtitle")}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>GitHub URL</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
            />
          </div>
          <div>
            <Label className="flex items-center justify-between">
              <span>{t("utilities.viaAgent.promptLabel")}</span>
              <Button size="sm" variant="ghost" onClick={copy} className="gap-1">
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? t("utilities.viaAgent.copied") : t("utilities.viaAgent.copy")}
              </Button>
            </Label>
            <Textarea
              value={prompt}
              readOnly
              className="font-mono text-xs h-64"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("utilities.viaAgent.footer1")}
            <code className="font-mono mx-1">{"<<reflex:utility>>"}</code>
            {t("utilities.viaAgent.footer2")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

