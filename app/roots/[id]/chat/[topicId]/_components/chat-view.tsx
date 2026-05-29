"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, Send, Sparkles, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/app/roots/[id]/_components/markdown-view";
import { CommandBarFrame } from "@/app/roots/[id]/_components/command-bar-frame";
import {
  ChatInputForm,
  type ChatAttachment,
} from "@/app/roots/[id]/_components/chat-input-form";
import { dispatchReflex, REFLEX_EVENTS } from "@/lib/client/events";
import type {
  AgentEvent,
  AgentMeta,
  AgentStatus,
} from "@/lib/server/agents/types";
import { ToolCall } from "./tool-call";
import {
  McpAddCard,
  PermissionCard,
  QuestionCard,
  type McpAddState,
  type PermissionState,
  type QuestionState,
} from "./interaction-cards";
import { KbWriteCard, type KbWriteState } from "./kb-write-card";
import { UtilityInstalledCard } from "./utility-installed-card";
import { WidgetPreviewCard } from "./widget-preview-card";
import { WorkflowPreviewCard } from "./workflow-preview-card";

interface Props {
  rootId: string;
  topicId: string;
  initialEvents: AgentEvent[];
  initialActive: boolean;
}

interface ToolState {
  toolUseId: string;
  name: string;
  input: unknown;
  result?: { content: string; isError?: boolean };
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolState }
  | { kind: "permission"; perm: PermissionState }
  | { kind: "question"; question: QuestionState }
  | { kind: "kb"; kb: KbWriteState }
  | { kind: "mcp-add"; entry: McpAddState }
  | {
      kind: "utility";
      utility: {
        id: string;
        name: string;
        scope: "global" | "project";
        version: string;
      };
    }
  | {
      kind: "widget";
      widget: {
        op: "create" | "update";
        widgetId: string;
        title: string;
        description?: string;
        widgetKind: string;
        data: unknown;
        sourceTopicId?: string;
      };
    }
  | {
      kind: "workflow";
      workflow: {
        workflowId: string;
        label: string;
        description?: string;
        trigger: string;
        stepCount: number;
      };
    };

interface Turn {
  kind: "user" | "assistant" | "system" | "onboarding-done";
  agentId?: string;
  agentLabel?: string;
  agentRole?: string;
  agentModel?: string;
  body?: string;
  systemSubtype?: string;
  segments?: Segment[];
  pending?: boolean;
  error?: string;
}

/**
 * Renders a topic by playing its events.jsonl back into chat turns, then
 * subscribing to /stream for live updates. Subprocess lives in the background
 * on the server (AgentManager), so closing the tab no longer kills it.
 */
