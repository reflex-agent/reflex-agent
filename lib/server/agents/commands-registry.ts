/**
 * Single source of truth for chat slash-commands. Every command shows up
 * in the `/` palette autocomplete (UI reads this list via a server action)
 * and routes through one of two execution paths:
 *
 *   - "direct"      — handled by a client-side / server-action pair,
 *                     never starts an agent turn (`/remember`, `/delete-topic`,
 *                     `/clear-project`, `/help`).
 *
 *   - "agent-mode"  — message goes to the orchestrator as usual; the
 *                     command word is stripped and `commandId` is passed
 *                     into start-turn so the system prompt gets a
 *                     command-specific addendum (`/plan`, `/goal`,
 *                     `/research`, `/widget`, `/mcp`, `/skill`).
 *
 * Adding a new command:
 *   1. add an entry below with metadata
 *   2. if "direct": add the server action + wire the client handler
 *   3. if "agent-mode": add the instructions helper in slash-commands.ts
 *      and a case in start-turn.ts (or skill loader for /skill)
 */

export type CommandKind = "direct" | "agent-mode";

export interface CommandDef {
  id: string;
  /** What the user types — exact match after the leading `/`. */
  trigger: string;
  /** Short human-readable label for the palette. */
  label: string;
  /** One-line description, shown in palette and /help. */
  description: string;
  kind: CommandKind;
  /** Free-form usage hint (`/cmd <text>` style). */
  usage: string;
  /** Whether the command needs explicit confirm before firing (UI uses confirm()). */
  requiresConfirm?: boolean;
  /** When true, the command works without any text payload. */
  allowEmpty?: boolean;
  /** Icon name from lucide-react — UI maps string → component. */
  icon: string;
}

export const COMMANDS: CommandDef[] = [
  {
    id: "plan",
    trigger: "plan",
    label: "/plan",
    description:
      "Show the plan first — Reflex lays out the steps and waits for approval.",
    kind: "agent-mode",
    usage: "/plan <task>",
    icon: "ListChecks",
  },
  {
    id: "goal",
    trigger: "goal",
    label: "/goal",
    description:
      "Set a goal — Reflex will work toward it on its own, without reminders.",
    kind: "agent-mode",
    usage: "/goal <what to achieve>",
    icon: "Target",
  },
  {
    id: "research",
    trigger: "research",
    label: "/research",
    description:
      "Deep research on a topic — web search + summary with sources.",
    kind: "agent-mode",
    usage: "/research <topic>",
    icon: "Telescope",
  },
  {
    id: "widget",
    trigger: "widget",
    label: "/widget",
    description: "Create a card on the space dashboard.",
    kind: "agent-mode",
    usage: "/widget <what to show>",
    icon: "LayoutGrid",
  },
  {
    id: "workflow",
    trigger: "workflow",
    label: "/workflow",
    description:
      "Build a recipe — linear step-based automation for the task.",
    kind: "agent-mode",
    usage: "/workflow <what to automate>",
    icon: "Workflow",
  },
  {
    id: "distill",
    trigger: "distill",
    label: "/distill",
    description:
      "Pull a URL into the KB — extract key facts, action items, and links to related notes.",
    kind: "agent-mode",
    usage: "/distill <url> [focus]",
    icon: "BookOpenCheck",
  },
  {
    id: "practice",
    trigger: "practice",
    label: "/practice",
    description:
      "Roleplay a tough conversation — Reflex plays the counterpart and coaches you between turns.",
    kind: "agent-mode",
    usage: "/practice <scenario>",
    icon: "MessagesSquare",
  },
  {
    id: "reflect",
    trigger: "reflect",
    label: "/reflect",
    description:
      "Daily check-in — three questions adapted to your recent entries, saved as a journal note.",
    kind: "agent-mode",
    usage: "/reflect",
    allowEmpty: true,
    icon: "Sunrise",
  },
  {
    id: "remember",
    trigger: "remember",
    label: "/remember",
    description: "Save a note — straight into memory, no AI involved.",
    kind: "direct",
    usage: "/remember <what to remember>",
    icon: "BookmarkPlus",
  },
  {
    id: "mcp",
    trigger: "mcp",
    label: "/mcp",
    description: "Connect an external service (setup wizard opens in chat).",
    kind: "agent-mode",
    usage: "/mcp <what you need>",
    icon: "PackagePlus",
  },
  {
    id: "skill",
    trigger: "skill",
    label: "/skill",
    description: "Attach a role — a ready-made instruction set for this conversation.",
    kind: "agent-mode",
    usage: "/skill <role-id> [prompt]",
    icon: "Sparkles",
  },
  {
    id: "delete-topic",
    trigger: "delete-topic",
    label: "/delete-topic",
    description: "Delete this conversation (with confirmation).",
    kind: "direct",
    usage: "/delete-topic",
    requiresConfirm: true,
    allowEmpty: true,
    icon: "Trash2",
  },
  {
    id: "clear-project",
    trigger: "clear-project",
    label: "/clear-project",
    description:
      "DANGER: clear the space — all conversations, cards, memory. Double confirmation.",
    kind: "direct",
    usage: "/clear-project",
    requiresConfirm: true,
    allowEmpty: true,
    icon: "AlertOctagon",
  },
  {
    id: "util",
    trigger: "util",
    label: "/util",
    description: "Open a mini-app (by partial name or from the list).",
    kind: "direct",
    usage: "/util <partial name or id>",
    allowEmpty: true,
    icon: "Boxes",
  },
  {
    id: "help",
    trigger: "help",
    label: "/help",
    description: "List available commands.",
    kind: "direct",
    usage: "/help",
    allowEmpty: true,
    icon: "HelpCircle",
  },
];

export function findCommand(trigger: string): CommandDef | null {
  return COMMANDS.find((c) => c.trigger === trigger) ?? null;
}

/**
 * Parse a chat message looking for a leading `/cmd <payload>`. Returns the
 * matching CommandDef plus the trimmed payload. `null` means "just a
 * regular message — no command here".
 */
export function detectCommand(
  message: string,
): { def: CommandDef; payload: string } | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return null;
  // Use a tight regex so legit messages that contain slashes mid-text don't
  // get misinterpreted.
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const def = findCommand(m[1]!);
  if (!def) return null;
  return { def, payload: (m[2] ?? "").trim() };
}
