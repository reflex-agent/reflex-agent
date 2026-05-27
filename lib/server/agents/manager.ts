import "server-only";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { appendEvent, nextSeq } from "./events-log";
import type {
  AgentEvent,
  AgentHarnessId,
  AgentMeta,
  AgentRole,
  AgentStatus,
} from "./types";
import type { TaskId } from "@/lib/settings";
import { runClaudeCode } from "./runtime/claude-code";
import { runCodex } from "./runtime/codex";
import { runOllama } from "./runtime/ollama";
import { runImageGen } from "./runtime/image-gen";
import {
  extractDispatches,
  extractImageGens,
  extractKbEntries,
  extractMcpAdds,
  extractMemoryWrites,
  extractPermissions,
  extractQuestions,
  extractSkillCreates,
  extractSuggestions,
  hasOnboardingDone,
  extractUtilityDirectives,
  extractWidgetCreates,
  extractWidgetUpdates,
  extractWorkflowCreates,
  extractYoutubeSummaries,
  type DispatchDirective,
  type McpAddDirective,
  type MemoryDirective,
  type SuggestionDirective,
  type WidgetDirective,
  type WorkflowDirective,
  type YoutubeSummaryDirective,
} from "./protocol";
import { writeMemory } from "@/lib/server/memory/store";
import {
  isMemoryFile,
  isMemoryOp,
  isMemoryScope,
} from "@/lib/server/memory/types";
import {
  addSuggestion,
  SUGGESTION_KINDS,
} from "@/lib/server/suggestions/store";
import { writeSkill } from "@/lib/server/skills";
import { generateImage } from "@/lib/server/images/service";
import {
  buildRecord as buildWidgetRecord,
  readLayout,
  readWidget,
  writeLayout,
  writeWidget,
} from "@/lib/server/widgets/store";
import type { WidgetData } from "@/lib/server/widgets/types";
import {
  writeWorkflow,
  sanitizeId as sanitizeWorkflowId,
} from "@/lib/server/workflows/store";
import { validateWorkflowDef } from "@/lib/server/workflows/runner";
import type {
  WorkflowDef,
  WorkflowStepKind,
} from "@/lib/server/workflows/types";
import { readEvents } from "./events-log";
import { writeKbEntry } from "./kb-writer";
import {
  diffKb,
  reindexNewFiles,
  snapshotKb,
  type KbSnapshot,
} from "./kb-reindex";
import {
  savePendingMcpAdd,
  takePendingMcpAdd,
} from "./pending-mcp-adds";
import { ManifestSchema } from "@/lib/server/utilities/types";
import { installUtility } from "@/lib/server/utilities/store";
import type { buildUtility as BuildUtilityFn } from "@/lib/server/utilities/build";
import { loadSettings, saveSettings } from "@/lib/settings/store";
import {
  bumpGoalIterations,
  clearTopicGoal,
  getTopic,
} from "@/lib/server/topics";
import { MAX_GOAL_ITERATIONS } from "./slash-commands";
import {
  SUB_AGENT_ROLES,
  isSubAgentRole,
  type SubAgentRoleId,
} from "./sub-roles";

/**
 * Singleton lifecycle manager for all agents in the process. Lives on
 * `globalThis` so dev-mode HMR doesn't orphan running subprocesses.
 *
 * Lifecycle model
 * ---------------
 *   ensureAgent({topic, role})  →  AgentMeta  (one per (topicId, role))
 *   invoke(agentId, ...)        →  spawns a single "turn" under that agent
 *   destroy(agentId)            →  terminal `agent-end`
 *
 * A topic's orchestrator agent is created once and reused across every
 * subsequent user message. Each turn is delimited by `turn-start` /
 * `turn-end` events; the agent's `status` flips between `idle` and `running`.
 */

export interface EnsureAgentArgs {
  topicId: string;
  rootId: string;
  rootPath: string;
  reflexScope: string;
  role: AgentRole;
  task: TaskId;
  harness: AgentHarnessId;
  model: string;
  language: string;
  label: string;
  parentId?: string;
}

export interface InvokeArgs {
  agentId: string;
  /** System prompt for this turn (often constant across turns). */
  systemPrompt: string;
  /** Full prompt body (e.g. transcript + new user message). */
  prompt: string;
  /** Persisted as a user-message event at the start of the turn. */
  userMessage?: string;
  /** Tools the runtime is allowed to invoke without prompting. */
  allowedTools?: string[];
}

interface AgentRuntimeState {
  meta: AgentMeta;
  rootPath: string;
  reflexScope: string;
}

class AgentManager {
  private agents = new Map<string, AgentRuntimeState>();
  /** topicId → role → agentId. Used to dedupe `ensureAgent` calls. */
  private byTopicRole = new Map<string, Map<AgentRole, string>>();
  private emitter = new EventEmitter();
  /** Per-agent buffer of assistant text for the current turn; scanned for
   *  protocol markers at turn-end. */
  private turnText = new Map<string, string>();
  /** Per-agent system prompt cached from the last invoke — reused when
   *  responding to a permission/question creates a continuation turn. */
  private lastInvoke = new Map<
    string,
    { systemPrompt: string; rootPath: string }
  >();
  /** Pending `<<reflex:mcp-add>>` proposals awaiting user approval. */
  private pendingMcpAdds = new Map<
    string,
    { agentId: string; directive: McpAddDirective }
  >();

  // ---------------------------------------------------------------------
  // creation
  // ---------------------------------------------------------------------

  async ensureAgent(args: EnsureAgentArgs): Promise<AgentMeta> {
    const existingId = this.byTopicRole.get(args.topicId)?.get(args.role);
    if (existingId) {
      const existing = this.agents.get(existingId);
      if (existing) return { ...existing.meta };
    }
    return this.createAgent(args);
  }

  private async createAgent(args: EnsureAgentArgs): Promise<AgentMeta> {
    const id = shortId();
    const meta: AgentMeta = {
      id,
      topicId: args.topicId,
      rootId: args.rootId,
      role: args.role,
      task: args.task,
      harness: args.harness,
      model: args.model,
      label: args.label,
      status: "idle",
      startedAt: now(),
      ...(args.parentId ? { parentId: args.parentId } : {}),
    };
    this.agents.set(id, {
      meta,
      rootPath: args.rootPath,
      reflexScope: args.reflexScope,
    });
    let roleMap = this.byTopicRole.get(args.topicId);
    if (!roleMap) {
      roleMap = new Map();
      this.byTopicRole.set(args.topicId, roleMap);
    }
    roleMap.set(args.role, id);
    await this.emit({
      type: "agent-start",
      meta,
      agentId: id,
      ts: meta.startedAt,
      seq: 0,
    });
    return meta;
  }

  // ---------------------------------------------------------------------
  // turns
  // ---------------------------------------------------------------------

