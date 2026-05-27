import "server-only";
import { execa } from "execa";
import crypto from "node:crypto";
import type { AgentEvent } from "../types";
import { writeClaudeMcpConfig } from "./mcp-config-file";

/**
 * Run an agent backed by the local `claude` CLI in headless stream-json mode.
 * Parses the protocol into `assistant-delta` / `tool-use` / `tool-result`
 * events, emits them through the AgentManager singleton.
 *
 * The subprocess is intentionally NOT tied to any HTTP request lifecycle.
 * Once spawned, it runs to completion regardless of whether the user keeps
 * the tab open.
 */

interface ClaudeStreamSystem {
  type: "system";
  subtype?: string;
  tools?: unknown;
}

interface ClaudeStreamAssistant {
  type: "assistant";
  message?: {
    content?: Array<
      | { type: "text"; text: string }
      | {
          type: "tool_use";
          id: string;
          name: string;
          input?: unknown;
        }
    >;
  };
}

interface ClaudeStreamUser {
  type: "user";
  message?: {
    content?: Array<{
      type: "tool_result";
      tool_use_id: string;
      content?: string | Array<{ type: string; text?: string }>;
      is_error?: boolean;
    }>;
  };
}

interface ClaudeStreamResult {
  type: "result";
  subtype?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  is_error?: boolean;
}

type ClaudeStreamLine =
  | ClaudeStreamSystem
  | ClaudeStreamAssistant
  | ClaudeStreamUser
  | ClaudeStreamResult;

interface Runtime {
  meta: { id: string };
  args: {
    rootPath: string;
    reflexScope: string;
    systemPrompt: string;
    prompt: string;
    model: string;
    allowedTools?: string[];
  };
  manager: {
    emit: (event: AgentEvent) => Promise<void>;
    registerKiller?: (agentId: string, fn: () => void) => void;
    clearKiller?: (agentId: string) => void;
  };
}

const DEFAULT_TOOLS = [
  "Read",
  "LS",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
];

