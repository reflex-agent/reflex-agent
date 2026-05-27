# Host API reference

The host API is the single namespace through which a utility (running
in an iframe or a worker thread) talks to Reflex. Every method is
gated by a permission slot in the utility's manifest and wrapped in
an audit trail.

```
utility iframe / worker
        │
        ▼
POST /api/utilities/<scope>/<id>/host   { method, args }
        │
        ▼
dispatchHostMethod(method, args, ctx)
        │
        ▼  permission check  → audit start
   handler(...)
        │  audit end with result
        ▼
        return JSON
```

Source: `lib/server/utilities/host-api.ts`.

## Methods

| Method | Permission | Returns |
|---|---|---|
| `llm.complete` | `llm.tasks: [task]` | `{text}` from the assigned model |
| `kb.add` | `kb.write` (+ `kb.kinds` if set) | `{relPath, abs}` |
| `kb.list` | `kb.read` | Array of entries |
| `kb.read` | `kb.read` | `{meta, body}` |
| `fs.read` | `fs.sandbox` | `{content}` inside sandbox dir |
| `fs.write` | `fs.sandbox` | `{ok}` |
| `fs.list` | `fs.sandbox` | Dir listing |
| `web.fetch` | `web.fetch.domains` whitelist | HTTP response |
| `web.search` | `web.search` | Search hits |
| `audit.log` | `audit.write` | `{ok}` |
| `actions.invoke` | always allowed (self-call) | Action's return value |
| `mcp.call` | `mcpServers` whitelist | Tool result |
| `mcp.listServers` | `mcpServers` (filtered) | Array of server ids |
| `mcp.listTools` | `mcpServers` (filtered) | Array of tools |
| `secrets.get` | declared in `manifest.secrets` | `{value}` |
| `secrets.list` | always (declared keys only) | Array of metadata |
| `agent.invoke` | `agent.invoke` | Ephemeral orchestrator's reply |
| `workflow.list` | `workflow.read` | Array of `WorkflowDef` |
| `workflow.read` | `workflow.read` | Single workflow |
| `workflow.run` | `workflow.run` | `{runId}` |
| `cards.update` | always (own utility) | `{ok}` |
| `images.generate` | `images.generate` | `{url, sha, mime}` |
| `images.search` | `images.search` | Hits |
| `images.attach` | `images.attach` + `web.fetch.domains` | `{url, sha}` |
| `images.pickBest` | `images.search` | The chosen candidate |
| `mermaid.validate` | always | `{ok, errors[]}` |
| `tasks.create` | task-board utility only | `{taskId}` |
| `tasks.update` | task-board utility only | `{ok}` |
| `tasks.delete` | task-board utility only | `{ok}` |
| `tasks.get` | task-board utility only | Task entry |
| `tasks.list` | task-board utility only | Tasks |
| `tasks.dispatch` | task-board utility only | `{topicId, worktree?}` |
| `tasks.observe` | task-board utility only | `{status, lastAssistantText, pending, events}` |
| `tasks.complete` | task-board utility only | `{ok}` |
| `git.isRepo` | always (read-only) | `boolean` |
| `git.hasRemote` | always (read-only) | `boolean` |
| `git.hasGhCli` | always (read-only) | `boolean` |
| `git.worktree.create` | task-board utility only | `{dir, branch, baseRef}` |
| `git.worktree.merge` | task-board utility only | `{ok}` or `{conflicts}` |
| `git.worktree.remove` | task-board utility only | `{ok}` |
| `git.worktree.list` | task-board utility only | Array |
| `sessions.search` | `sessions.search` | `{hits}` (see [sessions.md](sessions.md)) |

"task-board utility only" methods are gated by hard-coded checks on
`ctx.utility.manifest.id` — task primitives aren't a general
permission slot yet because their security model (spawning subprocess
agents, mutating worktrees) is sensitive enough that opening it to
any utility would need a separate UX pass.

## Audit trail

Every call writes a start + end pair in `~/.reflex/audit/<date>.jsonl`:

```jsonl
{"ts":"...","scope":"global","utilityId":"task-board","channel":"iframe","method":"kb.list","args":{...},"correlationId":"..."}
{"ts":"...","correlationId":"...","status":"ok","result":{...},"durationMs":12}
```

`channel` is `iframe` (called from the utility UI), `worker` (called
from a server action), or `internal` (server-side wiring).

`/audit` (the audit log UI) reads these files and renders a timeline
filtered by utility / method / status.

## Calling from a server action

Server actions get a `host` proxy with the same surface:

```ts
export async function run(args, host) {
  const kb = await host.kb.list({ kind: "task" });
  const reply = await host.llm.complete({ prompt: "..." });
  return { count: kb.length, summary: reply.text };
}
```

The proxy routes back through `dispatchHostMethod` with
`ctx.channel = "worker"`. Same permissions, same audit.

## Calling from the iframe

The iframe loads a small bridge that exposes the same shape:

```js
const kb = await reflex.kb.list({ kind: "note" });
await reflex.cards.update({ snapshot: {...} });
```

Under the hood it's a `postMessage` to a per-mount nonce-guarded
listener. The response is a Promise that resolves to the JSON result
or rejects with `{error: "..."}`.

## Errors

Every handler throws on:

- Schema-invalid args (zod parse error, surfaced as
  `"<method>: <zod message>"`).
- Permission denied (`"utility X lacks permissions.Y"`).
- Timeout (worker only — based on `serverActions[].timeoutMs`).
- Underlying failure (e.g. `kb.add` on a malformed slug).

The iframe / worker receives the message and decides how to surface
(toast, inline error). The audit trail captures every failure for
debugging.

## Adding a new method

1. Add a `*Schema = z.object({...})` near the top of `host-api.ts`.
2. Add a permission slot in `PermissionsSchema` in
   `lib/server/utilities/types.ts`.
3. Add a `case "yourns.method":` in the dispatch switch.
4. Add the handler `async function yourMethod(ctx, args)`. Check the
   permission first, do the work, return JSON.
5. Update this doc.

Keep handlers in the same file as the dispatch — finding what a
method does should never require a hunt.
