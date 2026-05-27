import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { reflexHome } from "@/lib/reflex/home";

/**
 * "Skills" = reusable instruction packs the user (or agent) can apply to
 * a turn via `/skill <id>`. Each skill is a markdown file with YAML
 * frontmatter:
 *
 *   ---
 *   id: deep-research
 *   title: "Deep research"
 *   description: "Web + KB research with citations"
 *   author: builtin
 *   ---
 *   ## Instructions
 *   ...the agent reads this verbatim...
 *
 * Lookup order (first hit wins):
 *   1. `~/.reflex/skills/<id>.md`         (user-installed, persisted across projects)
 *   2. built-in skills bundled below
 *
 * Future: per-root skills, MCP-bound skills, skills with permission scopes.
 * For v1 the contract is intentionally tiny: it's just an instructions
 * blob the system prompt gets for that one turn.
 */

export interface SkillMeta {
  id: string;
  title: string;
  description: string;
  /** "builtin" for in-process skills, "user" for filesystem-installed. */
  author: "builtin" | "user";
  /**
   * Where this skill lives. Global skills work in any Space; project
   * skills only show up when chatting inside their owner Space.
   * Builtins are global by definition.
   */
  scope: "builtin" | "global" | "project";
  /**
   * Optional workflow id that `/skill <this>` invokes before the prompt
   * is injected. Output is interpolated into the instructions as
   * `{{workflowOutput}}` and surfaced inline in chat.
   */
  workflowId?: string;
  /**
   * Optional utility action ref (`<utility-id>.<action>`) the skill
   * relies on. Currently advisory only — UI surfaces it so the user
   * knows what's needed; runtime execution comes later.
   */
  utilityRef?: string;
}

export interface Skill extends SkillMeta {
  instructions: string;
}

const GLOBAL_USER_DIR = path.join(reflexHome(), "skills");

function projectSkillsDir(rootPath: string): string {
  return path.join(rootPath, ".reflex", "skills");
}

