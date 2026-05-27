# Knowledge base

The KB is Reflex's content store — plain markdown files with YAML
frontmatter, organised under `<root>/.reflex/kb/`. There is no
database; the file tree IS the index.

## Layout

```
<root>/.reflex/
├── INDEX.md                       — agent-curated top-level summary
├── kb/
│   ├── note/                      — kind directories
│   │   ├── oauth-refresh.md
│   │   └── caching-strategy.md
│   ├── article/
│   ├── diagram/
│   ├── task/                      — written by the task-board utility
│   └── ...
└── ...
```

Each file is a `kb-entry`:

```yaml
---
kind: note
id: kb-2026-05-27-a1b2c3
title: How OAuth refresh works
slug: oauth-refresh
date: 2026-05-27
tags: [auth, security]
sourceTopicId: 2026-05-27-…       # which chat created this
---
# How OAuth refresh works
Body in markdown…
```

`kind` is the top-level subdirectory. It's a free string — common
values are `note`, `article`, `diagram`, `news`, `task`, but utilities
add their own. The KB reader uses `kind` to route to a renderer (e.g.
`diagram` → Mermaid component, `task` → task-board's card preview).

## Writing entries

Programmatic: `lib/server/agents/kb-writer.ts` exports `writeKbEntry`:

```ts
await writeKbEntry({
  rootPath: "...",
  kind: "note",
  title: "...",
  body: "...",
  slug: "...",        // optional, derived from title if absent
  meta: { tags: ["..."] },
  sourceTopicId: "...",
});
```

The writer:

- Normalises the slug (lowercase, hyphenated, max length).
- Resolves collisions by appending `-2`, `-3`, …
- Writes the file at `<root>/.reflex/kb/<kind>/<slug>.md`.
- Returns `{relPath, abs}`.

Agent-driven: the orchestrator emits `<<reflex:kb>>` (see
[markers.md](markers.md)). The manager calls `writeKbEntry`.

Utility-driven: `reflex.kb.add(...)` from inside a utility iframe or
server action, gated by `permissions.kb.write` and (optionally)
`permissions.kb.kinds`.

## Reading

`lib/server/kb.ts` exposes:

- `listKbFiles(rootPath, { kind?, query? })` — walks the KB tree,
  returns metadata for every entry.
- `readKbFile(rootPath, relPath)` — returns the parsed frontmatter +
  body.
- `kbBySlug(rootPath, kind, slug)` — single-file lookup.

`listKbFiles` is used by:

- The sidebar tree component on `/roots/[id]`.
- The system-prompt KB index snippet (so the agent sees titles +
  kinds before going into a turn).
- Utilities through `reflex.kb.list({kind, query, rootId})`.

## `kind` conventions we follow

| Kind | Purpose | Renderer hints |
|---|---|---|
| `note` | Default; free-form markdown | Plain |
| `article` | Long-form, structured | Adds a TOC |
| `diagram` | Mermaid source in body | Renders Mermaid |
| `news` | Single news item, often with `sourceUrl` | List view |
| `task` | Written by the task-board utility | Card view |
| `question` | Open question waiting on user input | Highlighted |
| `learning` | learn-anything utility output | Article-like |

Renderers live in `app/roots/[id]/kb/[...slug]/_components/`.
Anything without a renderer falls back to plain markdown.

## INDEX.md

Each Space's root has a top-level `INDEX.md` curated by the agent.
The agent treats this as its rolling "what's in this knowledge base"
summary. Init (`reflex init`) builds the first version by walking the
project; subsequent updates happen through `<<reflex:kb>>` markers
that target `INDEX.md` explicitly.

## File-watcher refresh

`reflex watch <dir>` (and the dev server's chokidar layer) watches
the project directory for non-`.reflex/` changes. When the user adds
or edits a file, the watcher schedules a debounced `init` re-run so
the KB stays in sync.

Debounce floor: 30 minutes by default (`watchDebounceMs` in
`.reflex/config.json`), so the agent doesn't churn on every save.

## `.reflexignore`

Gitignore-syntax file at `<root>/.reflexignore`. The walker honours
it the same way git does. `.reflex/` itself is always ignored (the
agent never recurses into its own output).

## Why markdown, not JSON?

- Diffs read cleanly in git.
- The user can edit by hand in any markdown editor.
- Searchable with grep / `searchSessions` / any future indexer.
- LLMs read markdown natively — no parser layer between disk and
  prompt.

The trade-off: schema enforcement is in the writer, not the file.
`writeKbEntry` is the single chokepoint that guarantees frontmatter
shape. Tools that bypass it (a user editing by hand) might write
inconsistent frontmatter — the reader is lenient and shows what it
has.
