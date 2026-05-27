/**
 * Memory file taxonomy — shared between server modules and UI.
 * Two scopes (global / project), eight files per scope, hard line caps.
 *
 * The file list is the contract — the marker schema, the system prompt,
 * the settings UI, and the workflow rollup all reference it.
 */

export const MEMORY_FILES = [
  "PERSONA",
  "VALUES",
  "INTERESTS",
  "GOALS",
  "RELATIONSHIPS",
  "ROUTINES",
  "AVOID",
  "RECENT",
] as const;

export type MemoryFile = (typeof MEMORY_FILES)[number];

export type MemoryScope = "global" | "project";

export type MemoryOp = "append" | "replace" | "remove";

export const FILE_CAPS: Record<MemoryFile, number> = {
  PERSONA: 20,
  VALUES: 15,
  INTERESTS: 20,
  GOALS: 20,
  RELATIONSHIPS: 20,
  ROUTINES: 15,
  AVOID: 15,
  RECENT: 30,
};

export const FILE_DESCRIPTIONS: Record<MemoryFile, string> = {
  PERSONA: "Name, location, role, workplace, family, mother tongue",
  VALUES: "Operating principles, how the user prefers to be addressed",
  INTERESTS: "Active topics, hobbies, learning targets",
  GOALS: "Life and work goals (not per-task /goal)",
  RELATIONSHIPS: "Key people: name, role, last shared context",
  ROUTINES: "Daily and weekly rhythms (wake, work, exercise)",
  AVOID: "Explicit \"don't suggest\" — topics, words, people",
  RECENT: "Rolling summary of the last ~7 days (auto-generated)",
};

export const TIER_BY_FILE: Record<MemoryFile, 1 | 2 | 3> = {
  PERSONA: 1,
  VALUES: 1,
  INTERESTS: 2,
  GOALS: 2,
  RELATIONSHIPS: 2,
  ROUTINES: 2,
  AVOID: 2,
  RECENT: 3,
};

export function isMemoryFile(s: string): s is MemoryFile {
  return (MEMORY_FILES as readonly string[]).includes(s);
}

export function isMemoryScope(s: string): s is MemoryScope {
  return s === "global" || s === "project";
}

export function isMemoryOp(s: string): s is MemoryOp {
  return s === "append" || s === "replace" || s === "remove";
}
