import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  AuditEntry,
  InstalledUtility,
  Manifest,
  ServerAction,
} from "./types";
import matter from "gray-matter";
import { auditCall, appendAudit } from "./audit";
import { utilityFile, listUtilities, resolveUtility } from "./store";
import { capabilityRegistry } from "@/lib/server/capabilities/registry";
import { findGrant, type SharePlane } from "./grant-store";
import {
  listProviders as listProviderEntries,
  findProviderCapability,
  rebuildProviderDirectory,
  getKindOwner,
  type ProviderInput,
} from "./provider-directory";
import { quickComplete } from "@/lib/server/quick";
import { writeKbEntry } from "@/lib/server/agents/kb-writer";
import { listKbFiles, readKbFile } from "@/lib/server/kb";
import { searchSessions } from "@/lib/server/sessions";
import { getRoot } from "@/lib/registry";
import { loadSettings } from "@/lib/settings/store";
import type { Assignment, TaskId } from "@/lib/settings";
import type { McpConfig } from "./mcp";

/**
 * Single entry-point for everything a utility can ask Reflex to do. Used by:
 *   - the iframe ↔ host bridge (REST POST /host)
 *   - the Worker pool (server-actions call back into here through parentPort)
 *
 * Every method is gated by the utility's manifest.permissions and wrapped in
 * an audit start/end pair.
 */

export type Channel = AuditEntry["channel"];

export interface HostContext {
  utility: InstalledUtility;
  channel: Channel;
  /** Set when this call originated from a server action — links nested calls. */
  parentCorrelationId?: string;
}

const LlmCompleteSchema = z.object({
  task: z.enum(["chat", "quick", "rag", "embed"]).default("quick"),
  prompt: z.string().min(1),
  model: z.string().optional(),
});

const KbAddSchema = z.object({
  kind: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().default(""),
  meta: z.record(z.string(), z.unknown()).optional(),
  slug: z.string().optional(),
  date: z.string().optional(),
  /** When set, write to that project; otherwise to the utility's rootId if any. */
  rootId: z.string().optional(),
});

const KbListSchema = z.object({
  kind: z.string().optional(),
  query: z.string().optional(),
  rootId: z.string().optional(),
});

const KbReadSchema = z.object({
  relPath: z.string().min(1),
  rootId: z.string().optional(),
});

const FsArgSchema = z.object({
  path: z.string().min(1),
  content: z.string().optional(),
});

const WebFetchSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
});

const WebSearchSchema = z.object({
  query: z.string().min(1).max(512),
});

const AuditLogSchema = z.object({
  type: z.string().min(1).max(64),
  payload: z.unknown().optional(),
});

