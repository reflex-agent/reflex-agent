# Utilities

Utilities are installable extensions that bundle a UI, server actions,
and (optionally) slash commands, skills, system-prompt addenda, and
workflows. They're the way capability lands in Reflex without
modifying core.

Examples that ship in the curated registry:

- `learn-anything` (separate repo `reflex-agent/rflx-learn-anything`)
- `task-board` (separate repo `reflex-agent/rflx-task-board`)

## Anatomy

A utility is a directory with:

```
my-util/
├── manifest.json           — required: id, version, permissions, etc.
├── ui.tsx                  — the iframe entry component
├── actions/                — server-action TS files
│   ├── refresh.ts
│   └── pickup.ts
├── settings.tsx            — optional settings panel
└── README.md
```

`manifest.json` is validated against `ManifestSchema` in
`lib/server/utilities/types.ts`. Required fields:

- `id` — kebab-case, globally unique.
- `name` — human-readable.
- `version` — semver.
- `ui` — relative path to the entry component (default `ui.tsx`).
- `serverActions[]` — each with `{name, entry, timeoutMs}`; `entry`
  must be a relative `.ts` file (not `.tsx`).
- `permissions` — see below.
- `secrets[]` — declarations. Values are never in the manifest;
  the user fills them in the utility panel.

Optional:

- `card` — declarative dashboard widget the utility owns.
- `mcpServers[]` — IDs of MCP servers the utility may call.
- `extensions` — see "Extension model" below.
- `source` — provenance: `{type: "agent" | "github" | …}`.

## Permissions

`manifest.permissions` is an explicit allowlist. The host API refuses
any call whose required permission isn't granted.

```ts
{
  llm: { tasks: ["chat", "quick", "rag", "embed"] },
  kb:  { read: true, write: true, kinds: ["note", "task"] },
  fs:  { sandbox: true },         // sandbox dir is the only fs path
  web: {
    fetch: { domains: ["example.com"] },
    search: true,
  },
  audit: { write: true },
  workers: { enabled: true, maxConcurrent: 2 },
  agent: { invoke: true },        // ephemeral orchestrator
  workflow: { read: true, run: true },
  images: {
    generate: true,
    search: true,
    attach: true,
    // External image hosts the iframe may render via <img src>. Each is
    // appended to the iframe CSP's img-src as https://<host>. The browser
    // loads them directly — no proxy. Bare hostnames, optional `*.`.
    domains: ["cdn.legost.in", "*.imgix.net"],
  },
  sessions: { search: true },     // FTS5 recall
}
```

Permissions are inspected during install (the dialog warns the user)
and at every dispatch (host-api.ts).

## Scopes: global vs project

Two install scopes:

- **Global** — `$REFLEX_HOME/utilities/<id>/`. Available in every
  Space's chat command palette / dashboard.
- **Project** — `<root>/.reflex/utilities/<id>/`. Available only in
  that Space.

`listUtilities({rootId})` returns the union (global + this project's
local). `listUtilities({})` returns only globals.

Install + scope choice happens in the install dialog. The user sees
both options if the utility doesn't pin one.

## Extension model (`manifest.extensions`)

Beyond having its own UI + actions, a utility can extend the chat
experience. The aggregator
`collectExtensions({rootId})` in `lib/server/utilities/extensions.ts`
unions extensions from every installed utility.

```ts
manifest.extensions: {
  slashCommands: [{
    name: "kanban",
    label: "Open the board",
    description: "...",
    arg: "optional-name",
  }],
  skills: [{
    id: "deep-research",
    label: "Deep research",
    description: "...",
    body: "<markdown skill>",
  }],
  workflows: [{
    id: "task-board-auto-pickup",
    label: "Pick up the next ready task",
    trigger: "hourly",
    steps: [...]
  }],
  systemPromptAddendum: "When the user asks about tasks, …",
}
```

Consumers:

- **Slash commands** — `commands-registry.ts` exposes them via the
  chat `/` palette. Selecting one wires the chosen value into the
  agent's next user message.
- **Skills** — `skills/loader.ts` includes them in `listSkills()` /
  `loadSkill()`. The orchestrator can `/skill <id>` to load one.
- **Workflows** — `scheduler.ts` and the `/workflows` list page
  union them with project workflows. They're tagged "from `<id>`" in
  the UI and read-only.
- **System-prompt addendum** — `chatSystemPrompt()` concatenates all
  blocks before the agent's instruction.

## Dependencies (esm.sh, bundled at build)

A utility can use third-party npm packages by declaring them:

```json
"dependencies": { "dayjs": "1.11.10", "zod": "3.23.8" }
```

At **build time** esbuild resolves a bare import of a listed package to
`https://esm.sh/<pkg>@<ver>` and inlines it into `bundle.js` (transitive
deps too). Fetched bytes are cached under `<utility>/dist/.esm-cache/`,
so rebuilds are offline + deterministic. **Nothing is fetched at
runtime** — the iframe CSP stays `connect-src 'none'`.

Rules:

- A bare import NOT in `dependencies` (and not React/`@host/*`) is a
  build error — `dependencies` is the allowlist the user reviews at
  install.
- Pin exact versions (ranges work but lose reproducibility).
- React is shared with the host (`?external=react,...`) — no duplicate
  copy.
- Pure-JS/ESM packages only. node-native (binary) packages won't work in
  action bundles.
- No `npm install`, no per-utility `node_modules`, no postinstall
  scripts — esm.sh serves pre-built ESM.

## Server actions: auto-discovery

