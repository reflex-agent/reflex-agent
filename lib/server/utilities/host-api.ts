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
import { auditCall, appendAudit } from "./audit";
import { utilityFile } from "./store";
import { quickComplete } from "@/lib/server/quick";
import { writeKbEntry } from "@/lib/server/agents/kb-writer";
import { listKbFiles, readKbFile } from "@/lib/server/kb";
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
    ]),
    title: z.string().optional(),
    description: z.string().optional(),
    data: z.record(z.string(), z.unknown()).default({}),
  }),
  rootId: z.string().optional(),
});

const HOSTS_NEEDING_LLM = new Set<TaskId>(["chat", "quick", "rag", "embed"]);

export async function dispatchHostCall(
  ctx: HostContext,
  method: string,
  rawArgs: unknown,
): Promise<unknown> {
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
    switch (method) {
      case "llm.complete":
        return llmComplete(ctx, LlmCompleteSchema.parse(rawArgs));
      case "kb.add":
        return kbAdd(ctx, KbAddSchema.parse(rawArgs));
      case "kb.list":
        return kbList(ctx, KbListSchema.parse(rawArgs));
      case "kb.read":
        return kbRead(ctx, KbReadSchema.parse(rawArgs));
      case "fs.read":
        return fsRead(ctx, FsArgSchema.parse(rawArgs));
      case "fs.write":
        return fsWrite(ctx, FsArgSchema.parse(rawArgs));
      case "fs.list":
        return fsList(ctx, FsArgSchema.parse(rawArgs));
      case "web.fetch":
        return webFetch(ctx, WebFetchSchema.parse(rawArgs));
      case "web.search":
        return webSearch(ctx, WebSearchSchema.parse(rawArgs));
      case "audit.log":
        return auditFreeform(ctx, AuditLogSchema.parse(rawArgs), correlationId);
      case "actions.invoke":
        return actionsInvoke(ctx, ActionInvokeSchema.parse(rawArgs), correlationId);
      case "mcp.call":
        return mcpCall(ctx, McpCallSchema.parse(rawArgs));
      case "mcp.listServers":
        return mcpListServers(ctx);
      case "mcp.listTools":
        return mcpListTools(ctx, McpListToolsSchema.parse(rawArgs));
      case "secrets.get":
        return secretsGet(ctx, SecretsGetSchema.parse(rawArgs));
      case "secrets.list":
        return secretsList(ctx);
      case "agent.invoke":
        return agentInvoke(ctx, AgentInvokeSchema.parse(rawArgs));
      case "workflow.list":
        return workflowList(ctx, WorkflowListSchema.parse(rawArgs));
      case "workflow.read":
        return workflowRead(ctx, WorkflowReadSchema.parse(rawArgs));
      case "workflow.run":
        return workflowRun(ctx, WorkflowRunSchema.parse(rawArgs));
      case "cards.update":
        return cardsUpdate(ctx, CardsUpdateSchema.parse(rawArgs));
      case "images.generate":
        return imagesGenerate(ctx, ImagesGenerateSchema.parse(rawArgs));
      case "images.search":
        return imagesSearch(ctx, ImagesSearchSchema.parse(rawArgs));
      case "images.attach":
        return imagesAttach(ctx, ImagesAttachSchema.parse(rawArgs));
      case "images.pickBest":
        return imagesPickBest(ctx, ImagesPickBestSchema.parse(rawArgs));
      case "mermaid.validate":
        return mermaidValidate(ctx, MermaidValidateSchema.parse(rawArgs));
      default:
        throw new Error(`Unknown host method: ${method}`);
    }
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