const McpCallSchema = z.object({
  /** Server id from the registry. Optional for legacy mcp-bridge utilities. */
  server: z.string().min(1).optional(),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

const McpListToolsSchema = z.object({
  server: z.string().min(1).optional(),
});

const SecretsGetSchema = z.object({
  key: z.string().min(1),
});

const ActionInvokeSchema = z.object({
  name: z.string().min(1),
  args: z.unknown().optional(),
});

const AgentInvokeSchema = z.object({
  prompt: z.string().min(1).max(40_000),
  rootId: z.string().optional(),
  /** Override harness/model for this single run; otherwise inherit chat assignment. */
  harness: z.string().optional(),
  model: z.string().optional(),
  language: z.string().optional(),
  /** Optional label that shows up in audit + transient topic title. */
  label: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(15 * 60_000).optional(),
});

const WorkflowListSchema = z.object({
  rootId: z.string().optional(),
});

const WorkflowReadSchema = z.object({
  workflowId: z.string().min(1),
  rootId: z.string().optional(),
});

const WorkflowRunSchema = z.object({
  workflowId: z.string().min(1),
  rootId: z.string().optional(),
  input: z.unknown().optional(),
});

const ImagesGenerateSchema = z.object({
  prompt: z.string().min(1).max(8_000),
  provider: z.enum(["gemini", "codex"]).optional(),
  size: z.string().max(40).optional(),
  aspectRatio: z.string().max(40).optional(),
  referenceImageUrls: z.array(z.string().url()).max(6).optional(),
  alt: z.string().max(280).optional(),
  rootId: z.string().optional(),
});

const ImagesSearchSchema = z.object({
  query: z.string().min(1).max(200),
  provider: z.enum(["unsplash", "pexels", "brave"]).optional(),
  count: z.number().int().min(1).max(24).optional(),
});

const ImagesAttachSchema = z.object({
  sourceUrl: z.string().url(),
  rootId: z.string().optional(),
});

const MermaidValidateSchema = z.object({
  source: z.string().min(1).max(20_000),
});

// ---------------------------------------------------------------------------
// Tasks + git worktree

const TaskHookSchema = z
  .object({
    kind: z.enum(["workflow", "chat"]),
    id: z.string().optional(),
    prompt: z.string().optional(),
  })
  .strict();

const TaskAttachmentSchema = z
  .object({
    kind: z.enum(["image", "text", "file"]),
    file: z.string().min(1).max(500),
    caption: z.string().max(500).optional(),
  })
  .strict();

const TaskCreateSchema = z.object({
  title: z.string().min(1).max(280),
  body: z.string().max(50_000).default(""),
  type: z
    .enum([
      "feature",
      "bug",
      "refactor",
      "docs",
      "chore",
      "research",
      "review",
      "call",
      "idea",
    ])
    .default("feature"),
  status: z
    .enum(["backlog", "ready", "in-progress", "review", "done", "blocked"])
    .default("backlog"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  labels: z.array(z.string()).default([]),
  assignee: z.string().nullable().default(null),
  parent: z.string().nullable().default(null),
  links: z
    .object({
      blocks: z.array(z.string()).optional(),
      blockedBy: z.array(z.string()).optional(),
      related: z.array(z.string()).optional(),
    })
    .default({}),
  pre: z.array(TaskHookSchema).default([]),
  post: z.array(TaskHookSchema).default([]),
  attachments: z.array(TaskAttachmentSchema).default([]),
});

const TaskUpdateSchema = z.object({
  id: z.string().min(1),
  patch: z
    .object({
      title: z.string().min(1).max(280).optional(),
      body: z.string().max(50_000).optional(),
      type: z
        .enum([
          "feature",
          "bug",
          "refactor",
          "docs",
          "chore",
          "research",
          "review",
          "call",
          "idea",
        ])
        .optional(),
      status: z
        .enum(["backlog", "ready", "in-progress", "review", "done", "blocked"])
        .optional(),
      priority: z.enum(["low", "normal", "high"]).optional(),
      labels: z.array(z.string()).optional(),
      assignee: z.string().nullable().optional(),
      parent: z.string().nullable().optional(),
      links: z
        .object({
          blocks: z.array(z.string()).optional(),
          blockedBy: z.array(z.string()).optional(),
          related: z.array(z.string()).optional(),
        })
        .optional(),
      pre: z.array(TaskHookSchema).optional(),
      post: z.array(TaskHookSchema).optional(),
      attachments: z.array(TaskAttachmentSchema).optional(),
    })
    .default({}),
});

const TaskIdSchema = z.object({ id: z.string().min(1) });

const TaskDispatchSchema = z.object({
  id: z.string().min(1),
  harness: z.string().optional(),
  model: z.string().optional(),
});

const TaskCompleteSchema = z.object({
  id: z.string().min(1),
  outcome: z.enum(["done", "review", "blocked"]),
});

const WorktreeMergeSchema = z.object({
  branch: z.string().min(1),
  intoRef: z.string().optional(),
});

const WorktreeRemoveSchema = z.object({
  slug: z.string().min(1),
  branch: z.string().min(1),
  force: z.boolean().default(false),
  deleteBranch: z.boolean().default(true),
});

const WorktreeCreateSchema = z.object({
  slug: z.string().min(1),
  branch: z.string().min(1),
  baseRef: z.string().optional(),
});

const SessionsSearchSchema = z.object({
  query: z.string().min(1).max(512),
  rootId: z.string().optional(),
  source: z.enum(["journal", "topic"]).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const ImagesPickBestSchema = z.object({
  query: z.string().min(1).max(200),
  alt: z.string().max(280).default(""),
  context: z.string().max(2_000).default(""),
  candidates: z
    .array(
      z.object({
        url: z.string().url(),
        thumb: z.string().url(),
        attribution: z.object({
          name: z.string().default(""),
          link: z.string().default(""),
        }),
      }),
    )
    .min(1)
    .max(12),
  rootId: z.string().optional(),
});

const CardsUpdateSchema = z.object({
  /** Override the widget id; defaults to `utility:<utilityId>`. */
  widgetId: z.string().optional(),
  /** New `inner` payload — same shape as the original `manifest.card`. */
  snapshot: z.object({
    kind: z.enum([
      "markdown",
      "news-list",
      "link-list",
      "kpi",
      "checklist",
      "quote",
      "kb-pinned",
      "progress",
      "image",
      "stat-table",
      "map",
      "action-list",
    ]),
    title: z.string().optional(),
    description: z.string().optional(),
    data: z.record(z.string(), z.unknown()).default({}),
  }),
  rootId: z.string().optional(),
});

const HOSTS_NEEDING_LLM = new Set<TaskId>(["chat", "quick", "rag", "embed"]);

/**
 * The host-method dispatch table (north-star Phase 4 — collapse the stringly-
 * typed switch into one data-driven registry). Each entry is the VERBATIM body
 * of its former `case`, so behavior is identical; the id set is pinned by the
 * golden-id ABI test (test/host-api-surface.test.ts) + test/host-methods-
 * table.test.ts. This table is what a future describe()/proxy generator
 * iterates, and the bridge the Layer-2 CapabilityRegistry will absorb.
 */
type HostMethod = (
  ctx: HostContext,
  rawArgs: unknown,
  correlationId: string,
) => unknown;

// Share Plane schemas (cross-utility data + capabilities — see docs/sharing.md).
const ScopedListSchema = z.object({
  provider: z.string().min(1).max(80),
  kind: z.string().min(1).max(64),
  rootId: z.string().optional(),
  query: z.string().optional(),
});
const ScopedReadSchema = z.object({
  provider: z.string().min(1).max(80),
  kind: z.string().min(1).max(64),
  relPath: z.string().min(1),
  rootId: z.string().optional(),
});
const ListProvidersSchema = z.object({
  kind: z.string().optional(),
  verb: z.string().optional(),
});
const CapabilitiesInvokeSchema = z.object({
  provider: z.string().min(1).max(80),
  verb: z.string().min(1).max(64),
  input: z.unknown().optional(),
  rootId: z.string().optional(),
});

export const HOST_METHODS: Record<string, HostMethod> = {
  "llm.complete": (ctx, raw) => llmComplete(ctx, LlmCompleteSchema.parse(raw)),
  "kb.add": (ctx, raw) => kbAdd(ctx, KbAddSchema.parse(raw)),
  "kb.list": (ctx, raw) => kbList(ctx, KbListSchema.parse(raw)),
  "kb.read": (ctx, raw) => kbRead(ctx, KbReadSchema.parse(raw)),
  "fs.read": (ctx, raw) => fsRead(ctx, FsArgSchema.parse(raw)),
  "fs.write": (ctx, raw) => fsWrite(ctx, FsArgSchema.parse(raw)),
  "fs.list": (ctx, raw) => fsList(ctx, FsArgSchema.parse(raw)),
  "web.fetch": (ctx, raw) => webFetch(ctx, WebFetchSchema.parse(raw)),
  "web.search": (ctx, raw) => webSearch(ctx, WebSearchSchema.parse(raw)),
  "audit.log": (ctx, raw, cid) =>
    auditFreeform(ctx, AuditLogSchema.parse(raw), cid),
  "actions.invoke": (ctx, raw, cid) =>
    actionsInvoke(ctx, ActionInvokeSchema.parse(raw), cid),
  "mcp.call": (ctx, raw) => mcpCall(ctx, McpCallSchema.parse(raw)),
  "mcp.listServers": (ctx) => mcpListServers(ctx),
  "mcp.listTools": (ctx, raw) => mcpListTools(ctx, McpListToolsSchema.parse(raw)),
  "secrets.get": (ctx, raw) => secretsGet(ctx, SecretsGetSchema.parse(raw)),
  "secrets.list": (ctx) => secretsList(ctx),
  "agent.invoke": (ctx, raw) => agentInvoke(ctx, AgentInvokeSchema.parse(raw)),
  "workflow.list": (ctx, raw) => workflowList(ctx, WorkflowListSchema.parse(raw)),
  "workflow.read": (ctx, raw) => workflowRead(ctx, WorkflowReadSchema.parse(raw)),
  "workflow.run": (ctx, raw) => workflowRun(ctx, WorkflowRunSchema.parse(raw)),
  "cards.update": (ctx, raw) => cardsUpdate(ctx, CardsUpdateSchema.parse(raw)),
  "images.generate": (ctx, raw) =>
    imagesGenerate(ctx, ImagesGenerateSchema.parse(raw)),
  "images.search": (ctx, raw) => imagesSearch(ctx, ImagesSearchSchema.parse(raw)),
  "images.attach": (ctx, raw) => imagesAttach(ctx, ImagesAttachSchema.parse(raw)),
  "images.pickBest": (ctx, raw) =>
    imagesPickBest(ctx, ImagesPickBestSchema.parse(raw)),
  "mermaid.validate": (ctx, raw) =>
    mermaidValidate(ctx, MermaidValidateSchema.parse(raw)),
  "tasks.create": (ctx, raw) => tasksCreate(ctx, TaskCreateSchema.parse(raw)),
  "tasks.update": (ctx, raw) => tasksUpdate(ctx, TaskUpdateSchema.parse(raw)),
  "tasks.delete": (ctx, raw) => tasksDelete(ctx, TaskIdSchema.parse(raw)),
  "tasks.get": (ctx, raw) => tasksGet(ctx, TaskIdSchema.parse(raw)),
  "tasks.list": (ctx) => tasksList(ctx),
  "tasks.dispatch": (ctx, raw) => tasksDispatch(ctx, TaskDispatchSchema.parse(raw)),
  "tasks.observe": (ctx, raw) => tasksObserve(ctx, TaskIdSchema.parse(raw)),
  "tasks.complete": (ctx, raw) =>
    tasksComplete(ctx, TaskCompleteSchema.parse(raw)),
  "git.isRepo": (ctx) => gitIsRepo(ctx),
  "git.hasRemote": (ctx) => gitHasRemote(ctx),
  "git.hasGhCli": () => gitHasGhCli(),
  "git.worktree.create": (ctx, raw) =>
    worktreeCreate(ctx, WorktreeCreateSchema.parse(raw)),
  "git.worktree.merge": (ctx, raw) =>
    worktreeMerge(ctx, WorktreeMergeSchema.parse(raw)),
  "git.worktree.remove": (ctx, raw) =>
    worktreeRemove(ctx, WorktreeRemoveSchema.parse(raw)),
  "git.worktree.list": (ctx) => worktreeList(ctx),
  "sessions.search": (ctx, raw) =>
    sessionsSearch(ctx, SessionsSearchSchema.parse(raw)),
  "kb.scopedList": (ctx, raw) => kbScopedList(ctx, ScopedListSchema.parse(raw)),
  "kb.scopedRead": (ctx, raw) => kbScopedRead(ctx, ScopedReadSchema.parse(raw)),
  "capabilities.listProviders": (ctx, raw) =>
    capabilitiesListProviders(ctx, ListProvidersSchema.parse(raw)),
  "capabilities.invoke": (ctx, raw, cid) =>
    capabilitiesInvoke(ctx, CapabilitiesInvokeSchema.parse(raw), cid),
};

/**
 * Register every host method on the shared CapabilityRegistry (Phase 4 — one
 * registry across agents/utilities/workflows). Each capability wraps the exact
 * HOST_METHODS table fn, so routing through the registry is behavior-identical
 * to calling the table; this just makes the host surface visible to
 * registry.describe() (proxy/prompt/step-picker generation). Idempotent.
 */
let hostMethodsRegistered = false;
function ensureHostMethodsRegistered(): void {
  if (hostMethodsRegistered) return;
  hostMethodsRegistered = true;
  const reg = capabilityRegistry();
  for (const [id, fn] of Object.entries(HOST_METHODS)) {
    if (reg.has(id)) continue;
    reg.register({
      kind: "sync",
      id,
      run: (input, capCtx) =>
        fn(capCtx.host as HostContext, input, capCtx.correlationId ?? ""),
    });
  }
}

/**
 * Sensitive host methods that spawn subprocess agents (tasks.dispatch → a real
 * Claude Code / Codex child process) or mutate the user's real git repository
 * (git.worktree.*). Each is gated by a real permission slot the utility
 * REQUESTS and the user consents to at install (fix B — see docs/sharing.md),
 * which replaced the original task-board-only id-gate. Read-only git.isRepo /
 * hasRemote / hasGhCli stay open (documented as "always").
 */
const SENSITIVE_METHOD_SLOTS: Record<
  string,
  "tasks.read" | "tasks.write" | "tasks.dispatch" | "worktree"
> = {
  "tasks.get": "tasks.read",
  "tasks.list": "tasks.read",
  "tasks.observe": "tasks.read",
  "tasks.create": "tasks.write",
  "tasks.update": "tasks.write",
  "tasks.delete": "tasks.write",
  "tasks.complete": "tasks.write",
  "tasks.dispatch": "tasks.dispatch",
  "git.worktree.create": "worktree",
  "git.worktree.merge": "worktree",
  "git.worktree.remove": "worktree",
  "git.worktree.list": "worktree",
};

function hasSensitiveSlot(
  manifest: Manifest,
  slot: "tasks.read" | "tasks.write" | "tasks.dispatch" | "worktree",
): boolean {
  const p = manifest.permissions;
  switch (slot) {
    case "tasks.read":
      return !!p.tasks?.read;
    case "tasks.write":
      return !!p.tasks?.write;
    case "tasks.dispatch":
      return !!p.tasks?.dispatch;
    case "worktree":
      return !!p.worktree;
  }
}

/**
 * Back-compat shim: an un-upgraded task-board (declares none of the new
 * sensitive slots) keeps working while the slot becomes the real boundary for
 * every other utility. Remove once task-board ships its slot declarations.
 */
function isLegacyTaskBoard(manifest: Manifest): boolean {
  return (
    manifest.id === "task-board" &&
    !manifest.permissions.tasks &&
    !manifest.permissions.worktree
  );
}

export async function dispatchHostCall(
  ctx: HostContext,
  method: string,
  rawArgs: unknown,
): Promise<unknown> {
  ensureHostMethodsRegistered();
  const meta = {
    utilityId: ctx.utility.manifest.id,
    scope: ctx.utility.scope,
    channel: ctx.channel,
    method,
    args: rawArgs,
    ...(ctx.parentCorrelationId
      ? { parentCorrelationId: ctx.parentCorrelationId }
      : {}),
  };
  return auditCall(meta, async (correlationId) => {
    if (!capabilityRegistry().has(method)) {
      throw new Error(`Unknown host method: ${method}`);
    }
    // Gate sensitive methods on a real permission slot (fix B — see
    // SENSITIVE_METHOD_SLOTS above). The denied call is still audited; an
    // un-upgraded task-board is grandfathered in by isLegacyTaskBoard.
    const requiredSlot = SENSITIVE_METHOD_SLOTS[method];
    if (
      requiredSlot &&
      !hasSensitiveSlot(ctx.utility.manifest, requiredSlot) &&
      !isLegacyTaskBoard(ctx.utility.manifest)
    ) {
      throw new Error(
        `utility "${ctx.utility.manifest.id}" lacks permission "${requiredSlot}" required for ${method}`,
      );
    }
    // Route through the unified CapabilityRegistry. The registered run wraps
    // the same HOST_METHODS fn, so this is behavior-identical to the table.
    return capabilityRegistry().invoke(method, rawArgs, {
      caller: "utility",
      host: ctx,
      correlationId,
    });
  });
}

async function secretsGet(
  ctx: HostContext,
  args: z.infer<typeof SecretsGetSchema>,
): Promise<{ value: string }> {
  const declared = ctx.utility.manifest.secrets ?? [];
  const slot = declared.find((s) => s.key === args.key);
  if (!slot) {
    throw new Error(
      `secret "${args.key}" is not declared in manifest.secrets`,
    );
  }
  const { getSecret } = await import("./secrets-store");
  const value = await getSecret(
    ctx.utility.scope,
    ctx.utility.manifest.id,
    args.key,
    ctx.utility.rootId,
  );
  if (value == null) {
    throw new Error(
      `secret "${args.key}" is not set — fill it in the utility's panel`,
    );
  }
  return { value };
}

async function secretsList(
  ctx: HostContext,
): Promise<{ secrets: Array<{ key: string; set: boolean; required: boolean; label: string; description: string }> }> {
  const declared = ctx.utility.manifest.secrets ?? [];
  const { listSecretKeys } = await import("./secrets-store");
  const filled = new Set(
    await listSecretKeys(
      ctx.utility.scope,
      ctx.utility.manifest.id,
      ctx.utility.rootId,
    ),
  );
  return {
    secrets: declared.map((s) => ({
      key: s.key,
      set: filled.has(s.key),
      required: s.required,
      label: s.label,
      description: s.description,
    })),
  };
}

/**
 * Resolve the MCP config the utility intends to talk to:
 *   - explicit `server` arg → registry lookup (must be declared in
 *     `manifest.mcpServers`).
 *   - omitted `server` AND utility is a legacy single-server mcp-bridge
 *     (`source.type === "mcp"`) → fall back to `<dir>/mcp.json`.
 *   - omitted `server` AND utility declares exactly one server → use it.
 */
async function resolveMcpConfig(
  ctx: HostContext,
  serverId: string | undefined,
): Promise<{ config: McpConfig; serverId: string }> {
  const declared = ctx.utility.manifest.mcpServers ?? [];
  let id = serverId;
  if (!id) {
    if (declared.length === 1) id = declared[0]!;
    else if (ctx.utility.manifest.source?.type === "mcp") {
      const cfgPath = path.join(ctx.utility.dir, "mcp.json");
      const raw = await fs.readFile(cfgPath, "utf8").catch(() => null);
      if (!raw) throw new Error(`mcp config missing at ${cfgPath}`);
      const { McpConfigSchema } = await import("./mcp");
      return {
        config: McpConfigSchema.parse(JSON.parse(raw)),
        serverId: "(bundled)",
      };
    } else {
      throw new Error(
        declared.length === 0
          ? "manifest.mcpServers is empty — declare which server you want to use"
          : "multiple mcpServers declared — pass `server` explicitly",
      );
    }
  }
  if (!declared.includes(id)) {
    throw new Error(
      `mcp server "${id}" is not in manifest.mcpServers — declare it to gain access`,
    );
  }
  const { getMcpServer } = await import("@/lib/server/mcp-registry");
  const entry = await getMcpServer(id);
  if (!entry) {
    throw new Error(
      `mcp server "${id}" is not registered — add it in Settings → MCP`,
    );
  }
  return { config: entry.config, serverId: id };
}

async function mcpCall(
  ctx: HostContext,
  args: z.infer<typeof McpCallSchema>,
): Promise<{ server: string; isError?: boolean; content: unknown }> {
  const { config, serverId } = await resolveMcpConfig(ctx, args.server);
  const { callTool } = await import("./mcp");
  const result = await callTool(config, args.tool, args.args);
  return {
    server: serverId,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    content: result.content,
  };
}

async function mcpListServers(
  ctx: HostContext,
): Promise<{
  servers: Array<{ id: string; label: string; description: string; registered: boolean }>;
}> {
  const declared = ctx.utility.manifest.mcpServers ?? [];
  const { listMcpServers } = await import("@/lib/server/mcp-registry");
  const registry = await listMcpServers();
  const registered = new Map(registry.map((s) => [s.id, s]));
  return {
    servers: declared.map((id) => {
      const r = registered.get(id);
      return {
        id,
        label: r?.label ?? id,
        description: r?.description ?? "",
        registered: !!r,
      };
    }),
  };
}

async function mcpListTools(
  ctx: HostContext,
  args: z.infer<typeof McpListToolsSchema>,
): Promise<{
  server: string;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}> {
  const { config, serverId } = await resolveMcpConfig(ctx, args.server);
  const { connectAndListTools } = await import("./mcp");
  const info = await connectAndListTools(config);
  return { server: serverId, tools: info.tools };
}

// ---------------------------------------------------------------------------
// llm.complete

async function llmComplete(
  ctx: HostContext,
  args: z.infer<typeof LlmCompleteSchema>,
): Promise<{ text: string }> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.llm?.tasks?.includes(args.task),
    `llm.${args.task} not granted in manifest`,
  );
  const settings = await loadSettings();
  const assignment: Assignment = {
    ...settings.assignments[args.task],
    ...(args.model ? { model: args.model } : {}),
  };
  const text = await quickComplete(assignment, args.prompt, {
    timeoutMs: 60_000,
  });
  return { text };
}

// ---------------------------------------------------------------------------
// kb.*

async function kbAdd(
  ctx: HostContext,
  args: z.infer<typeof KbAddSchema>,
): Promise<{ relPath: string; absPath: string }> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.kb?.write,
    "kb.write not granted",
  );
  if (ctx.utility.manifest.permissions.kb?.kinds) {
    const ok = ctx.utility.manifest.permissions.kb.kinds.includes(args.kind);
    if (!ok) {
      throw new Error(`kb kind "${args.kind}" not in manifest allowlist`);
    }
  }
  // Owner-enforced kinds (Share Plane): if a provider has CLAIMED this kind,
  // only that provider may write it — stops a consumer forging another
  // utility's owned data. Unclaimed / legacy kinds behave exactly as before.
  const kindOwner = await getKindOwner(args.kind);
  if (kindOwner && kindOwner !== ctx.utility.manifest.id) {
    throw new Error(`kb.add: kind "${args.kind}" is owned by utility "${kindOwner}"`);
  }
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const written = await writeKbEntry({
    rootPath: targetRoot.path,
    directive: {
      kind: args.kind,
      title: args.title,
      ...(args.body ? { body: args.body } : {}),
      ...(args.meta ? { meta: args.meta } : {}),
      ...(args.slug ? { slug: args.slug } : {}),
      ...(args.date ? { date: args.date } : {}),
    },
    provenance: {
      kind: "utility",
      id: ctx.utility.manifest.id,
      version: ctx.utility.manifest.version,
    },
  });
  return { relPath: written.relPath, absPath: written.absPath };
}

async function kbList(
  ctx: HostContext,
  args: z.infer<typeof KbListSchema>,
): Promise<
  Array<{ relPath: string; title?: string; kind?: string; modifiedAt: string }>
> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.kb?.read,
    "kb.read not granted",
  );
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const files = await listKbFiles(targetRoot.path);
  const q = args.query?.toLowerCase();
  return files
    .filter((f) => {
      if (args.kind) {
        const dir = f.rel.split("/")[0];
        if (dir !== args.kind && f.meta.kind !== args.kind) return false;
      }
      if (q) {
        const hay = `${f.rel} ${f.meta.title ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .map((f) => ({
      relPath: f.rel,
      title: f.meta.title,
      kind: f.meta.kind,
      modifiedAt: f.modifiedAt,
    }));
}

async function kbRead(
  ctx: HostContext,
  args: z.infer<typeof KbReadSchema>,
): Promise<{ content: string }> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.kb?.read,
    "kb.read not granted",
  );
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const content = await readKbFile(targetRoot.path, args.relPath);
  return { content };
}

// ---------------------------------------------------------------------------
// Share Plane — cross-utility data (kb.scoped*) + capabilities. See docs/sharing.md.

/** True iff a KB entry's host-stamped `createdBy` marks it owned by `provider`. */
function ownedByProvider(createdBy: unknown, provider: string): boolean {
  if (typeof createdBy !== "string") return false;
  return (
    createdBy === `utility:${provider}` ||
    createdBy.startsWith(`utility:${provider}@`)
  );
}

function grantRequired(
  consumer: string,
  plane: SharePlane,
  provider: string,
  selector: string,
): Error {
  return new Error(
    `grant_required: utility "${consumer}" needs a ${plane} grant for ${provider}/${selector}`,
  );
}

function ensureConsume(ctx: HostContext): void {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.shares?.consume,
    "shares.consume not granted",
  );
}

/**
 * Rebuild the provider directory from the currently-installed utilities so
 * discovery + capability resolution are always fresh (ownership is preserved
 * across rebuilds). The install/uninstall hooks also refresh it; this keeps the
 * host methods correct regardless of that wiring.
 */
async function syncProviderDirectory(rootId?: string): Promise<void> {
  const utils = await listUtilities(rootId ? { rootId } : {});
  const inputs: ProviderInput[] = utils.map((u) => ({
    id: u.manifest.id,
    scope: u.scope,
    ...(u.rootId ? { rootId: u.rootId } : {}),
    version: u.manifest.version,
    provides: u.manifest.provides,
  }));
  await rebuildProviderDirectory(inputs);
}

async function kbScopedList(
  ctx: HostContext,
  args: z.infer<typeof ScopedListSchema>,
): Promise<
  Array<{ relPath: string; title?: string; kind?: string; modifiedAt: string }>
> {
  ensureConsume(ctx);
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const grant = await findGrant({
    consumer: ctx.utility.manifest.id,
    provider: args.provider,
    plane: "data",
    selector: args.kind,
    scope: targetRoot.id,
  });
  if (!grant)
    throw grantRequired(ctx.utility.manifest.id, "data", args.provider, args.kind);
  const files = await listKbFiles(targetRoot.path);
  const q = args.query?.toLowerCase();
  return files
    .filter((f) => {
      const dir = f.rel.split("/")[0];
      if (dir !== args.kind && f.meta.kind !== args.kind) return false;
      if (!ownedByProvider(f.meta.data.createdBy, args.provider)) return false;
      if (q) {
        const hay = `${f.rel} ${f.meta.title ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .map((f) => ({
      relPath: f.rel,
      title: f.meta.title,
      kind: f.meta.kind,
      modifiedAt: f.modifiedAt,
    }));
}

async function kbScopedRead(
  ctx: HostContext,
  args: z.infer<typeof ScopedReadSchema>,
): Promise<{ content: string }> {
  ensureConsume(ctx);
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const grant = await findGrant({
    consumer: ctx.utility.manifest.id,
    provider: args.provider,
    plane: "data",
    selector: args.kind,
    scope: targetRoot.id,
  });
  if (!grant)
    throw grantRequired(ctx.utility.manifest.id, "data", args.provider, args.kind);
  const dir = args.relPath.split("/")[0];
  if (dir !== args.kind) {
    throw new Error(
      `kb.scopedRead: relPath is not under the granted kind "${args.kind}"`,
    );
  }
  // readKbFile guards path traversal under .reflex/.
  const content = await readKbFile(targetRoot.path, args.relPath);
  const fm = matter(content).data as Record<string, unknown>;
  if (!ownedByProvider(fm.createdBy, args.provider)) {
    throw new Error(
      `kb.scopedRead: "${args.relPath}" is not owned by provider "${args.provider}"`,
    );
  }
  return { content };
}

async function capabilitiesListProviders(
  ctx: HostContext,
  args: z.infer<typeof ListProvidersSchema>,
): Promise<unknown[]> {
  ensureConsume(ctx);
  await syncProviderDirectory(ctx.utility.rootId);
  const filter =
    args.kind || args.verb
      ? {
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.verb ? { verb: args.verb } : {}),
        }
      : undefined;
  const entries = await listProviderEntries(filter);
  // Metadata only — never payloads.
  return entries.map((e) => ({
    provider: e.provider,
    version: e.version,
    scope: e.scope,
    data: e.data.map((d) => ({ kind: d.kind, ...(d.doc ? { doc: d.doc } : {}) })),
    capabilities: e.capabilities.map((c) => ({
      verb: c.verb,
      ...(c.doc ? { doc: c.doc } : {}),
      sideEffects: c.sideEffects,
      input: c.input,
      output: c.output,
    })),
  }));
}

async function capabilitiesInvoke(
  ctx: HostContext,
  args: z.infer<typeof CapabilitiesInvokeSchema>,
  correlationId: string,
): Promise<unknown> {
  ensureConsume(ctx);
  // Anti-confused-deputy: the consumer must have DECLARED the import.
  const declared = (ctx.utility.manifest.consumes?.capabilities ?? []).some(
    (c) => c.verb === args.verb && (!c.provider || c.provider === args.provider),
  );
  if (!declared) {
    throw new Error(
      `capabilities.invoke: "${args.verb}" from "${args.provider}" is not declared in manifest.consumes.capabilities`,
    );
  }
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const grant = await findGrant({
    consumer: ctx.utility.manifest.id,
    provider: args.provider,
    plane: "capability",
    selector: args.verb,
    scope: targetRoot.id,
  });
  if (!grant)
    throw grantRequired(
      ctx.utility.manifest.id,
      "capability",
      args.provider,
      args.verb,
    );
  await syncProviderDirectory(targetRoot.id);
  const found = await findProviderCapability(
    args.provider,
    args.verb,
    targetRoot.id,
  );
  if (!found) {
    throw new Error(
      `capabilities.invoke: provider "${args.provider}" does not export verb "${args.verb}"`,
    );
  }
  const providerUtil = await resolveUtility(args.provider, targetRoot.id);
  if (!providerUtil) {
    throw new Error(
      `capabilities.invoke: provider "${args.provider}" is not installed`,
    );
  }
  const action = providerUtil.manifest.serverActions.find(
    (a) => a.name === found.capability.action,
  );
  if (!action) {
    throw new Error(
      `capabilities.invoke: provider action "${found.capability.action}" not found in "${args.provider}"`,
    );
  }
  // Runs in the PROVIDER's sandbox (its dir/data/secrets) — runServerAction
  // keys identity off the passed utility. Dynamic import breaks the
  // host-api <-> worker-pool import cycle.
  const { runServerAction } = await import("./worker-pool");
  return runServerAction({
    utility: providerUtil,
    action,
    args: args.input,
    parentCorrelationId: correlationId,
  });
}

// ---------------------------------------------------------------------------
// fs.*  (sandboxed to <utility>/data/)

function resolveDataPath(
  ctx: HostContext,
  relPath: string,
): string {
  if (relPath.startsWith("/") || relPath.includes("..")) {
    throw new Error(`unsafe fs path: ${relPath}`);
  }
  const dataDir = path.join(ctx.utility.dir, "data");
  const abs = path.resolve(dataDir, relPath);
  const rel = path.relative(dataDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`fs path escapes data dir: ${relPath}`);
  }
  return abs;
}

async function fsRead(
  ctx: HostContext,
  args: z.infer<typeof FsArgSchema>,
): Promise<{ content: string }> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.fs?.sandbox,
    "fs not granted",
  );
  const abs = resolveDataPath(ctx, args.path);
  const content = await fs.readFile(abs, "utf8");
  return { content };
}