  /** Run a single turn under an existing agent. Fire-and-forget. */
  async invoke(args: InvokeArgs): Promise<void> {
    const state = this.agents.get(args.agentId);
    if (!state) throw new Error(`Agent not found: ${args.agentId}`);
    if (state.meta.status === "running") {
      throw new Error(`Agent ${args.agentId} is already running`);
    }
    state.meta.status = "running";
    this.lastInvoke.set(args.agentId, {
      systemPrompt: args.systemPrompt,
      rootPath: state.rootPath,
    });
    this.turnText.set(args.agentId, "");
    const turnId = shortId();
    // Emit the user message first so the projector renders it above the
    // assistant block. `turn-start` then opens the assistant's response.
    if (args.userMessage) {
      await this.emit({
        type: "user-message",
        text: args.userMessage,
        agentId: args.agentId,
        ts: now(),
        seq: 0,
      });
    }
    await this.emit({
      type: "turn-start",
      turnId,
      agentId: args.agentId,
      ts: now(),
      seq: 0,
    });
    // Snapshot the KB before the agent runs so we can diff at turn-end and
    // auto-index any files the agent created via the Write tool (i.e. not
    // through the <<reflex:kb>> directive).
    let kbBefore: KbSnapshot | null = null;
    try {
      kbBefore = await snapshotKb(state.rootPath);
    } catch {
      // best-effort; an unreadable root just disables auto-index for the turn
    }
    try {
      const rtCtx = {
        meta: { id: state.meta.id },
        args: {
          rootPath: state.rootPath,
          reflexScope: state.reflexScope,
          systemPrompt: args.systemPrompt,
          prompt: args.prompt,
          model: state.meta.model,
          allowedTools: args.allowedTools ?? [],
        },
        manager: this,
      };
      if (state.meta.harness === "claude-code") {
        await runClaudeCode(rtCtx);
      } else if (state.meta.harness === "codex") {
        await runCodex(rtCtx);
      } else if (state.meta.harness === "ollama") {
        await runOllama(rtCtx);
      } else if (state.meta.harness === "image-gen") {
        await runImageGen({
          meta: rtCtx.meta,
          args: { rootPath: rtCtx.args.rootPath, prompt: rtCtx.args.prompt },
          manager: rtCtx.manager,
        });
      } else {
        throw new Error(`Unsupported harness: ${String(state.meta.harness)}`);
      }
      // Inline image generation: scan the turn text for `<<reflex:image-gen>>`
      // markers and emit `assistant-delta` events with markdown image refs
      // BEFORE turn-end, so the image appears inside the current assistant
      // bubble (not as a separate bubble below).
      await this.applyImageGenDirectives(args.agentId);
      // Decide whether /goal mode requires another automatic turn.
      // Reads `turnText` (still populated) and inspects it for
      // GOAL ACHIEVED / pending-human markers — directive *emission* is
      // deferred until after `status=idle` to avoid a race where the user
      // clicks an answer/permission button before this method returns.
      const goalContinuation = await this.evaluateGoalContinuation(
        args.agentId,
      );
      state.meta.status = "idle";
      await this.emit({
        type: "turn-end",
        turnId,
        status: "completed",
        agentId: args.agentId,
        ts: now(),
        seq: 0,
      });
      // Now that status is "idle" and turn-end is flushed, surface the
      // protocol markers (permission/question/kb). `respondQuestion` &
      // friends therefore see an idle agent and accept the answer
      // immediately.
      const { writtenViaKb, dispatches, youtubeSummaries } =
        await this.detectInteractionDirectives(args.agentId);
      // Auto-index any KB files the agent created via Write (outside the
      // <<reflex:kb>> protocol). Skip files that just emitted their own
      // kb-write event via the directive path to avoid duplicates. Touches
      // parent INDEX.md and emits kb-write events so the sidebar refreshes.
      if (kbBefore) {
        await this.reindexAfterTurn(args.agentId, kbBefore, writtenViaKb);
      }
      // Specialist dispatch: orchestrator handed off work via
      // <<reflex:dispatch>>. Spawn sub-agents concurrently, await their
      // turn-ends, then re-invoke the orchestrator with their results. The
      // /goal continuation logic is suppressed for this turn — the dispatch
      // flow itself drives the next turn.
      if (dispatches.length > 0 && state.meta.role === "orchestrator") {
        // Run async — don't block the current invoke's finally cleanup.
        void this.dispatchSubAgents(args.agentId, dispatches).catch((err) => {
          void this.emit({
            type: "error",
            message:
              "sub-agent dispatch failed: " +
              (err instanceof Error ? err.message : String(err)),
            agentId: args.agentId,
            ts: now(),
            seq: 0,
          });
        });
      } else if (
        youtubeSummaries.length > 0 &&
        state.meta.role === "orchestrator"
      ) {
        void this.runYoutubeSummaries(args.agentId, youtubeSummaries).catch(
          (err) => {
            void this.emit({
              type: "error",
              message:
                "youtube-summary failed: " +
                (err instanceof Error ? err.message : String(err)),
              agentId: args.agentId,
              ts: now(),
              seq: 0,
            });
          },
        );
      } else if (goalContinuation) {
        // Schedule next turn after a brief microtask so this turn-end is
        // flushed first. continueTurn rebuilds the prompt from the latest
        // transcript (which now includes our just-finished turn).
        setTimeout(() => {
          void this.continueTurn(
            args.agentId,
            `[Reflex /goal] Continue execution. Active goal: ${goalContinuation.goal}. Iteration ${goalContinuation.iteration}/${MAX_GOAL_ITERATIONS}. If the task is done AND verified, finish with the marker \`GOAL ACHIEVED\` and a kb-entry kind:"goal-completion".`,
          );
        }, 50);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.meta.status = "idle";
      state.meta.error = message;
      await this.emit({
        type: "error",
        message,
        agentId: args.agentId,
        ts: now(),
        seq: 0,
      });
      await this.emit({
        type: "turn-end",
        turnId,
        status: "failed",
        error: message,
        agentId: args.agentId,
        ts: now(),
        seq: 0,
      });
    } finally {
      this.turnText.delete(args.agentId);
    }
  }

  /**
   * Append a user decision to the topic and start a continuation turn so the
   * agent can keep going. Used by both permission and question responses.
   * Returns the synthesized continuation message for callers that want to
   * display it.
   */
  async respondPermission(
    agentId: string,
    args: {
      requestId: string;
      decision: "allow" | "deny";
      scope?: "once" | "always";
      tool?: string;
    },
  ): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) throw new Error("Agent not found");
    // Note: do NOT bail when status === "running". The harness can emit
    // multiple permission-request cards inside a single turn (each blocked
    // tool call ⇒ new card); the user must be able to answer them while
    // the agent is still mid-stream. We still gate `continueTurn` below
    // on idle — running agents don't need an explicit continuation.
    const wasRunning = state.meta.status === "running";
    // Look up the original request to determine its action context.
    let originalAction: string | undefined;
    try {
      const events = await readEvents(state.rootPath, state.meta.topicId);
      const req = events.find(
        (e): e is Extract<AgentEvent, { type: "permission-request" }> =>
          e.type === "permission-request" && e.requestId === args.requestId,
      );
      originalAction = req?.action;
    } catch {
      // ignore — still proceed with the response
    }
    await this.emit({
      type: "permission-response",
      requestId: args.requestId,
      decision: args.decision,
      ...(args.scope ? { scope: args.scope } : {}),
      agentId,
      ts: now(),
      seq: 0,
    });
    let toolPolicyNote = "";
    if (
      originalAction === "tool-policy" &&
      args.decision === "allow" &&
      args.tool
    ) {
      try {
        const settings = await loadSettings();
        const taskKey = state.meta.task;
        const assignment = settings.assignments[taskKey];
        if (assignment && !assignment.allowedTools.includes(args.tool)) {
          assignment.allowedTools = [...assignment.allowedTools, args.tool];
          await saveSettings(settings);
          toolPolicyNote = ` Tool ${args.tool} added to settings.assignments.${taskKey}.allowedTools.`;
        }
      } catch (err) {
        await this.emit({
          type: "error",
          message:
            "Failed to save allowed tool: " +
            (err instanceof Error ? err.message : String(err)),
          agentId,
          ts: now(),
          seq: 0,
        });
      }
    }
    const userMessage = `[Reflex] Permission for ${args.tool ?? "action"} (${args.requestId}): ${args.decision}${
      args.scope ? ` (${args.scope})` : ""
    }.${toolPolicyNote} Continue.`;
    // Only schedule a continuation turn if the agent is idle. If it was
    // already running, the current turn drives itself to completion and
    // a `continueTurn` call would race the in-flight invoke.
    if (!wasRunning) {
      await this.continueTurn(agentId, userMessage);
    }
  }

  async respondQuestion(
    agentId: string,
    args: { questionId: string; answer: string },
  ): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) throw new Error("Agent not found");
    const wasRunning = state.meta.status === "running";
    await this.emit({
      type: "answer",
      questionId: args.questionId,
      answer: args.answer,
      agentId,
      ts: now(),
      seq: 0,
    });
    const userMessage = `[Reflex] Answer for question ${args.questionId}: ${args.answer}. Continue.`;
    if (!wasRunning) {
      await this.continueTurn(agentId, userMessage);
    }
  }

  /**
   * Handle the user's decision on a `<<reflex:mcp-add>>` request. On
   * approve, secret values from the form are merged into the proposed
   * config (env for stdio, headers for http/sse), the result is saved into
   * the global MCP registry, and the agent gets re-invoked with the
   * registration outcome.
   */
  async respondMcpAdd(
    agentId: string,
    args: {
      requestId: string;
      decision: "approve" | "reject";
      secretValues?: Record<string, string>;
    },
  ): Promise<void> {
    const state = this.agents.get(agentId);
    const wasRunning = !!(state && state.meta.status === "running");

    // Pending lookup: prefer the live in-memory map (cheap), fall back to
    // the disk-backed copy so we still work after HMR / dev restart.
    let directive: McpAddDirective | null = null;
    let topicId: string | null = state?.meta.topicId ?? null;
    let rootPath: string | null = state?.rootPath ?? null;
    const inMem = this.pendingMcpAdds.get(args.requestId);
    if (inMem && inMem.agentId === agentId) {
      directive = inMem.directive;
      this.pendingMcpAdds.delete(args.requestId);
    } else {
      const persisted = await takePendingMcpAdd(args.requestId);
      if (persisted) {
        directive = persisted.directive;
        topicId = topicId ?? persisted.topicId;
        rootPath = rootPath ?? persisted.rootPath;
      }
    }
    if (!directive) {
      throw new Error(`Unknown mcp-add request: ${args.requestId}`);
    }

    // Wraps `emit` (which silently no-ops for unknown agents) so we still
    // get an event into events.jsonl for the response card to flip out of
    // "pending", even if the originating agent has since been destroyed.
    const writeEvent = async (event: AgentEvent): Promise<void> => {
      if (state) {
        await this.emit(event);
        return;
      }
      if (topicId && rootPath) {
        const seq = await nextSeq(rootPath, topicId);
        await appendEvent(rootPath, topicId, { ...event, seq });
      }
    };

    let userMessage: string;
    if (args.decision === "reject") {
      await writeEvent({
        type: "mcp-add-response",
        requestId: args.requestId,
        decision: "reject",
        agentId,
        ts: now(),
        seq: 0,
      });
      userMessage = `[Reflex] User rejected adding MCP server "${directive.server}". Don't re-propose the same server — either pick a different approach or ask the user what they prefer.`;
      if (state && !wasRunning) await this.continueTurn(agentId, userMessage);
      return;
    }

    // Merge user-supplied secret values into the proposed config.
    try {
      const merged = await mergeSecretsIntoConfig(
        directive.config,
        directive.secrets ?? [],
        args.secretValues ?? {},
      );
      const { McpConfigSchema } = await import("@/lib/server/utilities/mcp");
      const config = McpConfigSchema.parse(merged);
      const { addMcpServer, updateMcpServer, getMcpServer } = await import(
        "@/lib/server/mcp-registry"
      );
      const existing = await getMcpServer(directive.server);
      if (existing) {
        await updateMcpServer(directive.server, {
          label: directive.label,
          ...(directive.description !== undefined
            ? { description: directive.description }
            : {}),
          config,
        });
      } else {
        await addMcpServer({
          id: directive.server,
          label: directive.label,
          ...(directive.description !== undefined
            ? { description: directive.description }
            : {}),
          config,
        });
      }
      await writeEvent({
        type: "mcp-add-response",
        requestId: args.requestId,
        decision: "approve",
        server: directive.server,
        agentId,
        ts: now(),
        seq: 0,
      });
      userMessage = `[Reflex] MCP server "${directive.server}" registered. You can now call its tools via \`mcp__${directive.server}__<tool>\` (chat) or \`reflex.mcp.call({server:"${directive.server}",tool,args})\` (from a utility that declared it in manifest.mcpServers). Continue.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await writeEvent({
        type: "error",
        message: "mcp-add failed: " + msg,
        agentId,
        ts: now(),
        seq: 0,
      });
      await writeEvent({
        type: "mcp-add-response",
        requestId: args.requestId,
        decision: "reject",
        agentId,
        ts: now(),
        seq: 0,
      });
      userMessage = `[Reflex] Failed to register MCP server "${directive.server}": ${msg}. Don't retry the exact same config; either fix the issue or ask the user.`;
    }
    // Only re-invoke the agent if it's still alive AND idle. If it's
    // mid-turn, the user-message will be lost — we trust the current
    // turn to drive itself to completion. After restart we just save to
    // the registry and trust the user to message the topic again.
    if (state && !wasRunning) await this.continueTurn(agentId, userMessage);
  }

  /** Re-invoke the agent with a synthesized user message and the prior
   *  transcript already in events.jsonl. Settings (incl. allowedTools) are
   *  re-read so newly-granted tools take effect on the very next turn. */
  private async continueTurn(
    agentId: string,
    userMessage: string,
  ): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) return;
    const last = this.lastInvoke.get(agentId);
    if (!last) {
      await this.emit({
        type: "error",
        message:
          "Cannot continue turn: no cached system prompt. Send another message manually.",
        agentId,
        ts: now(),
        seq: 0,
      });
      return;
    }
    let allowedTools: string[] = [];
    try {
      const settings = await loadSettings();
      allowedTools = settings.assignments[state.meta.task]?.allowedTools ?? [];
    } catch {
      // fall through with empty list — runtime will use its built-in defaults
    }
    const transcript = await buildTranscript(last.rootPath, state.meta.topicId);
    const prompt = `Prior conversation:\n\n${transcript}\n\n### user\n${userMessage}\n\n### assistant\n(Reply now.)`;
    void this.invoke({
      agentId,
      systemPrompt: last.systemPrompt,
      prompt,
      userMessage,
      allowedTools,
    }).catch(() => {
      // emit("error") already recorded by invoke; swallow
    });
  }

  /**
   * If the topic has an active /goal, decide whether to fire another turn:
   *   - Agent emitted `GOAL ACHIEVED` (case-insensitive on its own line) or a
   *     `goal-completion` KB write → mark goal completed, stop.
   *   - User has open permission/question requests → pause, let them respond.
   *   - Otherwise → bump iteration; if over the cap, abandon; else continue.
   */
  private async evaluateGoalContinuation(
    agentId: string,
  ): Promise<{ goal: string; iteration: number } | null> {
    const state = this.agents.get(agentId);
    if (!state) return null;
    // Sub-agents don't own the topic-level goal; only the orchestrator drives
    // /goal continuation.
    if (state.meta.role !== "orchestrator") return null;
    let topic;
    try {
      topic = await getTopic(state.rootPath, state.meta.topicId);
    } catch {
      return null;
    }
    if (!topic) return null;
    const meta = topic.meta;
    if (!meta.goal || meta.goalStatus !== "active") return null;

    const buf = this.turnText.get(agentId) ?? "";
    const achieved =
      /(^|\n)\s*GOAL ACHIEVED\s*(\n|$)/i.test(buf) ||
      /<<reflex:kb>>[\s\S]*?"kind"\s*:\s*"goal-completion"[\s\S]*?<<\/reflex:kb>>/i.test(
        buf,
      );
    if (achieved) {
      try {
        await clearTopicGoal(state.rootPath, state.meta.topicId, "completed");
      } catch {
        // ignore — manager doesn't have a UX channel for fs errors here
      }
      return null;
    }

    // If the agent is awaiting human input via question/permission, do NOT
    // auto-continue; that's the user's turn.
    const awaitingHuman =
      /<<reflex:(?:question|permission)>>[\s\S]*?<<\/reflex:(?:question|permission)>>/i.test(
        buf,
      );
    if (awaitingHuman) return null;

    try {
      const next = await bumpGoalIterations(
        state.rootPath,
        state.meta.topicId,
      );
      if (next > MAX_GOAL_ITERATIONS) {
        await clearTopicGoal(
          state.rootPath,
          state.meta.topicId,
          "abandoned",
        );
        await this.emit({
          type: "error",
          message: `Goal iteration cap reached (${MAX_GOAL_ITERATIONS}). Goal marked as abandoned — clear or restart via /goal to keep trying.`,
          agentId,
          ts: now(),
          seq: 0,
        });
        return null;
      }
      return { goal: meta.goal, iteration: next };
    } catch {
      return null;
    }
  }

  /**
   * Diff the KB against the pre-turn snapshot and index anything new.
   * Surfaces each new file as a `kb-write` event so the UI's sidebar and
   * file list refresh in real-time (the same channel <<reflex:kb>> uses).
   */
  private async reindexAfterTurn(
    agentId: string,
    before: KbSnapshot,
    skip: Set<string> = new Set(),
  ): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) return;
    try {
      const diffed = await diffKb(state.rootPath, before);
      const newFiles = diffed.filter((f) => !skip.has(f.abs));
      if (newFiles.length === 0) return;
      await reindexNewFiles(state.rootPath, newFiles);
      for (const f of newFiles) {
        await this.emit({
          type: "kb-write",
          kind: f.kind ?? "note",
          title: f.title ?? f.rel,
          relPath: f.rel,
          absPath: f.abs,
          agentId,
          ts: now(),
          seq: 0,
        });
      }
    } catch (err) {
      await this.emit({
        type: "error",
        message:
          "kb auto-index failed: " +
          (err instanceof Error ? err.message : String(err)),
        agentId,
        ts: now(),
        seq: 0,
      });
    }
  }

  /**
   * Spawn one specialist per dispatch directive, run them concurrently,
   * collect their assistant text, then re-invoke the orchestrator with a
   * synthesized "user" message that quotes each result. Sub-agents are
   * created off-the-books (not in `byTopicRole` — multiple of the same role
   * can coexist) and destroyed once their turn ends.
   */
  private async dispatchSubAgents(
    orchestratorAgentId: string,
    dispatches: DispatchDirective[],
  ): Promise<void> {
    const parent = this.agents.get(orchestratorAgentId);
    if (!parent) return;
    const settings = await loadSettings();
    // Sub-agents share the orchestrator's harness/model by default —
    // predictable for plain dispatches. The directive can override
    // per-call (e.g. {harness:"codex"} for code-heavy specialists).
    const defaultHarness = parent.meta.harness;
    const defaultModel = parent.meta.model;
    const language = settings.language;

    interface DispatchResult {
      role: SubAgentRoleId;
      id: string;
      brief: string;
      output: string;
      error?: string;
    }

    const runs = await Promise.all(
      dispatches.map(async (d): Promise<DispatchResult> => {
        const roleId = d.role as SubAgentRoleId;
        const role = SUB_AGENT_ROLES[roleId]!;
        const subId = shortId();
        // Validate the requested harness against the registered set; an
        // invalid value silently falls back to the parent's harness so
        // a typo in the directive doesn't blow up the whole dispatch.
        const harness =
          d.harness && isKnownHarness(d.harness)
            ? (d.harness as AgentHarnessId)
            : defaultHarness;
        const model = typeof d.model === "string" && d.model.length > 0
          ? d.model
          : defaultModel;
        const subMeta: AgentMeta = {
          id: subId,
          topicId: parent.meta.topicId,
          rootId: parent.meta.rootId,
          role: "subagent",
          task: parent.meta.task,
          harness,
          model,
          label: role.label,
          status: "idle",
          startedAt: now(),
          parentId: orchestratorAgentId,
        };
        this.agents.set(subId, {
          meta: subMeta,
          rootPath: parent.rootPath,
          reflexScope: parent.reflexScope,
        });
        await this.emit({
          type: "agent-start",
          meta: subMeta,
          agentId: subId,
          ts: now(),
          seq: 0,
        });
        const systemPrompt = role.systemPrompt({
          language,
          root: parent.rootPath,
          reflexScope: parent.reflexScope,
          brief: d.brief,
        });
        const userMessage = d.brief;
        const prompt = `${userMessage}\n\n### assistant\n(Reply now.)`;
        try {
          await this.invoke({
            agentId: subId,
            systemPrompt,
            prompt,
            userMessage,
            allowedTools: role.allowedTools,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.emit({
            type: "error",
            message: `sub-agent (${roleId}) failed: ${msg}`,
            agentId: subId,
            ts: now(),
            seq: 0,
          });
          await this.destroy(subId, "failed");
          return {
            role: roleId,
            id: d.id ?? subId,
            brief: d.brief,
            output: "",
            error: msg,
          };
        }
        const output = (this.turnText.get(subId) ?? "").trim();
        await this.destroy(subId, "completed");
        return { role: roleId, id: d.id ?? subId, brief: d.brief, output };
      }),
    );

    // Compose the synthesized user message the orchestrator sees on its
    // continuation turn. Quote each sub-agent's output verbatim so the
    // orchestrator can pick what to surface to the actual user.
    const blocks = runs.map((r) => {
      const heading = `### sub-agent: ${r.role}${r.id ? ` [${r.id}]` : ""}`;
      const briefLine = `**Brief:** ${r.brief.replace(/\n+/g, " ").trim()}`;
      const body = r.error
        ? `_failed_ — ${r.error}`
        : r.output.length > 0
          ? r.output
          : "_(no output)_";
      return [heading, briefLine, "", body].join("\n");
    });
    const synthesized = [
      "[Reflex] Sub-agent results follow. Use them to compose the user-facing reply. Do NOT re-dispatch the same brief; if a result is empty or insufficient, either solve it yourself or ask the user.",
      "",
      ...blocks,
    ].join("\n\n");
    await this.continueTurn(orchestratorAgentId, synthesized);
  }

  /**
   * Scan the accumulated assistant text for protocol markers. Returns:
   *   - `writtenViaKb`: abs-paths written via `<<reflex:kb>>` (so the reindex
   *     pass can skip them).
   *   - `dispatches`: any `<<reflex:dispatch>>` directives — the manager
   *     will spawn specialists and re-invoke the orchestrator with their
   *     synthesized results.
   */
  private async detectInteractionDirectives(
    agentId: string,
  ): Promise<{
    writtenViaKb: Set<string>;
    dispatches: DispatchDirective[];
    youtubeSummaries: YoutubeSummaryDirective[];
  }> {
    const writtenViaKb = new Set<string>();
    const buf = this.turnText.get(agentId) ?? "";
    if (!buf) return { writtenViaKb, dispatches: [], youtubeSummaries: [] };
    const state = this.agents.get(agentId);
    const perms = extractPermissions(buf);
    for (const p of perms) {
      await this.emit({
        type: "permission-request",
        requestId: p.id ?? shortId(),
        ...(p.tool ? { tool: p.tool } : {}),
        ...(p.action ? { action: p.action } : {}),
        ...(p.input !== undefined ? { input: p.input } : {}),
        ...(p.description ? { description: p.description } : {}),
        agentId,
        ts: now(),
        seq: 0,
      });
    }
    const questions = extractQuestions(buf);
    for (const q of questions) {
      await this.emit({
        type: "question",
        questionId: q.id ?? shortId(),
        prompt: q.prompt,
        ...(q.header ? { header: q.header } : {}),
        ...(q.multiSelect ? { multiSelect: true } : {}),
        ...(q.choices ? { choices: q.choices } : {}),
        ...(q.options ? { options: q.options } : {}),
        agentId,
        ts: now(),
        seq: 0,
      });
    }
    const mcpAdds = extractMcpAdds(buf);
    for (const m of mcpAdds) {
      const requestId = m.id ?? shortId();
      // Stash the original proposal so respondMcpAdd can recover it when the
      // user approves. The directive isn't yet trusted/saved — just parked.
      // Also persisted to disk so HMR / dev-server restarts don't strand
      // the user with an un-approvable card ("Agent not found").
      this.pendingMcpAdds.set(requestId, { agentId, directive: m });
      if (state) {
        await savePendingMcpAdd({
          requestId,
          agentId,
          topicId: state.meta.topicId,
          rootPath: state.rootPath,
          directive: m,
        });
      }
      await this.emit({
        type: "mcp-add-request",
        requestId,
        server: m.server,
        label: m.label,
        ...(m.description ? { description: m.description } : {}),
        config: redactConfigSecrets(m.config, m.secrets ?? []),
        ...(m.secrets && m.secrets.length > 0 ? { secrets: m.secrets } : {}),
        agentId,
        ts: now(),
        seq: 0,
      });
    }
    if (state) {
      const kbEntries = extractKbEntries(buf);
      for (const entry of kbEntries) {
        try {
          const written = await writeKbEntry({
            rootPath: state.rootPath,
            directive: entry,
          });
          writtenViaKb.add(written.absPath);
          await this.emit({
            type: "kb-write",
            kind: written.kind,
            title: written.title,
            relPath: written.relPath,
            absPath: written.absPath,
            agentId,
            ts: now(),
            seq: 0,
          });
        } catch (err) {
          await this.emit({
            type: "error",
            message:
              "kb-write failed: " +
              (err instanceof Error ? err.message : String(err)),
            agentId,
            ts: now(),
            seq: 0,
          });
        }
      }
      await this.processMemoryWrites(buf, agentId, state.rootPath);
      await this.processSuggestions(
        buf,
        agentId,
        state.rootPath,
        state.meta.topicId,
      );
      if (hasOnboardingDone(buf)) {
        await this.emit({
          type: "onboarding-done",
          agentId,
          ts: now(),
          seq: 0,
        });
      }
      await this.processSkillCreates(buf, agentId, state.rootPath);
      const utilityDirs = extractUtilityDirectives(buf);
      for (const u of utilityDirs) {
        try {
          // Agents sometimes emit a partial / non-conformant `source` (wrong
          // enum value, missing `fetchedAt`). Strip it before validation —
          // we own provenance metadata. The agent's hint (type/origin) is
          // merged back in below.
          const rawManifest =
            u.manifest && typeof u.manifest === "object"
              ? (u.manifest as Record<string, unknown>)
              : {};
          const agentSource =
            rawManifest.source && typeof rawManifest.source === "object"
              ? (rawManifest.source as Record<string, unknown>)
              : {};
          const { source: _stripped, ...manifestNoSource } = rawManifest;
          void _stripped;
          const manifest = ManifestSchema.parse(manifestNoSource);
          const allowedTypes = ["agent", "github", "archive", "mcp"] as const;
          const agentType =
            typeof agentSource.type === "string" &&
            (allowedTypes as readonly string[]).includes(agentSource.type)
              ? (agentSource.type as (typeof allowedTypes)[number])
              : "agent";
          const installed = await installUtility({
            scope: u.scope,
            ...(u.scope === "project" ? { rootId: state.meta.rootId } : {}),
            manifest,
            files: u.files,
            source: {
              type: agentType,
              origin:
                typeof agentSource.origin === "string"
                  ? agentSource.origin
                  : `agent:${state.meta.rootId}:${state.meta.topicId}:${state.meta.id}`,
              fetchedAt: new Date().toISOString(),
              installedBy: "agent",
            },
          });
          // Dynamic import keeps the singleton AgentManager (cached on
          // globalThis across HMR) from holding a stale reference to
          // buildUtility after edits to build.ts.
          const buildMod = (await import(
            "@/lib/server/utilities/build"
          )) as { buildUtility: typeof BuildUtilityFn };
          await buildMod.buildUtility(installed);
          await this.emit({
            type: "utility-installed",
            utilityId: installed.manifest.id,
            scope: installed.scope,
            name: installed.manifest.name,
            version: installed.manifest.version,
            agentId,
            ts: now(),
            seq: 0,
          });
        } catch (err) {
          await this.emit({
            type: "utility-error",
            message:
              "utility install failed: " +
              (err instanceof Error ? err.message : String(err)),
            agentId,
            ts: now(),
            seq: 0,
          });
        }
      }
    }
    const dispatches = extractDispatches(buf).filter((d) =>
      isSubAgentRole(d.role),
    );
    const youtubeSummaries = extractYoutubeSummaries(buf);
    const widgetCreates = extractWidgetCreates(buf);
    const widgetUpdates = extractWidgetUpdates(buf);
    if (state && (widgetCreates.length > 0 || widgetUpdates.length > 0)) {
      await this.applyWidgetDirectives(
        state.rootPath,
        state.meta.topicId,
        agentId,
        widgetCreates,
        widgetUpdates,
      );
    }
    const workflowCreates = extractWorkflowCreates(buf);
    if (state && workflowCreates.length > 0) {
      await this.applyWorkflowDirectives(
        state.rootPath,
        state.meta.topicId,
        agentId,
        workflowCreates,
      );
    }
    return { writtenViaKb, dispatches, youtubeSummaries };
  }

  /**
   * Inline image generation. For each `<<reflex:image-gen>>` directive in
   * the current turn's text:
   *   1. Call the image service (gemini / codex) and persist bytes into
   *      `<root>/.reflex/assets/images/<sha>.<ext>`.
   *   2. Emit an `assistant-delta` carrying a markdown image ref so the
   *      image appears inside the current turn's bubble.
   *   3. If the directive sets `attachToKb`, also `kb.add` a standalone
   *      `kind: "image"` entry.
   *
   * Runs BEFORE turn-end so the deltas append to the active turn instead
   * of forming a new bubble below.
   */
  private async applyImageGenDirectives(agentId: string): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) return;
    const buf = this.turnText.get(agentId) ?? "";
    if (!buf || !buf.includes("reflex:image-gen")) return;
    const directives = extractImageGens(buf);
    if (directives.length === 0) return;
    for (const d of directives) {
      try {
        const result = await generateImage({
          rootId: state.meta.rootId,
          prompt: d.prompt,
          ...(d.provider ? { provider: d.provider } : {}),
          ...(d.size ? { size: d.size } : {}),
          ...(d.aspectRatio ? { aspectRatio: d.aspectRatio } : {}),
          ...(d.referenceImageUrls
            ? { referenceImageUrls: d.referenceImageUrls }
            : {}),
        });
        const alt = (d.caption || d.prompt)
          .replace(/[\[\]\n]/g, " ")
          .slice(0, 200);
        await this.emit({
          type: "assistant-delta",
          text: `\n\n![${alt}](${result.urlPath})\n`,
          agentId,
          ts: now(),
          seq: 0,
        });
        if (d.attachToKb) {
          try {
            const written = await writeKbEntry({
              rootPath: state.rootPath,
              directive: {
                kind: "image",
                title: d.caption || d.prompt.slice(0, 80),
                body: `![${alt}](${result.urlPath})`,
                meta: {
                  provider: result.provider,
                  prompt: d.prompt,
                  sha: result.sha,
                  ...(d.aspectRatio ? { aspectRatio: d.aspectRatio } : {}),
                },
              },
            });
            await this.emit({
              type: "kb-write",
              kind: written.kind,
              title: written.title,
              relPath: written.relPath,
              absPath: written.absPath,
              agentId,
              ts: now(),
              seq: 0,
            });
          } catch (err) {
            await this.emit({
              type: "error",
              message:
                "image-gen kb attach failed: " +
                (err instanceof Error ? err.message : String(err)),
              agentId,
              ts: now(),
              seq: 0,
            });
          }
        }
      } catch (err) {
        await this.emit({
          type: "assistant-delta",
          text: `\n\n_Failed to generate image: ${
            err instanceof Error ? err.message : String(err)
          }_\n`,
          agentId,
          ts: now(),
          seq: 0,
        });
      }
    }
  }

  /**
   * Persist workflows the agent emitted via `<<reflex:workflow-create>>`.
   * Each becomes one JSON file on disk; we emit a `workflow-event` so
   * chat-view can surface a preview card linking to the editor.
   */
  private async processMemoryWrites(
    buf: string,
    agentId: string,
    rootPath: string,
  ): Promise<void> {
    const writes = extractMemoryWrites(buf);
    for (const w of writes) {
      try {
        if (!isMemoryScope(w.scope) || !isMemoryFile(w.file) || !isMemoryOp(w.op)) {
          await this.emit({
            type: "error",
            message: `memory-write: bad marker (scope=${w.scope}, file=${w.file}, op=${w.op})`,
            agentId,
            ts: now(),
            seq: 0,
          });
          continue;
        }
        const ctx =
          w.scope === "global"
            ? ({ scope: "global" } as const)
            : ({ scope: "project", rootPath } as const);
        const res = await writeMemory(ctx, w.file, w.op, {
          ...(w.content !== undefined ? { content: w.content } : {}),
          ...(w.match !== undefined ? { match: w.match } : {}),
        });
        if (!res.ok) {
          await this.emit({
            type: "error",
            message: `memory-write rejected (${res.error}) for ${w.scope}/${w.file}`,
            agentId,
            ts: now(),
            seq: 0,
          });
          continue;
        }
        await this.emit({
          type: "memory-write",
          scope: w.scope,
          file: w.file,
          op: w.op,
          lines: res.lines,
          cap: res.cap,
          agentId,
          ts: now(),
          seq: 0,
        });
      } catch (err) {
        await this.emit({
          type: "error",
          message:
            "memory-write failed: " +
            (err instanceof Error ? err.message : String(err)),
          agentId,
          ts: now(),
          seq: 0,
        });
      }
    }
  }

  private async processSkillCreates(
    buf: string,
    agentId: string,
    rootPath: string,
  ): Promise<void> {
    const items = extractSkillCreates(buf);
    for (const s of items) {
      try {
        const file = await writeSkill({
          scope: s.scope,
          id: s.id,
          title: s.title,
          description: s.description ?? "",
          instructions: s.instructions,
          ...(s.scope === "project" ? { rootPath } : {}),
          ...(s.workflowId ? { workflowId: s.workflowId } : {}),
          ...(s.utilityRef ? { utilityRef: s.utilityRef } : {}),
        });
        await this.emit({
          type: "skill-created",
          scope: s.scope,
          skillId: s.id,
          title: s.title,
          file,
          agentId,
          ts: now(),
          seq: 0,
        });
      } catch (err) {
        await this.emit({
          type: "error",
          message:
            "skill-create failed: " +
            (err instanceof Error ? err.message : String(err)),
          agentId,
          ts: now(),
          seq: 0,
        });
      }
    }
  }

  private async processSuggestions(
    buf: string,
    agentId: string,
    rootPath: string,
    topicId: string,
  ): Promise<void> {
    const items = extractSuggestions(buf);
    for (const s of items) {
      try {
        if (
          !(SUGGESTION_KINDS as readonly string[]).includes(s.kind) ||
          !s.title?.trim() ||
          !s.prompt?.trim()
        ) {
          await this.emit({
            type: "error",
            message: `suggestion rejected: invalid shape (kind=${s.kind})`,
            agentId,
            ts: now(),
            seq: 0,
          });
          continue;
        }
        const saved = await addSuggestion(rootPath, {
          kind: s.kind,
          title: s.title,
          description: s.description ?? "",
          prompt: s.prompt,
          sourceTopicId: topicId,
        });
        await this.emit({
          type: "suggestion-added",
          suggestionId: saved.id,
          kind: saved.kind,
          title: saved.title,
          agentId,
          ts: now(),
          seq: 0,
        });
      } catch (err) {
        await this.emit({
          type: "error",
          message:
            "suggestion failed: " +
            (err instanceof Error ? err.message : String(err)),
          agentId,
          ts: now(),
          seq: 0,
        });
      }
    }
  }

  private async applyWorkflowDirectives(
    rootPath: string,
    topicId: string,
    agentId: string,
    directives: WorkflowDirective[],
  ): Promise<void> {
    for (const d of directives) {
      try {
        const id = sanitizeWorkflowId(d.id);
        if (!id) throw new Error("Workflow id is empty");
        const now = new Date().toISOString();
        // Auto-assign step ids if missing, default trigger to manual.
        const steps = d.steps.map((s, i) => ({
          id: sanitizeWorkflowId(s.id ?? `step-${i + 1}`),
          kind: s.kind as WorkflowStepKind,
          label: s.label,
          params: s.params ?? {},
        }));
        const wf: WorkflowDef = {
          id,
          label: d.label,
          ...(d.description ? { description: d.description } : {}),
          trigger: d.trigger ?? "manual",
          steps,
          createdAt: now,
          updatedAt: now,
          sourceTopicId: topicId,
        };
        const err = validateWorkflowDef(wf);
        if (err) throw new Error(err);
        await writeWorkflow(rootPath, wf);
        await this.emit({
          type: "workflow-event",
          workflowId: wf.id,
          label: wf.label,
          ...(wf.description ? { description: wf.description } : {}),
          trigger: wf.trigger,
          stepCount: wf.steps.length,
          sourceTopicId: topicId,
          agentId,
          ts: now,
          seq: 0,
        });
      } catch (err) {
        await this.emit({
          type: "workflow-error",
          workflowId: d.id,
          message:
            "workflow-create failed: " +
            (err instanceof Error ? err.message : String(err)),
          agentId,
          ts: now(),
          seq: 0,
        });
      }
    }
  }

  /**
   * Persist widgets the agent emitted via `<<reflex:widget-create>>` or
   * `<<reflex:widget-update>>`. Each directive becomes a JSON file on disk
   * (or updates an existing one) and the dashboard layout gets reconciled
   * so new widgets show up immediately. A `widget-event` is emitted into
   * the topic's events.jsonl so chat-view can render an inline preview at
   * the position where the agent created/updated the widget.
   *
   * Failures are converted to `widget-error` events instead of throwing —
   * the agent sees them in the next turn's transcript (if any) but the
   * rest of the directive batch continues.
   */
  private async applyWidgetDirectives(
    rootPath: string,
    topicId: string,
    agentId: string,
    creates: WidgetDirective[],
    updates: WidgetDirective[],
  ): Promise<void> {
    const layout = await readLayout(rootPath);
    const newOrder = [...layout.order];
    const newHidden = [...layout.hidden];
    for (const d of [...creates, ...updates]) {
      const isUpdate = updates.includes(d);
      try {
        const payload = { kind: d.kind, data: d.data } as unknown as WidgetData;
        const existing = isUpdate ? await readWidget(rootPath, d.id) : null;
        const record = buildWidgetRecord({
          id: d.id,
          title: d.title,
          ...(d.description ? { description: d.description } : {}),
          sourceTopicId: topicId,
          payload,
          existing,
          ...(d.size ? { size: d.size } : {}),
          ...(d.refresh ? { refresh: d.refresh } : {}),
          ...(d.memory !== undefined ? { memory: d.memory } : {}),
          ...(d.memoryFile ? { memoryFile: d.memoryFile } : {}),
        });
        await writeWidget(rootPath, record);
        // New widget → goes into hidden (library) by default. User pins it
        // to the dashboard via the chat preview card or the widget library.
        // Existing → leave layout untouched (already placed somewhere).
        if (!existing) {
          if (!newHidden.includes(record.id) && !newOrder.includes(record.id)) {
            newHidden.push(record.id);
          }
        }
        await this.emit({
          type: "widget-event",
          op: isUpdate && existing ? "update" : "create",
          widgetId: record.id,
          title: record.title,
          ...(record.description ? { description: record.description } : {}),
          kind: record.kind,
          data: record.data,
          sourceTopicId: topicId,
          agentId,
          ts: now(),
          seq: 0,
        });
      } catch (err) {
        await this.emit({
          type: "widget-error",
          widgetId: d.id,
          message:
            (isUpdate ? "widget-update" : "widget-create") +
            " failed: " +
            (err instanceof Error ? err.message : String(err)),
          agentId,
          ts: now(),
          seq: 0,
        });
      }
    }
    await writeLayout(rootPath, { order: newOrder, hidden: newHidden });
  }

  /**
   * Run Gemini's native YouTube summarization for each directive the
   * orchestrator emitted, then continue the turn with the results spliced
   * in as a synthesized user-context message. Fire-and-forget — the caller
   * lets this run async after turn-end so the response stream isn't
   * blocked while Gemini chews on the video.
   */
  private async runYoutubeSummaries(
    agentId: string,
    directives: YoutubeSummaryDirective[],
  ): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) return;
    // Progress ping so the UI shows something during the (potentially
    // 10-30s) Gemini call. `reflex.preflight` subtype is whitelisted by
    // chat-view.tsx — runtime "hook_started"/"hook_response" stays hidden.
    await this.emit({
      type: "system",
      text: `Starting Gemini YouTube summary (${directives.length}):\n${directives.map((d) => `• ${d.url}`).join("\n")}`,
      subtype: "reflex.preflight",
      agentId,
      ts: now(),
      seq: 0,
    });
    const { summarizeYoutubeAction } = await import(
      "@/lib/server/youtube-actions"
    );
    const results = await Promise.all(
      directives.map(async (d) => {
        const r = await summarizeYoutubeAction({
          url: d.url,
          ...(d.prompt ? { prompt: d.prompt } : {}),
        });
        return r.ok
          ? { url: d.url, text: r.text, model: r.model }
          : { url: d.url, error: r.error };
      }),
    );
    const blocks = results.map((r) => {
      if ("text" in r) {
        return [
          `### youtube-summary ${r.url}`,
          `_(Gemini ${r.model} — use as primary source; do not WebFetch the same URL.)_`,
          "",
          r.text,
        ].join("\n");
      }
      return `### youtube-summary ${r.url}\n_(Gemini failed: ${r.error}. Notify the user and suggest saving the key in Settings -> Gemini, or answer without the summary.)_`;
    });
    await this.emit({
      type: "system",
      text: results.every((r) => "text" in r)
        ? "Summaries received, passing to the agent."
        : "Some summaries failed — details are in the context.",
      subtype: "reflex.preflight",
      agentId,
      ts: now(),
      seq: 0,
    });
    const synthesized =
      `[Reflex] Gemini YouTube summaries you requested:\n\n${blocks.join("\n\n")}\n\n` +
      `Now answer the user based on this context. Do not repeat the summaries verbatim — compose a human-readable response.`;
    await this.continueTurn(agentId, synthesized);
  }

  /** Permanently destroy an agent (emits terminal agent-end). */
  async destroy(agentId: string, status: AgentStatus = "completed"): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.meta.status = status;
    state.meta.endedAt = now();
    await this.emit({
      type: "agent-end",
      status,
      agentId,
      ts: state.meta.endedAt,
      seq: 0,
    });
    this.agents.delete(agentId);
    this.turnText.delete(agentId);
    this.lastInvoke.delete(agentId);
    const roleMap = this.byTopicRole.get(state.meta.topicId);
    if (roleMap) {
      for (const [role, id] of roleMap) {
        if (id === agentId) roleMap.delete(role);
      }
      if (roleMap.size === 0) this.byTopicRole.delete(state.meta.topicId);
    }
  }

  // ---------------------------------------------------------------------
  // event plumbing
  // ---------------------------------------------------------------------

  async emit(event: AgentEvent): Promise<void> {
    const state = this.agents.get(event.agentId);
    if (!state) return;
    const seq = await nextSeq(state.rootPath, state.meta.topicId);
    const stamped: AgentEvent = { ...event, seq };
    await appendEvent(state.rootPath, state.meta.topicId, stamped);
    if (event.type === "assistant-delta") {
      const cur = this.turnText.get(event.agentId) ?? "";
      this.turnText.set(event.agentId, cur + event.text);
    }
    this.emitter.emit(`topic:${state.meta.topicId}`, stamped);
    this.emitter.emit(`agent:${event.agentId}`, stamped);
  }

  subscribeTopic(
    topicId: string,
    cb: (event: AgentEvent) => void,
  ): () => void {
    const channel = `topic:${topicId}`;
    this.emitter.on(channel, cb);
    return () => this.emitter.off(channel, cb);
  }

  subscribeAgent(
    agentId: string,
    cb: (event: AgentEvent) => void,
  ): () => void {
    const channel = `agent:${agentId}`;
    this.emitter.on(channel, cb);
    return () => this.emitter.off(channel, cb);
  }

  // ---------------------------------------------------------------------
  // queries
  // ---------------------------------------------------------------------

  list(args?: { topicId?: string; rootId?: string }): AgentMeta[] {
    const out: AgentMeta[] = [];
    for (const state of this.agents.values()) {
      if (args?.topicId && state.meta.topicId !== args.topicId) continue;
      if (args?.rootId && state.meta.rootId !== args.rootId) continue;
      out.push({ ...state.meta });
    }
    out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return out;
  }

  get(agentId: string): AgentMeta | null {
    const state = this.agents.get(agentId);
    return state ? { ...state.meta } : null;
  }

  isActive(topicId: string): boolean {
    const roleMap = this.byTopicRole.get(topicId);
    if (!roleMap) return false;
    for (const agentId of roleMap.values()) {
      const state = this.agents.get(agentId);
      if (state?.meta.status === "running") return true;
    }
    return false;
  }

  /**
   * Topic IDs that currently have at least one running agent attached to the
   * given root. Used by the dashboard to surface "agent is working right now"
   * cards independent of the /goal-active flag.
   */
  listRunningTopicsForRoot(rootId: string): string[] {
    const out = new Set<string>();
    for (const st of this.agents.values()) {
      if (st.meta.rootId !== rootId) continue;
      if (st.meta.status !== "running") continue;
      out.add(st.meta.topicId);
    }
    return [...out];
  }

  /**
   * Detach every running agent attached to this topic so a new turn can
   * start cleanly. Emits an `agent-end` event with status "cancelled" so
   * the UI flips out of the "active" state immediately. The runtime's
   * background subprocess may still finish on its own; any events it
   * emits after destroy will be dropped (see `emit()` — events from
   * unknown agentIds are no-ops).
   */
  async stopTopic(topicId: string): Promise<{ stopped: number }> {
    // Iterate every agent attached to the topic (orchestrator + any live
    // sub-agents). byTopicRole only tracks orchestrator-style singletons,
    // so we scan `agents` directly to catch dispatched specialists too.
    const ids: string[] = [];
    for (const [agentId, st] of this.agents) {
      if (st.meta.topicId === topicId) ids.push(agentId);
    }
    let stopped = 0;
    for (const agentId of ids) {
      const state = this.agents.get(agentId);
      if (!state || state.meta.status !== "running") continue;
      await this.destroy(agentId, "cancelled");
      stopped += 1;
    }
    return { stopped };
  }
}

