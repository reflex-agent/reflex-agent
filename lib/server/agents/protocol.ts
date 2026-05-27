import "server-only";

/**
 * Harness-neutral interaction protocol. Agents (claude-code, codex, ollama,
 * …) signal permission requests and clarifying questions to Reflex by
 * embedding tagged JSON in their output:
 *
 *   <<reflex:permission>>{"id":"opt","tool":"Write","input":{...},"description":"..."}<</reflex:permission>>
 *   <<reflex:question>>{"id":"opt","prompt":"…","choices":["yes","no"]}<</reflex:question>>
 *
 * AgentManager scans the accumulated turn text after `turn-end` and emits
 * `permission-request` / `question` events for each match. The user responds
 * through the UI; the manager appends the decision as a synthesized
 * user-message and invokes a continuation turn.
 */

export const PERMISSION_OPEN = "<<reflex:permission>>";
export const PERMISSION_CLOSE = "<</reflex:permission>>";
export const QUESTION_OPEN = "<<reflex:question>>";
export const QUESTION_CLOSE = "<</reflex:question>>";
export const KB_OPEN = "<<reflex:kb>>";
export const KB_CLOSE = "<</reflex:kb>>";
export const UTILITY_OPEN = "<<reflex:utility>>";
export const UTILITY_CLOSE = "<</reflex:utility>>";
export const DISPATCH_OPEN = "<<reflex:dispatch>>";
export const DISPATCH_CLOSE = "<</reflex:dispatch>>";
export const MCP_ADD_OPEN = "<<reflex:mcp-add>>";
export const MCP_ADD_CLOSE = "<</reflex:mcp-add>>";
export const YOUTUBE_SUMMARY_OPEN = "<<reflex:youtube-summary>>";
export const YOUTUBE_SUMMARY_CLOSE = "<</reflex:youtube-summary>>";
export const WIDGET_CREATE_OPEN = "<<reflex:widget-create>>";
export const WIDGET_CREATE_CLOSE = "<</reflex:widget-create>>";
export const WIDGET_UPDATE_OPEN = "<<reflex:widget-update>>";
export const WIDGET_UPDATE_CLOSE = "<</reflex:widget-update>>";
export const WORKFLOW_CREATE_OPEN = "<<reflex:workflow-create>>";
export const WORKFLOW_CREATE_CLOSE = "<</reflex:workflow-create>>";
export const IMAGE_GEN_OPEN = "<<reflex:image-gen>>";
export const IMAGE_GEN_CLOSE = "<</reflex:image-gen>>";
export const MEMORY_OPEN = "<<reflex:memory>>";
export const MEMORY_CLOSE = "<</reflex:memory>>";
export const SUGGESTION_OPEN = "<<reflex:suggestion>>";
export const SUGGESTION_CLOSE = "<</reflex:suggestion>>";
export const ONBOARDING_DONE_OPEN = "<<reflex:onboarding-done>>";
export const ONBOARDING_DONE_CLOSE = "<</reflex:onboarding-done>>";
export const SKILL_CREATE_OPEN = "<<reflex:skill-create>>";
export const SKILL_CREATE_CLOSE = "<</reflex:skill-create>>";

export interface PermissionDirective {
  id?: string;
  tool?: string;
  action?: string;
  input?: unknown;
  description?: string;
}

/**
 * Question for the user. Rich shape mirrors Claude Code's native
 * AskUserQuestion (which agents instinctively reach for) so the agent
 * never has to fall back to the native tool.
 *
 * - `prompt`     — main question text
 * - `header`     — very short tag/chip (max ~12 chars). Optional.
 * - `multiSelect`— if true, user can pick 0..N options (checkboxes).
 *                   Answer comes back as JSON-stringified array. Defaults to false.
 * - `options`    — rich rows with label + optional description (preferred).
 * - `choices`    — legacy flat strings; still works, treated as label-only options.
 *
 * For multiple questions in one batch, wrap them in `{questions: [...]}`
 * — the extractor flattens the batch into individual events keyed by id.
 */
export interface QuestionDirective {
  id?: string;
  prompt: string;
  header?: string;
  multiSelect?: boolean;
  choices?: string[];
  options?: Array<{ label: string; description?: string }>;
}