async function fsWrite(
  ctx: HostContext,
  args: z.infer<typeof FsArgSchema>,
): Promise<{ ok: true; bytes: number }> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.fs?.sandbox,
    "fs not granted",
  );
  if (typeof args.content !== "string") {
    throw new Error("fs.write requires content (string)");
  }
  const abs = resolveDataPath(ctx, args.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, args.content, "utf8");
  return { ok: true, bytes: Buffer.byteLength(args.content, "utf8") };
}

async function fsList(
  ctx: HostContext,
  args: z.infer<typeof FsArgSchema>,
): Promise<{ entries: Array<{ name: string; isDir: boolean }> }> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.fs?.sandbox,
    "fs not granted",
  );
  const abs = resolveDataPath(ctx, args.path || ".");
  try {
    const items = await fs.readdir(abs, { withFileTypes: true });
    return {
      entries: items.map((e) => ({ name: e.name, isDir: e.isDirectory() })),
    };
  } catch {
    return { entries: [] };
  }
}

// ---------------------------------------------------------------------------
// web.*

async function webFetch(
  ctx: HostContext,
  args: z.infer<typeof WebFetchSchema>,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const allowedDomains =
    ctx.utility.manifest.permissions.web?.fetch?.domains ?? [];
  let host: string;
  try {
    host = new URL(args.url).hostname;
  } catch {
    throw new Error(`invalid url: ${args.url}`);
  }
  const ok = allowedDomains.some(
    (d) => host === d || host.endsWith(`.${d}`),
  );
  if (!ok) {
    throw new Error(
      `web.fetch denied: domain "${host}" not in whitelist (${allowedDomains.join(", ")})`,
    );
  }
  const init: RequestInit = {
    method: args.method,
    ...(args.headers ? { headers: args.headers } : {}),
    signal: AbortSignal.timeout(20_000),
  };
  if (args.body !== undefined && args.method !== "GET") {
    init.body =
      typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }
  const res = await fetch(args.url, init);
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, body: text };
}

