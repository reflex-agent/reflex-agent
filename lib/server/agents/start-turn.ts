import "server-only";
import path from "node:path";
import { reflexRoot } from "@/lib/reflex/paths";
import { chatSystemPrompt } from "@/lib/reflex/agents/prompts";
import { loadSettings } from "@/lib/settings/store";
import { getRoot } from "@/lib/registry";
import { agentManager } from "./manager";
import { readEvents } from "./events-log";
import {
  detectSlashCommand,
  distillInstructions,
  goalInstructions,
  mcpInstructionsForCommand,
  practiceInstructions,
  reflectInstructions,
  workflowInstructionsForCommand,
  planInstructions,
  researchInstructions,
  widgetInstructionsForCommand,
} from "./slash-commands";
import { detectCommand } from "./commands-registry";
import { getTopic, setTopicGoal } from "@/lib/server/topics";
import { loadSkill } from "@/lib/server/skills";
import { buildMemoryBlock } from "@/lib/server/memory/inject";

export interface Attachment {
  name: string;
  absPath: string;
  size: number;
  mime: string;
}

// Cyrillic prefix (\u0440\u0443\u0441 = "rus" in Russian) — kept as a
// unicode-escaped string so this source stays ASCII while still matching
// localized russian-spelled language settings at runtime.
const RU_PREFIX = "\u0440\u0443\u0441";

/**
 * Spawn (or reuse) the topic's orchestrator and run one turn for the given
 * user message. Called from both POST /send and from startTopicAction so the
 * code path for "first message" and "subsequent message" is the same.
 *
 * Returns immediately with the agent id. The actual turn runs in the
 * background — closing the tab won't kill it.
 */
