# Architecture

Reflex is a single Node.js process. It runs as a Next.js server (App
Router, Next 15) that owns:

- the HTTP / web UI;
- a background workflow scheduler;
- subprocess agents (Claude Code CLI / Codex App Server JSON-RPC);
- a sandbox for utility iframes;
- a worker pool that hosts utility server actions out-of-process.

There is no external database. Everything Reflex persists lives in
plain files: markdown for content, JSON for state, SQLite only for the
session-search FTS5 index.

## Two homes

Reflex distinguishes two filesystem roots:

- **`REFLEX_HOME`** — global state shared across every Space.
  Defaults: `~/.reflex` (dev) / `~/.reflex-agent` (prod). Holds
  `registry.json`, `settings.json`, global memory, MCP configs,
  installed global utilities, the FTS5 sessions DB.
- **`<root>/.reflex/`** — per-Space state, scoped to one directory the
  user registered as a "Reflex root". Holds the KB tree, chat topics,
  per-project memory, project utilities, worktrees, journal.

`reflexHome()` and `reflexRoot(path)` are the two helpers that resolve
these — never hard-code paths.

## Layered diagram

```
┌───────────────────────────────────────────────────────────────────┐
│                       Next.js App Router                          │
│  /roots/[id]      /utilities      /onboarding    /settings        │
└───────────┬───────────────────────────────────────────────────────┘
            │                          server actions, route handlers
            ▼
┌───────────────────────────────────────────────────────────────────┐
│                       lib/server/  (server-only)                  │
│                                                                   │
│  ┌──────────┐  ┌────────┐  ┌────────┐  ┌─────────────────┐        │
│  │  memory  │  │   kb   │  │ topics │  │  sessions (FTS5)│        │
│  └──────────┘  └────────┘  └────────┘  └─────────────────┘        │
│                                                                   │
│  ┌────────────────────────────┐   ┌─────────────────────┐         │
│  │  workflows  +  scheduler   │   │   utilities         │         │
│  │  (runner, system-tasks)    │   │   (host-api,        │         │
│  └────────────────────────────┘   │    worker-pool,     │         │
│                                   │    iframe bridge)   │         │
│  ┌────────────────────────────┐   └─────────────────────┘         │
│  │ agents (Claude Code / Codex)                                   │
│  │  manager → runtime → protocol (<<reflex:*>> markers)           │
│  └────────────────────────────────────────────────────────────────│
└───────────────────────────────────────────────────────────────────┘
```

## The boot path

`app/layout.tsx` is the root layout — it runs on every request, but
the dynamic flag forces server-render. Two side effects happen at
import time:

1. `startScheduler()` (idempotent, guarded by a global) boots the
   workflow scheduler singleton. From that point on, every minute it
   ticks through registered Spaces and system tasks.
2. The root layout pulls the locale + messages for next-intl.

There is no separate worker process. The scheduler runs inside the
same Node process as the HTTP server, with `setInterval(...).unref()`
so it doesn't block shutdown.

## Process model

```
┌─ Next.js (Node)
│   ├─ Scheduler tick loop (in-process)
│   ├─ Utility iframe ↔ /host route ↔ host-api dispatcher
│   ├─ Worker-pool   (spawned per utility action invocation)
│   └─ Agent subprocess (per active chat / dispatched task)
│        ├─ Claude Code CLI (execa)  — protocol via stdout markers
│        └─ Codex App Server         — JSON-RPC over stdio
└─ MCP servers (one subprocess per registered server, on demand)
```

Each "active" agent is a child process owned by the
`AgentRuntimeState` for one topic. The state map is keyed by
`(rootId, topicId)`; killing the process flushes the entry.

## Cross-cutting subsystems

| Subsystem | Doc | Lives in |
|---|---|---|
| Memory (8-file taxonomy) | [memory.md](memory.md) | `lib/server/memory/` |
| Sessions (FTS5 recall) | [sessions.md](sessions.md) | `lib/server/sessions/` |
| Knowledge Base | [kb.md](kb.md) | `lib/server/kb.ts`, `lib/server/agents/kb-writer.ts` |
| Topics (chats) | [topics.md](topics.md) | `lib/server/topics.ts` |
| Workflows + scheduler | [workflows.md](workflows.md) | `lib/server/workflows/` |
| Utilities + extensions | [utilities.md](utilities.md) | `lib/server/utilities/` |
| Markers protocol | [markers.md](markers.md) | `lib/server/agents/protocol.ts` |
| Host API surface | [host-api.md](host-api.md) | `lib/server/utilities/host-api.ts` |
| Skills | [skills.md](skills.md) | `lib/server/agents/skills/` |
| Tasks / worktrees | [tasks.md](tasks.md) | `lib/server/tasks/` + `rflx-task-board` |

## Design constraints we keep

- **No database, no daemon.** Reflex is `npx`-installable. Adding a
  Postgres or a watchdog would tank that. SQLite (built-in to Node 24)
  is acceptable for indices, not for primary state.
- **Markdown is the source of truth.** Memory, KB, topics, journals,
  tasks — all plain markdown with YAML frontmatter. Indices can be
  rebuilt from files.
- **Local-first.** Network is opt-in (LLM calls, web fetch, GitHub
  installer). Reflex must function offline for browsing + reading.
- **Agent-extensible.** New behaviour comes either through markers
  (writing primitives in core) or utilities (installable extensions).
  The core stays small; capability lives in installable units.
