import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import matter from "gray-matter";
import { reflexRoot } from "@/lib/reflex/paths";

/**
 * Chat transcripts. Each chat is a Markdown file in `<root>/.reflex/topics/`
 * with YAML frontmatter and `## user` / `## assistant` headings between turns.
 * The agent is encouraged to ignore this folder when (re)building the KB.
 */

const TOPICS_DIR_NAME = "topics";

export type GoalStatus = "active" | "completed" | "abandoned";

export interface TopicFrontmatter {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  harness?: string;
  model?: string;
  language?: string;
  /** /goal command's payload — when set, manager auto-continues the agent. */
  goal?: string;
  goalStatus?: GoalStatus;
  goalIterations?: number;
  /**
   * Marks the topic as a helper conversation bound to a utility — the
   * compact chat sidebar inside the utility opens THIS topic. Topics
   * with this flag are hidden from the regular "Conversations" list so
   * helper-chats don't pollute the project sidebar.
   */
  helperFor?: string;
  /**
   * When set, this topic is the live conversation behind task `<taskId>`
   * on the task-board utility. The board polls events from this topic
   * to render the "live status" line + "agent needs you" badge.
   */
  taskId?: string;
}

export interface TopicMessage {
  role: "user" | "assistant";
  body: string;
}

export interface Topic {
  meta: TopicFrontmatter;
  messages: TopicMessage[];
  /** Absolute path on disk. */
  abs: string;
}

export interface TopicSummary {
  meta: TopicFrontmatter;
  preview: string;
  abs: string;
}

function topicsDir(root: string): string {
  return path.join(reflexRoot(root), TOPICS_DIR_NAME);
}

function topicFile(root: string, id: string): string {
  return path.join(topicsDir(root), `${sanitizeId(id)}.md`);
}

function sanitizeId(id: string): string {
  // Allow alnum, dash, underscore — nothing fancy.
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}