function now(): string {
  return new Date().toISOString();
}

const KNOWN_HARNESSES: ReadonlySet<string> = new Set<AgentHarnessId>([
  "claude-code",
  "codex",
  "ollama",
  "image-gen",
]);

function isKnownHarness(s: string): boolean {
  return KNOWN_HARNESSES.has(s);
}

/**
 * Mask secret env values in an MCP config so the proposal we show in chat
 * doesn't echo back whatever placeholder the agent wrote (e.g.
 * "GITHUB_TOKEN: ghp_REPLACE_ME"). For stdio configs we redact `env`; for
 * http/sse we redact `headers`.
 */
function redactConfigSecrets(
  rawConfig: unknown,
  secrets: Array<{ envKey: string }>,
): unknown {
  if (!rawConfig || typeof rawConfig !== "object") return rawConfig;
  const cfg = rawConfig as Record<string, unknown>;
  const transport = cfg.transport;
  const target =
    transport === "stdio"
      ? "env"
      : transport === "http" || transport === "sse"
        ? "headers"
        : null;
  if (!target) return cfg;
  const slots = new Set(secrets.map((s) => s.envKey));
  if (slots.size === 0) return cfg;
  const original = cfg[target];
  if (!original || typeof original !== "object") return cfg;
  const redacted: Record<string, string> = {};
  for (const [k, v] of Object.entries(original as Record<string, unknown>)) {
    redacted[k] = slots.has(k) ? "***" : String(v);
  }
  return { ...cfg, [target]: redacted };
}