export interface QuestionBatch {
  questions: QuestionDirective[];
}

/**
 * "Save this into the project knowledge base." Materializes as
 * `<root>/.reflex/<kind>/<date>-<slug>.md` with frontmatter.
 */
export interface KbDirective {
  /** e.g. "fact" | "task" | "meeting" | "product" | …custom. */
  kind: string;
  title: string;
  /** Markdown body (rendered after the frontmatter). */
  body?: string;
  /** Free-form structured fields surfaced as frontmatter (status, tags,
   *  attendees, sku, price, url, …). */
  meta?: Record<string, unknown>;
  /** Optional slug override; otherwise derived from title. */
  slug?: string;
  /** Optional date override (defaults to today) in YYYY-MM-DD. */
  date?: string;
}

export function extractPermissions(text: string): PermissionDirective[] {
  return extractAll<PermissionDirective>(text, PERMISSION_OPEN, PERMISSION_CLOSE);
}

export function extractQuestions(text: string): QuestionDirective[] {
  // Accept both single `{prompt:..., options:...}` and batch
  // `{questions:[...]}` forms in one marker. Flatten everything into a
  // single list of individual questions.
  const raw = extractAll<QuestionDirective | QuestionBatch>(
    text,
    QUESTION_OPEN,
    QUESTION_CLOSE,
  );
  const out: QuestionDirective[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    if ("questions" in r && Array.isArray((r as QuestionBatch).questions)) {
      for (const q of (r as QuestionBatch).questions) {
        if (q && typeof q === "object" && typeof q.prompt === "string") {
          out.push(q);
        }
      }
      continue;
    }
    if (typeof (r as QuestionDirective).prompt === "string") {
      out.push(r as QuestionDirective);
    }
  }
  return out;
}

export function extractKbEntries(text: string): KbDirective[] {
  return extractAll<KbDirective>(text, KB_OPEN, KB_CLOSE).filter(
    (e): e is KbDirective =>
      typeof e?.kind === "string" && typeof e?.title === "string",
  );
}

/**
 * Memory marker — the agent decides what facts about the user (global)
 * or the current project (scope=project) are durable enough to persist.
 * Handler in manager validates and writes through the same store the
 * settings UI uses, so the user can edit/wipe anything the agent saved.
 */
export interface MemoryDirective {
  scope: "global" | "project";
  file: string;
  op: "append" | "replace" | "remove";
  content?: string;
  match?: string;
}

export function extractMemoryWrites(text: string): MemoryDirective[] {
  return extractAll<MemoryDirective>(text, MEMORY_OPEN, MEMORY_CLOSE).filter(
    (e): e is MemoryDirective =>
      !!e &&
      typeof e.scope === "string" &&
      typeof e.file === "string" &&
      typeof e.op === "string",
  );
}

/**
 * "I think the user might want X" — agent hypothesises a utility install,
 * a research topic, a widget, or a goal. Lands on the project dashboard
 * as a card the user approves or rejects. Approval spawns a topic with
 * `prompt` pre-seeded; rejection writes it to project AVOID memory.
 */
export interface SuggestionDirective {
  kind: "utility" | "research" | "widget" | "goal" | "skill";
  title: string;
  description: string;
  /** Slash-command or chat message the approve-action will send. */
  prompt: string;
}

export function extractSuggestions(text: string): SuggestionDirective[] {
  return extractAll<SuggestionDirective>(
    text,
    SUGGESTION_OPEN,
    SUGGESTION_CLOSE,
  ).filter(
    (e): e is SuggestionDirective =>
      !!e &&
      typeof e.kind === "string" &&
      typeof e.title === "string" &&
      typeof e.description === "string" &&
      typeof e.prompt === "string",
  );
}

/**
 * "I noticed you keep asking me to do X — let's capture that as a skill."
 * The orchestrator emits this when it spots a recurring pattern in the
 * Space (or across Spaces for global). Manager validates, writes the
 * markdown file via `writeSkill`, and emits a `skill-created` event.
 */
export interface SkillCreateDirective {
  scope: "global" | "project";
  id: string;
  title: string;
  description: string;
  instructions: string;
  workflowId?: string;
  utilityRef?: string;
}