async function webSearch(
  ctx: HostContext,
  args: z.infer<typeof WebSearchSchema>,
): Promise<{ results: Array<{ title: string; url: string; snippet?: string }> }> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.web?.search,
    "web.search not granted",
  );
  const settings = await loadSettings();
  // Reuse the "quick" assignment but force WebSearch to be allowed for this call.
  const assignment: Assignment = {
    ...settings.assignments.quick,
    allowedTools: Array.from(
      new Set([...(settings.assignments.quick.allowedTools ?? []), "WebSearch"]),
    ),
  };
  const prompt = [
    "Use the WebSearch tool to find recent results for the query below.",
    "Return ONLY a JSON object on a single line with shape:",
    `  {"results":[{"title":"…","url":"…","snippet":"…"}]}`,
    "No prose, no markdown fences. Max 8 results.",
    "",
    `Query: ${args.query}`,
  ].join("\n");
  const text = await quickComplete(assignment, prompt, { timeoutMs: 60_000 });
  // Extract the first JSON object from the reply.
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return { results: [] };
  try {
    const parsed = JSON.parse(match[0]) as {
      results?: Array<{ title?: string; url?: string; snippet?: string }>;
    };
    const cleaned = (parsed.results ?? [])
      .filter((r) => typeof r.url === "string" && typeof r.title === "string")
      .map((r) => ({
        title: r.title as string,
        url: r.url as string,
        ...(r.snippet ? { snippet: r.snippet } : {}),
      }));
    return { results: cleaned };
  } catch {
    return { results: [] };
  }
}

