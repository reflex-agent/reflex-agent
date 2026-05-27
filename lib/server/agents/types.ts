import type { HarnessId, TaskId } from "@/lib/settings";

/**
 * Agents are the unit of execution in Reflex. A topic owns one orchestrator
 * agent; the orchestrator may delegate to sub-agents (potentially of a
 * different harness). All output flows through the topic's `events.jsonl` log
 * tagged with the originating agent's id.
 */

export type AgentRole = "orchestrator" | "subagent";

/**
 * Extended harness id for agent execution. Includes the chat-capable
 * harnesses from settings (claude-code/codex/ollama) plus special-purpose
 * runtimes like `image-gen` that aren't part of the chat assignment matrix
 * but still need to surface as agents (sidebar status, audit trail, etc).
 */
export type AgentHarnessId = HarnessId | "image-gen";

export type AgentStatus =
  | "starting"
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentMeta {
  /** Stable runtime id (uuid v4 short). */
  id: string;
  /** Topic the agent streams into. */
  topicId: string;
  /** Project (root) id — for sidebar grouping. */
  rootId: string;
  /** Parent agent id (set for sub-agents). */
  parentId?: string;
  role: AgentRole;
  /** Task assignment from settings — drives harness/model/system prompt. */
  task: TaskId;
  harness: AgentHarnessId;
  model: string;
  /** Short human label shown in the sidebar (e.g. "Orchestrator", "Title"). */
  label: string;
  status: AgentStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export type AgentEventBase = {
  /** ISO timestamp. */
  ts: string;
  /** Monotonic counter per topic, used for ?since replay. */
  seq: number;
  /** Agent that produced this event. */
  agentId: string;
};

export type AgentEvent = AgentEventBase &
  (
    | { type: "agent-start"; meta: AgentMeta }
    | { type: "agent-end"; status: AgentStatus; error?: string }
    /** One conversational round (user message → assistant reply). Multiple
     *  turn-start/turn-end pairs share the same agentId for an orchestrator's
     *  lifetime. */
    | { type: "turn-start"; turnId: string }
    | { type: "turn-end"; turnId: string; status: AgentStatus; error?: string }
    | { type: "user-message"; text: string }
    | { type: "assistant-delta"; text: string }
    | {
        type: "tool-use";
        toolUseId: string;
        name: string;
        input: unknown;
      }
    | {
        type: "tool-result";
        toolUseId: string;
        content: string;
        isError?: boolean;
      }
    | { type: "system"; text: string; subtype?: string }
    | { type: "error"; message: string }
    /**
     * Permission ask from the agent: "may I do X?". Emitted by the manager
     * when an agent's text contains `<<reflex:permission>>{...}<</reflex:permission>>`.
     * Harness-neutral — works the same way for claude-code, codex, ollama, …
     */
    | {
        type: "permission-request";
        requestId: string;
        tool?: string;
        action?: string;
        input?: unknown;
        description?: string;
      }
    | {
        type: "permission-response";
        requestId: string;
        decision: "allow" | "deny";
        scope?: "once" | "always";
      }
    /**
     * Free-form clarifying question from the agent. Rich shape mirrors
     * Claude Code's AskUserQuestion: short `header` chip, multi-select
     * support, and either flat `choices` or rich `options` with
     * label+description rows. Backward compat: only `prompt` is required.
     */
    | {
        type: "question";
        questionId: string;
        prompt: string;
        header?: string;
        multiSelect?: boolean;
        choices?: string[];
        options?: Array<{ label: string; description?: string }>;
      }
    | { type: "answer"; questionId: string; answer: string }
    /**
     * The agent saved a new entry into the project's knowledge base via the
     * `<<reflex:kb>>{...}<</reflex:kb>>` marker. Emitted by the manager
     * after the file is written to disk.
     */
    | {
        type: "kb-write";
        kind: string;
        title: string;
        relPath: string;
        absPath: string;
      }
    /**
     * Agent updated user / project memory via `<<reflex:memory>>`. Emitted
     * after the on-disk file changed. Surfaced in chat as a small
     * confirmation card.
     */
    | {
        type: "memory-write";
        scope: "global" | "project";
        file: string;
        op: "append" | "replace" | "remove";
        lines: number;
        cap: number;
      }
    /**
     * Agent proposed an action via `<<reflex:suggestion>>`. The proposal
     * is persisted to `<root>/.reflex/suggestions.json` and rendered as
     * a card on the project dashboard awaiting approve/reject.
     */
    | {
        type: "suggestion-added";
        suggestionId: string;
        kind: "utility" | "research" | "widget" | "goal" | "skill";
        title: string;
      }
    /**
     * The agent generated and installed a new utility via the
     * `<<reflex:utility>>{...}<</reflex:utility>>` marker.
     */
    | {
        type: "utility-installed";
        utilityId: string;
        scope: "global" | "project";
        name: string;
        version: string;
      }
    /** Validation or install error for a utility marker. */
    | {
        type: "utility-error";
        message: string;
      }
    /**
     * Agent proposed registering a new MCP server. Renders as an
     * approve/reject card with optional secret-paste inputs. Approval
     * triggers a continuation turn with the registration result.
     */
    | {
        type: "mcp-add-request";
        requestId: string;
        server: string;
        label: string;
        description?: string;
        /** Sanitized config with secret env-values masked out. */
        config: unknown;
        secrets?: Array<{
          envKey: string;
          label: string;
          description?: string;
          required?: boolean;
          oauth?: string;
        }>;
      }
    | {
        type: "mcp-add-response";
        requestId: string;
        decision: "approve" | "reject";
        server?: string;
      }
    /**
     * Dashboard widget mutation. Mirrors the widget record stored on disk
     * — chat-view uses this to render a preview where the agent created
     * the widget. `op` distinguishes "first time" from "updated" so the
     * UI can show different labels.
     */
    | {
        type: "widget-event";
        op: "create" | "update";
        widgetId: string;
        title: string;
        description?: string;
        kind: string;
        data: unknown;
        sourceTopicId?: string;
      }
    /** Widget directive failed validation or persistence. */
    | {
        type: "widget-error";
        widgetId?: string;
        message: string;
      }
    /**
     * Agent composed a workflow via `<<reflex:workflow-create>>`. Chat-view
     * surfaces a preview card linking to the editor. The workflow itself
     * is already persisted on disk by the time this event fires.
     */
    | {
        type: "workflow-event";
        workflowId: string;
        label: string;
        description?: string;
        trigger: "manual" | "hourly" | "daily" | "weekly";
        stepCount: number;
        sourceTopicId?: string;
      }
    | {
        type: "workflow-error";
        workflowId?: string;
        message: string;
      }
  );

export type AgentEventType = AgentEvent["type"];
