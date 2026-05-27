import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Per-project list of agent-proposed actions awaiting user decision.
 * Created by the onboarding chat (`space-onboarding` skill) and any
 * future flow that wants to land a hypothesis on the dashboard.
 *
 * Stored at `<root>/.reflex/suggestions.json` so each Space owns its own
 * pile. Approval starts a topic with the suggestion's `action.prompt`
 * pre-seeded; rejection drops the entry and remembers it in AVOID.md
 * so the agent doesn't propose the same thing again.
 */

export const SUGGESTION_KINDS = [
  "utility",
  "research",
  "widget",
  "goal",
  "skill",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export type SuggestionStatus = "pending" | "approved" | "rejected";

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  description: string;
  /**
   * The prompt that gets pre-filled into a new chat topic when the user
   * approves. Typically a slash-command invocation like
   * `"/research how to track resting heart-rate trends weekly"` or
   * `"/widget weekly run distance kpi"`.
   */
  prompt: string;
  /** Topic that proposed this suggestion (so user can re-open the source). */
  sourceTopicId?: string;
  createdAt: string;
  status: SuggestionStatus;
  /** Set when status === "approved" — the topic that fulfils it. */
  topicId?: string;
}

interface SuggestionsFile {
  version: 1;
  items: Suggestion[];
}

function suggestionsPath(rootPath: string): string {
  return path.join(rootPath, ".reflex", "suggestions.json");
}

async function readFileSafe(rootPath: string): Promise<SuggestionsFile> {
  try {
    const raw = await fs.readFile(suggestionsPath(rootPath), "utf8");
    const parsed = JSON.parse(raw) as SuggestionsFile;
    if (parsed.version === 1 && Array.isArray(parsed.items)) return parsed;
  } catch {
    /* missing or malformed — start fresh */
  }
  return { version: 1, items: [] };
}

async function writeFile(
  rootPath: string,
  file: SuggestionsFile,
): Promise<void> {
  const p = suggestionsPath(rootPath);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(file, null, 2) + "\n", "utf8");
}

export async function listSuggestions(
  rootPath: string,
): Promise<Suggestion[]> {
  const file = await readFileSafe(rootPath);
  return file.items;
}

export async function listPendingSuggestions(
  rootPath: string,
): Promise<Suggestion[]> {
  const items = await listSuggestions(rootPath);
  return items.filter((s) => s.status === "pending");
}

export interface AddSuggestionInput {
  kind: SuggestionKind;
  title: string;
  description: string;
  prompt: string;
  sourceTopicId?: string;
}

export async function addSuggestion(
  rootPath: string,
  input: AddSuggestionInput,
): Promise<Suggestion> {
  const file = await readFileSafe(rootPath);
  // Dedup by (kind, title) — agent often re-emits when nudged.
  const titleNorm = input.title.trim().toLowerCase();
  const existing = file.items.find(
    (s) =>
      s.kind === input.kind &&
      s.title.trim().toLowerCase() === titleNorm &&
      s.status === "pending",
  );
  if (existing) return existing;
  const s: Suggestion = {
    id: crypto.randomBytes(6).toString("hex"),
    kind: input.kind,
    title: input.title.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    ...(input.sourceTopicId ? { sourceTopicId: input.sourceTopicId } : {}),
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  file.items.push(s);
  await writeFile(rootPath, file);
  return s;
}

export async function markApproved(
  rootPath: string,
  id: string,
  topicId: string,
): Promise<Suggestion | null> {
  const file = await readFileSafe(rootPath);
  const idx = file.items.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  file.items[idx] = {
    ...file.items[idx]!,
    status: "approved",
    topicId,
  };
  await writeFile(rootPath, file);
  return file.items[idx]!;
}

export async function markRejected(
  rootPath: string,
  id: string,
): Promise<Suggestion | null> {
  const file = await readFileSafe(rootPath);
  const idx = file.items.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  file.items[idx] = { ...file.items[idx]!, status: "rejected" };
  await writeFile(rootPath, file);
  return file.items[idx]!;
}
