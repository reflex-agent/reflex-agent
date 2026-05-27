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
}

export interface Skill extends SkillMeta {
  instructions: string;
}

const USER_DIR = path.join(reflexHome(), "skills");

const BUILTIN: Skill[] = [
  {
    id: "deep-research",
    title: "Deep research",
    description:
      "Multi-agent research with citation discipline — facts and synthesis land as cross-linked KB entries.",
    author: "builtin",
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
    id: "weekly-reflect",
    title: "Weekly reflection",
    description:
      "Read the last 14 journal entries and produce a themed reflection with a generated visual.",
    author: "builtin",
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

export async function listSkills(): Promise<SkillMeta[]> {
  const user = await listUserSkills();
  const seen = new Set<string>(user.map((s) => s.id));
  const builtin = BUILTIN.filter((s) => !seen.has(s.id)).map(
    ({ instructions: _i, ...m }) => {
      void _i;
      return m;
    },
  );
  return [...user.map(({ instructions: _i, ...m }) => {
    void _i;
    return m;
  }), ...builtin];
}

async function listUserSkills(): Promise<Skill[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(USER_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    try {
      const raw = await fs.readFile(path.join(USER_DIR, e.name), "utf8");
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
        instructions: parsed.content.trim(),
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export async function loadSkill(id: string): Promise<Skill | null> {
  const user = await listUserSkills();
  const hit = user.find((s) => s.id === id);
  if (hit) return hit;
  return BUILTIN.find((s) => s.id === id) ?? null;
}
