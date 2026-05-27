# Session search (FTS5)

Reflex indexes every Space's journal entries and chat transcripts into
a single SQLite FTS5 database. Memory tells the agent **what is
durably true**; session search lets it answer **what was mentioned
once, a while ago, and isn't worth promoting to memory**.

## Storage

One database for the whole Reflex install:

```
$REFLEX_HOME/sessions.db
```

Two tables:

```sql
CREATE TABLE documents (
  id          INTEGER PRIMARY KEY,
  source      TEXT    NOT NULL,   -- 'journal' | 'topic'
  root_id     TEXT    NOT NULL,
  root_path   TEXT    NOT NULL,
  ref         TEXT    NOT NULL,   -- filename without .md
  file_path   TEXT    NOT NULL UNIQUE,
  title       TEXT,
  iso_date    TEXT,               -- entry date or createdAt
  mtime_ms    INTEGER NOT NULL,
  indexed_at  INTEGER NOT NULL
);

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

`documents_fts.rowid` matches `documents.id` so search joins are
trivial.

We use `node:sqlite`, Node 24's built-in SQLite. FTS5 ships in the
bundled build — no native dependency, no `better-sqlite3` install
step. The module is still marked "experimental" by Node but the API
we use (`DatabaseSync`, `.prepare`, `.run`, `.all`) hasn't moved.

## Sources indexed

- `<root>/.reflex/journal/*.md` — daily journal entries.
- `<root>/.reflex/topics/*.md` — chat transcripts.

Both are markdown with YAML frontmatter. The indexer parses with
`gray-matter` and stores:

- `title` from frontmatter `title` field, falling back to the first
  non-empty body line.
- `iso_date` from frontmatter `date` (journals) or `createdAt`
  (topics), falling back to the filename's leading `YYYY-MM-DD-` slug.
- `body` is the markdown body with `## user` / `## assistant` headings
  stripped (they're noise to FTS).

## Incremental refresh

`indexAllSessions()` is the entry point:

1. Walk every root.
2. For each `.md` file, compare `stat.mtimeMs` to the row's `mtime_ms`.
3. If newer, re-parse + re-insert into both tables.
4. After the walk, prune rows whose `file_path` no longer exists on
   disk.

Result: `{ scanned, upserted, removed }`. A typical tick on an idle
install reports `upserted: 0` and finishes in milliseconds.

The scheduler fires `system:sessions-index` hourly (see
[workflows.md](workflows.md)). For freshness needs tighter than an
hour, call `reindexSessionsAction()` from a server action.

## Search API

```ts
import { searchSessions } from "@/lib/server/sessions";

const hits = await searchSessions("oauth refresh", {
  rootId: "abc123",     // optional: restrict to one Space
  source: "topic",       // optional: 'journal' | 'topic'
  since: "2026-05-01",
  until: "2026-05-31",
  limit: 10,             // default 20, max 100
});
```

Each hit:

```ts
{
  id: number,
  source: "journal" | "topic",
  rootId: string,
  rootPath: string,
  ref: string,
  title: string,
  isoDate: string | null,
  rank: number,          // bm25, lower = more relevant
  snippet: string,       // matched terms wrapped in {{…}}
}
```

### Query normalisation

The caller passes a natural-language query. `normaliseQuery()`:

- Strips FTS5 reserved chars users rarely intend (`"`, `*`, `^`, `:`).
- Preserves `AND` / `OR` / `NOT` / `NEAR` operator tokens.
- Wraps plain words with a trailing `*` so single-character typos and
  word stems still match.

On a malformed query (rare — a stray `(` for instance), `searchSessions`
catches the FTS5 syntax error and retries with operator chars
stripped, so the caller still gets a result instead of an exception.

## Permissions for utilities

Utilities access search through the host API:

```js
await reflex.sessions.search({
  query: "oauth refresh",
  source: "topic",
  limit: 5,
});
```

Gated by `permissions.sessions.search: true` in the manifest. Refused
otherwise.

## Server actions (UI)

`lib/server/sessions/actions.ts` exposes:

| Action | Returns |
|---|---|
| `searchSessionsAction(query, opts)` | `SessionSearchHit[]` |
| `reindexSessionsAction()` | `{scanned, upserted, removed}` |
| `getSessionsIndexStatsAction()` | `{documents, journals, topics}` |

These are `"use server"` functions usable directly from React
components.

## Failure modes

- **Stale index after a manual file edit**: the user edits a journal
  .md by hand outside Reflex. The hourly task picks it up; if they
  need it sooner, kick off `reindexSessionsAction()`.
- **DB locked**: the SQLite DB is opened once per process and reused.
  WAL mode is enabled. If two Reflex processes share a `REFLEX_HOME`,
  one will block the other on writes — not supported.
- **Schema migrations**: a `meta(schema_version)` row guards the
  schema. If you bump the schema, add a migration branch in
  `ensureSchema()` — refusing-with-loud-error is the current default.