export async function startOrchestratorTurn(args: {
  rootId: string;
  topicId: string;
  message: string;
  attachments?: Attachment[];
  /**
   * Rel-path (inside `<root>/.reflex/`) of the KB document the user was
   * reading when they started this turn. Treated as primary context: the
   * agent is instructed to Read it first and only fall back to neighbouring
   * files if the answer isn't there.
   */
  focusFile?: string;
  /**
   * Optional harness override for this turn. When set, takes precedence
   * over `settings.assignments.chat.harness` — used by headless callers
   * (`reflex.agent.invoke({harness: ...})`) and image-gen flows that
   * need a specific runtime regardless of the user's default.
   */
  harness?: import("./types").AgentHarnessId;
  /** Optional model override; companion to `harness`. */
  model?: string;
}): Promise<{ agentId: string } | { error: string; status?: number }> {
  const entry = await getRoot(args.rootId);
  if (!entry) return { error: "Root not found", status: 404 };
  if (agentManager.isActive(args.topicId)) {
    return { error: "Topic already has a running agent", status: 409 };
  }
  const settings = await loadSettings();
  const assignment = settings.assignments.chat;
  const harness = args.harness ?? assignment.harness;
  const model = args.model ?? assignment.model;
  const language = settings.language;
  const reflexScope = reflexRoot(entry.path);

  // Slash commands: /plan augments this turn's system prompt; /goal also
  // persists state on the topic so the manager can keep auto-invoking the
  // agent until the goal is achieved. Other agent-mode commands
  // (/research, /widget, /mcp, /skill) just contribute a system-prompt
  // addendum for this turn.
  const command = detectSlashCommand(args.message);
  const richCommand = detectCommand(args.message);
  let effectiveMessage = args.message;
  if (command) {
    if (command.kind === "goal" && command.text) {
      await setTopicGoal(entry.path, args.topicId, command.text);
      effectiveMessage = command.text;
    } else if (command.kind === "plan") {
      effectiveMessage = command.text || args.message;
    }
  } else if (richCommand && richCommand.def.kind === "agent-mode") {
    // For non-plan/goal agent-mode commands, drop the `/cmd` prefix from
    // the message the agent sees — the system prompt addendum carries
    // the instructions; the agent works against the cleaned payload.
    effectiveMessage = richCommand.payload || args.message;
  }

  // Optional skill loaded for this turn via `/skill <id> [payload]`.
  let skillBlock: string | null = null;
  if (richCommand?.def.id === "skill") {
    const [skillId, ...rest] = richCommand.payload.split(/\s+/);
    if (skillId) {
      const skill = await loadSkill(skillId);
      if (skill) {
        skillBlock = skill.instructions;
        effectiveMessage = rest.join(" ").trim() || effectiveMessage;
      }
    }
  }

  // Re-load topic to pick up active goal (set either above or in a previous
  // turn). Goal instructions are folded into the system prompt every turn.
  const topic = await getTopic(entry.path, args.topicId);
  const activeGoal =
    topic?.meta.goal && topic.meta.goalStatus === "active"
      ? topic.meta.goal
      : undefined;

  const baseSystemPrompt = await chatSystemPrompt({
    root: entry.path,
    scope: entry.path,
    reflexScope,
    language,
  });
  const memoryBlock = await buildMemoryBlock({ rootPath: entry.path });
  const youtubeUrls = extractYoutubeUrls(effectiveMessage);
  const systemPrompt = [
    baseSystemPrompt,
    memoryBlock,
    activeGoal ? goalInstructions(activeGoal, language) : "",
    command?.kind === "plan" ? planInstructions(language) : "",
    richCommand?.def.id === "research"
      ? researchInstructions(richCommand.payload, language)
      : "",
    richCommand?.def.id === "widget"
      ? widgetInstructionsForCommand(richCommand.payload, language)
      : "",
    richCommand?.def.id === "mcp"
      ? mcpInstructionsForCommand(richCommand.payload, language)
      : "",
    richCommand?.def.id === "workflow"
      ? workflowInstructionsForCommand(richCommand.payload, language)
      : "",
    richCommand?.def.id === "distill"
      ? distillInstructions(richCommand.payload, language)
      : "",
    richCommand?.def.id === "practice"
      ? practiceInstructions(richCommand.payload, language)
      : "",
    richCommand?.def.id === "reflect"
      ? reflectInstructions(language)
      : "",
    skillBlock ?? "",
    args.focusFile ? focusFileInstructions(args.focusFile, reflexScope, language) : "",
    youtubeUrls.length > 0
      ? youtubeSummaryInstructions(youtubeUrls, language)
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const agent = await agentManager.ensureAgent({
    topicId: args.topicId,
    rootId: args.rootId,
    rootPath: entry.path,
    reflexScope,
    role: "orchestrator",
    task: "chat",
    harness,
    model,
    language,
    label: "Orchestrator",
  });

  const userMessageForLog = renderUserBlockPlain(
    args.message,
    args.attachments,
  );

  // Emit the user-message event synchronously so the topic UI shows the
  // user's bubble immediately — before any of the (potentially slow)
  // preflight work runs. Normally `invoke()` emits this itself, but we want
  // the bubble + preflight progress visible *before* invoke is even called.
  await agentManager.emit({
    type: "user-message",
    text: userMessageForLog,
    agentId: agent.id,
    ts: new Date().toISOString(),
    seq: 0,
  });

  // Heavy prep (transcript read) plus invoke happen in the background so
  // the HTTP /send caller returns immediately with the agentId. If the
  // orchestrator decides it needs a YouTube summary, it emits the
  // <<reflex:youtube-summary>> directive — the manager intercepts and
  // continues the turn with Gemini output. No regex pre-flight here.
  void (async () => {
    try {
      const transcript = await renderTranscript(entry.path, args.topicId);
      const userBlock = renderUserBlock(effectiveMessage, args.attachments);
      const prompt = transcript
        ? `Prior conversation:\n\n${transcript}\n\n${userBlock}\n\n### assistant\n(Reply now.)`
        : `${userBlock}\n\n### assistant\n(Reply now.)`;
      await agentManager.invoke({
        agentId: agent.id,
        systemPrompt,
        prompt,
        // userMessage NOT passed here — we already emitted user-message
        // synchronously above so the bubble shows up immediately.
        allowedTools: assignment.allowedTools,
      });
    } catch (err) {
      await agentManager.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        agentId: agent.id,
        ts: new Date().toISOString(),
        seq: 0,
      });
    }
  })();

  return { agentId: agent.id };
}

/**
 * Appended to the orchestrator's system prompt only when the user's
 * message contains a YouTube URL. Tells the agent it can ask Reflex to
 * fetch a Gemini-generated summary on demand — but only when the user's
 * request actually needs the video's *content* (description, what's said,
 * key points). For purely meta questions ("what player is best",
 * "fix this URL") the agent just answers directly without the directive.
 */