// ---------------------------------------------------------------------------
// audit.log (free-form)

async function auditFreeform(
  ctx: HostContext,
  args: z.infer<typeof AuditLogSchema>,
  correlationId: string,
): Promise<{ ok: true }> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.audit?.write,
    "audit.write not granted",
  );
  await appendAudit({
    ts: new Date().toISOString(),
    utilityId: ctx.utility.manifest.id,
    scope: ctx.utility.scope,
    channel: ctx.channel,
    method: `app:${args.type}`,
    phase: "end",
    correlationId,
    args: args.payload,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// actions.invoke

async function actionsInvoke(
  ctx: HostContext,
  args: z.infer<typeof ActionInvokeSchema>,
  parentCorrelationId: string,
): Promise<unknown> {
  if (ctx.channel === "worker") {
    throw new Error(
      "actions.invoke can only be called from the UI iframe, not from inside a worker",
    );
  }
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.workers?.enabled,
    "workers.enabled not granted",
  );
  const action: ServerAction | undefined =
    ctx.utility.manifest.serverActions.find((a) => a.name === args.name);
  if (!action) {
    throw new Error(`unknown server action: ${args.name}`);
  }
  // Lazy import to avoid worker pool boot on read-only paths.
  const { runServerAction } = await import("./worker-pool");
  return runServerAction({
    utility: ctx.utility,
    action,
    args: args.args,
    parentCorrelationId,
  });
}

// ---------------------------------------------------------------------------
// agent.invoke — spawn ephemeral orchestrator, harvest its reply

async function agentInvoke(
  ctx: HostContext,
  args: z.infer<typeof AgentInvokeSchema>,
): Promise<{ text: string; topicId: string; timedOut: boolean }> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.agent?.invoke,
    "agent.invoke not granted",
  );
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const { runHeadlessAgent } = await import("@/lib/server/agents/headless");
  const result = await runHeadlessAgent({
    rootId: targetRoot.id,
    prompt: args.prompt,
    label:
      args.label ??
      `[utility ${ctx.utility.manifest.id}] agent.invoke`,
    ...(args.harness ? { harness: args.harness } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.language ? { language: args.language } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  });
  return result;
}

