"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  MessageSquare,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import { deleteTopicAction } from "@/lib/server/topic-actions";
import { dispatchReflex } from "@/lib/client/events";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import type { RegistryEntry } from "@/lib/registry";
import {
  loadKbSectionsAction,
  loadTopicsAction,
  loadSidebarUtilitiesAction,
  loadSidebarMemoryAction,
  type SidebarSection,
  type SidebarTopic,
  type SidebarUtility,
  type SidebarMemoryFile,
} from "@/lib/server/sidebar-actions";
import { listRootsAction } from "@/lib/server/registry-actions";
import { listAgentsAction } from "@/lib/server/agents/actions";
import type { AgentMeta } from "@/lib/server/agents/types";
import { REFLEX_EVENTS, useReflexEvent } from "@/lib/client/events";
import { Bot, Activity, Boxes, FileSearch, Brain, Package } from "lucide-react";

interface Props {
  initialRoots: RegistryEntry[];
}

export function AppSidebar({ initialRoots }: Props) {
  const pathname = usePathname();
  const t = useTranslations("app");
  const [roots, setRoots] = useState<RegistryEntry[]>(initialRoots);

  const reloadRoots = useCallback(async () => {
    const res = await listRootsAction();
    if (res.ok) setRoots(res.entries);
  }, []);

  useReflexEvent(REFLEX_EVENTS.rootsChanged, reloadRoots);

  // Public share pages must not leak the Reflex management UI — the
  // sidebar shows roots, topics, and KB tree which are intentionally
  // off-limits to anonymous viewers.
  if (pathname?.startsWith("/share/") || pathname === "/share") {
    return null;
  }

  return (
    <aside className="w-72 shrink-0 border-r bg-muted/30 flex flex-col">
      <div className="px-4 py-4 flex items-center gap-2 border-b">
        <span className="reflex-gradient inline-flex h-7 w-7 items-center justify-center rounded-lg text-white shadow-sm">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="leading-tight">
          <Link
            href="/"
            className="text-sm font-semibold tracking-tight hover:underline"
          >
            Reflex
          </Link>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            knowledge base
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <nav className="px-2 pt-3 pb-6">
          <div className="px-2 mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {t("sidebar.spaces")}
          </div>
          {roots.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              {t("sidebar.empty")}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {roots.map((r) => (
                <ProjectItem
                  key={r.id}
                  root={r}
                  active={pathname?.startsWith(`/roots/${r.id}`) ?? false}
                />
              ))}
            </ul>
          )}
          <div className="mt-2 px-2">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-start text-xs"
            >
              <Link href="/roots/new">
                <FolderPlus className="mr-1 h-3.5 w-3.5" /> {t("sidebar.addSpace")}
              </Link>
            </Button>
          </div>
        </nav>
      </ScrollArea>

      <Separator />
      <div className="px-2 py-2 space-y-0.5">
        <Button
          asChild
          variant={
            pathname === "/utilities" || pathname?.startsWith("/utilities/")
              ? "secondary"
              : "ghost"
          }
          size="sm"
          className="w-full justify-start"
        >
          <Link href="/utilities">
            <Boxes className="mr-2 h-4 w-4" /> {t("sidebar.utilities")}
          </Link>
        </Button>
        <Button
          asChild
          variant={pathname === "/audit" ? "secondary" : "ghost"}
          size="sm"
          className="w-full justify-start"
        >
          <Link href="/audit">
            <FileSearch className="mr-2 h-4 w-4" /> {t("sidebar.audit")}
          </Link>
        </Button>
        <Button
          asChild
          variant={pathname === "/settings" ? "secondary" : "ghost"}
          size="sm"
          className="w-full justify-start"
        >
          <Link href="/settings">
            <Settings className="mr-2 h-4 w-4" /> Settings
          </Link>
        </Button>
      </div>
    </aside>
  );
}