You don't have to hand-list every action in `manifest.serverActions`.
Any top-level `actions/<name>.ts` is auto-registered as an action named
`<name>` at install (timeout 30s). Files whose basename starts with `_`
(`_store.ts`, `_types.ts`) are treated as private helpers and skipped.
Explicitly declared actions win (use that to set a custom `timeoutMs`).
The expanded list is persisted into the stored `manifest.json`.

## Multiple views (router)

`@host/ui` ships a tiny in-memory router (the iframe has no address bar):

```tsx
import { RouterView, useReflexRoute } from "@host/ui";

function Board({ navigate }) { return <button onClick={() => navigate("detail", { id: 7 })}>open</button>; }
function Detail({ params, back }) { return <button onClick={back}>← {params.id}</button>; }

export default function App() {
  return <RouterView routes={{ board: Board, detail: Detail }} initial="board" />;
}
```

Each view receives `{ params, navigate, back, replace, route, canBack }`.
For manual control use `useReflexRoute(initial)` directly.

## Host API (the bridge)

The utility iframe talks to the host through `postMessage` against a
single endpoint:

```
POST /api/utilities/<scope>/<id>/host
{ method: "kb.add", args: {...} }
```

The route validates the request came from the iframe (origin + per-
mount nonce), then calls `dispatchHostMethod(method, args, ctx)` in
`lib/server/utilities/host-api.ts`. Every method:

- Validates `args` with a zod schema.
- Checks the relevant permission slot.
- Wraps the call in audit start/end (`auditCall`).
- Returns JSON or a typed error.

The list of methods is in [host-api.md](host-api.md).

## Worker pool (server actions)

`manifest.serverActions[]` runs out-of-process in `worker-pool.ts`.
Each invocation spawns a Node worker thread that:

1. Loads `worker-bootstrap.js`.
2. Resolves the utility's bundle (`esbuild`-compiled at install time).
3. Imports the action entry, calls `run(args, host)`.
4. Returns the JSON-serialisable result.

Timeouts come from `serverActions[].timeoutMs` (max 600s). The host
proxy `host.<method>(...)` lets actions call the host API the same way
the iframe does — same audit trail, same permissions.

## Installation flow

Source types:

- `agent` — created in the current chat by the orchestrator (writes
  files into the local utility dir).
- `github` — `github:owner/repo[@ref]`. Fetcher in
  `lib/server/utilities/github.ts` resolves the ref to a SHA, fetches
  `manifest.json`, then BFS-walks relative imports in source files
  (`.tsx`, `.ts`, `.jsx`, `.js`, `.mjs`) to pull every referenced
  file. Probe candidates that don't exist return null silently;
  manifest-declared entries (`ui`, `serverActions[].entry`) are
  required and throw on 404.
- `archive` — uploaded `.zip`.
- `builtin` — shipped in the curated registry.
- `mcp` — synthesised wrapper around an MCP server (legacy path).

`lib/server/utilities/curated-registry.ts` is the curated list shown
in the install gallery. Adding an entry there ships a utility by
default — no extra install step from the user.

## Cards (dashboard widgets)

A utility can declare ONE `card` in its manifest:

```json
"card": {
  "kind": "kpi",
  "title": "Tasks",
  "action": "refreshCard",     // server action returning a fresh snapshot
  "refresh": "hourly",          // background cadence (manual = view-only)
  "data": { "items": [ ... ] }  // placeholder until first live refresh
}
```

Two ways the card stays fresh:

1. **Live action (recommended).** Declare `card.action` — a server
   action that returns a snapshot `{kind, data, title?, description?}`.
   Reflex calls it in a worker (with the utility's host API, so it can
   read `reflex.kb.list` / `reflex.tasks.list` / etc.) on dashboard
   view AND on the `card.refresh` cadence. The card reflects reality
   without the user opening the mini-app. Requires
   `permissions.workers.enabled`.
2. **Push.** From its own iframe / a workflow, the utility calls
   `reflex.cards.update({snapshot})`. Good for "update right after a
   write" but stale otherwise.

Supported `card.kind`: `markdown`, `news-list`, `link-list`, `kpi`,
`checklist`, `quote`, `kb-pinned`, `progress`, `image`, `stat-table`,
`map`, `action-list`. (`utility-card` is the wrapper, not a card kind.)

### `action-list` — interactive cards

`action-list` renders grouped items, each optionally carrying ONE action
button that invokes a server action of the same utility. The snapshot:

```json
{
  "kind": "action-list",
  "title": "Tasks",
  "data": {
    "groups": [
      {
        "label": "Backlog",
        "emptyText": "clear",
        "items": [
          {
            "id": "t-123",
            "title": "Add OAuth rotation",
            "badge": "feature",
            "action": { "label": "Send to agent", "actionName": "dispatchFromCard" }
          }
        ]
      }
    ]
  }
}
```

When the button is clicked, Reflex runs `actionName` (a declared
serverAction, needs `workers.enabled`) with `{ id, ...action.args }`,
then re-runs `card.action` and swaps in the fresh snapshot. This is how
the task-board card dispatches a task without opening the board.

## Why iframe + worker, not in-process?

- **Iframe** gives the utility its own DOM root, lets it ship its own
  React tree, and isolates style + script crashes.
- **Worker thread** gives server actions a clean v8 context, a hard
  timeout knob, and prevents one slow utility from blocking the
  Next.js request loop.

The bridge code in both directions has been the source of more bugs
than the rest of utilities combined, so when a feature can land at the
host-API level instead of a new bridge primitive, it does.