const BUILTIN: Skill[] = [
  {
    id: "deep-research",
    title: "Deep research",
    description:
      "Multi-agent research with citation discipline — facts and synthesis land as cross-linked KB entries.",
    author: "builtin",
    scope: "builtin",
    instructions: [
      "## Skill: deep-research",
      "",
      "Run the investigation like a professional analyst. This skill is NOT a chat answer; it produces durable, cited KB artifacts.",
      "",
      "### Step 1 — Scope (this turn)",
      "Read the user's request. If it's ambiguous (timeframe, depth, perspective), ask up to 3 questions in a single `<<reflex:question>>` block. Otherwise, write a short search plan: 3–8 key sub-questions that, answered together, fully address the user's request. Pick the plan; then continue to Step 2 in the SAME turn.",
      "",
      "### Step 2 — Parallel dispatch (this turn)",
      "For each sub-question, emit a `<<reflex:dispatch>>` to a `researcher` sub-agent with role-specific brief:",
      "",
      "```",
      `<<reflex:dispatch>>{"id":"r1","role":"researcher","brief":"Question: <sub-question>. Use WebSearch + WebFetch. Return STRICTLY: a JSON array of findings. Each finding = {claim: '<one-sentence fact>', url: '<source>', date: '<ISO if findable, else null>', confidence: 'high'|'medium'|'low'}. Reject any claim you cannot back with a real URL — return an empty array rather than guess. No prose."}<</reflex:dispatch>>`,
      "```",
      "",
      "Multiple dispatches in one turn run in parallel. STOP after emitting markers — Reflex re-invokes you with results.",
      "",
      "### Step 3 — Citation triage (next turn)",
      "When sub-agent outputs arrive, parse each into the {claim,url,date,confidence} shape. If a sub-agent returned uncited claims OR an empty array on a critical question, re-dispatch ONE retry with a tighter brief (\"Your previous reply lacked citations. Find 1–3 verifiable sources for: <sub-question>.\").",
      "",
      "### Step 4 — Synthesis + KB write (final turn)",
      "Compose the master `research-note`. The body must be markdown with three sections: **Findings** (every claim with inline `[source](url)` citation), **Gaps** (what couldn't be sourced), **Open questions** (what to investigate next). Emit:",
      "",
      "```",
      `<<reflex:kb>>{"kind":"research-note","title":"<topic — 4-9 words>","body":"<full markdown report>","meta":{"questionsPlanned":<n>,"factsCount":<n>,"researchedAt":"<ISO>"}}<</reflex:kb>>`,
      "```",
      "",
      "Then emit ONE `<<reflex:kb>>` per sourced fact:",
      "",
      "```",
      `<<reflex:kb>>{"kind":"research-fact","title":"<claim — 4-12 words>","body":"<claim sentence>\\n\\nSource: [<domain>](<url>) (<date>)","meta":{"sourceUrl":"<url>","sourceDate":"<ISO or null>","confidence":"<high|medium|low>","researchNote":"<title of master note>"}}<</reflex:kb>>`,
      "```",
      "",
      "### Step 5 — Reply",
      "Tell the user, in one paragraph, what was found and where it lives in the KB. If `>=5` facts came back, propose a `link-list` or `news-list` widget via `<<reflex:widget-create>>`.",
      "",
      "### Rules",
      "- Never answer from model memory; every claim flows through WebSearch/WebFetch via a sub-agent.",
      "- Don't fabricate dates. Use `null` if the page has no clear date.",
      "- Don't dispatch the same brief twice if a sub-agent returned empty — that's a Gap, not a retry case.",
      "- Failure modes degrade transparently: rate-limit / network error → mention it in Gaps, continue with what you have.",
    ].join("\n"),
  },
  {
    id: "widget-builder",
    title: "Widget builder",
    description:
      "Widget-creation helper - suggests the kind and data format.",
    author: "builtin",
    scope: "builtin",
    instructions: [
      "## Skill: widget-builder",
      "",
      "You help design and assemble a widget:",
      "  1. Clarify via `<<reflex:question>>` the widget's purpose and audience (for me alone / for the team / a report).",
      "  2. Pick the optimal `kind` - justify the choice out loud (one line).",
      "  3. If the widget needs data, gather it via WebFetch/WebSearch/Read before emitting.",
      "  4. Emit exactly one `<<reflex:widget-create>>` marker, with a thoughtful `id` and `refresh` cadence.",
      "  5. Tell the user how to edit the widget (pencil icon -> this same topic).",
    ].join("\n"),
  },
  {
    id: "space-onboarding",
    title: "Space onboarding",
    description:
      "Designs the dashboard for a new Space: emits a batch of utility/research/widget/goal suggestions based on the folder name (and any signal already in the folder) on the FIRST turn — no Q&A unless the user asks for it.",
    author: "builtin",
    scope: "builtin",
    instructions: [
      "## Skill: space-onboarding",
      "",
      "You are the dashboard designer for a freshly-created Space. The user just picked a folder and dropped here — they have NOT asked you anything yet. They want to see what you'd put on this Space's dashboard.",
      "",
      "**Do not start a Q&A.** Don't ask \"what is this Space for?\" — the folder name and any files already inside are your starting context. Build hypotheses from there in this turn.",
      "",
      "### What you do on turn 1 (now)",
      "",
      "1. **Read signal already on disk** — quickly skim:",
      "   - the folder name (in `## Project root` of the system prompt)",
      "   - top-level files via `Glob` `*` (3-second pass) — are there PDFs, notebooks, datasets, drafts? If yes, name them when describing suggestions.",
      "",
      "2. **Write a short opening — 2 sentences max.** Tell the user what you inferred from the folder (\"Looks like a Space for studying LLM internals from the name\") and that you're putting suggestions on the dashboard for them to approve or dismiss. No lecture, no list of capabilities.",
      "",
      "3. **Capture a single working hypothesis as project memory** via one `<<reflex:memory>>{scope:\"project\",file:\"PERSONA\",op:\"append\",content:\"<one sentence on what this Space is\"}` marker. This is your best guess — the user can edit it later.",
      "",
      "4. **Emit 4-7 `<<reflex:suggestion>>` markers** covering a balanced mix:",
      "   - 1-2 utilities (concrete mini-apps from the curated registry that fit)",
      "   - 1-2 widgets (KPIs / checklists / news-list / link-list — whatever feels useful as a glance)",
      "   - 1-2 research topics (open questions the user probably has, /research-style)",
      "   - 0-1 goal (only if the folder name implies a clear outcome — \"run a half-marathon\", \"finish PhD\")",
      "   - 0-1 skill recommendation (e.g. `/skill deep-research` for study/research Spaces)",
      "",
      "5. **Stop.** Tell the user \"Suggestions are on the dashboard. Approve what you want, dismiss the rest, or tell me what I'm missing.\" Then emit `<<reflex:onboarding-done>>finished<</reflex:onboarding-done>>` on its own line — Reflex renders a CTA card so the user can jump straight to the dashboard. Do not execute anything yourself.",
      "",
      "### Follow-up turns (user replied with more context)",
      "",
      "If the user adds detail on a later turn:",
      "  - Update PERSONA/GOALS/INTERESTS in project memory with the new facts.",
      "  - Emit a few MORE suggestion markers refined by the new signal (don't repeat ones already proposed — the dashboard deduplicates by title, but stay disciplined).",
      "  - 2-3 sentence reply, no preamble.",
      "  - If the user said something true about *themselves* (not just this Space — e.g. \"I'm a researcher\", \"I have asthma\") → write to scope=global instead.",
      "",
      "### Suggestion marker shape",
      "",
      "```",
      `<<reflex:suggestion>>{`,
      `  "kind": "utility" | "research" | "widget" | "goal" | "skill",`,
      `  "title": "<4-9 words, imperative>",`,
      `  "description": "<one sentence saying WHY this fits THIS Space>",`,
      `  "prompt": "<exactly what to type into a new chat if approved — usually a slash command like /research, /widget, /util, /distill, or a plain message>"`,
      `}<</reflex:suggestion>>`,
      "```",
      "",
      "### Examples (folder name → batch)",
      "",
      "Folder `понимание ЛЛМ` (\"Understanding LLMs\"):",
      "  - utility `Install Learn-anything` → `/util install learn-anything`",
      "  - skill `Use deep-research for literature` → `/skill deep-research`",
      "  - research `Map the LLM curriculum landscape` → `/research best self-study resources for LLM internals: tokenization, attention, training, alignment`",
      "  - widget `Reading-list link-list` → `/widget link-list of papers and tutorials I'm working through`",
      "  - widget `Weekly study hours KPI` → `/widget weekly study hours KPI, refresh weekly`",
      "  - goal `Finish curriculum by end of Q3` → `/goal complete LLM internals curriculum by 2026-09-30; weekly progress check-ins`",
      "",
      "Folder `marathon training`:",
      "  - utility `Install route-builder` → `/util install route-builder`",
      "  - widget `Weekly distance KPI` → `/widget weekly running distance KPI`",
      "  - widget `Race checklist` → `/widget checklist of race-day prep items`",
      "  - research `Compare HRV apps` → `/research best HRV apps for endurance training, with citations`",
      "  - goal `Half-marathon under 2:00 by Oct` → `/goal sub-2:00 half-marathon by 2026-10-15`",
      "",
      "### Rules",
      "",
      "- **No Q&A.** Don't ask the user to summarise the Space — read the folder.",
      "- Max one short paragraph of prose around the markers. The dashboard is the deliverable, not the chat.",
      "- 4-7 suggestions, no more. Quality > volume.",
      "- Don't propose generic utilities (\"unit-converter\") unless the folder clearly hints at it.",
      "- The user might dismiss everything — that's fine. Don't argue.",
      "- Never start the topic for them. The dashboard approve button does that — your job ends after the markers are out.",
    ].join("\n"),
  },
  {
    id: "memory-rollup",
    title: "Memory rollup (RECENT.md)",
    description:
      "Replace global RECENT.md with a fresh summary of the last week from journals and recent chats.",
    author: "builtin",
    scope: "builtin",
    instructions: [
      "## Skill: memory-rollup",
      "",
      "Refresh the rolling 7-day memory file. Runs against the GLOBAL scope only — never touches per-project memory.",
      "",
      "Procedure:",
      "  1. Use `Glob` to list `.reflex/kb/journal/*.md` in this project. Read entries from the last 7 days (meta.date ≥ today-7).",
      "  2. Skim the topic titles + first message of recent chat topics — `Glob` on `.reflex/topics/*.md`, read frontmatter.",
      "  3. Synthesize: themes, recurring concerns, mood arc, unresolved threads, notable wins. ≤25 lines, one fact per line, terse and third-person about the user.",
      "  4. Emit exactly one marker — replaces the file in full:",
      "",
      "```",
      `<<reflex:memory>>{`,
      `  "scope": "global",`,
      `  "file": "RECENT",`,
      `  "op": "replace",`,
      `  "content": "<25-line summary, newline-joined>"`,
      `}<</reflex:memory>>`,
      "```",
      "",
      "  5. After the marker, give the user a 1-2 sentence wrap-up of the dominant theme.",
      "",
      "Constraints:",
      "  - Don't write to PERSONA/VALUES/INTERESTS/etc. — only RECENT. Those files belong to durable facts, not weekly summaries.",
      "  - Don't speculate. If the journal is thin (<4 entries), say so and skip the rollup.",
      "  - Quote one or two of the user's own phrasings where they capture a theme. Sparingly.",
    ].join("\n"),
  },
  {
    id: "weekly-reflect",
    title: "Weekly reflection",
    description:
      "Read the last 14 journal entries and produce a themed reflection with a generated visual.",
    author: "builtin",
    scope: "builtin",
    instructions: [
      "## Skill: weekly-reflect",
      "",
      "Generate a weekly reflection from the user's recent journal entries.",
      "",
      "Procedure:",
      "  1. Use `Glob` to list `.reflex/kb/journal/*.md`. Read the last 14 entries (most recent by meta.date).",
      "  2. Analyze across them: recurring themes, mood drift, goals raised vs progress made, cognitive distortions you can name (overgeneralization, catastrophizing, mind-reading, etc.) — only when clearly evidenced in the text, never as armchair diagnosis.",
      "  3. Pick ONE central theme for the week (e.g. \"work-life boundary slipping\", \"momentum on the side project\", \"loneliness on weekends\").",
      "  4. Emit ONE `<<reflex:image-gen>>` marker with a metaphorical visual for the theme (style: minimalist illustration; aspectRatio: 16:9; provider: gemini). Set `attachToKb: true`.",
      "  5. Emit ONE `<<reflex:kb>>` marker for the reflection:",
      "",
      "```",
      `<<reflex:kb>>{`,
      `  "kind": "weekly-reflection",`,
      `  "title": "Week of <Mon date> — <theme>",`,
      `  "body": "<markdown: image, theme paragraph, themes-list with evidence quotes from journal entries, distortions-noticed list with gentle reframes, one suggested experiment for next week>",`,
      `  "meta": { "weekStart": "<ISO Monday>", "weekEnd": "<ISO Sunday>", "entriesAnalyzed": <n>, "theme": "<theme>" }`,
      `}<</reflex:kb>>`,
      "```",
      "",
      "  6. Reply to the user with a 2-sentence summary and a single open question they could sit with for the coming week.",
      "",
      "Constraints:",
      "  - Quote the user's own words when illustrating themes — don't paraphrase into something they didn't say.",
      "  - If fewer than 4 entries exist in the window, say so and skip the reflection (it's not enough signal yet).",
      "  - Avoid clinical language. \"Notice\" not \"diagnose\".",
    ].join("\n"),
  },
  {
    id: "kb-curator",
    title: "KB curator",
    description:
      "Turns raw content into clean KB notes with the right kind and meta.",
    author: "builtin",
    scope: "builtin",
    instructions: [
      "## Skill: kb-curator",
      "",
      "You are the knowledge-base curator. Every input - note, fact, or link - becomes a tidy KB entry:",
      "  1. Determine the `kind` (fact | task | meeting | product | person | place | event | ...). If ambiguous - ask.",
      "  2. Title: 4-9 words, no quotes, no trailing period.",
      "  3. `meta`: put structured fields here (ISO dates, links, tags). Do NOT duplicate them in the body.",
      "  4. `body`: anything that didn't fit in meta - context, nuance, quotes with sources.",
      "  5. Emit a `<<reflex:kb>>` marker; do not write via Write - the manager places it in the correct folder.",
      "  6. If the entry adds to an existing topic - mention sibling files via @-mentions in chat (for context, not for the agent).",
    ].join("\n"),
  },
];