function ProjectItem({
  root,
  active,
}: {
  root: RegistryEntry;
  active: boolean;
}) {
  const t = useTranslations("app");
  const [expanded, setExpanded] = useState(active);
  const [kbExpanded, setKbExpanded] = useState(false);
  const [memoryExpanded, setMemoryExpanded] = useState(false);
  const [topicsExpanded, setTopicsExpanded] = useState(false);
  const [utilitiesExpanded, setUtilitiesExpanded] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [sections, setSections] = useState<SidebarSection[] | null>(null);
  const [memory, setMemory] = useState<SidebarMemoryFile[] | null>(null);
  const [topics, setTopics] = useState<SidebarTopic[] | null>(null);
  const [utilities, setUtilities] = useState<SidebarUtility[] | null>(null);
  const [agents, setAgents] = useState<AgentMeta[] | null>(null);
  const [loadingKb, setLoadingKb] = useState(false);
  const [loadingMemory, setLoadingMemory] = useState(false);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [loadingUtilities, setLoadingUtilities] = useState(false);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);

  const fetchKb = useCallback(async () => {
    setLoadingKb(true);
    const res = await loadKbSectionsAction(root.id);
    setLoadingKb(false);
    if (res.ok) setSections(res.sections);
    else setSections([]);
  }, [root.id]);

  const fetchTopics = useCallback(async () => {
    setLoadingTopics(true);
    const res = await loadTopicsAction(root.id);
    setLoadingTopics(false);
    if (res.ok) setTopics(res.topics);
    else setTopics([]);
  }, [root.id]);

  const fetchAgents = useCallback(async () => {
    setLoadingAgents(true);
    const res = await listAgentsAction({ rootId: root.id });
    setLoadingAgents(false);
    if (res.ok) setAgents(res.agents);
    else setAgents([]);
  }, [root.id]);

  const fetchMemory = useCallback(async () => {
    setLoadingMemory(true);
    const res = await loadSidebarMemoryAction(root.id);
    setLoadingMemory(false);
    if (res.ok) setMemory(res.files);
    else setMemory([]);
  }, [root.id]);

  const fetchUtilities = useCallback(async () => {
    setLoadingUtilities(true);
    const res = await loadSidebarUtilitiesAction(root.id);
    setLoadingUtilities(false);
    if (res.ok) setUtilities(res.utilities);
    else setUtilities([]);
  }, [root.id]);

  // Refetch on relevant events when the corresponding section is open.
  useReflexEvent(REFLEX_EVENTS.kbChanged(root.id), () => {
    if (kbExpanded) void fetchKb();
    else setSections(null);
  });
  useReflexEvent(REFLEX_EVENTS.topicsChanged(root.id), () => {
    if (topicsExpanded) void fetchTopics();
    else setTopics(null);
    // Agents change in lock-step with topics.
    if (agentsExpanded) void fetchAgents();
    else setAgents(null);
    // Utility helper threads also live in the topic store.
    if (utilitiesExpanded) void fetchUtilities();
    else setUtilities(null);
  });

  // Poll agents while expanded so live status changes show up. Cheap: it
  // only hits the in-process AgentManager singleton.
  useEffect(() => {
    if (!agentsExpanded) return;
    const t = setInterval(() => {
      void fetchAgents();
    }, 3000);
    return () => clearInterval(t);
  }, [agentsExpanded, fetchAgents]);

  const toggleKb = async () => {
    const next = !kbExpanded;
    setKbExpanded(next);
    if (next && sections === null && !loadingKb) await fetchKb();
  };
  const toggleMemory = async () => {
    const next = !memoryExpanded;
    setMemoryExpanded(next);
    if (next && memory === null && !loadingMemory) await fetchMemory();
  };
  const toggleTopics = async () => {
    const next = !topicsExpanded;
    setTopicsExpanded(next);
    if (next && topics === null && !loadingTopics) await fetchTopics();
  };
  const toggleUtilities = async () => {
    const next = !utilitiesExpanded;
    setUtilitiesExpanded(next);
    if (next && utilities === null && !loadingUtilities) await fetchUtilities();
  };
  const toggleAgents = async () => {
    const next = !agentsExpanded;
    setAgentsExpanded(next);
    if (next && agents === null && !loadingAgents) await fetchAgents();
  };

  const label = displayName(root.path);

  return (
    <li>
      <div className="flex items-center group">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
          aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <Link
          href={`/roots/${root.id}`}
          className={`flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded-md text-sm hover:bg-accent ${
            active ? "bg-accent" : ""
          }`}
        >
          <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{label}</span>
        </Link>
      </div>
      {expanded && (
        <ul className="ml-5 mt-0.5 space-y-0.5 border-l pl-1">
          <li>
            <button
              type="button"
              onClick={toggleKb}
              className="w-full flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {kbExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{t("sidebar.kb")}</span>
              {loadingKb && (
                <Loader2 className="ml-auto h-3 w-3 animate-spin shrink-0" />
              )}
            </button>
            {kbExpanded && sections !== null && (
              <KbSectionList
                rootId={root.id}
                sections={sections}
                pathname={pathname}
              />
            )}
          </li>
          <li>
            <button
              type="button"
              onClick={toggleMemory}
              className="w-full flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {memoryExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <Brain className="h-3 w-3 shrink-0" />
              <span className="truncate">{t("sidebar.memory")}</span>
              {loadingMemory && (
                <Loader2 className="ml-auto h-3 w-3 animate-spin shrink-0" />
              )}
            </button>
            {memoryExpanded && memory !== null && (
              <MemoryList memory={memory} />
            )}
          </li>
          <li>
            <button
              type="button"
              onClick={toggleTopics}
              className="w-full flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {topicsExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <MessageSquare className="h-3 w-3 shrink-0" />
              <span className="truncate">{t("sidebar.topics")}</span>
              {loadingTopics && (
                <Loader2 className="ml-auto h-3 w-3 animate-spin shrink-0" />
              )}
              {topics !== null && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {topics.length}
                </span>
              )}
            </button>
            {topicsExpanded && topics !== null && (
              <TopicList
                rootId={root.id}
                topics={topics}
                pathname={pathname}
              />
            )}
          </li>
          <li>
            <button
              type="button"
              onClick={toggleUtilities}
              className="w-full flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {utilitiesExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <Boxes className="h-3 w-3 shrink-0" />
              <span className="truncate">{t("sidebar.utilities")}</span>
              {loadingUtilities && (
                <Loader2 className="ml-auto h-3 w-3 animate-spin shrink-0" />
              )}
              {utilities !== null && !loadingUtilities && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {utilities.length}
                </span>
              )}
            </button>
            {utilitiesExpanded && utilities !== null && (
              <UtilityList
                rootId={root.id}
                utilities={utilities}
                pathname={pathname}
              />
            )}
          </li>
          <li>
            <button
              type="button"
              onClick={toggleAgents}
              className="w-full flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {agentsExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <Bot className="h-3 w-3 shrink-0" />
              <span className="truncate">{t("sidebar.agents")}</span>
              {loadingAgents && (
                <Loader2 className="ml-auto h-3 w-3 animate-spin shrink-0" />
              )}
              {agents !== null && !loadingAgents && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {agents.filter((a) => isLive(a.status)).length}/{agents.length}
                </span>
              )}
            </button>
            {agentsExpanded && agents !== null && (
              <AgentList agents={agents} pathname={pathname} />
            )}
          </li>
        </ul>
      )}
    </li>
  );
}