// ---------------------------------------------------------------------------
// workflow.* — list / read / run from inside a utility

async function workflowList(
  ctx: HostContext,
  args: z.infer<typeof WorkflowListSchema>,
): Promise<Array<{
  id: string;
  label: string;
  description?: string;
  trigger: string;
  stepCount: number;
  updatedAt: string;
}>> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.workflow?.read,
    "workflow.read not granted",
  );
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const { listWorkflows } = await import("@/lib/server/workflows/store");
  const items = await listWorkflows(targetRoot.path);
  return items.map((w) => ({
    id: w.id,
    label: w.label,
    ...(w.description ? { description: w.description } : {}),
    trigger: w.trigger,
    stepCount: w.steps.length,
    updatedAt: w.updatedAt,
  }));
}

async function workflowRead(
  ctx: HostContext,
  args: z.infer<typeof WorkflowReadSchema>,
): Promise<unknown> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.workflow?.read,
    "workflow.read not granted",
  );
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const { readWorkflow } = await import("@/lib/server/workflows/store");
  const wf = await readWorkflow(targetRoot.path, args.workflowId);
  if (!wf) {
    throw new Error(`workflow "${args.workflowId}" not found`);
  }
  return wf;
}

async function workflowRun(
  ctx: HostContext,
  args: z.infer<typeof WorkflowRunSchema>,
): Promise<unknown> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.workflow?.run,
    "workflow.run not granted",
  );
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const { runWorkflow } = await import("@/lib/server/workflows/runner");
  const res = await runWorkflow(targetRoot.id, args.workflowId, args.input);
  if (!res.ok) throw new Error(res.error);
  return res.run;
}

// ---------------------------------------------------------------------------
// cards.update — refresh the utility's dashboard preview