function newTopicId(): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${stamp}-${rand}`;
}

function deriveTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim().split(/\r?\n/)[0] ?? "Untitled";
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "…" : trimmed;
}

export async function listTopics(root: string): Promise<TopicSummary[]> {
  const dir = topicsDir(root);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TopicSummary[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    const abs = path.join(dir, e.name);
    try {
      const raw = await fs.readFile(abs, "utf8");
      const parsed = matter(raw);
      const meta = parsed.data as Partial<TopicFrontmatter>;
      if (!meta.id || !meta.createdAt) continue;
      const preview = parsed.content
        .replace(/^##\s+(user|assistant)\s*$/gim, "")
        .trim()
        .slice(0, 160);
      out.push({
        meta: {
          id: meta.id,
          title: meta.title ?? "Untitled",
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt ?? meta.createdAt,
          harness: meta.harness,
          model: meta.model,
          language: meta.language,
          ...(meta.goal ? { goal: meta.goal } : {}),
          ...(meta.goalStatus ? { goalStatus: meta.goalStatus } : {}),
          ...(typeof meta.goalIterations === "number"
            ? { goalIterations: meta.goalIterations }
            : {}),
          // Provenance flags — the sidebar uses these to route helper /
          // task-bound topics out of the user-facing Conversations list.
          ...(meta.helperFor ? { helperFor: meta.helperFor } : {}),
          ...(meta.taskId ? { taskId: meta.taskId } : {}),
        },
        preview,
        abs,
      });
    } catch {
      // skip malformed files
    }
  }
  out.sort((a, b) => Date.parse(b.meta.updatedAt) - Date.parse(a.meta.updatedAt));
  return out;
}

export async function getTopic(
  root: string,
  id: string,
): Promise<Topic | null> {
  const file = topicFile(root, id);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const parsed = matter(raw);
  const meta = parsed.data as Partial<TopicFrontmatter>;
  if (!meta.id) return null;
  return {
    meta: {
      id: meta.id,
      title: meta.title ?? "Untitled",
      createdAt: meta.createdAt ?? new Date().toISOString(),
      updatedAt: meta.updatedAt ?? meta.createdAt ?? new Date().toISOString(),
      harness: meta.harness,
      model: meta.model,
      language: meta.language,
      ...(meta.goal ? { goal: meta.goal } : {}),
      ...(meta.goalStatus ? { goalStatus: meta.goalStatus } : {}),
      ...(typeof meta.goalIterations === "number"
        ? { goalIterations: meta.goalIterations }
        : {}),
    },
    messages: parseMessages(parsed.content),
    abs: file,
  };
}

/** Patch frontmatter fields on a topic file in-place. */
async function patchTopicMeta(
  root: string,
  id: string,
  patch: Partial<TopicFrontmatter>,
): Promise<void> {
  const file = topicFile(root, id);
  const raw = await fs.readFile(file, "utf8");
  const parsed = matter(raw);
  const next: Record<string, unknown> = {
    ...(parsed.data as Record<string, unknown>),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  // Strip undefined to keep frontmatter tidy.
  for (const k of Object.keys(next)) {
    if (next[k] === undefined) delete next[k];
  }
  await fs.writeFile(file, matter.stringify(parsed.content, next), "utf8");
}

export async function setTopicGoal(
  root: string,
  id: string,
  goal: string,
): Promise<void> {
  await patchTopicMeta(root, id, {
    goal,
    goalStatus: "active",
    goalIterations: 0,
  });
}

export async function setGoalStatus(
  root: string,
  id: string,
  status: GoalStatus,
): Promise<void> {
  await patchTopicMeta(root, id, { goalStatus: status });
}

export async function bumpGoalIterations(
  root: string,
  id: string,
): Promise<number> {
  const file = topicFile(root, id);
  const raw = await fs.readFile(file, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const cur =
    typeof data.goalIterations === "number" ? data.goalIterations : 0;
  const next = cur + 1;
  await patchTopicMeta(root, id, { goalIterations: next });
  return next;
}

export async function clearTopicGoal(
  root: string,
  id: string,
  status: GoalStatus = "abandoned",
): Promise<void> {
  await patchTopicMeta(root, id, { goalStatus: status });
}

function parseMessages(body: string): TopicMessage[] {
  const out: TopicMessage[] = [];
  const lines = body.split(/\r?\n/);
  let current: TopicMessage | null = null;
  for (const line of lines) {
    const heading = /^##\s+(user|assistant)\s*$/i.exec(line);
    if (heading) {
      if (current) out.push({ ...current, body: current.body.trimEnd() });
      current = { role: heading[1]!.toLowerCase() as "user" | "assistant", body: "" };
      continue;
    }
    if (current) current.body += line + "\n";
  }
  if (current) out.push({ ...current, body: current.body.trimEnd() });
  return out;
}

export interface CreateTopicArgs {
  root: string;
  firstMessage: string;
  harness?: string;
  model?: string;
  language?: string;
  helperFor?: string;
  taskId?: string;
}

export async function createTopic(args: CreateTopicArgs): Promise<Topic> {
  const id = newTopicId();
  const now = new Date().toISOString();
  const title = deriveTitle(args.firstMessage);
  const meta: TopicFrontmatter = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    ...(args.harness ? { harness: args.harness } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.language ? { language: args.language } : {}),
    ...(args.helperFor ? { helperFor: args.helperFor } : {}),
    ...(args.taskId ? { taskId: args.taskId } : {}),
  };
  // .md is metadata-only now; the conversation transcript lives in
  // <id>.events.jsonl and is the single source of truth for chat content.
  await fs.mkdir(topicsDir(args.root), { recursive: true });
  await fs.writeFile(topicFile(args.root, id), serialize(meta, ""), "utf8");
  return {
    meta,
    messages: [],
    abs: topicFile(args.root, id),
  };
}

export async function appendMessage(
  root: string,
  id: string,
  message: TopicMessage,
): Promise<void> {
  const topic = await getTopic(root, id);
  if (!topic) throw new Error(`Topic not found: ${id}`);
  topic.messages.push({ ...message, body: message.body.trimEnd() });
  topic.meta.updatedAt = new Date().toISOString();
  const body =
    topic.messages
      .map((m) => `## ${m.role}\n${m.body}`)
      .join("\n\n") + "\n";
  await fs.writeFile(
    topicFile(root, id),
    serialize(topic.meta, body),
    "utf8",
  );
}

/** Overwrite the frontmatter `title` while keeping all messages intact. */
export async function updateTopicTitle(
  root: string,
  id: string,
  title: string,
): Promise<void> {
  const topic = await getTopic(root, id);
  if (!topic) throw new Error(`Topic not found: ${id}`);
  topic.meta.title = title;
  topic.meta.updatedAt = new Date().toISOString();
  const body =
    topic.messages
      .map((m) => `## ${m.role}\n${m.body}`)
      .join("\n\n") + "\n";
  await fs.writeFile(
    topicFile(root, id),
    serialize(topic.meta, body),
    "utf8",
  );
}

/**
 * Permanently delete the topic — both the frontmatter `.md` and the
 * event-log `.events.jsonl` next to it. Idempotent: missing files don't
 * throw (returns `false` for the missing-file case so callers can surface
 * "already gone" UX if they want).
 *
 * Callers are responsible for stopping any running agent on this topic
 * BEFORE calling — otherwise the agent's next emit will recreate the
 * events log under the same id.
 */
export async function deleteTopic(
  root: string,
  id: string,
): Promise<{ removedMd: boolean; removedEvents: boolean }> {
  const safeId = sanitizeId(id);
  if (!safeId) throw new Error(`Invalid topic id: ${id}`);
  const mdPath = topicFile(root, safeId);
  const eventsPath = path.join(
    topicsDir(root),
    `${safeId}.events.jsonl`,
  );
  const removedMd = await tryUnlink(mdPath);
  const removedEvents = await tryUnlink(eventsPath);
  return { removedMd, removedEvents };
}

async function tryUnlink(p: string): Promise<boolean> {
  try {
    await fs.unlink(p);
    return true;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return false;
    }
    throw err;
  }
}

function serialize(meta: TopicFrontmatter, body: string): string {
  return matter.stringify(body, meta as unknown as Record<string, unknown>);
}
