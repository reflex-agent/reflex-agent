# Agents

Reflex orchestrates external coding agents as subprocesses. Two
harnesses are supported, and the user can switch per topic.

## Supported harnesses

| Harness | Transport | Tool model | When we use it |
|---|---|---|---|
| **Claude Code CLI** | `execa` subprocess, line-based stdin/stdout | Built-in tools (Read, Bash, …) + MCP | Default for code tasks |
| **Codex App Server** | JSON-RPC over stdio (`@openai/codex-sdk`) | Codex's native tool set | Default when Codex is the assigned model; some utilities pin it |

Both are launched per topic (or per dispatched task). State lives in
`AgentRuntimeState` in `lib/server/agents/manager.ts`, keyed by
`(rootId, topicId)`.

## Why subprocesses, not API-mode

Originally we considered using the Anthropic SDK directly. Two reasons
we use the CLI / App Server instead:

- The CLIs already handle the tool-calling loop, permissioning, MCP
  bridging, and streaming. Re-implementing that against the raw API
  would be more code to maintain, not less.
- Users authenticate the CLIs once (via `claude login`, `codex
  login`). Reflex never touches their API keys — the CLI does.

The trade-off is process management. The manager has to deal with
crashes, mid-turn permission updates, idle reaping, etc. That's worth
it for the leverage of not owning the agent loop.

## Per-turn flow

For a chat topic with Claude Code:

1. **Spawn or reuse.** Manager checks
   `AgentRuntimeState.get(rootId, topicId)`. If a process is running,
   feed the message via stdin. If not, spawn a new one with:
   - `--system-prompt-file <tmp>` containing the assembled prompt
     (base + memory + utility addenda + KB index + skill body).
   - `--allowedTools <list>` based on user settings.
   - `--mcp-config <tmp>` materialised from the MCP registry (see
     `lib/server/agents/runtime/mcp-config-file.ts`).
   - cwd = worktree dir if the topic is task-bound, otherwise the
     Space root.
2. **Stream stdout** line by line. Lines are either agent text,
   JSON-line tool events (Claude Code's `--output-format=stream-json`),
   or our markers.
3. **Marker parser** extracts `<<reflex:*>>` from text-channel
   output, dispatches handlers ([markers.md](markers.md)), and emits
   `marker-handled` events on the topic's `.events.jsonl`.
4. **Permission prompts** (Claude Code's `tool_use_pending`) are
   converted into a `PendingInteraction` and shown in the UI. User's
   response is written back to the subprocess.

## The Always-allow restart dance

Claude Code's `--allowedTools` list is fixed at spawn. When the user
clicks **Always allow** mid-turn for a previously denied tool, the
fresh tool wouldn't be in the running subprocess's allowlist.

Manager solves this:

1. Saves the user's pending message and current state.
2. Calls `killer()` (SIGTERM) on the running process.
3. Re-spawns with the updated `--allowedTools`.
4. Replays the user message so the fresh subprocess picks up where
   the old one left off.

This is the only place we kill a subprocess by design. Idle reaping
happens on a timer; user actions otherwise let the agent finish.

## Codex App Server

Codex uses JSON-RPC instead of line-based text. The wrapper in
`lib/server/codex/` exposes `quickComplete`, the per-topic chat loop,
and image generation. Permissions flow the same way (we surface
permission prompts into our `PendingInteraction` queue) but the
transport is different.

Reflex never invokes `codex exec` directly — always App Server JSON-
RPC. Easier to maintain, lets us multiplex multiple concurrent calls
on one Codex process.

## Headless dispatched agents

The orchestrator can spin up an ephemeral sub-agent for a one-shot
task via `<<reflex:dispatch>>` (or utilities can call
`reflex.agent.invoke({prompt})`). These:

- Create a hidden topic (filtered from the sidebar).
- Run one turn end-to-end.
- Return the assistant text to the caller.
- Get deleted after harvest unless the dispatch payload says to
  preserve.

Used heavily by utilities that want agent reasoning without burdening
the user's chat history (e.g. task-board's auto-pickup ranker).

## Quick completions

For utility purposes that want "small LLM call, no streaming, no
tools" the system exposes:

```ts
quickComplete(assignment, prompt, { timeoutMs })
```

`assignment` is one of `chat`, `quick`, `rag`, `embed` resolved
through user settings to a specific model. `quickComplete` is the
plumbing for:

- Memory auto-compaction (`compactFile`).
- Memory rollup (`runMemoryRollup`).
- Title derivation, summary tasks, classification.

It bypasses the agent harness entirely — direct API call, single
turn, returns the text.

## Pending interactions

`PendingInteraction` is the unified shape for "the agent needs you":

```ts
type PendingKind =
  | "permission"     // tool use awaiting allow/deny
  | "question"       // <<reflex:question>>
  | "task-question"; // task-board's "agent stuck on a task"

interface PendingInteraction {
  id: string;
  kind: PendingKind;
  prompt: string;
  choices?: string[];
  toolUse?: { name: string; input: unknown };
  // ...
}
```

The UI renders each kind differently; the manager exposes the queue
through `reflex.tasks.observe` so the task-board can show a "needs
you" badge on bound tasks.

## Configuration: assignments

`/settings → Assignments` lets the user map four logical tasks to
specific harnesses + models:

- `chat` — the main orchestrator
- `quick` — small fast calls (summaries, classification)
- `rag` — retrieval-augmented queries (when applicable)
- `embed` — embeddings (not heavily used yet)

Each assignment is `{harness, model}`. Defaults are sensible:
`claude-opus-4-7` for chat, `claude-haiku-4-5` for quick.

`loadSettings()` returns these; consumers reference
`settings.assignments.<task>` rather than reading the model id
directly.