async function cardsUpdate(
  ctx: HostContext,
  args: z.infer<typeof CardsUpdateSchema>,
): Promise<{ ok: true; widgetId: string }> {
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const widgetId = args.widgetId ?? `utility:${ctx.utility.manifest.id}`;
  const { readWidget, writeWidget } = await import(
    "@/lib/server/widgets/store"
  );
  const existing = await readWidget(targetRoot.path, widgetId);
  const innerPayload = {
    kind: args.snapshot.kind,
    data: args.snapshot.data,
    ...(args.snapshot.title ? { title: args.snapshot.title } : {}),
    ...(args.snapshot.description
      ? { description: args.snapshot.description }
      : {}),
  };
  if (existing && existing.kind === "utility-card") {
    const existingData = existing.data as unknown as Record<string, unknown>;
    const next = {
      ...existing,
      data: {
        ...existingData,
        inner: innerPayload,
      },
      updatedAt: new Date().toISOString(),
    } as typeof existing;
    await writeWidget(targetRoot.path, next);
  } else {
    // No widget yet (e.g. user uninstalled then partial state) → bail out
    // gracefully rather than recreate it without manifest context.
    throw new Error(
      `cards.update: no utility-card widget for ${ctx.utility.manifest.id}`,
    );
  }
  return { ok: true, widgetId };
}

// ---------------------------------------------------------------------------
// images.* — generate / search / attach

async function imagesGenerate(
  ctx: HostContext,
  args: z.infer<typeof ImagesGenerateSchema>,
): Promise<{
  url: string;
  sha: string;
  size: number;
  mime: string;
  provider: "gemini" | "codex";
}> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.images?.generate,
    "images.generate not granted",
  );
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const { generateImage } = await import("@/lib/server/images/service");
  const res = await generateImage({
    rootId: targetRoot.id,
    prompt: args.prompt,
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.size ? { size: args.size } : {}),
    ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
    ...(args.referenceImageUrls
      ? { referenceImageUrls: args.referenceImageUrls }
      : {}),
    ...(args.alt ? { alt: args.alt } : {}),
  });
  return {
    url: res.urlPath,
    sha: res.sha,
    size: res.size,
    mime: res.mime,
    provider: res.provider,
  };
}

async function imagesSearch(
  ctx: HostContext,
  args: z.infer<typeof ImagesSearchSchema>,
): Promise<{
  results: Array<{
    url: string;
    thumb: string;
    attribution: { name: string; link: string };
    width?: number;
    height?: number;
    provider: "unsplash" | "pexels" | "brave";
  }>;
}> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.images?.search,
    "images.search not granted",
  );
  const { searchImages } = await import("@/lib/server/images/service");
  const hits = await searchImages({
    query: args.query,
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.count ? { count: args.count } : {}),
  });
  return { results: hits };
}

async function imagesAttach(
  ctx: HostContext,
  args: z.infer<typeof ImagesAttachSchema>,
): Promise<{ url: string; sha: string; size: number; mime: string }> {
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.images?.attach,
    "images.attach not granted",
  );
  // Trust boundary: if the utility also has `images.search` granted, it
  // can hand us URLs from any domain — search results come from arbitrary
  // pages on the web (Brave, Unsplash, Pexels). Without `search`, fall
  // back to the same domain whitelist as `web.fetch` so utilities that
  // only declare specific source URLs stay constrained.
  const hasSearch = !!ctx.utility.manifest.permissions.images?.search;
  if (!hasSearch) {
    const allowedDomains =
      ctx.utility.manifest.permissions.web?.fetch?.domains ?? [];
    let host: string;
    try {
      host = new URL(args.sourceUrl).hostname;
    } catch {
      throw new Error(`invalid sourceUrl: ${args.sourceUrl}`);
    }
    const ok = allowedDomains.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
    if (!ok) {
      throw new Error(
        `images.attach denied: domain "${host}" not in web.fetch whitelist (${allowedDomains.join(", ") || "(empty)"}). Grant images.search to allow arbitrary search-result URLs.`,
      );
    }
  } else {
    // Still validate URL shape so we surface a clear error early.
    try {
      new URL(args.sourceUrl);
    } catch {
      throw new Error(`invalid sourceUrl: ${args.sourceUrl}`);
    }
  }
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const { attachRemote } = await import("@/lib/server/images/service");
  const res = await attachRemote({
    rootId: targetRoot.id,
    sourceUrl: args.sourceUrl,
  });
  return {
    url: res.urlPath,
    sha: res.sha,
    size: res.size,
    mime: res.mime,
  };
}

async function imagesPickBest(
  ctx: HostContext,
  args: z.infer<typeof ImagesPickBestSchema>,
): Promise<{ pickIndex: number; reason: string; via: string }> {
  // Gated by `images.search` rather than its own permission flag — picking
  // is the second half of the search-then-attach flow, so anyone with
  // search already implicitly has the right to judge candidates.
  ensurePermission(
    ctx.utility.manifest,
    !!ctx.utility.manifest.permissions.images?.search,
    "images.pickBest requires images.search permission",
  );
  // The vision judge spawns a headless agent — it needs a real root for
  // scratch space and the agent context. Same fallback as kb/images.attach.
  const targetRoot = await resolveTargetRoot(ctx, args.rootId);
  const { pickBestImage } = await import("@/lib/server/images/judge");
  const res = await pickBestImage({
    rootId: targetRoot.id,
    query: args.query,
    alt: args.alt,
    context: args.context,
    candidates: args.candidates,
  });
  return { pickIndex: res.pickIndex, reason: res.reason, via: res.via };
}

// ---------------------------------------------------------------------------
// helpers

function ensurePermission(
  _manifest: Manifest,
  ok: boolean,
  message: string,
): void {
  if (!ok) throw new Error(`permission denied: ${message}`);
}

async function resolveTargetRoot(
  ctx: HostContext,
  rootId?: string,
): Promise<{ id: string; path: string }> {
  const id = rootId ?? ctx.utility.rootId;
  if (!id) {
    throw new Error(
      "no rootId available: project-scoped operation requires a project root",
    );
  }
  const entry = await getRoot(id);
  if (!entry) throw new Error(`unknown rootId: ${id}`);
  return { id: entry.id, path: entry.path };
}

let mermaidParseCache: ((src: string) => Promise<unknown>) | null = null;

/**
 * Validate a Mermaid diagram. Tries the real `mermaid` package's parser
 * first (covers all diagram types). Falls back to a regex pre-flight if
 * mermaid can't be loaded server-side (e.g. needs window) — that path
 * catches only the most common authoring mistakes but is better than
 * shipping a broken diagram to the UI.
 */
