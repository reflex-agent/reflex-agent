import "server-only";
import { detectCommand } from "./commands-registry";

/**
 * Slash commands that turn into agent-mode turns. Direct-action commands
 * (`/remember`, `/delete-topic`, `/clear-project`, `/help`) never reach
 * here — they're intercepted client-side.
 *
 * The legacy `/plan` and `/goal` callers expect a small narrow shape; the
 * new commands (`/research`, `/widget`, `/mcp`, `/skill`) plug in via
 * `agentModeInstructions(id, payload, language)`.
 */

export type SlashCommandKind = "plan" | "goal";

export interface SlashCommand {
  /** Recognised legacy kind for plan/goal handling in start-turn. */
  kind: SlashCommandKind;
  /** The user's payload after the command word. */
  text: string;
}

export function detectSlashCommand(message: string): SlashCommand | null {
  const c = detectCommand(message);
  if (!c) return null;
  if (c.def.id === "plan" || c.def.id === "goal") {
    return { kind: c.def.id, text: c.payload };
  }
  return null;
}

export function planInstructions(language: string): string {
  return [
    "## /plan — Plan-first mode",
    "",
    `Reply in ${language}. **Before doing anything**, lay out a clear, numbered step-by-step plan. Each step should be concrete and verifiable.`,
    "",
    "Once the plan is ready, emit a question marker requesting approval:",
    "",
    `  <<reflex:question>>{"prompt":"Approve this plan?","choices":["approve","revise"]}<</reflex:question>>`,
    "",
    "Then STOP and wait for the user's reply.",
    "",
    "On the next turn:",
    "  - If the user approved → execute the plan, narrating progress and tools used.",
    "  - If the user asked to revise/change → update the plan and emit another approval question.",
    "Iterate until the user explicitly approves. Do not begin execution until then.",
  ].join("\n");
}

export function goalInstructions(goal: string, language: string): string {
  return [
    "## /goal — Persistent goal mode (do not stop until validated)",
    "",
    `Active goal: ${goal}`,
    "",
    `Reply in ${language}. Reflex will keep re-invoking you turn after turn until the goal is achieved AND validated. Don't write filler — every turn must move the task forward.`,
    "",
    "Workflow each turn:",
    "  1. Take the next concrete action toward the goal (use tools when needed: Read, Glob, Grep, WebSearch, WebFetch, etc.).",
    "  2. Show your work briefly so the user can audit progress.",
    "  3. When you believe the goal is complete, **validate it** (verify with a tool: read the file, fetch the URL, run a search). Don't claim completion without evidence.",
    "  4. After successful validation, emit a KB record:",
    "",
    `     <<reflex:kb>>{"kind":"goal-completion","title":"<short>","body":"<what was done + validation evidence>","meta":{"goal":${JSON.stringify(goal)}}}<</reflex:kb>>`,
    "",
    "     And END your message with the literal phrase on its own line:",
    "",
    "     GOAL ACHIEVED",
    "",
    "If you genuinely need user input mid-flight (clarification, permission for a risky action, missing data), pause via <<reflex:question>> or <<reflex:permission>>. Those markers stop auto-continuation; everything else keeps the loop going.",
  ].join("\n");
}

/**
 * "/research" — deep-research mode for a single turn. The orchestrator
 * is encouraged to dispatch a researcher sub-agent and iterate widely
 * across web + KB before synthesizing.
 */