export async function listSkills(
  rootPath?: string,
  rootId?: string,
): Promise<SkillMeta[]> {
  const project = rootPath ? await listFromDir(projectSkillsDir(rootPath), "project") : [];
  const global = await listFromDir(GLOBAL_USER_DIR, "global");
  const fromUtilities = await listFromUtilities(rootId);
  const seen = new Set<string>([
    ...project.map((s) => s.id),
    ...global.map((s) => s.id),
    ...fromUtilities.map((s) => s.id),
  ]);
  const builtin = BUILTIN.filter((s) => !seen.has(s.id));
  const stripInstructions = ({ instructions: _i, ...m }: Skill): SkillMeta => {
    void _i;
    return m;
  };
  return [
    ...project.map(stripInstructions),
    ...global.map(stripInstructions),
    ...fromUtilities.map(stripInstructions),
    ...builtin.map(stripInstructions),
  ];
}

/**
 * Skills declared inside installed utilities' `manifest.extensions.skills`.
 * Provenance lives in `author` so the palette can show "from <utility>".
 */
async function listFromUtilities(rootId?: string): Promise<Skill[]> {
  try {
    const { collectExtensions } = await import(
      "@/lib/server/utilities/extensions"
    );
    const ext = await collectExtensions(rootId ? { rootId } : {});
    return ext.skills.map((s): Skill => ({
      id: s.id,
      title: s.title,
      description: s.description,
      author: "user",
      scope: s.utility.scope === "project" ? "project" : "global",
      ...(s.workflowId ? { workflowId: s.workflowId } : {}),
      instructions: s.instructions,
    }));
  } catch {
    return [];
  }
}