async function mermaidValidate(
  _ctx: HostContext,
  args: z.infer<typeof MermaidValidateSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const source = args.source.trim();
  if (!source) return { ok: false, error: "empty diagram" };

  // First the cheap regex pre-flight — flags issues the official parser
  // sometimes accepts on the happy path but the renderer rejects.
  const preflightErr = preflightMermaid(source);
  if (preflightErr) return { ok: false, error: preflightErr };

  // Then the real parser. Lazy-loaded + cached so repeat calls don't
  // pay the import cost.
  try {
    if (!mermaidParseCache) {
      const mod = (await import("mermaid")) as {
        default?: { parse?: (src: string) => Promise<unknown> };
        parse?: (src: string) => Promise<unknown>;
      };
      const parser = mod.default?.parse ?? mod.parse;
      if (typeof parser !== "function") {
        // Library can't be used here — accept after preflight.
        return { ok: true };
      }
      mermaidParseCache = parser.bind(mod.default ?? mod);
    }
    await mermaidParseCache(source);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function preflightMermaid(src: string): string | null {
  const lines = src.split("\n").map((l) => l.trim()).filter(Boolean);
  const head = lines[0] ?? "";
  // Quick header sanity — mermaid accepts many diagram types; just check
  // the first non-blank line starts with a known keyword.
  const KNOWN = [
    "graph",
    "flowchart",
    "sequenceDiagram",
    "classDiagram",
    "stateDiagram",
    "stateDiagram-v2",
    "erDiagram",
    "journey",
    "gantt",
    "pie",
    "gitGraph",
    "mindmap",
    "timeline",
    "quadrantChart",
    "requirementDiagram",
    "C4Context",
    "sankey-beta",
    "xychart-beta",
    "block-beta",
  ];
  if (!KNOWN.some((k) => head === k || head.startsWith(`${k} `))) {
    return `unrecognised diagram type at line 1: "${head.slice(0, 80)}"`;
  }
  // The killer in user-reported diagrams: unquoted labels containing
  // characters mermaid's lexer treats as syntax (slash in [/foo/] means
  // parallelogram, parens collide with circle shape, non-ASCII tokens
  // sometimes trip the lexer if not quoted). Quoting is always safe.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Match the shape `IDENT[content]` where content has special chars
    // and isn't already quoted.
    const m = /\b[A-Za-z0-9_]+\[([^\]]+)\]/.exec(line);
    if (!m) continue;
    const inner = m[1]!;
    if (inner.startsWith('"') && inner.endsWith('"')) continue;
    if (/^[\\/(>{]/.test(inner)) {
      return `line ${i + 1}: node label starts with a shape-modifier character ("${inner.slice(0, 30)}") — wrap the label in double quotes`;
    }
    if (/[()\\/{}|]/.test(inner)) {
      return `line ${i + 1}: node label contains special characters ("${inner.slice(0, 30)}") — wrap the label in double quotes`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tasks + git host methods

async function tasksCreate(
  ctx: HostContext,
  args: z.infer<typeof TaskCreateSchema>,
): Promise<{ id: string }> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { createTask } = await import("@/lib/server/tasks/store");
  const task = await createTask(rootPath, args);
  return { id: task.id };
}

async function tasksUpdate(
  ctx: HostContext,
  args: z.infer<typeof TaskUpdateSchema>,
): Promise<{ ok: boolean }> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { updateTask } = await import("@/lib/server/tasks/store");
  const updated = await updateTask(rootPath, args.id, args.patch);
  return { ok: !!updated };
}

async function tasksDelete(
  ctx: HostContext,
  args: z.infer<typeof TaskIdSchema>,
): Promise<{ ok: boolean }> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { deleteTask } = await import("@/lib/server/tasks/store");
  const ok = await deleteTask(rootPath, args.id);
  return { ok };
}

async function tasksGet(
  ctx: HostContext,
  args: z.infer<typeof TaskIdSchema>,
): Promise<unknown> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { getTask } = await import("@/lib/server/tasks/store");
  return getTask(rootPath, args.id);
}

async function tasksList(ctx: HostContext): Promise<{ tasks: unknown[] }> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { listTasks } = await import("@/lib/server/tasks/store");
  const tasks = await listTasks(rootPath);
  return { tasks };
}

async function tasksDispatch(
  ctx: HostContext,
  args: z.infer<typeof TaskDispatchSchema>,
): Promise<unknown> {
  const { id: rootId } = await resolveTargetRoot(ctx);
  const { dispatchTask } = await import("@/lib/server/tasks/dispatch");
  return dispatchTask({
    rootId,
    taskId: args.id,
    ...(args.harness ? { harness: args.harness } : {}),
    ...(args.model ? { model: args.model } : {}),
  });
}

async function tasksObserve(
  ctx: HostContext,
  args: z.infer<typeof TaskIdSchema>,
): Promise<unknown> {
  const { id: rootId } = await resolveTargetRoot(ctx);
  const { observeTask } = await import("@/lib/server/tasks/observe");
  return observeTask({ rootId, taskId: args.id });
}

async function tasksComplete(
  ctx: HostContext,
  args: z.infer<typeof TaskCompleteSchema>,
): Promise<{ ok: boolean }> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { updateTask } = await import("@/lib/server/tasks/store");
  const updated = await updateTask(rootPath, args.id, { status: args.outcome });
  return { ok: !!updated };
}

async function gitIsRepo(ctx: HostContext): Promise<{ ok: boolean }> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { isGitRepo } = await import("@/lib/server/tasks/worktree");
  return { ok: await isGitRepo(rootPath) };
}

async function gitHasRemote(ctx: HostContext): Promise<{ ok: boolean }> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { hasRemote } = await import("@/lib/server/tasks/worktree");
  return { ok: await hasRemote(rootPath) };
}

async function gitHasGhCli(): Promise<{ ok: boolean }> {
  const { hasGhCli } = await import("@/lib/server/tasks/worktree");
  return { ok: await hasGhCli() };
}

async function worktreeCreate(
  ctx: HostContext,
  args: z.infer<typeof WorktreeCreateSchema>,
): Promise<unknown> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { createWorktree } = await import("@/lib/server/tasks/worktree");
  return createWorktree({
    rootPath,
    slug: args.slug,
    branch: args.branch,
    ...(args.baseRef ? { baseRef: args.baseRef } : {}),
  });
}

async function worktreeMerge(
  ctx: HostContext,
  args: z.infer<typeof WorktreeMergeSchema>,
): Promise<unknown> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { mergeWorktree } = await import("@/lib/server/tasks/worktree");
  return mergeWorktree({
    rootPath,
    branch: args.branch,
    ...(args.intoRef ? { intoRef: args.intoRef } : {}),
  });
}

async function worktreeRemove(
  ctx: HostContext,
  args: z.infer<typeof WorktreeRemoveSchema>,
): Promise<unknown> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { removeWorktree } = await import("@/lib/server/tasks/worktree");
  return removeWorktree({
    rootPath,
    slug: args.slug,
    branch: args.branch,
    force: args.force,
    deleteBranch: args.deleteBranch,
  });
}

async function worktreeList(ctx: HostContext): Promise<unknown> {
  const { path: rootPath } = await resolveTargetRoot(ctx);
  const { listWorktrees } = await import("@/lib/server/tasks/worktree");
  return { worktrees: await listWorktrees(rootPath) };
}

async function sessionsSearch(
  ctx: HostContext,
  args: z.infer<typeof SessionsSearchSchema>,
): Promise<{ hits: unknown[] }> {
  if (!ctx.utility.manifest.permissions.sessions?.search) {
    throw new Error(
      `utility "${ctx.utility.manifest.id}" lacks permissions.sessions.search`,
    );
  }
  const opts: Parameters<typeof searchSessions>[1] = { limit: args.limit };
  if (args.rootId !== undefined) opts.rootId = args.rootId;
  if (args.source !== undefined) opts.source = args.source;
  if (args.since !== undefined) opts.since = args.since;
  if (args.until !== undefined) opts.until = args.until;
  const hits = await searchSessions(args.query, opts);
  return { hits };
}
