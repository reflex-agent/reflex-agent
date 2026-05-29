# Tasks (the task-board utility + core primitives)

Task management in Reflex is split across two pieces:

- **Core primitives** in `reflex-agent`: `reflex.tasks.*` and
  `reflex.git.worktree.*` host methods, the `<<reflex:task-create>>` /
  `<<reflex:task-update>>` markers, the `task-question` pending kind,
  and `TopicFrontmatter.taskId`.
- **The `task-board` utility** (`reflex-agent/rflx-task-board`, shipped via
  curated registry): the Kanban UI, board ordering, attachments, the
  auto-pickup workflow, settings, dashboard KPI card.

Most of the user-facing behaviour is in the utility. Core only ships
what the utility's sandbox can't do on its own.

## Data model

A task is a KB entry with `kind: "task"`. The frontmatter is the
source of truth; the body is free-form description.

```yaml
---
id: t-a1b2c3
title: Add OAuth refresh-token rotation
type: feature | bug | refactor | docs | chore | research | review | call | idea
status: backlog | ready | in-progress | review | done | blocked
priority: low | normal | high
labels: [auth, security]
assignee: agent | user-name | null

# Agent binding (written by core via reflex.tasks.dispatch)
topicId: 2026-05-27-...
agentRequested: claude-code

# Git isolation (written by core)
worktree:
  dir: .reflex/worktrees/t-a1b2c3
  branch: task/oauth-refresh
  baseRef: main@<sha>

# Relations (utility-managed)
links:
  blocks: [t-...]
  blockedBy: [t-...]
  related: [t-...]
parent: <task-id>

# Lifecycle hooks (utility-managed; runner in core fires them)
pre:  [{kind: "workflow", id: "fetch-spec"}]
post: [{kind: "workflow", id: "regen-docs"}]

# Attachments (utility-managed)
attachments:
  - {kind: "image", file: "screenshot-1.png", caption: "401 trace"}

createdAt: ...
updatedAt: ...
---
# Description
Markdown body.
```

Board ordering (which column / position) lives in the utility's own
state (`<utility-data>/board.json`) — utility owns presentation, core
owns the source of truth.

## Task types

The `type` field drives:

- whether dispatch creates a worktree (`isCode: true` for code-bearing
  types);
- which skill nudge is included in the dispatch prompt;
- card colour / icon on the board;
- default `pre` / `post` hooks;
- whether **PR mode** applies when the task hits `done`.

| Type | `isCode` | Default skill nudge | Typical post |
|---|---|---|---|
| `feature` | yes | none | regen-docs |
| `bug` | yes | `deep-research` (repro first) | add regression note |
| `refactor` | yes | none | regen-docs |
| `docs` | yes | none | — |
| `chore` | yes | none | — |
| `research` | no | `deep-research` | KB entry summarising findings |
| `review` | yes | none | comment summary |
| `call` | no | none — no auto-dispatch by default | pre: draft agenda; post: meeting notes |
| `idea` | no | none — parked thought | — |

## Lifecycle

1. **Create** — the user clicks "+" on the board, or the agent emits
   `<<reflex:task-create>>`. Utility writes the KB entry under
   `kind: "task"`. Initial status `backlog`.
2. **Move to ready** — user (or agent) drags the card. No side
   effects.
3. **Dispatch** — utility calls `reflex.tasks.dispatch({taskId})`:
   - For code tasks: core creates a worktree on `task/<slug>` from
     `main`, symlinks `.reflex/memory` into the worktree so the
     agent's memory stays consistent.
   - Starts a chat topic bound via `taskId`. The agent runs in the
     worktree dir (code tasks) or the project root (non-code).
   - Status flips to `in-progress`.
4. **Live status** — utility polls `reflex.tasks.observe({taskId})`
   every ~3 seconds while the board view is mounted. The observer
   returns the bound topic's last assistant line, pending interactions,
   and a recent slice of events.
5. **Done** — agent (or user) marks done. If `isCode` and `gh` CLI is
   present + repo has a remote, the "Merge" button becomes "Open PR"
   and runs `gh pr create`. Otherwise local merge.
6. **Cleanup** — auto-prune merged worktrees ON by default. Auto-prune
   unmerged worktrees after 14 days (configurable). Manual "Prune
   now" lists every worktree with age.

## Auto-pickup

Optional. When enabled in the utility's settings:

- The utility registers a workflow `task-board-auto-pickup` with
  trigger `hourly` (via `manifest.extensions.workflows`).
- The workflow's first step is an `ask-agent` that gets the user's
  pickup prompt + a JSON snapshot of `ready` and `in-progress` tasks,
  and returns `{taskId, harness?, model?, reason}`.
- The next step calls `reflex.tasks.dispatch({taskId})`.

The user only sees one toggle. Default OFF.

## Worktrees

`lib/server/tasks/worktree.ts` wraps `git worktree`:

- `createWorktree(rootPath, branch, baseRef)` →
  - Resolves `<root>/.reflex/worktrees/<taskId>` as `dir`.
  - `git -C rootPath worktree add <dir> -b <branch>` from `baseRef`.
  - Symlinks `<dir>/.reflex/memory` → `<rootPath>/.reflex/memory` so
    global + project memory stays consistent across worktrees.
  - Appends `worktrees/` to `.reflexignore` if not already there.

- `removeWorktree(rootPath, branch, {merge})`:
  - If `merge`, `git merge --no-ff <branch>` first. Conflict →
    leaves the worktree intact, returns `{conflicts}`.
  - `git worktree remove --force <dir>`; `git branch -d/-D` based on
    merged state.

Non-git project: dispatch shows a "no isolation" warning and runs the
agent at the project root. Acceptable for KB-heavy projects without
code.

## Pre / post hooks

When the utility dispatches a task:

1. Read `task.pre[]`. Each entry:
   - `{kind:"workflow", id}` → `reflex.workflow.run({workflowId: id})`.
   - `{kind:"chat", prompt}` → buffered and prepended to the agent's
     initial prompt.
2. Dispatch the agent with the combined prompt.
3. When `reflex.tasks.observe` returns `status === "done"`, the
   utility walks `task.post[]` the same way.

Configured per task in the task detail drawer.

## Why a utility, not a core feature?

Originally was planned as core. We landed on utility because:

- The Kanban UI is opinionated. The user might prefer list view,
  calendar view, GTD-style processing — better as installable.
- Core stays small. Worktree + dispatch primitives ARE in core because
  the sandbox can't shell out to git; everything else (board, KPI,
  attachments, ordering) is plain host-API consumer.
- It validates the extension model. Anything we couldn't ship via the
  extension model became a new host-API method instead of a special
  case for the task-board.

## Cross-Space task aggregation, recurring tasks, time-tracking

Not implemented. Deferred. The task-board operates per-Space; if you
want everything in one view, that's a future utility on top of
`reflex.kb.list({kind:"task"})` across roots — or a different utility
entirely.