async function listFromDir(
  dir: string,
  scope: "global" | "project",
): Promise<Skill[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, e.name), "utf8");
      const parsed = matter(raw);
      const data = parsed.data as Partial<Skill>;
      const id = typeof data.id === "string" ? data.id : null;
      if (!id) continue;
      out.push({
        id,
        title: typeof data.title === "string" ? data.title : id,
        description:
          typeof data.description === "string" ? data.description : "",
        author: "user",
        scope,
        ...(typeof data.workflowId === "string"
          ? { workflowId: data.workflowId }
          : {}),
        ...(typeof data.utilityRef === "string"
          ? { utilityRef: data.utilityRef }
          : {}),
        instructions: parsed.content.trim(),
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export async function loadSkill(
  id: string,
  rootPath?: string,
  rootId?: string,
): Promise<Skill | null> {
  // Precedence: project file > global file > utility-provided > builtin.
  if (rootPath) {
    const projectHit = (await listFromDir(projectSkillsDir(rootPath), "project")).find(
      (s) => s.id === id,
    );
    if (projectHit) return projectHit;
  }
  const globalHit = (await listFromDir(GLOBAL_USER_DIR, "global")).find(
    (s) => s.id === id,
  );
  if (globalHit) return globalHit;
  const utilHit = (await listFromUtilities(rootId)).find((s) => s.id === id);
  if (utilHit) return utilHit;
  return BUILTIN.find((s) => s.id === id) ?? null;
}

export interface WriteSkillInput {
  id: string;
  title: string;
  description: string;
  instructions: string;
  scope: "global" | "project";
  rootPath?: string;
  workflowId?: string;
  utilityRef?: string;
}

/**
 * Persist a user/agent-authored skill to disk. Called by the
 * `<<reflex:skill-create>>` marker handler and (eventually) by a future
 * Settings UI. Returns the resolved file path.
 */
export async function writeSkill(input: WriteSkillInput): Promise<string> {
  if (input.scope === "project" && !input.rootPath) {
    throw new Error("project skill requires rootPath");
  }
  const dir =
    input.scope === "project"
      ? projectSkillsDir(input.rootPath!)
      : GLOBAL_USER_DIR;
  await fs.mkdir(dir, { recursive: true });
  const slug = sanitizeId(input.id);
  if (!slug) throw new Error("invalid skill id");
  const front: Record<string, string> = {
    id: slug,
    title: input.title.trim() || slug,
    description: input.description.trim(),
  };
  if (input.workflowId) front.workflowId = input.workflowId;
  if (input.utilityRef) front.utilityRef = input.utilityRef;
  const yaml = Object.entries(front)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const body = `---\n${yaml}\n---\n${input.instructions.trim()}\n`;
  const file = path.join(dir, `${slug}.md`);
  await fs.writeFile(file, body, "utf8");
  return file;
}

function sanitizeId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