function AgentList({
  agents,
  pathname,
}: {
  agents: AgentMeta[];
  pathname: string | null;
}) {
  if (agents.length === 0) {
    return (
      <AgentListEmpty />
    );
  }
  // Build parent → children map for nested rendering.
  const byParent = new Map<string | undefined, AgentMeta[]>();
  for (const a of agents) {
    const key = a.parentId;
    const list = byParent.get(key) ?? [];
    list.push(a);
    byParent.set(key, list);
  }
  const roots = byParent.get(undefined) ?? [];
  return (
    <ul className="ml-4 mt-0.5 space-y-0.5 border-l pl-1">
      {roots.map((a) => (
        <AgentNode
          key={a.id}
          agent={a}
          byParent={byParent}
          pathname={pathname}
          depth={0}
        />
      ))}
    </ul>
  );
}

function AgentListEmpty() {
  const t = useTranslations("app");
  return (
    <div className="ml-4 px-3 py-1 text-[11px] italic text-muted-foreground">
      {t("sidebar.noAgents")}
    </div>
  );
}

function AgentNode({
  agent,
  byParent,
  pathname,
  depth,
}: {
  agent: AgentMeta;
  byParent: Map<string | undefined, AgentMeta[]>;
  pathname: string | null;
  depth: number;
}) {
  const children = byParent.get(agent.id) ?? [];
  const href = `/agents/${agent.id}`;
  const active = pathname === href;
  return (
    <li>
      <Link
        href={href}
        className={`flex items-center gap-1 px-2 py-1 text-[12px] rounded hover:bg-accent ${
          active ? "bg-accent" : ""
        }`}
        style={{ paddingLeft: depth * 8 + 4 }}
      >
        {isLive(agent.status) ? (
          <Activity className="h-3 w-3 text-emerald-600 shrink-0 animate-pulse" />
        ) : (
          <Bot className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <span className="truncate flex-1">{agent.label}</span>
        <span
          className="font-mono text-[10px] text-muted-foreground shrink-0"
          title={`${agent.harness} · ${agent.model}`}
        >
          {agent.harness === "claude-code"
            ? "claude"
            : agent.harness === "ollama"
              ? "ollama"
              : "codex"}
        </span>
      </Link>
      {children.length > 0 && (
        <ul className="space-y-0.5">
          {children.map((c) => (
            <AgentNode
              key={c.id}
              agent={c}
              byParent={byParent}
              pathname={pathname}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function isLive(status: string): boolean {
  return status === "starting" || status === "running";
}

function KbSectionList({
  rootId,
  sections,
  pathname,
}: {
  rootId: string;
  sections: SidebarSection[];
  pathname: string | null;
}) {
  if (sections.length === 0) {
    return <KbEmpty />;
  }
  return (
    <ul className="ml-4 mt-0.5 space-y-0.5 border-l pl-1">
      {sections.map((s) =>
        s.isDir ? (
          <DirSection
            key={s.rel}
            rootId={rootId}
            section={s}
            pathname={pathname}
          />
        ) : (
          <li key={s.rel}>
            <FileLink rootId={rootId} section={s} pathname={pathname} />
          </li>
        ),
      )}
    </ul>
  );
}

function KbEmpty() {
  const t = useTranslations("app");
  return (
    <div className="px-3 py-1 text-[11px] italic text-muted-foreground">
      {t("sidebar.kbEmpty")}
    </div>
  );
}

function DirSection({
  rootId,
  section,
  pathname,
}: {
  rootId: string;
  section: SidebarSection;
  pathname: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
        >
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0 mr-1" />
        <span className="text-[12px] flex-1 truncate">{section.label}</span>
      </div>
      {open && section.children && (
        <ul className="ml-4 space-y-0.5 border-l pl-1">
          {section.children.map((c) => (
            <li key={c.rel}>
              <FileLink rootId={rootId} section={c} pathname={pathname} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function FileLink({
  rootId,
  section,
  pathname,
}: {
  rootId: string;
  section: SidebarSection;
  pathname: string | null;
}) {
  if (!section.fileRel) return null;
  const encoded = section.fileRel
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const href = `/roots/${rootId}/kb/${encoded}`;
  const active = pathname === href;
  return (
    <Link
      href={href}
      className={`flex items-center gap-1 px-2 py-1 text-[12px] rounded hover:bg-accent ${
        active ? "bg-accent" : ""
      }`}
    >
      <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
      <span className="truncate">{section.label}</span>
    </Link>
  );
}

function TopicList({
  rootId,
  topics,
  pathname,
}: {
  rootId: string;
  topics: SidebarTopic[];
  pathname: string | null;
}) {
  if (topics.length === 0) {
    return <TopicsEmpty />;
  }
  return (
    <ul className="ml-4 mt-0.5 space-y-0.5 border-l pl-1">
      {topics.map((t) => (
        <TopicRow
          key={t.id}
          rootId={rootId}
          topic={t}
          pathname={pathname}
        />
      ))}
    </ul>
  );
}

function TopicsEmpty() {
  const t = useTranslations("app");
  return (
    <div className="ml-4 px-3 py-1 text-[11px] italic text-muted-foreground">
      {t("sidebar.noTopics")}
    </div>
  );
}

function TopicRow({
  rootId,
  topic,
  pathname,
}: {
  rootId: string;
  topic: SidebarTopic;
  pathname: string | null;
}) {
  const t = useTranslations("app");
  const href = `/roots/${rootId}/chat/${topic.id}`;
  const active = pathname === href;
  const [pending, startDelete] = useTransition();
  const router = useRouter();

  const onDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(t("sidebar.deleteTopicConfirm", { title: topic.title }))) {
      return;
    }
    startDelete(async () => {
      const res = await deleteTopicAction(rootId, topic.id);
      if (!res.ok) {
        toast.error(res.error ?? t("sidebar.deleteFailed"));
        return;
      }
      toast.success(t("sidebar.topicDeleted"));
      dispatchReflex(REFLEX_EVENTS.topicsChanged(rootId));
      // If we were inside the just-deleted chat, bounce back to the dashboard.
      if (active) router.push(`/roots/${rootId}`);
    });
  };

  return (
    <li className="group/topic">
      <Link
        href={href}
        className={`flex items-center gap-1 px-2 py-1 text-[12px] rounded hover:bg-accent ${
          active ? "bg-accent" : ""
        }`}
      >
        <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="truncate flex-1 min-w-0">{topic.title}</span>
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          aria-label={t("sidebar.deleteTopic")}
          title={t("sidebar.deleteTopic")}
          className="opacity-0 group-hover/topic:opacity-100 transition-opacity p-0.5 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive shrink-0"
        >
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </button>
      </Link>
    </li>
  );
}

function MemoryList({ memory }: { memory: SidebarMemoryFile[] }) {
  const t = useTranslations("app");
  const nonEmpty = memory.filter((m) => !m.empty);
  if (nonEmpty.length === 0) {
    return (
      <div className="ml-4 px-3 py-1 text-[11px] italic text-muted-foreground">
        {t("sidebar.memoryEmpty")}
      </div>
    );
  }
  return (
    <ul className="ml-4 mt-0.5 space-y-0.5 border-l pl-1">
      {nonEmpty.map((m) => (
        <li key={m.file}>
          <Link
            href="/settings"
            title={m.description}
            className="flex items-center gap-1 px-2 py-1 text-[12px] rounded hover:bg-accent"
          >
            <Brain className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="truncate flex-1 min-w-0">{m.file}</span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {m.lines}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function UtilityList({
  rootId,
  utilities,
  pathname,
}: {
  rootId: string;
  utilities: SidebarUtility[];
  pathname: string | null;
}) {
  const t = useTranslations("app");
  if (utilities.length === 0) {
    return (
      <div className="ml-4 px-3 py-1 text-[11px] italic text-muted-foreground">
        {t("sidebar.utilitiesEmpty")}
      </div>
    );
  }
  return (
    <ul className="ml-4 mt-0.5 space-y-0.5 border-l pl-1">
      {utilities.map((u) => (
        <UtilityNode
          key={`${u.scope}:${u.id}`}
          rootId={rootId}
          utility={u}
          pathname={pathname}
        />
      ))}
    </ul>
  );
}

function UtilityNode({
  rootId,
  utility,
  pathname,
}: {
  rootId: string;
  utility: SidebarUtility;
  pathname: string | null;
}) {
  const [open, setOpen] = useState(false);
  const href = `/utilities/${utility.scope}/${encodeURIComponent(utility.id)}${
    utility.rootId ? `?rootId=${encodeURIComponent(utility.rootId)}` : ""
  }`;
  const hasThreads = utility.threads.length > 0;
  return (
    <li>
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasThreads}
          className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-30"
        >
          {hasThreads ? (
            open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )
          ) : (
            <span className="inline-block h-3 w-3" />
          )}
        </button>
        <Link
          href={href}
          className="flex-1 min-w-0 flex items-center gap-1 px-1 py-1 text-[12px] rounded hover:bg-accent"
        >
          <Package className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="truncate flex-1">{utility.name}</span>
          {hasThreads && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              {utility.threads.length}
            </span>
          )}
        </Link>
      </div>
      {open && hasThreads && (
        <ul className="ml-4 space-y-0.5 border-l pl-1">
          {utility.threads.map((th) => {
            const chatHref = `/roots/${rootId}/chat/${th.id}`;
            const active = pathname === chatHref;
            return (
              <li key={th.id}>
                <Link
                  href={chatHref}
                  className={`flex items-center gap-1 px-2 py-1 text-[12px] rounded hover:bg-accent ${
                    active ? "bg-accent" : ""
                  }`}
                >
                  <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1 min-w-0">{th.title}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function displayName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
