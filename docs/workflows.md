# Workflows

Workflows are linear "recipes" the user (or the agent) composes from a
handful of typed step kinds. No DAGs, no branching syntax, no code
mode — they're meant for non-programmers. The agent can author them
via `<<reflex:workflow-create>>`; the UI lets the user tweak steps
after creation.

## File layout

Per-Space workflows live as JSON under:

```
<root>/.reflex/workflows/<workflow-id>.json
```

Each is a `WorkflowDef`:

```ts
interface WorkflowDef {
  id: string;
  label: string;
  description?: string;
  trigger: "manual" | "hourly" | "daily" | "weekly";
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  sourceTopicId?: string;
  enabled?: boolean;  // scheduler-only; defaults to true
}
```

Workflow runs are stored as JSON per run under:

```
<root>/.reflex/workflows/runs/<workflow-id>/<run-id>.json
```

## Step kinds

Defined in `lib/server/workflows/types.ts`. Each kind has a
`WorkflowKindMeta` entry with `defaultParams` and `fields` (UI hints).

| Kind | Purpose |
|---|---|
| `text-template` | Glue: assemble text from a template with `{{prev}}`, `{{steps.<id>.output}}`, `{{input.<field>}}` |
| `http-request` | HTTP request with method / headers / body. JSON-aware response |
| `web-fetch` | Fetches a URL and returns its textual content |
| `ask-agent` | Runs a headless orchestrator agent with a question; output is its reply |
| `kb-write` | Saves to the knowledge base with frontmatter (kind, title, body) |
| `utility-call` | Invokes a named server action of an installed utility |
| `image-generate` | Generates an image (Gemini / Codex), returns `{url, sha, mime, provider}` |
| `image-search` | Searches Unsplash / Pexels / Brave for images |

## Templates

Strings inside step params are rendered before the handler runs.
Substitution syntax:

- `{{prev}}` — output of the immediately preceding step
- `{{steps.<id>.output}}` — output of step `<id>`, dotted access for
  nested fields (`{{steps.fetch.output.title}}`)
- `{{input.<field>}}` — fields from the trigger input (when run
  manually or via `reflex.workflow.run({input})`)
- `{{workflow.label}}` — the workflow's own label

## Triggers + scheduler

- `manual` — run only when explicitly invoked (button in UI,
  `/workflow` command, `reflex.workflow.run(...)`).
- `hourly` / `daily` / `weekly` — picked up by the background
  scheduler.

### Scheduler

`lib/server/workflows/scheduler.ts` runs a singleton tick loop every
60 seconds. On each tick it:

1. Walks every registered root.
2. For each project workflow, combines it with utility-provided
   workflows (`manifest.extensions.workflows`).
3. Filters out: `manual` triggers, `enabled: false` entries, runs
   whose interval hasn't elapsed since the last run.
4. Runs the eligible workflows; failures are logged, never blocking.
5. After the root loop, runs system tasks.

The scheduler:

- Boots automatically from `app/layout.tsx` (idempotent, guarded by
  a global flag — HMR-safe).
- Uses `setInterval(...).unref()` so it never blocks Node shutdown.
- Guards against overlapping ticks (`handle.running`).
- Tracks last-fired time in memory; falls back to the on-disk last
  run's `startedAt` when the in-memory cache is cold (after restart).

## `enabled` flag

`enabled?: boolean` on `WorkflowDef` lets the user pause a scheduled
workflow without changing its trigger or deleting it. Defaults to
`true` (absent = enabled, for back-compat).

Behaviour:

- Scheduler skips `enabled: false` outright.
- Manual runs (button, `/workflow`, `runWorkflow` API) ignore the flag
  and still fire.
- The list page UI exposes a Switch per row. Utility-provided
  workflows show as read-only with a "from `<utility-id>`" badge — to
  disable them, uninstall or fork the utility.

`setWorkflowEnabledAction(rootId, wfId, enabled)` is the server action.

## System tasks (cross-project)

`lib/server/workflows/system-tasks.ts` defines `SYSTEM_TASKS`. These
share the scheduler tick loop but aren't full `WorkflowDef` instances
— each has its own implementation and **isn't bound to any single
project**.

| Id | Trigger | Purpose |
|---|---|---|
| `system:memory-rollup` | weekly | Aggregates journal entries across all Spaces, summarises into global `RECENT.md` |
| `system:sessions-index` | hourly | Incremental FTS5 reindex of `.reflex/journal/*.md` + `.reflex/topics/*.md` across all roots |

System tasks are not configurable per project. They're owned by
core because their effect is cross-Space (memory rollup) or
cross-Space + index-global (sessions). New system tasks live in
`system-tasks.ts` and need a `trigger` + `run` function returning
`{ok, detail?}`.

## Authoring via marker

The orchestrator can emit:

```
<<reflex:workflow-create>>
{
  "id": "morning-news",
  "label": "Morning news digest",
  "trigger": "daily",
  "steps": [
    {
      "id": "fetch",
      "kind": "web-fetch",
      "label": "Get hacker news front page",
      "params": { "url": "https://news.ycombinator.com" }
    },
    {
      "id": "summ",
      "kind": "ask-agent",
      "label": "Summarise top stories",
      "params": { "prompt": "Summarise the top 5 of: {{prev}}" }
    },
    {
      "id": "save",
      "kind": "kb-write",
      "label": "Save to KB",
      "params": {
        "kind": "news",
        "title": "Daily HN digest",
        "body": "{{steps.summ.output}}"
      }
    }
  ]
}
<</reflex:workflow-create>>
```

The manager writes the file, runs an initial smoke test (manual
trigger), and surfaces the workflow under `/roots/[id]/workflows`.

## Runner internals

`lib/server/workflows/runner.ts` is the executor:

1. Loads the def, opens a new run file with `status: "running"`.
2. For each step:
   - Renders params via the template engine.
   - Dispatches to the kind's handler in
     `lib/server/workflows/nodes.ts`.
   - Captures output, status, error, timestamps into
     `run.steps[]`.
3. Run status flips to `completed` / `failed` / `cancelled` based on
   step results.

Steps run sequentially. There is no retry, no branching — if a step
fails, the run fails and subsequent steps are `skipped`.

## UI

- `/roots/[id]/workflows` — list. Toggle, last-run, next-run, "from
  utility" badge.
- `/roots/[id]/workflows/[wfId]` — detail. Edit steps, view runs,
  inspect rendered params per step in a past run.
