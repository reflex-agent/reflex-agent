# Markers protocol (`<<reflex:*>>`)

Markers are side-channel instructions the orchestrator agent emits
inline in its response. They look like XML but are deliberately
simpler — `<<reflex:NAME>>JSON<</reflex:NAME>>`. The agent emits them
as it writes to the user; the marker parser intercepts them from the
assistant stream BEFORE the rendered text reaches the chat UI,
executes the side effect (writing to KB, updating memory, scheduling
a task), and rewrites the marker into a confirmation card.

The user sees the card. The agent sees the original marker in its own
transcript. The two are kept in sync.

## Why markers, not tool calls?

We don't run the orchestrator with structured tool-use because:

- Claude Code CLI / Codex CLI aren't tool-calling APIs — they're
  streaming text completers.
- Markers compose: the same response can write a KB note, save a
  memory, and schedule a task without three tool round-trips.
- They survive transcript replay — the agent reading its own past
  output gets the same signal as the parser did.

The cost is that markers are textual — a hostile prompt could try to
inject one. The hygiene scanner ([memory.md](memory.md)) refuses
inputs that LOOK like markers. The agent is also told to fence
markers it's discussing (in code blocks) so it doesn't accidentally
re-emit one.

## Marker registry

Defined in `lib/server/agents/protocol.ts`. Each constant pairs an
open and close tag (`<<reflex:NAME>>` … `<</reflex:NAME>>`).

| Marker | Side effect |
|---|---|
| `<<reflex:permission>>` | Ask the user to allow a tool invocation (Claude Code passthrough) |
| `<<reflex:question>>` | Pose a multiple-choice question to the user mid-turn |
| `<<reflex:kb>>` | Write a knowledge-base entry |
| `<<reflex:utility>>` | Mount a curated utility in this Space |
| `<<reflex:dispatch>>` | Dispatch a sub-task to another harness/model |
| `<<reflex:mcp-add>>` | Propose a new MCP server registration |
| `<<reflex:youtube-summary>>` | Summarise a YouTube video and write to KB |
| `<<reflex:widget-create>>` | Create a dashboard widget |
| `<<reflex:widget-update>>` | Update an existing widget |
| `<<reflex:workflow-create>>` | Author a new workflow |
| `<<reflex:image-gen>>` | Generate an image and attach |
| `<<reflex:memory>>` | Persist a fact in memory |
| `<<reflex:suggestion>>` | Surface a dashboard suggestion card |
| `<<reflex:onboarding-done>>` | Finish the per-Space onboarding wizard |
| `<<reflex:skill-create>>` | Create a global or project-scoped skill |
| `<<reflex:task-create>>` | Create a task on the task-board utility |
| `<<reflex:task-update>>` | Update an existing task |

## Parser

`lib/server/agents/protocol.ts` exports `extractMarkers(text)` which
returns `{cleaned, markers}`. The cleaned text is what gets shown to
the user; markers are dispatched to their handlers in
`lib/server/agents/manager.ts`.

The parser is lenient on whitespace and accepts both `<reflex:…>` and
`<<reflex:…>>` forms. The agent prompt instructs it to use the
double-angle form.

## Payload reference

### `<<reflex:memory>>`

```json
{
  "scope": "global" | "project",
  "file": "PERSONA" | "VALUES" | "INTERESTS" | "GOALS"
        | "RELATIONSHIPS" | "ROUTINES" | "AVOID" | "RECENT",
  "op": "append" | "replace" | "remove",
  "content": "Lives in Berlin, wakes at 6am.",
  "match": "<substring>"
}
```

`content` required for `append` and `replace`; `match` required for
`remove`. See [memory.md](memory.md).

### `<<reflex:kb>>`

```json
{
  "kind": "note" | "article" | "diagram" | "...",
  "title": "How OAuth refresh works",
  "body": "<markdown>",
  "slug": "oauth-refresh"        // optional
}
```

Writes a `kind/`-keyed file under `<root>/.reflex/kb/`. See
[kb.md](kb.md).

### `<<reflex:task-create>>` / `<<reflex:task-update>>`

```json
{
  "title": "Add OAuth refresh-token rotation",
  "type": "feature" | "bug" | ...,
  "status": "backlog" | "ready" | ...,
  "labels": ["auth"],
  "description": "<markdown>"
}
```

Handled by the task-board utility's host-API surface (`reflex.tasks.*`).
See [tasks.md](tasks.md).

### `<<reflex:skill-create>>`

```json
{
  "scope": "global" | "project",
  "id": "memory-rollup",
  "label": "Roll up the last 7 days",
  "description": "<markdown>",
  "body": "<skill markdown body>"
}
```

Writes a `.md` skill under `$REFLEX_HOME/skills/` (global) or
`<root>/.reflex/skills/` (project). See [skills.md](skills.md).

### `<<reflex:workflow-create>>`

```json
{
  "id": "...",
  "label": "...",
  "trigger": "manual" | "hourly" | "daily" | "weekly",
  "steps": [
    { "id": "fetch", "kind": "web-fetch", "label": "…", "params": {...} },
    { "id": "summ",  "kind": "ask-agent", "label": "…", "params": {...} }
  ]
}
```

See [workflows.md](workflows.md) for step shapes.

### `<<reflex:suggestion>>`

```json
{
  "kind": "topic" | "workflow" | "utility" | "kb",
  "label": "Set up a daily news digest",
  "rationale": "You mentioned…",
  "action": { "...": "..." }
}
```

Surfaces a card on the Space dashboard. The action payload is
shape-dependent on `kind`.

### `<<reflex:onboarding-done>>`

```json
{}
```

Marks the per-Space onboarding wizard as complete. The wizard hides
on next dashboard render.

### `<<reflex:dispatch>>`

```json
{
  "prompt": "…",
  "harness": "claude-code" | "codex",
  "model": "claude-opus-4-7",
  "label": "Research how X works"
}
```

Spins up an ephemeral orchestrator agent in a sub-topic. The orchestrator
uses this when work warrants a fresh context window.

### `<<reflex:image-gen>>`

```json
{
  "prompt": "…",
  "provider": "gemini" | "codex",
  "aspectRatio": "16:9",
  "size": "1024x1024"
}
```

Generated images land in `<root>/.reflex/assets/images/` keyed by
SHA, served via `/api/images/<rootId>/<sha>.<ext>`.

## Lifecycle in a turn

1. User sends a message.
2. Manager builds the system prompt (memory block, utility prompt
   blocks, skill nudges, KB index) and spawns / continues the agent
   subprocess.
3. Agent streams its response. The streaming layer parses markers
   incrementally — closed markers fire immediately, so a `<<reflex:kb>>`
   at the start of the response is written before the agent finishes
   the final sentence.
4. Marker handlers in `manager.ts` mutate state (memory, KB, tasks,
   …) and emit a "handled" event on the topic's event stream so the
   UI re-renders the card.
5. After stream close, manager persists the cleaned transcript +
   marker confirmations to `<topicId>.events.jsonl`.