export function ChatView({
  rootId,
  topicId,
  initialEvents,
  initialActive,
}: Props) {
  const t = useTranslations("roots");
  const [events, setEvents] = useState<AgentEvent[]>(initialEvents);
  const [active, setActive] = useState(initialActive);
  const [streamConnected, setStreamConnected] = useState(false);
  const lastSeq = useRef<number>(
    initialEvents.length > 0
      ? initialEvents[initialEvents.length - 1]!.seq
      : -1,
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const turns = useMemo(() => projectEvents(events), [events]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [turns, scrollToBottom]);

  // Subscribe to the live SSE stream — with auto-reconnect. A single fetch
  // ends on any blip (server restart, proxy/idle timeout, network drop); we
  // loop and re-open it, always with `since=lastSeq.current` so we resume
  // exactly where we left off (no gaps, no replays). Backoff caps at 15s and
  // resets on a successful connect. `applyEvent` dedupes by seq regardless.
  useEffect(() => {
    let stopped = false;
    let ctrl: AbortController | null = null;
    let backoff = 1000;

    const run = async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const url = `/api/roots/${rootId}/chat/${topicId}/stream?since=${lastSeq.current}`;
          const res = await fetch(url, { signal: ctrl.signal });
          if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
          setStreamConnected(true);
          backoff = 1000; // healthy connection — reset backoff
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break; // server closed — fall through to reconnect
            buf += dec.decode(value, { stream: true });
            for (const evt of splitSSE(buf)) {
              buf = evt.rest;
              if (evt.event === "event" && evt.data) {
                applyEvent(evt.data as AgentEvent);
              } else if (evt.event === "error") {
                toast.error(
                  String(
                    (evt.data as { message?: string })?.message ?? "stream",
                  ),
                );
              }
            }
          }
        } catch (err) {
          if (stopped) return;
          void err; // transient — reconnect below
        } finally {
          setStreamConnected(false);
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
      }
    };
    void run();

    return () => {
      stopped = true;
      ctrl?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, rootId]);

  const applyEvent = useCallback((ev: AgentEvent) => {
    if (ev.seq <= lastSeq.current) return;
    lastSeq.current = ev.seq;
    setEvents((cur) => [...cur, ev]);
    if (ev.type === "turn-start") {
      setActive(true);
    } else if (ev.type === "agent-start" && ev.meta.role === "orchestrator") {
      // Legacy logs (pre-turn-events) treated each agent-start as a turn.
      setActive(true);
    }
    if (ev.type === "turn-end" || ev.type === "agent-end") {
      setActive(false);
      dispatchReflex(REFLEX_EVENTS.topicsChanged(rootId));
    }
    if (ev.type === "kb-write") {
      dispatchReflex(REFLEX_EVENTS.kbChanged(rootId));
    }
  }, [rootId]);

  const stop = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/roots/${rootId}/chat/${topicId}/stop`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? `HTTP ${res.status}`);
        return;
      }
      // Optimistically clear the local "active" flag — `agent-end` will
      // arrive on the stream shortly and confirm the state.
      setActive(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [rootId, topicId]);

  const send = useCallback(
    async (message: string, attachments: ChatAttachment[]): Promise<boolean> => {
      const trimmed = message.trim();
      if (!trimmed && attachments.length === 0) return false;
      try {
        const res = await fetch(
          `/api/roots/${rootId}/chat/${topicId}/send`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: trimmed, attachments }),
          },
        );
        if (res.status === 409) {
          toast.error(t("chat.waitForCurrentAnswer"));
          return false;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `HTTP ${res.status}`);
          return false;
        }
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [rootId, topicId],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b px-6 py-2 flex items-center gap-3 text-xs">
        <span className="text-muted-foreground inline-flex items-center gap-1">
          {streamConnected ? (
            <>
              <Wifi className="h-3 w-3 text-emerald-600" /> {t("chat.connectedToStream")}
            </>
          ) : (
            <>
              <WifiOff className="h-3 w-3 text-muted-foreground" /> {t("chat.offline")}
            </>
          )}
        </span>
        {active && (
          <Badge variant="default" className="gap-1 bg-emerald-600">
            <Loader2 className="h-3 w-3 animate-spin" /> {t("chat.agentWorking")}
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground font-mono">
          seq: {lastSeq.current}
        </span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6 space-y-4">
          {turns.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              {t("chat.topicEmpty")}
            </p>
          ) : (
            turns.map((t, i) => (
              <TurnView
                key={i}
                turn={t}
                rootId={rootId}
                topicId={topicId}
              />
            ))
          )}
        </div>
      </div>
      <CommandBarFrame label={t("chat.replyInTopicLabel")}>
        <ChatInputForm
          rootId={rootId}
          topicId={topicId}
          placeholder={t("chat.topicPlaceholder")}
          submitLabel={t("chat.send")}
          pendingLabel={t("chat.sendPending")}
          SubmitIcon={Send}
          active={active}
          onStop={stop}
          onSubmit={({ message, attachments }) => send(message, attachments)}
        />
      </CommandBarFrame>
    </div>
  );
}

function TurnView({
  turn,
  rootId,
  topicId,
}: {
  turn: Turn;
  rootId: string;
  topicId: string;
}) {
  const t = useTranslations("roots");
  const sendSummaryToChat = (text: string, url: string) => {
    const message = t("kb.summaryContextChat", { url, text });
    void fetch(`/api/roots/${rootId}/chat/${topicId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, attachments: [] }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `HTTP ${res.status}`);
          return;
        }
        toast.success(t("kb.summarySentToChat"));
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
      });
  };
  if (turn.kind === "system") {
    return <SystemEventTurn body={turn.body ?? ""} subtype={turn.systemSubtype} />;
  }
  if (turn.kind === "onboarding-done") {
    return <OnboardingDoneCard rootId={rootId} />;
  }
  if (turn.kind === "user") {
    // Briefs dispatched to sub-agents are emitted as user-messages on the
    // sub-agent's stream. The sub-agent's response is already shown
    // collapsed via SubAgentWrapper — showing the verbose brief on top of
    // every dispatch clutters the chat with internal traffic. Suppress.
    if (turn.agentRole === "subagent") return null;
    const body = turn.body ?? "";
    // Hide the bootstrap message Reflex auto-injects when spawning the
    // per-Space onboarding topic — the user didn't type it.
    if (/^\/skill\s+space-onboarding\s*$/.test(body.trim())) return null;
    const system = classifySystemUserMessage(body, {
      mcpSetupDefault: t("chat.mcpSetupDefault"),
      mcpSetupBadge: t("chat.mcpSetupBadge"),
      answerBadge: t("chat.answerBadge"),
      permissionBadge: t("chat.permissionBadge"),
      permissionUserDecision: t("chat.permissionUserDecision"),
      mcpBadge: t("chat.mcpBadge"),
      goalBadge: t("chat.goalBadge"),
      goalAutoContinue: t("chat.goalAutoContinue"),
      systemBadge: t("chat.systemBadge"),
      systemMessage: t("chat.systemMessage"),
    });
    if (system) {
      return <SystemUserTurn system={system} />;
    }
    return (
      <div className="rounded-lg border bg-muted/40 p-4">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
          user
        </div>
        <MarkdownView
          source={body}
          onSendToChat={sendSummaryToChat}
        />
      </div>
    );
  }
  const isSubAgent = turn.agentRole === "subagent";
  return (
    <SubAgentWrapper isSubAgent={isSubAgent} turn={turn}>
      <div
        className={
          isSubAgent
            ? "rounded-md border border-dashed bg-muted/30 px-3 py-2"
            : "rounded-lg border bg-background p-4"
        }
      >
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-2">
          <Sparkles className="h-3 w-3" />
          <span>{turn.agentLabel ?? "assistant"}</span>
          {isSubAgent && (
            <span className="text-[10px] normal-case px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 tracking-normal">
              sub-agent
            </span>
          )}
          {turn.agentModel && (
            <span className="font-mono text-[10px] normal-case tracking-normal">
              {turn.agentModel}
            </span>
          )}
          {turn.pending && <Loader2 className="h-3 w-3 animate-spin" />}
          {turn.error && (
            <span className="text-destructive text-xs normal-case">
              {t("chat.errorPrefix", { message: turn.error })}
            </span>
          )}
        </div>
      {turn.segments?.map((seg, i) => {
        if (seg.kind === "text") {
          const cleaned = stripProtocolMarkers(seg.text);
          return cleaned.trim() ? (
            <MarkdownView
              key={i}
              source={cleaned}
              onSendToChat={sendSummaryToChat}
            />
          ) : null;
        }
        if (seg.kind === "tool") {
          return (
            <ToolCall
              key={i}
              name={seg.tool.name}
              input={seg.tool.input}
              {...(seg.tool.result ? { result: seg.tool.result } : {})}
              pending={!seg.tool.result}
            />
          );
        }
        if (seg.kind === "permission") {
          return <PermissionCard key={i} perm={seg.perm} />;
        }
        if (seg.kind === "question") {
          return <QuestionCard key={i} question={seg.question} />;
        }
        if (seg.kind === "kb") {
          return <KbWriteCard key={i} rootId={rootId} entry={seg.kb} />;
        }
        if (seg.kind === "mcp-add") {
          return <McpAddCard key={i} entry={seg.entry} />;
        }
        if (seg.kind === "utility") {
          return (
            <UtilityInstalledCard key={i} utility={seg.utility} rootId={rootId} />
          );
        }
        if (seg.kind === "widget") {
          return (
            <WidgetPreviewCard
              key={i}
              rootId={rootId}
              widget={seg.widget}
            />
          );
        }
        if (seg.kind === "workflow") {
          return (
            <WorkflowPreviewCard
              key={i}
              rootId={rootId}
              workflow={seg.workflow}
            />
          );
        }
        return null;
      })}
        {turn.pending && (!turn.segments || turn.segments.length === 0) && (
          <p className="text-sm text-muted-foreground">{t("chat.thinking")}</p>
        )}
      </div>
    </SubAgentWrapper>
  );
}