export function extractSkillCreates(text: string): SkillCreateDirective[] {
  return extractAll<SkillCreateDirective>(
    text,
    SKILL_CREATE_OPEN,
    SKILL_CREATE_CLOSE,
  ).filter(
    (e): e is SkillCreateDirective =>
      !!e &&
      (e.scope === "global" || e.scope === "project") &&
      typeof e.id === "string" &&
      e.id.trim().length > 0 &&
      typeof e.title === "string" &&
      typeof e.instructions === "string" &&
      e.instructions.trim().length > 0,
  );
}

/**
 * Empty marker the onboarding skill emits at the end of its final turn to
 * signal "dashboard is ready, the wizard is done." The chat-view renders
 * a CTA card so the user can jump to the dashboard.
 */
export function hasOnboardingDone(text: string): boolean {
  // Lenient — accept `<reflex:...>` and `<<reflex:...>>`, with or without
  // a payload between open/close.
  return /<{1,2}reflex:onboarding-done>{1,2}[\s\S]*?<{1,2}\/reflex:onboarding-done>{1,2}/i.test(
    text,
  );
}

/**
 * Utility generation marker. Carries scope + manifest + raw source files.
 * Validation/installation is done in manager.ts.
 */
export interface UtilityDirective {
  scope: "global" | "project";
  manifest: unknown;
  files: Record<string, string>;
}

/**
 * "Hand this task to a specialist." Carries a sub-role id (see
 * `sub-roles.ts`) plus a self-contained brief. The orchestrator pauses; the
 * manager spawns one short-lived sub-agent per dispatch, awaits them
 * concurrently, then feeds the synthesized results back so the orchestrator
 * can compose the final user-facing message.
 */
export interface DispatchDirective {
  /** Optional client-supplied id so the orchestrator can correlate results. */
  id?: string;
  /** Sub-role id (e.g. "researcher", "coder", "summarizer"). */
  role: string;
  /** Self-contained instructions for the specialist. */
  brief: string;
  /**
   * Optional harness override for this sub-agent. When omitted, the
   * sub-agent inherits the orchestrator's harness. Use this to route
   * code-heavy work to Codex (`"codex"`) while keeping the orchestrator
   * on Claude Code, or to delegate cheap pattern-match jobs to Ollama.
   */
  harness?: string;
  /** Optional model override; companion to `harness`. */
  model?: string;
}

/**
 * "Register a new MCP server in the global registry." Surfaced as a
 * user-approvable card: agent proposes the server (command/url + which env
 * vars are secrets the user must paste), user fills any required values and
 * clicks Approve. The manager merges the values into `config.env`, persists
 * via the registry, and feeds back a confirmation message to the agent.
 *
 * Anything sensitive (tokens, API keys) goes through the `secrets` field —
 * the agent SEES only the description it wrote itself; values come from the
 * user's input at approve-time and never enter chat transcript.
 */
export interface McpAddSecretSlot {
  /** Env-var key the value will be written to (e.g. "GITHUB_TOKEN"). */
  envKey: string;
  /** Short human label shown next to the input. */
  label: string;
  /** Explanation: what it is, where to obtain it, link if helpful. */
  description?: string;
  required?: boolean;
  /**
   * If set, this slot is filled via OAuth flow with the named provider —
   * the UI shows an "Authorize" button instead of a password input, and the
   * env value is persisted as `$oauth:<provider>` so tokens auto-rotate.
   * Provider must exist in `lib/server/oauth/providers.ts`.
   */
  oauth?: string;
}

export interface McpAddDirective {
  /** Optional client-supplied id so the agent can correlate the response. */
  id?: string;
  /** Server slug (kebab-case). Becomes the registry id. */
  server: string;
  label: string;
  description?: string;
  /** Same shape as `McpConfig`, possibly missing secret env values. */
  config: unknown;
  /** Env vars the user must paste at approve-time. */
  secrets?: McpAddSecretSlot[];
}

