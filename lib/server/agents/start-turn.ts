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
  newUtilityInstructions,
} from "./slash-commands";
import { detectCommand, type CommandDef } from "./commands-registry";
import { getTopic, setTopicGoal } from "@/lib/server/topics";
import { loadSkill } from "@/lib/server/skills";
import { buildMemoryBlock } from "@/lib/server/memory/inject";
import { collectExtensions } from "@/lib/server/utilities/extensions";

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
  // Fold in any utility-declared slash commands so they're recognised
  // the same as built-ins. The matching utility's `promptBlock` is
  // appended to the system prompt below.
  const extensions = await collectExtensions({ rootId: args.rootId });
  const utilityCommandDefs: CommandDef[] = extensions.slashCommands.map((c) => ({
    id: `${c.utility.utilityId}:${c.id}`,
    trigger: c.trigger,
    label: c.label,
    description: c.description,
    kind: c.kind,
    usage: c.usage,
    allowEmpty: c.allowEmpty,
    icon: c.icon,
  }));
  const command = detectSlashCommand(args.message);
  const richCommand = detectCommand(args.message, utilityCommandDefs);
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
  // Skills are resolved through project → global → builtin precedence so
  // a Space-specific override can shadow a global skill with the same id.
  let skillBlock: string | null = null;
  if (richCommand?.def.id === "skill") {
    const [skillId, ...rest] = richCommand.payload.split(/\s+/);
    if (skillId) {
      const skill = await loadSkill(skillId, entry.path, args.rootId);
      if (skill) {
        let body = skill.instructions;
        // If the skill binds to a workflow, run it now so the agent sees
        // the freshest output as part of its system prompt. Substitute
        // `{{workflowOutput}}` if present; otherwise append a context
        // section so the skill still gets the data.
        if (skill.workflowId) {
          const wfOutput = await runSkillWorkflow(
            args.rootId,
            skill.workflowId,
          );
          if (wfOutput !== null) {
            if (body.includes("{{workflowOutput}}")) {
              body = body.replace(/\{\{workflowOutput\}\}/g, wfOutput);
            } else {
              body = `${body}\n\n## Workflow output (from \`${skill.workflowId}\`)\n${wfOutput}`;
            }
          }
        }
        skillBlock = body;
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
    richCommand?.def.id === "new-utility"
      ? newUtilityInstructions(richCommand.payload, language)
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
    // Utility extensions: always-on system prompt addenda first, then
    // a per-turn block if the user invoked a utility-declared command.
    ...extensions.promptBlocks.map((p) => p.content),
    findUtilityCommandPromptBlock(richCommand, extensions, language) ?? "",
    // Dispatcher mode — only in the home Space.
    await dispatcherInstructions(args.rootId, language),
    // Dispatched-agent mode — when the dispatcher spawned this topic.
    topic?.meta.dispatchedFromDispatcher
      ? dispatchedAgentInstructions(language)
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
      const transcript = await renderTranscript(
        entry.path,
        args.topicId,
        args.rootId,
      );
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
/**
 * Dispatcher addendum — injected only when the chat runs in the home
 * Space. Turns the orchestrator into the central dispatcher: it knows
 * the user's Spaces and can act across them via `<<reflex:route>>`.
 */
async function dispatcherInstructions(
  rootId: string,
  language: string,
): Promise<string> {
  const { isHomeRoot, listRoots } = await import("@/lib/registry");
  if (!isHomeRoot(rootId)) return "";
  const roots = await listRoots().catch(() => []);
  const list =
    roots.length > 0
      ? roots
          .map((r) => `  - ${r.path.split("/").filter(Boolean).pop()} → id: ${r.id}`)
          .join("\n")
      : "  (none yet)";
  return [
    "## You are the dispatcher",
    "",
    `Reply in ${language}. This is the central, always-on thread — the user talks to you here AND from Telegram (same conversation). Two jobs:`,
    "  1. Collect durable facts about the user/their world into global memory (use `<<reflex:memory>>` with scope:\"global\").",
    "  2. Route work into the right Space. You can act ACROSS Spaces with `<<reflex:route>>`:",
    "",
    "```",
    `<<reflex:route>>{"kind":"space-create","title":"Side project X"}<</reflex:route>>`,
    `<<reflex:route>>{"kind":"task","rootId":"<space-id>","title":"…","body":"…","taskType":"feature"}<</reflex:route>>`,
    `<<reflex:route>>{"kind":"dispatch","rootId":"<space-id>","prompt":"…what the agent should do there…"}<</reflex:route>>`,
    "```",
    "",
    "Known Spaces (use their id as `rootId`):",
    list,
    "",
    "- `space-create` registers a new Space (folder under ~/reflex-spaces unless you pass `path`).",
    "- `task` files a card on that Space's board. `dispatch` starts an agent working in that Space immediately.",
    "- Prefer routing over doing project work here — this thread coordinates; the Spaces do the work. Confirm what you routed in one line.",
  ].join("\n");
}

/**
 * Injected when the dispatcher spawned this topic. The user isn't
 * watching this Space — they're in the dispatcher chat / Telegram — so
 * the agent must report back.
 */
function dispatchedAgentInstructions(language: string): string {
  return [
    "## You were dispatched here by the dispatcher",
    "",
    `Reply in ${language}. The user who asked for this is NOT watching this Space — they're in the central dispatcher chat (and Telegram). Keep them in the loop by reporting back:`,
    "",
    "```",
    `<<reflex:report>>{"status":"done","body":"one-line summary of what you did / the result"}<</reflex:report>>`,
    `<<reflex:report>>{"status":"question","body":"the exact question or blocker you need them to resolve"}<</reflex:report>>`,
    "```",
    "",
    "- ALWAYS emit a `done` report when you finish the task — with the outcome, not just \"done\".",
    "- The moment you're blocked or need a decision, emit a `question` report instead of stalling.",
    "- `update` status is fine for a meaningful mid-way checkpoint on a long task. Don't spam.",
    "- Do the actual work in this Space as usual; the report is how the result travels back to the user.",
  ].join("\n");
}

function findUtilityCommandPromptBlock(
  rich: { def: CommandDef; payload: string } | null,
  extensions: Awaited<ReturnType<typeof collectExtensions>>,
  language: string,
): string | null {
  if (!rich || rich.def.kind !== "agent-mode") return null;
  // Utility commands have ids of the form "<utilityId>:<commandId>".
  if (!rich.def.id.includes(":")) return null;
  const hit = extensions.slashCommands.find(
    (c) =>
      `${c.utility.utilityId}:${c.id}` === rich.def.id &&
      c.trigger === rich.def.trigger,
  );
  if (!hit?.promptBlock) return null;
  return hit.promptBlock
    .replace(/\{payload\}/g, rich.payload)
    .replace(/\{language\}/g, language);
}

async function runSkillWorkflow(
  rootId: string,
  workflowId: string,
): Promise<string | null> {
  try {
    const { runWorkflow } = await import("@/lib/server/workflows/runner");
    const res = await runWorkflow(rootId, workflowId);
    if (!res.ok) return null;
    // Concatenate every step's final output, plain text.
    const parts: string[] = [];
    for (const step of res.run.steps) {
      const out = step.output;
      if (out === undefined || out === null) continue;
      parts.push(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    }
    return parts.join("\n\n").trim() || null;
  } catch {
    return null;
  }
}

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
  rootId?: string,
): Promise<string> {
  let events = await readEvents(rootPath, topicId);
  let prefix = "";
  // Dispatcher thread is infinite — fold covered history into the rolling
  // summary so the prompt stays bounded (canonical log untouched).
  if (rootId && (await import("@/lib/registry")).isHomeRoot(rootId)) {
    const { getDispatcherSummary } = await import("@/lib/server/home/dispatcher");
    const summary = await getDispatcherSummary(topicId);
    if (summary && summary.coveredCount < events.length) {
      prefix = `### context (summary of earlier conversation)\n${summary.text}\n\n`;
      events = events.slice(summary.coveredCount);
    }
  }
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
  return prefix + lines.join("\n\n");
}
