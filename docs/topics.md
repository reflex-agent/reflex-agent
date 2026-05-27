# Topics (chats)

A topic is one chat. Each Space (root) has many topics under
`<root>/.reflex/topics/`. Two files per topic share the same id:

```
<topicId>.md             — frontmatter + rendered transcript (## user / ## assistant)
<topicId>.events.jsonl   — append-only event log (source of truth)
```

`<topicId>` is `YYYY-MM-DD-<8hex>`.

## Frontmatter

```yaml
---
id: 2026-05-27-a1b2c3d4
title: How does OAuth refresh work?
createdAt: 2026-05-27T10:00:00.000Z
updatedAt: 2026-05-27T10:32:14.000Z
harness: claude-code        # or codex
model: claude-opus-4-7
language: en
goal: …                     # set by /goal
goalStatus: active | completed | abandoned
goalIterations: 3
helperFor: <utilityId>      # hidden from sidebar; bound to a utility helper-chat
taskId: <task-id>           # bound to a task on the task-board
---
```

`helperFor` and `taskId` are mutually exclusive in spirit — both
indicate "this topic isn't a regular conversation, it's owned by
another system". The sidebar's regular-Conversations list hides
helper / task-bound topics so they don't clutter the chat history.

## Event log (`<topicId>.events.jsonl`)

Each line is one event. Used by:

- The chat UI to reconstruct what to render (rich content beyond just
  text: tool uses, marker cards, permissions prompts, attachment
  thumbnails).
- The task-board utility's poller (`reflex.tasks.observe`) to fetch
  recent events + pending interactions.
- Replay across restart — the agent reads back its own past events
  when continuing a topic.

Common event kinds:

| Kind | Meaning |
|---|---|
| `user-message` | A user turn |
| `assistant-delta` | Streaming chunk from the agent |
| `assistant-final` | End-of-turn marker with the cleaned text |
| `tool-use` | The agent called a tool (Read, Bash, …) |
| `tool-result` | The tool's reply |
| `permission` | Permission request from a `<<reflex:permission>>` marker |
| `permission-grant` / `permission-deny` | User's answer |
| `marker-handled` | A `<<reflex:*>>` marker fired; payload includes the result card |
| `agent-error` | Subprocess crash / non-zero exit |
| `turn-end` | Conclusion of one user-↔-assistant exchange |

`.md` is **metadata + a human-readable mirror** of the assistant
text; `.events.jsonl` is the canonical record. If they disagree, trust
the events.

## Lifecycle of a turn

1. **User submits a message** via the chat form (server action
   `appendUserMessage`).
2. Manager writes a `user-message` event, then **builds the system
   prompt**:
   - `chatSystemPrompt()` — base instructions
   - + `buildMemoryBlock({rootPath})` — global + project memory
   - + `collectExtensions({rootId}).promptBlocks` — utility addenda
   - + skill body if user typed `/skill <id>` in the message
   - + KB index snippet
3. **Spawn or reuse** the agent subprocess. If a topic already has a
   running agent, the message is fed via stdin; otherwise a new
   subprocess is started with `--system-prompt` + tool allowlist.
4. **Stream events.** The streaming layer parses `<<reflex:*>>`
   markers off the wire — handlers fire AS the agent writes, not
   after.
5. **Marker handlers** mutate state (memory, KB, task, …) and emit
   `marker-handled` events for the UI to render confirmation cards.
6. **End-of-turn:** the `assistant-final` event captures the cleaned
   text (markers stripped). The `.md` mirror is rewritten so a person
   re-opening the file sees the same transcript.

## Manager state

`lib/server/agents/manager.ts` keeps one `AgentRuntimeState` per
active topic in a Map keyed by `(rootId, topicId)`:

```ts
interface AgentRuntimeState {
  process: ChildProcess;
  killer: () => void;
  pendingInteractions: PendingInteraction[];
  bufferedDelta: string;
  …
}
```

The `killer` field exists because Claude Code's `--allowedTools` is
fixed at spawn. When the user clicks "Always allow" on a permission
mid-turn, manager SIGTERMs the subprocess, then calls `continueTurn`
with the replayed user message — the fresh spawn picks up the updated
allowlist.

## /goal mode

A topic can carry a `goal` field set via `/goal <text>`. When set,
after every assistant turn the manager evaluates "is the goal
reached?" via `quickComplete`. If not, it auto-continues with a
"continue the work" prompt. `goalIterations` increments per
auto-continue; the loop is bounded.

The agent can mark the goal complete by saying so explicitly; the
manager listens for the cue and flips `goalStatus` to `completed`.

## Deletion

`deleteTopic(root, id)` removes both files and stops any running
agent on that topic. The KB / memory / task side effects performed
during the topic are NOT rolled back — they're durable artifacts the
user keeps.

## Why two files per topic, not one?

The `.events.jsonl` log grows monotonically per turn (one append-only
write). The `.md` mirror gets rewritten in full on every turn (because
markdown headings can't be appended without re-parsing). Separating
the two means crash-safe append for the canonical log and a tidy mirror
for the markdown reader.