/**
 * Merge user-supplied secret values back into the proposed config.
 *
 * For OAuth-backed slots (`slot.oauth` set), we write a literal
 * `$oauth:<provider>` placeholder rather than the token itself — tokens are
 * hydrated at MCP-call time and auto-refreshed. We also verify the user has
 * actually completed the OAuth flow for that provider, so we don't persist
 * a config that's guaranteed to fail.
 */
async function mergeSecretsIntoConfig(
  rawConfig: unknown,
  secrets: Array<{ envKey: string; required?: boolean; oauth?: string }>,
  values: Record<string, string>,
): Promise<unknown> {
  if (!rawConfig || typeof rawConfig !== "object") return rawConfig;
  const cfg = { ...(rawConfig as Record<string, unknown>) };
  const transport = cfg.transport;
  const target =
    transport === "stdio"
      ? "env"
      : transport === "http" || transport === "sse"
        ? "headers"
        : null;
  if (!target) return cfg;
  const current = (cfg[target] ?? {}) as Record<string, unknown>;
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) merged[k] = String(v);
  for (const slot of secrets) {
    if (slot.oauth) {
      const { getOAuthTokens } = await import("@/lib/server/oauth/store");
      const { isOAuthProviderId } = await import(
        "@/lib/server/oauth/providers"
      );
      if (!isOAuthProviderId(slot.oauth)) {
        throw new Error(`unknown OAuth provider: ${slot.oauth}`);
      }
      const tokens = await getOAuthTokens(slot.oauth);
      if (!tokens) {
        throw new Error(
          `provider "${slot.oauth}" not authorized — open Settings → OAuth and Authorize first`,
        );
      }
      merged[slot.envKey] = `$oauth:${slot.oauth}`;
      continue;
    }
    const val = values[slot.envKey];
    if (val !== undefined && val !== "") {
      merged[slot.envKey] = val;
    } else if (slot.required) {
      throw new Error(`secret "${slot.envKey}" is required`);
    } else {
      delete merged[slot.envKey];
    }
  }
  cfg[target] = merged;
  return cfg;
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

