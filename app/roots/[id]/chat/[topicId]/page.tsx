import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { getRoot } from "@/lib/registry";
import { getTopic } from "@/lib/server/topics";
import { loadSettings } from "@/lib/settings/store";
import { readEvents } from "@/lib/server/agents/events-log";
import { agentManager } from "@/lib/server/agents/manager";
import { ChatView } from "./_components/chat-view";
import type { AgentEvent } from "@/lib/server/agents/types";
import { GoalBadge } from "./_components/goal-badge";
import { DeleteTopicButton } from "./_components/delete-topic-button";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string; topicId: string }>;
}) {
  const { id, topicId } = await params;
  const entry = await getRoot(id);
  if (!entry) notFound();
  const topic = await getTopic(entry.path, topicId);
  if (!topic) notFound();
  // Effective harness/model/language — what a turn ACTUALLY runs with. Every
  // interactive turn resolves these live from `assignments.chat` (see
  // startOrchestratorTurn), so the topic's own meta is a stale creation-time
  // snapshot: switching the model in Settings wouldn't update it. Show the
  // live config instead so the header never lies.
  const settings = await loadSettings();
  const effective = settings.assignments.chat;
  const events = await readEvents(entry.path, topicId);
  // Backfill: pre-events topics still have user messages only in the .md
  // file. If events.jsonl is empty, fabricate user-message events so the UI
  // shows the prior conversation.
  const initialEvents: AgentEvent[] =
    events.length === 0
      ? topic.messages.map((m, i) => ({
          type: m.role === "user" ? "user-message" : "assistant-delta",
          text: m.body,
          agentId: "legacy",
          ts: topic.meta.createdAt,
          seq: i,
        }) as AgentEvent)
      : events;
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="border-b px-6 py-3 flex items-start gap-4">
        <Button asChild variant="ghost" size="sm" className="-ml-3 mt-0.5">
          <Link href={`/roots/${id}`}>
            <ArrowLeft className="mr-1 h-4 w-4" /> KB
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-medium truncate">{topic.meta.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-mono">
              {effective.harness}
            </Badge>
            {effective.model && (
              <Badge variant="secondary" className="font-mono">
                {effective.model}
              </Badge>
            )}
            <span>lang: {settings.language}</span>
            <span className="ml-auto font-mono">
              {new Date(topic.meta.updatedAt).toLocaleString()}
            </span>
          </div>
          {topic.meta.goal && (
            <div className="mt-2">
              <GoalBadge
                rootId={id}
                topicId={topicId}
                goal={topic.meta.goal}
                status={topic.meta.goalStatus ?? "active"}
                iterations={topic.meta.goalIterations ?? 0}
              />
            </div>
          )}
        </div>
        <DeleteTopicButton
          rootId={id}
          topicId={topicId}
          topicTitle={topic.meta.title}
        />
      </header>
      <Separator />
      <ChatView
        rootId={id}
        topicId={topicId}
        initialEvents={initialEvents}
        initialActive={agentManager.isActive(topicId)}
      />
    </div>
  );
}