/**
 * Collapses a sub-agent turn under an expandable `<details>` so the chat
 * isn't cluttered with the orchestrator's internal workers. Orchestrator
 * turns render their children directly.
 */
function SubAgentWrapper({
  isSubAgent,
  turn,
  children,
}: {
  isSubAgent: boolean;
  turn: Turn;
  children: React.ReactNode;
}) {
  const t = useTranslations("roots");
  if (!isSubAgent) return <>{children}</>;
  const summary = [
    turn.agentLabel ?? "sub-agent",
    turn.pending
      ? t("chat.subAgentWorking")
      : turn.error
        ? t("chat.subAgentError")
        : t("chat.subAgentDone"),
  ].join(" · ");
  return (
    <details className="group" open={turn.pending}>
      <summary className="cursor-pointer list-none flex items-center gap-2 text-xs text-muted-foreground border-l-2 border-violet-300 pl-2 py-1 hover:text-foreground select-none">
        <span className="inline-block h-3 w-3 text-center transition-transform group-open:rotate-90">
          ▸
        </span>
        <Sparkles className="h-3 w-3 text-violet-500" />
        <span>{summary}</span>
        {turn.pending && <Loader2 className="h-3 w-3 animate-spin" />}
      </summary>
      <div className="mt-1 pl-4">{children}</div>
    </details>
  );
}

