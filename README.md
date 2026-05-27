# Reflex

Local-first AI knowledge base + agent platform. You point Reflex at a
directory ("a Space"), and an agent (Claude Code or Codex) becomes
your second brain for that directory: it keeps a knowledge tree, runs
scheduled workflows, recalls past conversations, and dispatches
sub-tasks in isolated git worktrees.

Everything is stored as plain markdown + JSON in your filesystem. No
external database, no cloud, no daemon. The only persistent process is
the Next.js server itself.

## Install

Prerequisites:

- **Node.js 22+** ([nodejs.org](https://nodejs.org/) or `nvm`/`fnm`).
  Node 24 recommended (built-in SQLite powers session search).
- A coding-agent CLI authenticated:
  - `npm i -g @openai/codex && codex login`, or
  - `npm i -g @anthropic-ai/claude-code && claude login`

Install Reflex globally:

```sh
npm i -g reflex-agent
# or: pnpm add -g reflex-agent
```

Launch the web UI:

```sh
reflex start              # opens http://localhost:3210 in your browser
reflex start --port 4000 --no-open
```

Dev runs on `:3211` by default so a `pnpm dev` and an installed
`reflex start` can co-exist without a port collision.

## First run

1. Click **Add a root** on the home screen and pick a directory.
2. On the Space dashboard, the onboarding wizard asks a few short
   questions to seed memory + suggest a first workflow.
3. Open a chat — type in plain language. The agent reads / writes the
   `.reflex/` tree, your memory files, and (with permission) shell +
   web tools.

## What Reflex actually does

### A knowledge base per Space

The agent builds a tree of markdown notes under `<your-dir>/.reflex/`:

```
<your-dir>/
├── .reflexignore        — gitignore-syntax — same rules
└── .reflex/
    ├── INDEX.md         — top-level summary
    ├── kb/              — categorised entries (note, article, diagram, …)
    ├── memory/          — eight files describing the user / project
    ├── topics/          — chat transcripts
    ├── journal/         — daily entries
    ├── workflows/       — saved recipes
    ├── utilities/       — locally-installed extensions
    └── worktrees/       — task-bound git worktrees
```

See [docs/kb.md](docs/kb.md) and [docs/architecture.md](docs/architecture.md).

### Cross-session memory

Eight bounded markdown files capture who the user is and what the
project is about. Every chat starts with this loaded into the system
prompt — the agent never re-asks who you are.

A weekly system task rolls up journal entries into a `RECENT.md`
summary. A hygiene scanner refuses memory writes that look like
prompt injection, credentials, or invisible unicode.

See [docs/memory.md](docs/memory.md).

### Searchable conversation history

Every journal entry + chat transcript across every Space is indexed
into a SQLite FTS5 database under `$REFLEX_HOME/sessions.db`. The
agent (or you, or a utility) can ask "what did we say about X?" with
ranked snippets returning in milliseconds.

See [docs/sessions.md](docs/sessions.md).

### Linear workflows, scheduled

The user (or the agent) composes "recipes" from typed steps —
`web-fetch`, `ask-agent`, `kb-write`, `image-generate`, etc. The
background scheduler fires triggered ones hourly / daily / weekly.

See [docs/workflows.md](docs/workflows.md).

### Installable utilities

Mini-apps that bring a UI iframe, server actions, slash commands,
skills, system-prompt addenda, and workflows. Shipped curated or
installed from GitHub. Two examples ship by default:

- **`learn-anything`** — chat-driven topic learning, materialised into
  the KB.
- **`task-board`** — Kanban board with agent-dispatch, git worktrees,
  pre/post hooks, auto-pickup.

See [docs/utilities.md](docs/utilities.md).

### Agent dispatch via worktrees

Code tasks dispatched from the task-board get an isolated git worktree
on `task/<slug>`, so two parallel agents can work on the same repo
without stepping on each other. PR mode auto-detects `gh` CLI and
turns "Merge" into "Open PR".

See [docs/tasks.md](docs/tasks.md).

## Architecture at a glance

One Node process. Inside it:

- Next.js App Router HTTP server (UI + server actions).
- A background workflow scheduler (in-process singleton).
- A worker pool for utility server actions.
- Subprocess agents (Claude Code / Codex) spawned per topic.
- MCP servers on demand.

Two filesystem homes: `REFLEX_HOME` (global state) and
`<root>/.reflex/` (per-Space).

For the full layer diagram and component map see
[docs/architecture.md](docs/architecture.md).

## Documentation

| Doc | Topic |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System map, process model, two-homes layout |
| [docs/memory.md](docs/memory.md) | 8-file taxonomy, caps, hygiene, weekly rollup |
| [docs/sessions.md](docs/sessions.md) | FTS5 recall over journal + topics |
| [docs/topics.md](docs/topics.md) | Chat transcripts, event log, `/goal` mode |
| [docs/kb.md](docs/kb.md) | Knowledge-base entries, kinds, slug rules |
| [docs/workflows.md](docs/workflows.md) | Step kinds, templates, scheduler, system tasks |
| [docs/utilities.md](docs/utilities.md) | Extension model, manifest, permissions, iframe + worker |
| [docs/host-api.md](docs/host-api.md) | Full `reflex.*` method reference |
| [docs/markers.md](docs/markers.md) | `<<reflex:*>>` protocol reference |
| [docs/skills.md](docs/skills.md) | Skill files, scopes, marker authoring |
| [docs/tasks.md](docs/tasks.md) | task-board utility, worktree mechanics, PR mode |
| [docs/agents.md](docs/agents.md) | Claude Code / Codex App Server integration, permissioning |

## CLI

```sh
reflex start                  # launch the web UI
reflex init <dir>             # scaffold .reflex/ and run initial agent pass
reflex watch <dir>            # watch dir and refresh KB on changes
reflex chat <dir>             # open a chat scoped to dir's KB
```

## Data directory

Reflex stores its global state (registered roots, settings, MCP config,
secrets, skills, sessions index, …) in one directory:

- **Dev (`pnpm dev`)** → `~/.reflex`
- **Prod (`reflex start` via npm-installed CLI)** → `~/.reflex-agent`

Override either by setting `REFLEX_HOME=/your/path` before launching.

## Develop from source

```sh
pnpm install
pnpm dev      # http://localhost:3211 (Next dev server with HMR)
pnpm build    # produce dist/ + .next/ for `reflex start`
pnpm typecheck
```

PRs welcome. The codebase favours small, focused modules — when in
doubt, look at neighbouring files and match the style.

## Config (`.reflex/config.json`)

```json
{
  "watchDebounceMs": 1800000,
  "agentBackend": "codex",
  "ignoreFile": ".reflexignore"
}
```

`watchDebounceMs` defaults to 30 minutes (`1800000`). Lower it for
tighter loops; the enforced minimum is 1 second (anti-thrash).

## License

MIT.