export function researchInstructions(payload: string, language: string): string {
  return [
    "## /research — Deep research mode (this turn)",
    "",
    `Reply in ${language}.`,
    payload ? `Topic: ${payload}` : "",
    "",
    "Approach:",
    "  1. Delegate the main search to a sub-agent with role `researcher` via `<<reflex:dispatch>>` (one marker — it will sweep web + KB on its own).",
    "  2. If possible — multiple researchers in parallel with different angles (e.g. \"history\", \"current state\", \"criticism\").",
    "  3. Wait for results, **compose a synthesis**: similarities, disagreements, blind spots. Cite sources with links.",
    "  4. At the end, propose saving key facts to the KB via the `<<reflex:kb>>` marker (kind=\"research-note\") — but wait for confirmation.",
    "  5. If the topic is deep — propose a `news-list` or `link-list` widget via `<<reflex:widget-create>>`.",
    "",
    "Don't answer from model memory — drive everything through WebSearch/WebFetch.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * "/widget" — focus the agent on creating or refreshing a dashboard widget.
 */
export function widgetInstructionsForCommand(
  payload: string,
  language: string,
): string {
  return [
    "## /widget — Create a dashboard widget",
    "",
    `Reply in ${language}.`,
    payload ? `User request: ${payload}` : "",
    "",
    "Rules:",
    "  1. Pick the appropriate `kind` (see the widgets block in the system prompt). If the request is ambiguous — ask via `<<reflex:question>>`.",
    "  2. Pick a stable kebab-case `id` that can later be reused for widget-update.",
    "  3. If you need fresh data (news, prices, statuses) — gather it via WebSearch/WebFetch before emitting.",
    "  4. Emit **one** `<<reflex:widget-create>>` marker in this turn, then briefly tell the user what appeared on the dashboard.",
    "  5. If the widget makes sense to auto-refresh — set `refresh: \"hourly\"|\"daily\"|\"weekly\"` and describe `memory` for dedup/history.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * "/workflow" — focus the turn on building a workflow (linear recipe of
 * steps) via the `<<reflex:workflow-create>>` directive. The base chat
 * prompt already includes the protocol shape; this addendum nudges the
 * agent to actually use it and constrains style.
 */
export function workflowInstructionsForCommand(
  payload: string,
  language: string,
): string {
  return [
    "## /workflow — Build a workflow (n8n-style linear recipe)",
    "",
    `Reply in ${language}.`,
    payload ? `User request: ${payload}` : "",
    "",
    "Rules:",
    "  1. If the task is ambiguous (what's included, where to write, how often) — ask 1-3 clarifying questions via `<<reflex:question>>` in a SINGLE block. Don't guess.",
    "  2. Steps are SHORT (3-5). Supported kinds: `text-template`, `http-request`, `web-fetch`, `ask-agent`, `kb-write`. If the task is broader — split it into multiple workflows.",
    "  3. Each step's `id` is stable kebab-case (templates use it: `{{steps.<id>.output}}`).",
    "  4. Trigger defaults to `manual`. Set `hourly/daily/weekly` only if the user explicitly asked for a schedule.",
    "  5. Emit **one** `<<reflex:workflow-create>>` marker in this turn. Don't duplicate the JSON in text — the preview card renders in chat automatically.",
    "  6. After the marker — a short plan in words: what the workflow does step by step, how to run it, what appears as the result.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * "/mcp" — short-circuit to the MCP setup wizard flow. The agent already
 * has detailed mcp-add instructions in the base chat prompt; this command
 * just nudges it to start the conversation in that direction.
 */
export function mcpInstructionsForCommand(
  payload: string,
  language: string,
): string {
  return [
    "## /mcp — Connect an MCP server",
    "",
    `Reply in ${language}.`,
    payload ? `Request: ${payload}` : "The user wants to connect an MCP server but didn't specify which one.",
    "",
    "Act as an MCP wizard:",
    "  1. If the request is concrete (e.g. \"github mcp\", \"notion\") — pick a config right away and propose it via `<<reflex:mcp-add>>`. Don't forget secrets slots with a description of where to get the token.",
    "  2. If the request is abstract — ask via `<<reflex:question>>` what to connect (Notion / Slack / GitHub / Linear / other).",
    "  3. If it's about an existing server — ask the user to use its tools; don't propose the add card again.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * "/distill <url> [focus]" — read a URL, extract structured insights,
 * cross-reference existing KB, save as a `distilled-source` entry with
 * backlinks. The payload is `"<url> [focus question]"`.
 */
export function distillInstructions(payload: string, language: string): string {
  const tokens = payload.trim().split(/\s+/);
  const url = tokens[0] ?? "";
  const focus = tokens.slice(1).join(" ");
  return [
    "## /distill — Pull a source into the second brain",
    "",
    `Reply in ${language}.`,
    url ? `Source URL: ${url}` : "No URL provided — ask the user for one and stop.",
    focus ? `User focus: ${focus}` : "",
    "",
    "Procedure (must follow in order):",
    "  1. Use `WebFetch` on the URL to read the actual content. If it's a YouTube link, emit `<<reflex:youtube-summary>>` instead and stop — the rest of this protocol resumes on the next turn with the summary in context.",
    "  2. Extract structured fields:",
    "     - **keyFacts** (3-8 bullets, each verifiable from the source)",
    "     - **contrarianView** (the strongest counter-argument or a credible disagreement)",
    "     - **actionItems** (concrete next steps the reader could take)",
    "     - **followUpQuestions** (what the article didn't answer)",
    "  3. Search the existing KB via `Glob`/`Grep` for 1-3 adjacent notes — same topic, same domain, same people. Note their rel-paths.",
    "  4. Pick a hero image: try `reflex.images.search` for a visual that fits the topic; if no provider key is set, skip this step silently.",
    "  5. Emit exactly one `<<reflex:kb>>` marker:",
    "",
    "```",
    `<<reflex:kb>>{`,
    `  "kind": "distilled-source",`,
    `  "title": "<succinct article title — 4-9 words>",`,
    `  "body": "<markdown: hero image (if any), keyFacts list, contrarianView paragraph, actionItems list, followUpQuestions list, link to source, links to adjacent notes>",`,
    `  "meta": {`,
    `    "sourceUrl": "<original URL>",`,
    `    "sourceDate": "<ISO date from the page if present>",`,
    `    "backlinks": ["<rel-path>", ...]`,
    `  }`,
    `}<</reflex:kb>>`,
    "```",
    "",
    "  6. After the marker, reply with a 2-3 sentence summary plus a list of the adjacent notes found (if any), so the user knows the new entry connects into their graph.",
    "  7. Don't paraphrase the article in the reply — the entry IS the artifact; the reply is just orientation.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * "/practice <scenario>" — roleplay mode. The orchestrator scopes the
 * scenario, then dispatches a `counterpart` sub-agent for each user turn.
 * A `coach` sub-agent provides inline feedback. `/practice end` triggers
 * the session post-mortem.
 */
export function practiceInstructions(payload: string, language: string): string {
  const isEnd = payload.trim().toLowerCase() === "end";
  if (isEnd) {
    return [
      "## /practice end — Session post-mortem",
      "",
      `Reply in ${language}.`,
      "",
      "Review the entire conversation in this topic. Produce a written analysis covering:",
      "  - Timeline (who said what, key inflection points)",
      "  - Missed openings (places where the user could have steered differently)",
      "  - Suggested phrasings for the trickiest moments",
      "  - One-line key insight",
      "",
      "Emit a single KB marker:",
      "",
      `  <<reflex:kb>>{"kind":"practice-session","title":"<scenario summary>","body":"<full analysis markdown>","meta":{"scenario":"<from earlier in topic>","turns":<n>}}<</reflex:kb>>`,
      "",
      "After the marker, give the user a 2-sentence wrap-up and suggest one drill they could practice next.",
    ].join("\n");
  }
  return [
    "## /practice — Difficult-conversation roleplay",
    "",
    `Reply in ${language}.`,
    payload ? `Scenario: ${payload}` : "No scenario provided.",
    "",
    "This is a roleplay session. **You are not the counterpart** — you orchestrate.",
    "",
    "First turn protocol (now):",
    "  1. If the scenario is thin, ask 1-3 scoping questions via `<<reflex:question>>` in a single block:",
    "     - Who is the counterpart (relationship, role, stake)?",
    "     - What's the user's goal in this conversation?",
    "     - Any history that matters (prior conflicts, shared context)?",
    "  2. If scoping is sufficient, write a brief persona sketch (2-3 lines) and announce \"Session ready — say your opening line.\"",
    "  3. Persist the scenario + persona to topic memory by emitting:",
    "",
    `     <<reflex:kb>>{"kind":"practice-session","title":"<scenario>","body":"### Scenario\\n...\\n### Persona\\n...","meta":{"phase":"setup","scenario":"<short>"}}<</reflex:kb>>`,
    "",
    "Subsequent turns (when the user has spoken their line):",
    "  1. Dispatch the counterpart to deliver one reply, then the coach for feedback. ONE turn = TWO concurrent dispatches:",
    "",
    `     <<reflex:dispatch>>{"id":"cp","role":"counterpart","brief":"Persona: <persona>. Goal of the user: <goal>. Respond in character to: <user's last line>. Be realistic — resist, push back, ask clarifying questions when it fits. 1-3 sentences. Don't break character."}<</reflex:dispatch>>`,
    `     <<reflex:dispatch>>{"id":"co","role":"coach","brief":"You are a communication coach. The user is practicing: <scenario>. They just said: <user's last line>. The counterpart will reply. In 1-2 sentences, name ONE thing the user did well AND ONE thing to improve. Suggest an alternate phrasing for next turn. Plain prose, no marker."}<</reflex:dispatch>>`,
    "",
    "  2. On the next turn, you'll see both outputs. Compose the reply as:",
    "",
    "     **<Counterpart name>:** \"<counterpart's words>\"",
    "",
    "     <details><summary>Coach feedback</summary>",
    "     <coach output>",
    "     </details>",
    "",
    "End-of-session:",
    "  - When the user types `/practice end`, the post-mortem protocol kicks in (separate command).",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * "/reflect" — adaptive daily check-in. The orchestrator pulls the last
 * 7 journal entries, picks 3 questions tailored to them, and lands the
 * answers as a `journal` KB entry.
 */
export function reflectInstructions(language: string): string {
  return [
    "## /reflect — Daily check-in",
    "",
    `Reply in ${language}.`,
    "",
    "Procedure:",
    "  1. Use `Glob` against `.reflex/kb/journal/*.md` (or `Grep` for `kind: journal` frontmatter) to find the last 7 journal entries. Read them — actual content, not just titles.",
    "  2. If TODAY's journal already exists (meta.date matches today's date), tell the user it's already done and offer to revisit specific entries instead. Stop.",
    "  3. Pick 3 questions. The first is general (mood / one-liner today). The next two are ADAPTED — reference something concrete from the recent entries (\"yesterday you mentioned X — where did that land?\", \"three days ago you set goal Y — any movement?\"). If no recent entries exist, fall back to general prompts (energy, one thing learned, one thing avoided).",
    "  4. Emit a SINGLE `<<reflex:question>>` block with all 3 questions formatted as a numbered list in the `prompt` field; mark `freeText: true`. STOP.",
    "  5. On the user's next turn (their answers), emit exactly one KB marker:",
    "",
    "```",
    `<<reflex:kb>>{`,
    `  "kind": "journal",`,
    `  "title": "<one-line summary of today's entry — derived from the answers>",`,
    `  "body": "### Question 1\\n<question>\\n\\n<answer>\\n\\n### Question 2\\n<question>\\n\\n<answer>\\n\\n### Question 3\\n<question>\\n\\n<answer>",`,
    `  "meta": { "date": "<today ISO date>", "mood": "<one-word inferred mood: calm|tense|excited|tired|focused|scattered|down|other>" }`,
    `}<</reflex:kb>>`,
    "```",
    "",
    "  6. After the marker, give the user a 1-sentence reflection — what stood out across their last few entries vs today. Don't psychoanalyse; just notice.",
    "",
    "Constraints:",
    "  - Don't ask more than 3 questions in step 4. Two-line max per question.",
    "  - Don't speculate about feelings the user didn't state. Inferred mood is best-guess, not therapy.",
    "  - If the user explicitly asks for a weekly review during this flow, switch to the `/skill weekly-reflect` flow.",
  ].join("\n");
}

export const MAX_GOAL_ITERATIONS = 15;