/**
 * Project the linear event log into the message turns shown in the UI.
 *
 * Each conversational round (user → assistant) is one Turn. A round is
 * delimited by `turn-start`/`turn-end` for the orchestrator (new model);
 * legacy logs use `agent-start`/`agent-end` per turn — handled below for
 * back-compat.
 */
function projectEvents(events: AgentEvent[]): Turn[] {
  const turns: Turn[] = [];
  const agentMetaById = new Map<string, AgentMeta>();
  let currentAssistant: Turn | null = null;
  let lastSegment: Segment | null = null;

  const openAssistant = (agentId: string): Turn | null => {
    const meta = agentMetaById.get(agentId);
    // sub-agent turns are rendered collapsed; allow them through
    const turn: Turn = {
      kind: "assistant",
      agentId,
      agentLabel: meta?.label ?? "assistant",
      ...(meta?.model ? { agentModel: meta.model } : {}),
      ...(meta?.role ? { agentRole: meta.role } : {}),
      segments: [],
      pending: true,
    };
    turns.push(turn);
    currentAssistant = turn;
    lastSegment = null;
    return turn;
  };

  const closeAssistant = (status?: AgentStatus, error?: string): void => {
    const cur = currentAssistant as Turn | null;
    if (!cur) return;
    cur.pending = false;
    if (status === "failed" && error) cur.error = error;
    currentAssistant = null;
    lastSegment = null;
  };

  for (const ev of events) {
    if (ev.type === "agent-start") {
      agentMetaById.set(ev.agentId, ev.meta);
      // Legacy logs treated each agent-start as a turn boundary. New logs
      // use turn-start instead; for them this branch is a no-op (the role
      // is recorded but no turn opens here).
      continue;
    }
    if (ev.type === "turn-start") {
      openAssistant(ev.agentId);
      continue;
    }
    if (ev.type === "turn-end") {
      closeAssistant(ev.status, ev.error);
      continue;
    }
    if (ev.type === "agent-end") {
      // Treat as turn-end if no explicit turn-end was emitted (legacy).
      closeAssistant(ev.status, ev.error);
      continue;
    }
    if (ev.type === "user-message") {
      const meta = agentMetaById.get(ev.agentId);
      const role = meta?.role;
      turns.push({
        kind: "user",
        body: ev.text,
        agentId: ev.agentId,
        ...(role ? { agentRole: role } : {}),
        ...(meta?.label ? { agentLabel: meta.label } : {}),
      });
      continue;
    }
    if (ev.type === "system") {
      // Only render Reflex-emitted system events (preflight progress, etc).
      // The claude-code runtime also emits `system` events for its own
      // internal hooks (`hook_started`, `hook_response`, `init`, …) — those
      // are noise for the user and should stay invisible.
      if (ev.subtype && ev.subtype.startsWith("reflex.")) {
        turns.push({
          kind: "system",
          body: ev.text,
          systemSubtype: ev.subtype,
        });
      }
      continue;
    }
    if (ev.type === "assistant-delta") {
      let target: Turn | null = currentAssistant;
      if (!target) target = openAssistant(ev.agentId);
      if (!target) continue;
      const segments = target.segments!;
      if (lastSegment && lastSegment.kind === "text") {
        lastSegment.text += ev.text;
      } else {
        const seg: Segment = { kind: "text", text: ev.text };
        segments.push(seg);
        lastSegment = seg;
      }
      continue;
    }
    if (ev.type === "tool-use") {
      let target: Turn | null = currentAssistant;
      if (!target) target = openAssistant(ev.agentId);
      if (!target) continue;
      const segments = target.segments!;
      const seg: Segment = {
        kind: "tool",
        tool: { toolUseId: ev.toolUseId, name: ev.name, input: ev.input },
      };
      segments.push(seg);
      lastSegment = seg;
      continue;
    }
    if (ev.type === "tool-result") {
      const target = currentAssistant as Turn | null;
      if (!target) continue;
      const segments = target.segments ?? [];
      for (let i = segments.length - 1; i >= 0; i--) {
        const s = segments[i]!;
        if (s.kind === "tool" && s.tool.toolUseId === ev.toolUseId) {
          s.tool.result = {
            content: ev.content,
            ...(ev.isError ? { isError: true } : {}),
          };
          break;
        }
      }
      continue;
    }
    if (ev.type === "error") {
      const target = currentAssistant as Turn | null;
      if (target) target.error = ev.message;
      continue;
    }
    if (ev.type === "permission-request") {
      const target = (currentAssistant as Turn | null) ?? openAssistant(ev.agentId);
      if (!target) continue;
      target.segments!.push({
        kind: "permission",
        perm: {
          requestId: ev.requestId,
          agentId: ev.agentId,
          ...(ev.tool ? { tool: ev.tool } : {}),
          ...(ev.action ? { action: ev.action } : {}),
          ...(ev.input !== undefined ? { input: ev.input } : {}),
          ...(ev.description ? { description: ev.description } : {}),
        },
      });
      lastSegment = target.segments![target.segments!.length - 1]!;
      continue;
    }
    if (ev.type === "permission-response") {
      // Mark matching permission card resolved across all turns.
      for (const t of turns) {
        if (t.kind !== "assistant" || !t.segments) continue;
        for (const s of t.segments) {
          if (s.kind === "permission" && s.perm.requestId === ev.requestId) {
            s.perm.resolved = {
              decision: ev.decision,
              ...(ev.scope ? { scope: ev.scope } : {}),
            };
          }
        }
      }
      continue;
    }
    if (ev.type === "question") {
      const target = (currentAssistant as Turn | null) ?? openAssistant(ev.agentId);
      if (!target) continue;
      target.segments!.push({
        kind: "question",
        question: {
          questionId: ev.questionId,
          agentId: ev.agentId,
          prompt: ev.prompt,
          ...(ev.header ? { header: ev.header } : {}),
          ...(ev.multiSelect ? { multiSelect: true } : {}),
          ...(ev.choices ? { choices: ev.choices } : {}),
          ...(ev.options ? { options: ev.options } : {}),
        },
      });
      lastSegment = target.segments![target.segments!.length - 1]!;
      continue;
    }
    if (ev.type === "answer") {
      for (const t of turns) {
        if (t.kind !== "assistant" || !t.segments) continue;
        for (const s of t.segments) {
          if (s.kind === "question" && s.question.questionId === ev.questionId) {
            s.question.resolved = { answer: ev.answer };
          }
        }
      }
      continue;
    }
    if (ev.type === "mcp-add-request") {
      const target =
        (currentAssistant as Turn | null) ?? openAssistant(ev.agentId);
      if (!target) continue;
      target.segments!.push({
        kind: "mcp-add",
        entry: {
          requestId: ev.requestId,
          agentId: ev.agentId,
          server: ev.server,
          label: ev.label,
          ...(ev.description ? { description: ev.description } : {}),
          config: ev.config,
          ...(ev.secrets ? { secrets: ev.secrets } : {}),
        },
      });
      lastSegment = target.segments![target.segments!.length - 1]!;
      continue;
    }
    if (ev.type === "mcp-add-response") {
      for (const t of turns) {
        if (t.kind !== "assistant" || !t.segments) continue;
        for (const s of t.segments) {
          if (s.kind === "mcp-add" && s.entry.requestId === ev.requestId) {
            s.entry.resolved = { decision: ev.decision };
          }
        }
      }
      continue;
    }
    if (ev.type === "onboarding-done") {
      turns.push({ kind: "onboarding-done" });
      continue;
    }
    if (ev.type === "kb-write") {
      const target =
        (currentAssistant as Turn | null) ?? openAssistant(ev.agentId);
      if (!target) continue;
      target.segments!.push({
        kind: "kb",
        kb: {
          kind: ev.kind,
          title: ev.title,
          relPath: ev.relPath,
        },
      });
      lastSegment = target.segments![target.segments!.length - 1]!;
      continue;
    }
    if (ev.type === "utility-installed") {
      const target =
        (currentAssistant as Turn | null) ?? openAssistant(ev.agentId);
      if (!target) continue;
      target.segments!.push({
        kind: "utility",
        utility: {
          id: ev.utilityId,
          name: ev.name,
          scope: ev.scope,
          version: ev.version,
        },
      });
      lastSegment = target.segments![target.segments!.length - 1]!;
      continue;
    }
    if (ev.type === "utility-error") {
      const target =
        (currentAssistant as Turn | null) ?? openAssistant(ev.agentId);
      if (target) target.error = ev.message;
      continue;
    }
    if (ev.type === "widget-event") {
      const target =
        (currentAssistant as Turn | null) ?? openAssistant(ev.agentId);
      if (!target) continue;
      target.segments!.push({
        kind: "widget",
        widget: {
          op: ev.op,
          widgetId: ev.widgetId,
          title: ev.title,
          ...(ev.description ? { description: ev.description } : {}),
          widgetKind: ev.kind,
          data: ev.data,
          ...(ev.sourceTopicId ? { sourceTopicId: ev.sourceTopicId } : {}),
        },
      });
      lastSegment = target.segments![target.segments!.length - 1]!;
      continue;
    }
    if (ev.type === "widget-error") {
      const target =
        (currentAssistant as Turn | null) ?? openAssistant(ev.agentId);
      if (target) target.error = ev.message;
      continue;
    }
    if (ev.type === "workflow-event") {
      const target =
        (currentAssistant as Turn | null) ?? openAssistant(ev.agentId);
      if (!target) continue;
      target.segments!.push({
        kind: "workflow",
        workflow: {
          workflowId: ev.workflowId,
          label: ev.label,
          ...(ev.description ? { description: ev.description } : {}),
          trigger: ev.trigger,
          stepCount: ev.stepCount,
        },
      });
      lastSegment = target.segments![target.segments!.length - 1]!;
      continue;
    }
    if (ev.type === "workflow-error") {
      const target =
        (currentAssistant as Turn | null) ?? openAssistant(ev.agentId);
      if (target) target.error = ev.message;
      continue;
    }
  }
  return turns;
}