export function extractMcpAdds(text: string): McpAddDirective[] {
  return extractAll<McpAddDirective>(text, MCP_ADD_OPEN, MCP_ADD_CLOSE).filter(
    (d): d is McpAddDirective =>
      d !== null &&
      typeof d === "object" &&
      typeof d.server === "string" &&
      typeof d.label === "string" &&
      typeof d.config === "object" &&
      d.config !== null,
  );
}

export function extractDispatches(text: string): DispatchDirective[] {
  return extractAll<DispatchDirective>(text, DISPATCH_OPEN, DISPATCH_CLOSE).filter(
    (d): d is DispatchDirective =>
      d !== null &&
      typeof d === "object" &&
      typeof d.role === "string" &&
      typeof d.brief === "string" &&
      d.brief.trim().length > 0,
  );
}

/**
 * "Run Gemini's native YouTube summarization on this URL." The orchestrator
 * decides — based on the user's request — whether the video's content is
 * needed at all (e.g. "what's the video about / what do they say / describe it" -> yes;
 * "which player is better / fix the link" -> no). Reflex auto-executes (no
 * approval card), since the Gemini key is already user-authorized in
 * Settings, then re-invokes the agent with the summary as user context.
 */
export interface YoutubeSummaryDirective {
  /** Optional client-supplied id so the orchestrator can correlate the response. */
  id?: string;
  /** Canonical YouTube URL (watch?v= / youtu.be / shorts / embed all fine). */
  url: string;
  /**
   * Optional custom Gemini prompt. Defaults to a generic
   * "summarize this video in <language>" so the orchestrator usually doesn't
   * need to supply one.
   */
  prompt?: string;
}

export function extractYoutubeSummaries(text: string): YoutubeSummaryDirective[] {
  return extractAll<YoutubeSummaryDirective>(
    text,
    YOUTUBE_SUMMARY_OPEN,
    YOUTUBE_SUMMARY_CLOSE,
  ).filter(
    (d): d is YoutubeSummaryDirective =>
      d !== null && typeof d === "object" && typeof d.url === "string",
  );
}

/**
 * "Create (or replace) a dashboard widget." The agent emits the full widget
 * payload — Reflex validates the kind+data against the registry, persists
 * to `<root>/.reflex/widgets/<id>.json`, prepends to the dashboard layout,
 * and emits a `widget-event` so chat-view can render a preview.
 *
 * Updates use the same shape but with `<<reflex:widget-update>>`; same
 * payload, just patches an existing record by id. Missing id → 404 fed back.
 */
export interface WidgetDirective {
  /** Stable kebab-case id. Reused for updates. */
  id: string;
  /** User-visible title. */
  title: string;
  /** Optional one-line description, shown under the title. */
  description?: string;
  /** Widget kind — must be one of the renderer registry's kinds. */
  kind: string;
  /** Kind-specific payload (see lib/server/widgets/types.ts). */
  data: unknown;
  /** Optional layout hint — column span / size mode. Both forms accepted
   *  for back-compat; `mode` is preferred. */
  size?: { cols?: 1 | 2 | 3; mode?: "sm" | "md" | "wide" };
  /** Auto-refresh cadence — "manual" | "hourly" | "daily" | "weekly". */
  refresh?: "manual" | "hourly" | "daily" | "weekly";
  /** Inline agent-managed memory for short structured state (<2KB). */
  memory?: string;
  /** Rel-path of an external markdown memory file (long-form history). */
  memoryFile?: string;
}

/**
 * Workflow definition emitted by the agent. Shape mirrors WorkflowDef
 * but `createdAt`/`updatedAt` are stamped on persist, and `steps[].id`
 * is auto-generated if omitted.
 */
export interface WorkflowDirective {
  id: string;
  label: string;
  description?: string;
  trigger?: "manual" | "hourly" | "daily" | "weekly";
  steps: Array<{
    id?: string;
    kind: string;
    label: string;
    params?: Record<string, unknown>;
  }>;
}

export function extractWorkflowCreates(text: string): WorkflowDirective[] {
  return extractAll<WorkflowDirective>(
    text,
    WORKFLOW_CREATE_OPEN,
    WORKFLOW_CREATE_CLOSE,
  ).filter(
    (d): d is WorkflowDirective =>
      !!d &&
      typeof d === "object" &&
      typeof d.id === "string" &&
      typeof d.label === "string" &&
      Array.isArray(d.steps) &&
      d.steps.length > 0,
  );
}