async function buildTranscript(
  rootPath: string,
  topicId: string,
): Promise<string> {
  const events = await readEvents(rootPath, topicId);
  const lines: string[] = [];
  let current: { role: "user" | "assistant"; text: string } | null = null;
  const flush = () => {
    if (!current) return;
    lines.push(`### ${current.role}\n${current.text.trim()}`);
    current = null;
  };
  for (const ev of events) {
    if (ev.type === "user-message") {
      flush();
      current = { role: "user", text: ev.text };
      flush();
    } else if (ev.type === "assistant-delta") {
      if (!current || current.role !== "assistant") {
        flush();
        current = { role: "assistant", text: "" };
      }
      current.text += ev.text;
    } else if (ev.type === "turn-end" || ev.type === "agent-end") {
      flush();
    }
  }
  flush();
  return lines.join("\n\n");
}

declare global {
  // eslint-disable-next-line no-var
  var __reflexAgentManager: AgentManager | undefined;
}

export const agentManager: AgentManager =
  globalThis.__reflexAgentManager ?? new AgentManager();
globalThis.__reflexAgentManager = agentManager;

// Kick the widget auto-refresh scheduler. Dynamic import keeps the file
// from being eagerly evaluated during the manager's own module-init
// (which would create a circular ref via start-turn → manager).
void import("@/lib/server/widgets/scheduler")
  .then((mod) => mod.startWidgetScheduler())
  .catch((err) => {
    console.error("[widget-scheduler] failed to start:", err);
  });

export type { AgentManager };