/** Strip <<reflex:…>>…<</reflex:…>> markers from rendered text — they're
 *  presented as cards instead. */
/**
 * Reflex injects synthesized user-message events when bootstrapping a topic
 * (MCP setup wizard, edit-utility goal kickoff) or routing UI decisions
 * back to the agent (question answer, permission decision, mcp-add response,
 * /goal auto-continue). Their visible text is noisy and confuses the reader
 * with technical scaffolding. We classify them so they can render compactly
 * with the technical guts hidden behind a toggle.
 */
interface SystemUserMessage {
  /** Short label for the chip (e.g. "MCP setup", "Answer", "/goal"). */
  badge: string;
  /** One-line summary the reader actually cares about. */
  summary: string;
  /** Full original text — shown when the user expands the block. */
  details: string;
}

interface SystemUserMessageLabels {
  mcpSetupDefault: string;
  mcpSetupBadge: string;
  answerBadge: string;
  permissionBadge: string;
  permissionUserDecision: string;
  mcpBadge: string;
  goalBadge: string;
  goalAutoContinue: string;
  systemBadge: string;
  systemMessage: string;
}

function classifySystemUserMessage(
  text: string,
  labels: SystemUserMessageLabels,
): SystemUserMessage | null {
  const trimmed = text.trimStart();
  // MCP setup wizard kickoff
  const wizard = /^\[MCP setup wizard\]\s*([^\n]*)/.exec(trimmed);
  if (wizard) {
    return {
      badge: labels.mcpSetupBadge,
      summary: wizard[1]!.trim() || labels.mcpSetupDefault,
      details: text,
    };
  }
  // Question answer routed back to the agent.
  const answer = /^\[Reflex\]\s+Answer for question\s+\S+:\s+([\s\S]*?)(?:\s*\.?\s*Continue\.\s*)?$/.exec(
    trimmed,
  );
  if (answer) {
    return {
      badge: labels.answerBadge,
      summary: answer[1]!.trim(),
      details: text,
    };
  }
  // Permission decision routed back to the agent.
  const perm = /^\[Reflex\]\s+(Allowed|Denied|User (allowed|denied))[\s\S]*?:\s*([\s\S]*?)(?:\s*\.?\s*Continue\.\s*)?$/.exec(
    trimmed,
  );
  if (perm) {
    return {
      badge: labels.permissionBadge,
      summary: (perm[3] ?? perm[1] ?? "").trim() || labels.permissionUserDecision,
      details: text,
    };
  }
  // MCP-add registration outcome.
  const mcpAdd = /^\[Reflex\]\s+(MCP server|User rejected|Failed to register)[\s\S]*?$/.exec(
    trimmed,
  );
  if (mcpAdd) {
    const first = trimmed.split("\n", 1)[0]!;
    return {
      badge: labels.mcpBadge,
      summary: first.replace(/^\[Reflex\]\s+/, "").slice(0, 200),
      details: text,
    };
  }
  // /goal auto-continuation pings from the manager.
  const goal = /^\[Reflex \/goal\]\s+([\s\S]*)/.exec(trimmed);
  if (goal) {
    return {
      badge: labels.goalBadge,
      summary: labels.goalAutoContinue,
      details: text,
    };
  }
  // Generic `[Something] ...` reflex-internal injection — collapse it.
  const generic = /^\[Reflex[^\]]*\]\s*([\s\S]*)/.exec(trimmed);
  if (generic) {
    const first = generic[1]!.split("\n", 1)[0]!.trim();
    return {
      badge: labels.systemBadge,
      summary: first.slice(0, 200) || labels.systemMessage,
      details: text,
    };
  }
  return null;
}