export async function runClaudeCode(rt: Runtime): Promise<void> {
  // Reflex's MCP registry → claude-code's --mcp-config. Each registered
  // server is also added to allowedTools as `mcp__<id>__*` so the agent can
  // actually invoke its tools (without the prefix claude would refuse).
  const mcpCfg = await writeClaudeMcpConfig(rt.meta.id);
  const baseTools =
    rt.args.allowedTools && rt.args.allowedTools.length > 0
      ? rt.args.allowedTools
      : DEFAULT_TOOLS;
  const tools = mcpCfg
    ? [...baseTools, ...mcpCfg.serverIds.map((id) => `mcp__${id}__*`)]
    : baseTools;
  const args = [
    "-p",
    rt.args.prompt,
    "--append-system-prompt",
    rt.args.systemPrompt,
    "--permission-mode",
    "default",
    "--allowedTools",
    tools.join(","),
    "--add-dir",
    rt.args.reflexScope,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    rt.args.model,
    ...(mcpCfg ? ["--mcp-config", mcpCfg.path] : []),
  ];
  const sub = execa("claude", args, {
    cwd: rt.args.rootPath,
    buffer: false,
    stdin: "ignore",
  });
  // Let the manager kill this subprocess when the user grants "Always
  // allow" mid-stream — only way to get claude to pick up the new
  // --allowedTools is to respawn it.
  rt.manager.registerKiller?.(rt.meta.id, () => {
    try {
      sub.kill("SIGTERM");
      // Hard-kill backstop in case SIGTERM is ignored.
      setTimeout(() => {
        try {
          sub.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 1500).unref();
    } catch {
      /* already dead */
    }
  });
  // Map tool_use id → actual tool name so we can recover the precise
  // tool when claude returns a "to write to PATH" error that doesn't
  // include the tool name verbatim. Lives for the duration of this
  // run() call.
  const toolUseNames = new Map<string, string>();
  try {
    for await (const line of readLines(sub.stdout)) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      for (const ev of toEvents(parsed, rt.meta.id, toolUseNames)) {
        await rt.manager.emit(ev);
      }
    }
    try {
      await sub;
    } catch (err) {
      // SIGTERM from the manager (after Always-allow) shows up here — swallow.
      if (sub.killed) {
        // intentional; the manager already scheduled a retry turn.
      } else {
        throw err;
      }
    }
  } finally {
    rt.manager.clearKiller?.(rt.meta.id);
    if (mcpCfg) await mcpCfg.cleanup();
  }
}

function parseLine(line: string): ClaudeStreamLine | null {
  try {
    return JSON.parse(line) as ClaudeStreamLine;
  } catch {
    return null;
  }
}

function toEvents(
  parsed: ClaudeStreamLine,
  agentId: string,
  toolUseNames: Map<string, string>,
): AgentEvent[] {
  const ts = new Date().toISOString();
  if (parsed.type === "system") {
    return [
      {
        type: "system",
        text: parsed.subtype ?? "system",
        subtype: parsed.subtype,
        agentId,
        ts,
        seq: 0,
      },
    ];
  }
  if (parsed.type === "assistant") {
    const out: AgentEvent[] = [];
    for (const part of parsed.message?.content ?? []) {
      if (part.type === "text") {
        out.push({
          type: "assistant-delta",
          text: part.text,
          agentId,
          ts,
          seq: 0,
        });
      } else if (part.type === "tool_use") {
        toolUseNames.set(part.id, part.name);
        out.push({
          type: "tool-use",
          toolUseId: part.id,
          name: part.name,
          input: part.input ?? {},
          agentId,
          ts,
          seq: 0,
        });
      }
    }
    return out;
  }
  if (parsed.type === "user") {
    const out: AgentEvent[] = [];
    for (const part of parsed.message?.content ?? []) {
      if (part.type === "tool_result") {
        const content = stringifyToolResult(part.content);
        out.push({
          type: "tool-result",
          toolUseId: part.tool_use_id,
          content,
          ...(part.is_error ? { isError: true } : {}),
          agentId,
          ts,
          seq: 0,
        });
        // Claude returns a synthetic tool_result with is_error=true when the
        // agent tried to use a tool that isn't in --allowedTools. Convert that
        // into a Reflex permission-request so the user can decide and we can
        // persist the choice back into settings for next time.
        if (part.is_error) {
          // Prefer the precise tool name from the originating tool_use
          // event — claude phrases Edit denials as "to write to PATH"
          // generically, so heuristic regex alone misroutes them.
          const fromUse = toolUseNames.get(part.tool_use_id);
          const blocked = fromUse ?? parseBlockedTool(content);
          if (blocked) {
            const target = parseBlockedTarget(content);
            out.push({
              type: "permission-request",
              requestId: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
              tool: blocked,
              action: "tool-policy",
              ...(target ? { input: { target } } : {}),
              description: target
                ? `The agent wants to ${verbFor(blocked)} \`${target}\` via "${blocked}". Allow?`
                : `The agent tried to call the "${blocked}" tool, but it is not in the allowed list for this task. Allow?`,
              agentId,
              ts,
              seq: 0,
            });
          }
        }
      }
    }
    return out;
  }
  if (parsed.type === "result") {
    return []; // agent-end emitted by manager when run() returns
  }
  return [];
}

/**
 * Extract the blocked tool name from claude's denial message. Claude Code
 * uses several phrasings depending on what was requested:
 *
 *   "Claude requested permissions to use WebSearch, but you haven't granted it yet."
 *   "Claude requested permissions to write to /path/foo.md, but you haven't granted it yet."
 *   "Claude requested permissions to edit /path/foo.md, but ..."
 *   "Claude requested permissions to run <cmd>, but ..."
 *
 * The first form gives the tool name directly; the rest hint at the tool
 * via the verb. Returns the canonical tool name or null if the message
 * isn't a permission denial.
 */
/**
 * Pull the target out of a Claude permission-denial message — path for
 * Write/Edit/Read, command for Bash. Returns null if no obvious target.
 */
function parseBlockedTarget(content: string): string | null {
  const m =
    /requested permissions to (?:write to|edit|read)\s+(\S+?)(?:,|\s+but\b|\s*$)/i.exec(
      content,
    ) ??
    /requested permissions to run\s+(.+?)(?:,\s+but\b|\s*$)/i.exec(content);
  return m?.[1]?.trim() ?? null;
}

function verbFor(tool: string): string {
  if (tool === "Write") return "write to";
  if (tool === "Edit" || tool === "MultiEdit") return "edit";
  if (tool === "Read") return "read";
  if (tool === "Bash") return "run a command";
  if (tool === "NotebookEdit") return "edit a notebook";
  if (tool === "WebFetch") return "fetch a URL";
  if (tool === "WebSearch") return "search the web";
  return "use";
}

function parseBlockedTool(content: string): string | null {
  const useMatch = /requested permissions to use\s+([A-Za-z_]\w*)/i.exec(content);
  if (useMatch?.[1]) return useMatch[1];
  if (/requested permissions to write\b/i.test(content)) return "Write";
  if (/requested permissions to edit\b/i.test(content)) return "Edit";
  if (/requested permissions to run\b/i.test(content)) return "Bash";
  if (/requested permissions to read\b/i.test(content)) return "Read";
  const tail = /permission .* tool[:\s]+([A-Za-z_]\w*)/i.exec(content);
  return tail?.[1] ?? null;
}

function stringifyToolResult(
  content?:
    | string
    | Array<{ type: string; text?: string }>,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((c) => (c.type === "text" && c.text ? c.text : ""))
    .join("");
}

async function* readLines(
  stdout: NodeJS.ReadableStream | null | undefined,
): AsyncGenerator<string> {
  if (!stdout) return;
  let buf = "";
  for await (const chunk of stdout as AsyncIterable<Buffer | string>) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
  if (buf.trim()) yield buf;
}