function youtubeSummaryInstructions(urls: string[], language: string): string {
  const isRu =
    /russ/i.test(language) || new RegExp(RU_PREFIX, "i").test(language);
  const urlList = urls.map((u) => `- ${u}`).join("\n");
  if (isRu) {
    return [
      "## YouTube video in the message",
      "",
      "The user's message contains YouTube URL(s):",
      urlList,
      "",
      "**Decide whether you actually need the video's content to answer.**",
      "",
      "- If the user wants to know **what the video is about** / **what's said in it** / a description / summary / quotes / facts — ask Reflex to run a Gemini summary:",
      "",
      "```",
      `<<reflex:youtube-summary>>{"url":"<URL>"}<</reflex:youtube-summary>>`,
      "```",
      "",
      "  One marker per video, all in the same turn. After emitting markers **STOP** — do not try to answer in this same turn. Reflex will wait for Gemini and re-invoke you with the summary in context.",
      "",
      "- If the request **doesn't need** the video's content (for example \"which player is better\", \"fix this link\", \"add another video to this\") — answer directly, no directive.",
      "",
      "- **Do not use WebFetch** for YouTube URLs — it returns neither captions nor video. Only the directive above.",
      "",
      "- If the Gemini summary fails (Reflex will return an error message), apologise and suggest saving a key in Settings -> Gemini. Respond in Russian.",
    ].join("\n");
  }
  return [
    "## YouTube video in the message",
    "",
    "The user's message contains YouTube URL(s):",
    urlList,
    "",
    "**Decide whether you actually need the video's content to answer.**",
    "",
    "- If the user wants to know **what the video is about** / **what's said in it** / a description / summary / quotes / facts — ask Reflex to run Gemini-summary:",
    "",
    "```",
    `<<reflex:youtube-summary>>{"url":"<URL>"}<</reflex:youtube-summary>>`,
    "```",
    "",
    "  One marker per video, all in the same turn. After emitting markers **STOP** — don't try to answer in this same turn. Reflex will wait for Gemini and re-invoke you with the summary in context.",
    "",
    "- If the request **doesn't need** the video's content (\"which player is best\", \"fix this URL\", \"add another video\") — answer directly, no directive.",
    "",
    "- **Don't use WebFetch** for YouTube URLs — it gets neither captions nor video. Only the directive above.",
    "",
    "- If the Gemini summary fails (Reflex will return an error message), apologise and suggest saving a key in Settings → Gemini.",
  ].join("\n");
}

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

function extractYoutubeUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s)>'"]+/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    try {
      const u = new URL(raw);
      if (!YT_HOSTS.has(u.hostname.toLowerCase())) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function focusFileInstructions(
  relPath: string,
  reflexScope: string,
  language: string,
): string {
  const abs = path.join(reflexScope, relPath);
  const isRu =
    /russ/i.test(language) || new RegExp(RU_PREFIX, "i").test(language);
  if (isRu) {
    return [
      "## Open document — primary context",
      "",
      `The user is currently reading this KB file: \`${relPath}\``,
      `Absolute path: \`${abs}\``,
      "",
      "Rules for this turn (respond in Russian):",
      "1. **Read this file in full via the Read tool first** — it is the primary source of context.",
      "2. Base your answer primarily on its contents.",
      "3. Only fall back to neighbouring files (same directory, sibling INDEX.md, parent dir) if the open file lacks the needed info.",
      "4. Don't guess: if neither the open file nor its neighbours contain the answer, say so explicitly and suggest where to look.",
      "5. When linking in your reply, use paths relative to the KB root (matching the open file).",
    ].join("\n");
  }
  return [
    "## Open document — primary context",
    "",
    `The user is currently reading this KB file: \`${relPath}\``,
    `Absolute path: \`${abs}\``,
    "",
    "Rules for this turn:",
    "1. **Read this file first via the Read tool** — it is the primary source of context.",
    "2. Base your answer primarily on its contents.",
    "3. Only fall back to neighbouring files (same directory, sibling INDEX.md, parent dir) if the open file lacks the needed info.",
    "4. Don't guess: if neither the open file nor its neighbours contain the answer, say so explicitly and suggest where to look.",
    "5. When citing, use rel-paths from the KB root (same convention as the open file).",
  ].join("\n");
}

function renderUserBlock(message: string, attachments?: Attachment[]): string {
  const lines: string[] = ["### user", message.trim() || "(no text)"];
  if (attachments && attachments.length > 0) {
    lines.push("");
    lines.push("Attached files (use the Read tool to open them):");
    for (const a of attachments) {
      lines.push(`  - ${a.absPath} (${a.mime}, ${a.size} bytes) — original: ${a.name}`);
    }
  }
  return lines.join("\n");
}

function renderUserBlockPlain(
  message: string,
  attachments?: Attachment[],
): string {
  const out = message.trim();
  if (!attachments || attachments.length === 0) return out;
  const list = attachments
    .map((a) => `📎 ${a.name} (${a.absPath})`)
    .join("\n");
  return out ? `${out}\n\n${list}` : list;
}

async function renderTranscript(
  rootPath: string,
  topicId: string,
): Promise<string> {
  const events = await readEvents(rootPath, topicId);
  const lines: string[] = [];
  let current: { role: "user" | "assistant"; text: string } | null = null;
  const flush = () => {
    if (!current) return;
    lines.push(`### ${current.role}\n${current.text.trim()}`);
    current = null;
  };
  for (const ev of events) {
    if (ev.type === "user-message") {
      flush();
      current = { role: "user", text: ev.text };
      flush();
    } else if (ev.type === "assistant-delta") {
      if (!current || current.role !== "assistant") {
        flush();
        current = { role: "assistant", text: "" };
      }
      current.text += ev.text;
    } else if (ev.type === "turn-end" || ev.type === "agent-end") {
      flush();
    }
  }
  flush();
  return lines.join("\n\n");
}