/**
 * Onboarding complete CTA — the wizard skill emitted
 * `<<reflex:onboarding-done>>` to signal the dashboard is ready. Renders a
 * call-to-action so the user can jump out of the wizard chat into the
 * dashboard view where the suggestion cards live.
 */
function OnboardingDoneCard({ rootId }: { rootId: string }) {
  const router = useRouter();
  return (
    <div className="rounded-lg border border-emerald-300 bg-emerald-50/70 dark:bg-emerald-950/30 p-4">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-emerald-500/10 p-2 mt-0.5">
          <Sparkles className="h-4 w-4 text-emerald-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">Dashboard is ready</div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Suggestions are waiting on the dashboard. Approve the ones that
            feel right; dismiss the rest. Come back here anytime to add
            context.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => router.push(`/roots/${rootId}`)}
        >
          Go to dashboard
        </Button>
      </div>
    </div>
  );
}

/**
 * Standalone `system` event emitted by the server (e.g. preflight progress
 * messages from start-turn). Rendered as a slim inline status row — visible
 * by default, not collapsed, since these are usually short progress pings
 * the user wants to see immediately.
 */
function SystemEventTurn({
  body,
  subtype,
}: {
  body: string;
  subtype?: string;
}) {
  const isPreflight = subtype === "reflex.preflight";
  return (
    <div
      className={[
        "rounded-md border px-3 py-2 text-xs flex items-start gap-2",
        isPreflight
          ? "border-violet-200 bg-violet-50/60 text-violet-900"
          : "border-dashed bg-muted/30 text-muted-foreground",
      ].join(" ")}
    >
      <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0 text-violet-600" />
      <div className="whitespace-pre-wrap leading-relaxed flex-1 min-w-0">
        {body}
      </div>
    </div>
  );
}

