# Memory

Reflex's memory is a small, fixed taxonomy of plaintext files that get
loaded into every chat's system prompt. The goal isn't a vector store
or a knowledge graph — it's the bounded, curated context that lets the
agent know who the user is across sessions without re-asking.

## Files and scopes

Eight files, two scopes:

| File | Description | Cap (lines) | Tier |
|---|---|---|---|
| `PERSONA` | Name, location, role, workplace, family, language | 20 | 1 |
| `VALUES` | Operating principles, how the user prefers to be addressed | 15 | 1 |
| `INTERESTS` | Active topics, hobbies, learning targets | 20 | 2 |
| `GOALS` | Life and work goals (not per-task `/goal`) | 20 | 2 |
| `RELATIONSHIPS` | Key people: name, role, last shared context | 20 | 2 |
| `ROUTINES` | Daily and weekly rhythms (wake, work, exercise) | 15 | 2 |
| `AVOID` | Explicit "don't suggest" — topics, words, people | 15 | 2 |
| `RECENT` | Rolling summary of the last ~7 days | 30 | 3 |

Scopes:

- **Global** — `$REFLEX_HOME/memory/<FILE>.md`. About the user, across
  every Space.
- **Project** — `<root>/.reflex/memory/<FILE>.md`. About this Space.

The taxonomy is intentionally fixed. Custom user-defined blocks would
make the system less predictable for the agent and harder to render.
If a fact doesn't fit, the agent puts it in `RECENT` (decays) or
recommends a KB entry instead.

## Injection into the system prompt

`buildMemoryBlock({rootPath})` renders both scopes into one block under
`## About the user` (global) and `## About this project` (per-Space).
Tiers are nested headings:

```
## About the user
### Identity
**PERSONA**
…
**VALUES**
…
### Current
**INTERESTS**
…
**GOALS**
…
### Last 7 days
**RECENT**
…
```

The renderer drops empty files and empty tiers — the block only
appears when there's signal. There is **no `readMemory` tool exposed
to the agent**. Memory is what the agent IS, not something it queries
mid-turn.

## Writing memory: markers

The agent persists memory by emitting a marker inside its response:

```
<<reflex:memory>>{
  "scope": "global" | "project",
  "file": "PERSONA",
  "op": "append" | "replace" | "remove",
  "content": "Lives in Berlin, wakes early.",
  "match": "<substring>"   // only for op:remove
}<</reflex:memory>>
```

The marker parser intercepts these from the assistant stream, calls
`writeMemory()`, and rewrites the marker into a confirmation card in
the rendered transcript.

The agent is told to emit memories proactively — corrections, stable
facts, preferences. It does not ask permission first; the user can
undo through the memory editor in `/settings`.

## Caps + auto-compaction

Every file has a hard line cap (`FILE_CAPS`). The store enforces it:

- `op: "append"` — if `current.lines + addition.lines > cap`, the
  store calls `compactFile()` which asks the user-configured `quick`
  model to merge the existing content + the new entry into ≤cap lines.
  If compaction still doesn't fit, the append is dropped (we don't
  loop). If compaction errors, append fails with `compact-failed`.
- `op: "replace"` — outright `cap-exceeded` error; caller is the
  agent or the user, both can decide.

This is borrowed from Hermes Agent's approach: bounded memory forces
selection over accumulation. The line-count budget is the line-by-line
mental model the agent maintains; a 25-line file is "approximately one
screen worth" and that's how the agent treats it.

## Hygiene scanner

Before any write actually lands, `checkMemoryHygiene()` runs:

- **Prompt-injection wrappers**: `<system>`, `<user>`, `<assistant>`,
  `[INST]`, `<|im_start|>`, and our own `<<reflex:*>>` syntax in the
  payload are all refused. Memory feeds the system prompt; we will
  not let a scraped page or chat paste redefine the agent's identity.
- **Credentials**: `sk-…`, `ghp_…` and other GitHub token prefixes,
  `AKIA…` AWS keys, JWT-shaped triples, Slack tokens, PEM private-key
  blocks. Refused with a hint to use the secrets store instead.
- **Invisible / bidi unicode**: zero-width chars, soft hyphen, bidi
  overrides, BOMs, and the TAG block (U+E0000–U+E007F). Refused
  rather than silently stripped — silent edits are dishonest.
- **Exact-line duplicates on append**: if every line in the addition
  is already present in the file, the append is refused with
  `nothing to add`.

`replace` ops skip the dup check (the whole file is overwritten by
intent) but still run injection + credential + unicode passes.

## Memory rollup (weekly system task)

`system:memory-rollup` is a built-in scheduled task (see
[workflows.md](workflows.md)) that runs once a week:

1. Walks every registered Space's `.reflex/journal/*.md`.
2. Sorts entries newest-first, caps at 60 entries, 400 chars per
   entry body.
3. Asks the `quick` model to summarise into ≤25 third-person lines
   covering recurring themes, mood arc, unresolved threads, wins.
4. Calls `writeMemory({scope:"global"}, "RECENT", "replace", {content})`.

If fewer than 4 journal entries exist across all Spaces, the task
skips silently — there's nothing to roll up yet.

## Editing memory directly

`/settings → Memory` exposes both scopes. The user can edit any file
inline; the editor is plain `<textarea>` with the file cap shown so
they know when they're about to bump it. The agent does not see edits
until its next turn (memory is read at the start of each system-prompt
build).

## Related markers

| Marker | Purpose |
|---|---|
| `<<reflex:memory>>` | Persist a fact in memory |
| `<<reflex:suggestion>>` | Surface a dashboard suggestion (not memory) |
| `<<reflex:onboarding-done>>` | Finish the onboarding wizard |

See [markers.md](markers.md) for the full protocol.

## Why not per-block descriptions / custom blocks?

`opencode-agent-memory` and Letta allow custom memory blocks with
description metadata. We chose a fixed taxonomy after experiments —
the agent and the user both reason better about a small set of named
concepts ("AVOID", "ROUTINES") than about an open-world list. Adding a
new block changes the schema, not the data; that's a deliberate
friction.