export function extractWidgetCreates(text: string): WidgetDirective[] {
  return extractAll<WidgetDirective>(
    text,
    WIDGET_CREATE_OPEN,
    WIDGET_CREATE_CLOSE,
  ).filter(validateWidgetDirective);
}

export function extractWidgetUpdates(text: string): WidgetDirective[] {
  return extractAll<WidgetDirective>(
    text,
    WIDGET_UPDATE_OPEN,
    WIDGET_UPDATE_CLOSE,
  ).filter(validateWidgetDirective);
}

function validateWidgetDirective(d: WidgetDirective): d is WidgetDirective {
  return (
    !!d &&
    typeof d === "object" &&
    typeof d.id === "string" &&
    d.id.length > 0 &&
    typeof d.title === "string" &&
    typeof d.kind === "string" &&
    !!d.data &&
    typeof d.data === "object"
  );
}

/**
 * "Generate an image and embed it in this assistant message." Reflex calls
 * the image service synchronously after turn-end, saves the bytes into
 * `<root>/.reflex/assets/images/<sha>.<ext>`, and appends a markdown image
 * reference to the assistant's reply (so MarkdownView renders it inline).
 * Optionally pins the image into KB as a `kind:"image"` entry.
 */
export interface ImageGenDirective {
  prompt: string;
  provider?: "gemini" | "codex";
  /** Pass-through hint, primarily for Codex (`1024x1024` etc). */
  size?: string;
  /** Gemini accepts e.g. `1:1`, `16:9`, `9:16`. */
  aspectRatio?: string;
  /** Caption text — used for markdown alt + KB title. */
  caption?: string;
  /** If true, also kb.add the image as a standalone entry. */
  attachToKb?: boolean;
  /** Optional reference images (URLs) for image+text generation. */
  referenceImageUrls?: string[];
}

export function extractImageGens(text: string): ImageGenDirective[] {
  return extractAll<ImageGenDirective>(text, IMAGE_GEN_OPEN, IMAGE_GEN_CLOSE).filter(
    (d): d is ImageGenDirective =>
      !!d &&
      typeof d === "object" &&
      typeof d.prompt === "string" &&
      d.prompt.trim().length > 0,
  );
}

export function extractUtilityDirectives(text: string): UtilityDirective[] {
  return extractAll<UtilityDirective>(text, UTILITY_OPEN, UTILITY_CLOSE).filter(
    (e): e is UtilityDirective =>
      e !== null &&
      typeof e === "object" &&
      (e.scope === "global" || e.scope === "project") &&
      typeof e.files === "object" &&
      e.files !== null,
  );
}

/**
 * Lenient marker extractor. We've documented `<<reflex:X>>...<</reflex:X>>`
 * as the canonical syntax, but LLMs sometimes drop one of the angle
 * brackets (especially the opener, since `<` reads as an XML-tag prefix).
 * Accept both `<` and `<<` on either end so a typo doesn't silently break
 * the directive.
 */
function extractAll<T>(text: string, open: string, close: string): T[] {
  // Strip leading "<<" and trailing ">>" from constants to reuse the inner
  // marker name (e.g. "reflex:mcp-add").
  const innerOpen = open.replace(/^<+/, "").replace(/>+$/, "");
  const innerClose = close.replace(/^<+/, "").replace(/>+$/, "");
  const reOpen = new RegExp(`<{1,2}${escapeRegex(innerOpen)}>{1,2}`, "g");
  const reClose = new RegExp(`<{1,2}${escapeRegex(innerClose)}>{1,2}`, "g");
  const out: T[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    reOpen.lastIndex = cursor;
    const startMatch = reOpen.exec(text);
    if (!startMatch) break;
    const payloadStart = startMatch.index + startMatch[0].length;
    reClose.lastIndex = payloadStart;
    const endMatch = reClose.exec(text);
    if (!endMatch) break;
    const payload = text.slice(payloadStart, endMatch.index).trim();
    cursor = endMatch.index + endMatch[0].length;
    try {
      out.push(JSON.parse(payload) as T);
    } catch {
      // skip malformed payload
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