function SystemUserTurn({ system }: { system: SystemUserMessage }) {
  return (
    <details className="group rounded-md border border-dashed bg-muted/20 px-3 py-1.5 text-xs">
      <summary className="cursor-pointer list-none flex items-center gap-2 select-none">
        <span className="inline-block h-3 w-3 text-center text-muted-foreground transition-transform group-open:rotate-90">
          ▸
        </span>
        <span className="rounded bg-muted-foreground/10 text-[10px] uppercase tracking-wider text-muted-foreground px-1.5 py-0.5 font-mono">
          {system.badge}
        </span>
        <span className="truncate text-foreground/80">{system.summary}</span>
      </summary>
      <pre className="mt-2 pl-5 text-[11px] whitespace-pre-wrap font-mono text-muted-foreground/90">
        {system.details}
      </pre>
    </details>
  );
}

function stripProtocolMarkers(text: string): string {
  // Accept both `<<reflex:X>>` and a typo'd `<reflex:X>` on either end —
  // mirrors the lenient extractor in lib/server/agents/protocol.ts.
  return (
    text
      // Any <<reflex:NAME>>…<</reflex:NAME>> marker (open/close matched via the
      // backreference) — was a hand-maintained tag list that silently leaked
      // newer markers like `route` / `report` / `notify`.
      .replace(
        /<{1,2}reflex:([a-z][a-z0-9-]*)>{1,2}[\s\S]*?<{1,2}\/reflex:\1>{1,2}/g,
        "",
      )
      // A trailing, not-yet-closed marker (mid-stream) so it doesn't flash.
      .replace(/<{1,2}reflex:[a-z][a-z0-9-]*>{1,2}[\s\S]*$/g, "")
  );
}

interface SSEEvent {
  event: string;
  data: unknown;
  rest: string;
}

function splitSSE(buf: string): SSEEvent[] {
  const out: SSEEvent[] = [];
  while (true) {
    const idx = buf.indexOf("\n\n");
    if (idx < 0) break;
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    let event = "message";
    let dataLine = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue; // heartbeat
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLine += line.slice(5).trimStart();
    }
    let data: unknown = null;
    try {
      data = dataLine ? JSON.parse(dataLine) : null;
    } catch {
      data = null;
    }
    out.push({ event, data, rest: buf });
  }
  return out;
}
