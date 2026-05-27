import "server-only";
import { loadMemory } from "./store";
import {
  MEMORY_FILES,
  TIER_BY_FILE,
  type MemoryFile,
  type MemoryScope,
} from "./types";

/**
 * Build the "About the user" / "About this project" block prepended to
 * every chat system prompt. Empty files and empty tiers drop out — the
 * block is added only when there is real signal.
 */

export async function buildMemoryBlock(args?: {
  rootPath?: string;
}): Promise<string> {
  const sections: string[] = [];
  const globalBlock = await renderScope({ scope: "global" }, "About the user");
  if (globalBlock) sections.push(globalBlock);
  if (args?.rootPath) {
    const projectBlock = await renderScope(
      { scope: "project", rootPath: args.rootPath },
      "About this project",
    );
    if (projectBlock) sections.push(projectBlock);
  }
  return sections.join("\n\n");
}

async function renderScope(
  ctx: { scope: MemoryScope; rootPath?: string },
  heading: string,
): Promise<string> {
  const data = await loadMemory(ctx);
  const tier1 = MEMORY_FILES.filter(
    (f) => TIER_BY_FILE[f] === 1 && data[f].content,
  );
  const tier2 = MEMORY_FILES.filter(
    (f) => TIER_BY_FILE[f] === 2 && data[f].content,
  );
  const tier3 = MEMORY_FILES.filter(
    (f) => TIER_BY_FILE[f] === 3 && data[f].content,
  );
  if (tier1.length === 0 && tier2.length === 0 && tier3.length === 0) {
    return "";
  }
  const lines: string[] = [`## ${heading}`];
  if (tier1.length > 0) {
    lines.push("### Identity");
    for (const f of tier1) lines.push(renderFile(f, data[f].content!));
  }
  if (tier2.length > 0) {
    lines.push("### Current");
    for (const f of tier2) lines.push(renderFile(f, data[f].content!));
  }
  if (tier3.length > 0) {
    lines.push("### Last 7 days");
    for (const f of tier3) lines.push(renderFile(f, data[f].content!));
  }
  return lines.join("\n");
}

function renderFile(file: MemoryFile, content: string): string {
  return [`**${file}**`, content.trim()].join("\n");
}
