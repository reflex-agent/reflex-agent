# Cross-utility data sharing — the Share Plane

> **Status: shipped (core + UI).** Stages 0–4 of the [migration](#migration)
> are implemented — the manifest schema (`provides`/`consumes` + the
> `shares`/`tasks`/`worktree` slots), the grant ledger (`grants.json`) and
> provider directory (`providers.json`), the four host methods
> (`kb.scopedList` / `kb.scopedRead` / `capabilities.invoke` /
> `capabilities.listProviders`), the permission-slot gate that replaced the
> task-board id-gate (fix B), owner-enforced `kbAdd`, install/uninstall refresh
> + grant pruning, and the opt-in `requireScopedReads` posture — and the
> user-facing surfaces have landed: **Settings → Sharing** (review + revoke
> grants, the posture toggle, the provider directory), **just-in-time consent**
> (a host-rendered prompt raised in the utility iframe wrapper on
> `grant_required`, which records the grant and retries the call), and
> **install-preview transparency** (sensitive slots + provides/consumes).
> **Remaining follow-up:** JIT consent for **worker / scheduled-workflow**
> contexts (which can't prompt and rely on a pre-existing grant); "allow once"
> / interface-level grants; and shipping the `writer-studio` utility and
> `task-board`'s `provides`/slot declarations in their own repos (until a
> provider declares its slots it is grandfathered in by `isLegacyTaskBoard`).

Utilities are sandboxed: each gets its own `fs` data dir, its own secrets, and
talks to the host only through the permission-gated, audited host API. That
isolation is the point — but real workflows need utilities to *compose*. A
writing utility should be able to read the tasks a task-board utility owns and
act on them ("draft a document per open writing task, then mark it done"),
**without** gaining blanket access to everything else in the Space (a Ledger's
transactions, a Vitals health record).

The Share Plane is how that composition happens: a single
consent + grant + audit broker over two access planes — **read shared data**
and **call an exported capability** — bound **dynamically** at runtime, never
pinned at install time.

## Design principles

- **Core is the sole broker.** Only the host writes grants, and only on
  explicit user consent. A producer never grants access to its own data — its
  *publication* is its opt-in; it is never prompted to approve a reader. A
  consumer cannot self-serve. This is the [architecture](architecture.md)
  authorization boundary: a sandbox cannot widen its own privileges.
- **Dynamic / late-bound.** Install order is irrelevant. A consumer can be
  installed months before any provider exists. Binding happens through
  **runtime discovery by interface** plus **just-in-time consent**, not a
  static install-time contract.
- **Read for facts, call for effects.** If you only need the content a
  producer already persists, read it (DATA plane). If you need an effect only
  the producer may perform — mutate its source of truth, run under its
  authority, touch its private data — call a verb it exports (CAPABILITY
  plane).
- **Least privilege, always audited.** A grant is scoped to one
  `(provider, selector)` pair. Every cross-utility access records
  `consumer → provider + selector + grantId` on the existing audit trail.

## The isolation baseline (today)

| Surface | Sharing | Granularity |
|---|---|---|
| `fs.*` | private — sandboxed to `<utility>/data` | per utility |
| `secrets.*` | private — declared per utility | per utility / per key |
| `kb.read` / `kb.list` | **blanket** — any utility with `kb.read` reads the *entire* Space KB | all-or-nothing (the `kind` arg is a caller-chosen filter, **not** a permission) |
| `kb.write` / `kb.kinds` | writes only; `kb.kinds` restricts which kinds a utility may write | per kind (writes) |
| `tasks.*` / `git.worktree.*` | **temporarily hard-gated** to `manifest.id === "task-board"` | one utility (stopgap) |
| `actions.invoke` | self only — a utility calling its own server actions | n/a (no inter-utility call exists) |

Two gaps follow directly:

1. **Reads are blanket.** A utility that wants one kind (`task`) must take
   `kb.read`, which exposes every kind in the Space. There is no per-kind /
   per-owner read scope, no consent for reading another utility's data, and no
   way to discover what data exists without first being able to read all of it.
2. **No inter-utility call.** `actions.invoke` is self-only and the only
   cross-utility-ish powers (`tasks.*`, worktrees) are gated to a single
   hard-coded id. There is no general, brokered way for utility A to invoke an
   operation utility B chooses to export.

The Share Plane closes both, and folds the temporary `tasks.*` id-gate into a
real permission model (see [Relation to the sensitive-capability slots](#relation-to-the-sensitive-capability-slots-fix-b)).

## The Share Plane

### DATA plane — granular, owner-scoped KB reads

Two new host methods take a **required** `{provider, kind}`:

```js
reflex.kb.scopedList({ provider: "task-board", kind: "task", rootId?, query? })
//   -> Array<{ relPath, title?, kind?, modifiedAt }>
reflex.kb.scopedRead({ provider: "task-board", kind: "task", relPath, rootId? })
//   -> { content }
```

The host (1) checks the caller holds a live **DATA grant** for
`(provider, kind)`; (2) walks **only** the owning kind's subtree and filters on
`meta.createdBy === "utility:<provider>@*"`; (3) returns the same shape as the
existing `kb.list` / `kb.read`. No provider code runs — it's a read-only pull.

The owner filter is what makes this safe: `meta.createdBy` is **stamped by the
host, last, on every KB write** (`lib/server/agents/kb-writer.ts`) and cannot
be spoofed by a utility. So a forged `kind: "task"` file written by some other
utility is *not* returned by a scoped read for `task-board`'s tasks.

Use the DATA plane when you only need to **read** content the producer already
persists and the producer's authority / invariants / private data are not
required.

### CAPABILITY plane — brokered RPC into the producer's sandbox

One new host method is the inter-utility **call** primitive Reflex lacks today:

```js
reflex.capabilities.invoke({ provider: "task-board", verb: "markDone", input, rootId? })
//   -> the verb's typed output
```

The host (1) checks a live **CAPABILITY grant** for `(provider, verb)`;
(2) checks the caller **declared the import** (anti-confused-deputy — declared
intent is necessary but not sufficient; the grant is the final gate);
(3) resolves `provider.provides.capabilities[verb].action` to a server action
in the **producer's** manifest; (4) validates `input` against the exported
schema; (5) builds a fresh `HostContext` **bound to the producer** and runs it
through `runServerAction` — which keys all worker identity (bundle dir, data,
secrets, scope) off the passed utility (`lib/server/utilities/worker-pool.ts`),
so the verb executes against the **producer's** sandbox, never the caller's;
(6) validates and returns only the verb's typed output. Iframe-callable like
`actions.invoke`; nested calls audit with `parentCorrelationId`.

Use the CAPABILITY plane when you need an **effect** or an operation only the
producer may perform: marking a task done (must go through the producer's
`tasks.update`), writing into a kind the producer owns, dispatching an agent.
A consumer can **never** mutate a producer's owned kind by writing KB directly
(owner-enforced `kbAdd`, below) — mutations route only through a verb the
producer exports and controls.

### Directory + ownership — discover-then-request

A self-healing `~/.reflex/providers.json` (rebuilt from installed manifests on
every install / uninstall, like the existing `rootRef` backfill) records, per
utility, the DATA kinds it provides and the verbs it exports, plus a kind
**ownership** map (first installer of a kind owns it; a later claimant is
rejected at install, mirroring the registry's duplicate guard).

```js
reflex.capabilities.listProviders({ kind?: "task", verb?: "markDone" })
//   -> Array<{ provider, version, data:[{kind,doc}], capabilities:[{verb,doc,sideEffects,input,output}] }>
```

Metadata only — **no payloads** — so it is safe to expose broadly (a coarse
`permissions.shares.consume` gate is enough). This is what makes binding
dynamic: a consumer or the agent queries it **at runtime** to find a provider
**by interface**, then requests access, all without first being able to read
anything.

### Grant + consent + audit — the single broker substrate

One `~/.reflex/grants.json` (`0600`, modeled on `lib/server/shares/store.ts`)
is the sole ledger for **both** planes:

```ts
type Grant = {
  id: string;
  consumer: string;            // utility id
  provider: string;            // utility id
  plane: "data" | "capability";
  selector: string;            // kind (data) | verb (capability)
  scope: "global" | string;    // rootId
  grantedAt: string;
  expiresAt?: string;
  revoked?: boolean;
};
```

Grants are created **only by core**, at install or just-in-time first use, on
explicit user consent. Both planes resolve authorization here; one
`Settings → Sharing` surface revokes from here; one audit query answers "who
read / called whose data under which grant."

## Dynamic binding

This is the part that makes the model match how utilities are actually
installed and used: **out of order, and wired up on demand.**

### Discovery is by interface, at runtime

A consumer does not hardcode a provider. It asks for a *shape*:
`listProviders({ kind: "task" })`. The result is `0`, `1`, or many providers.
Zero → "no task source installed yet." Many → the user (or agent) picks. The
writing utility is decoupled from `task-board` entirely; any utility that
provides `kind: "task"` can satisfy it.

### `consumes` is advisory, never a hard gate

```jsonc
// consumer manifest — optional, interface-typed, non-blocking
"consumes": {
  "data":         [{ "kind": "task", "reason": "Draft a document per writing task" }],
  "capabilities": [{ "provider": "task-board", "verb": "markDone", "reason": "Mark done after drafting" }]
}
```

`consumes` is **intent, not access** — declaring it grants nothing, and a
missing provider **never fails install**. Its only jobs: pre-seed the consent
dialog (and allow pre-authorization) when a provider *is* present, and show the
user, transparently, what a utility may later ask for. Omitting `provider`
binds to **any** provider of that kind at runtime. A fully dynamic utility may
skip `consumes` altogether and discover + request purely at runtime.

### Just-in-time consent, surfaced in the conversation

When an ungranted scoped call happens, the host throws `grant_required` and
raises a **`grant-request` interactive directive** on the same converged plane
as the existing `permission` / `question` / `mcp-add` directives (Phase 4,
commit `e5b7145`). The host — not the utility, so it cannot be spoofed —
renders the consent inline:

```
writer-studio wants to read your Tasks from task-board.
  [ Once ]  [ Always ]  [ Always, any task source ]  [ No ]
```

On approval the grant is written and the call is retried. Consent scopes:

- **Once / session** — ephemeral, not persisted.
- **Always (this provider)** — a persisted per-provider grant (default).
- **Always, any provider of this kind** — an interface-level grant that also
  covers *future* providers of that kind. Powerful for hands-off binding;
  louder in the prompt; opt-in.

### Late provider appearance

Install the consumer first (no provider — it simply finds zero). Install the
provider months later — `providers.json` rebuilds on install, so it is
immediately discoverable, with **no reinstall** of the consumer. The next time
the consumer (or the agent on the user's behalf) tries to use it, the JIT
consent fires. Order never matters.

## Agent vs utility — who is the consumer

A crucial distinction, because "ask the assistant to look at my writing tasks"
has two readings:

- **The agent itself** (Claude Code / Codex) is **not** a sandboxed utility. It
  runs with access to the Space (`--add-dir`) and already reads and writes the
  `.reflex/` tree, including the KB. Asking the assistant "what writing tasks
  do I have?" works **today** — the agent reads `kind: "task"` directly and
  filters. The agent is the user's proxy with the user's authority; it does not
  need a grant.
- **A utility** (a writing utility's iframe / worker / workflow) **is**
  sandboxed. When it needs another utility's data — including when the agent
  invokes that utility's command or skill — the Share Plane governs it, and JIT
  consent appears in the chat.

So: the Share Plane is for **utility → utility** (and utility → another
utility's owned data). The agent can already see the Space. When the agent acts
*for* a sandboxed utility, it may **surface** the consent but never **bypass**
it — a sandboxed utility is not silently elevated by being invoked from chat.

## Ownership and the `createdBy` filter

```jsonc
// producer manifest
"provides": {
  "data": [{ "kind": "task", "doc": "One file per task; frontmatter {status,priority,due}, body = description." }],
  "capabilities": [{
    "verb": "markDone", "action": "markTaskDone", "sideEffects": true,
    "input":  { "taskRelPath": "string", "resultRelPath": "string?" },
    "output": { "ok": "boolean", "status": "string" }
  }]
}
```

- `provides.data[].kind` **claims** a kind; at install the host records the
  producer as its owner (first-claim-wins; a duplicate claim is an install
  error). This turns the host-stamped `meta.createdBy` from an advisory badge
  into the **enforced** owner filter for scoped reads.
- `provides.capabilities[].action` must name a server action in the same
  manifest. `input` / `output` are a shape map the host compiles to a `zod`
  validator. Registered in the `CapabilityRegistry` under an owner-namespaced
  id (`utility:<provider>:<verb>`).
- **Owner-enforced `kbAdd`:** after the existing `kb.kinds` allowlist check, if
  a kind has a recorded owner, only the owner may write it. Unclaimed / legacy
  kinds behave exactly as today (back-compat).

## Worked example: writer-studio ↔ task-board

`writer-studio` is installed **first** (no task source exists). `task-board`
is installed later. The user then asks the assistant about writing tasks.

1. **Discover.** `writer-studio` (or the agent invoking it) calls
   `listProviders({ kind: "task" })`. Before `task-board` exists → `[]`. After
   → `[{ provider: "task-board", ... }]`.
2. **Read (JIT consent).** `kb.scopedList({ provider: "task-board", kind: "task" })`
   → no grant → `grant_required` → in-chat consent → user clicks **Always** →
   `g_data` written → retried → returns only `task-board`'s tasks (owner-filtered).
   A parallel attempt at `kind: "note"` or a Ledger kind **fails** — no grant —
   and `writer-studio` holds no blanket `kb.read`, so the legacy path is closed
   to it.
3. **Draft.** It reads bodies via `kb.scopedRead`, generates a draft with its
   own `llm` permission, and writes the draft to **its own** owned kind:
   `kb.add({ kind: "draft", ... })`. It cannot write `kind: "task"` —
   owner-enforced `kbAdd` rejects a non-owner, so it cannot forge a task.
4. **Act (capability plane).**
   `capabilities.invoke({ provider: "task-board", verb: "markDone", input })`
   → grant + declared-import check → resolves to `markTaskDone` → runs in
   **task-board's** sandbox, which calls `tasks.update` (allowed because
   task-board holds the real `permissions.tasks` slot) → returns
   `{ ok: true, status: "done" }`.

Result: `writer-studio` read only `task-board`'s task content, produced its own
drafts, and effected a state change in `task-board` — never touching Ledger /
Vitals KB, task-board's private `fs`, or its secrets — with the whole A→B flow
audited under two grants.

## Host API additions (summary)

| Surface | Signature | Notes |
|---|---|---|
| `kb.scopedList` | `({provider, kind, rootId?, query?}) -> [{relPath,title?,kind?,modifiedAt}]` | grant + owner filter; reuses `listKbFiles` |
| `kb.scopedRead` | `({provider, kind, relPath, rootId?}) -> {content}` | grant + owner filter; reuses `readKbFile` |
| `capabilities.invoke` | `({provider, verb, input, rootId?}) -> output` | brokered RPC; runs in producer's sandbox |
| `capabilities.listProviders` | `({plane?, kind?, verb?}) -> [...]` | metadata only; the dynamic catalog |
| `permissions.shares.consume` | `{ shares?: { consume?: boolean } }` | coarse master switch for the consume path |
| `permissions.tasks` / `permissions.worktree` | see below (fix B) | replace the temporary id-gate |
| stores | `grants.json` (`0600`) + `providers.json` | modeled on `shares/store.ts` + the registry singleton |

## Relation to the sensitive-capability slots (fix B)

There are two authorization questions, answered by the **same** consent / grant
/ audit machinery:

1. **May this utility call a host primitive** (`tasks.*`, `git.worktree.*`)? —
   a **permission slot** the utility requests and the user consents to at
   install. This is fix B: `dispatchHostCall` checks
   `permissions.tasks` / `permissions.worktree` instead of
   `manifest.id === "task-board"`, retiring the temporary id-gate from commit
   `8ba236d`. task-board keeps the power by declaring the slots.
2. **May consumer A call a verb exported by producer B?** — a **grant** in
   `grants.json` (the capability plane).

They compose in the worked example: `writer-studio` holds **no**
`permissions.tasks`; it calls task-board's exported `markDone` verb (grant), and
`markDone` — running in task-board's sandbox — uses task-board's own
`permissions.tasks` slot. The privileged primitive stays with the utility that
legitimately holds the slot; cross-utility access to that power flows **only**
through a curated verb the owner exports. Least privilege: the consumer gets the
narrow effect, never the raw primitive.

## Security guardrails

- **No producer self-grant.** A producer only claims kinds / exports verbs; it
  has no code path to write a grant and is never prompted to approve a reader.
- **No consumer over-read.** Scoped reads require a live grant **and** the owner
  filter — a granted consumer sees only that provider's owned entries in that
  one kind; a consumer without blanket `kb.read` has no other path.
- **Anti-confused-deputy.** `capabilities.invoke` requires both a declared
  import and a grant.
- **No impersonation.** The brokered verb runs in the producer's `HostContext`;
  the caller receives only the typed output, never the producer's secrets.
- **No raw-primitive escalation.** A consumer triggers effects only through
  curated verbs; it never acquires `permissions.tasks` or writes a producer's
  owned kind directly.
- **Cross-Space containment.** Grants are scope-bound; an arbitrary `rootId` is
  rejected unless a grant covers that scope (closes the `getRoot` no-owner-check
  path).
- **First-claim-wins ownership** prevents a utility from claiming another's
  kind.
- **Generic, not one-off.** Core ships `kb.scoped*`, `capabilities.invoke`, the
  slots, and the grant ledger as permission-gated primitives — the task-board
  id-gate (the one place core had a one-off rule) is removed.

## Migration

Each stage ships without breaking task-board, learn-anything, or today's
blanket `kb.read` consumers.

- **Stage 0 — dormant.** Extend `ManifestSchema` with optional
  `provides` / `consumes` and `PermissionsSchema` with `shares.consume`,
  `tasks`, `worktree`, all defaulting empty/false (every existing manifest stays
  valid). Add `grant-store.ts` + `provider-directory.ts`. Register the new host
  methods. Legacy `kb.read` / `kbAdd` unchanged; the plane is simply unused.
- **Stage 1 — adopt task-board + retire the id-gate (fix B).** task-board
  declares `provides.*`, `permissions.tasks`, `permissions.worktree`. The gate
  becomes a slot check with a back-compat shim (an un-upgraded task-board with
  no slots declared still passes). Self-healing backfill records task-board as
  owner of `kind: "task"`.
- **Stage 2 — writer-studio greenfield.** Built on the new path: no blanket
  `kb.read`, scoped reads + capability calls, JIT consent. Proves the
  end-to-end flow on the better-isolated default.
- **Stage 3 — narrow blanket `kb.read`, opt-in.** Keep honoring it, but: a
  louder install warning; a Space-level "Require scoped reads" setting
  (default OFF) that limits `kb.read` to own-written + granted entries; a lint
  nudge toward `consumes.data`. Instant rollback via the setting.
- **Stage 4 — lifecycle.** `Settings → Sharing` lists live grants with revoke;
  uninstall prunes grants and rebuilds the directory; honor `expiresAt`.

## Open questions

- **Kind namespacing.** Bare names (`task`) collide across independently
  authored utilities under first-claim-wins (install failure). Adopt
  producer-namespaced kinds (`task-board/task`) — cleaner, but changes the
  on-disk `.reflex/<kind>/` layout — or keep bare names with a collision UX?
- **Interface identity.** How is `kind: "task"` recognized as "the task
  interface" — a shared kind vocabulary, or a typed interface registry? With
  multiple `task` providers the user disambiguates at grant time.
- **Verb versioning.** `consumes.capabilities.minVersion` exists, but a concrete
  deprecation window + `describe()`-driven incompatibility warnings are needed
  so a grant doesn't silently target a changed verb shape.
- **Brokered-invoke cost / DoS.** `capabilities.invoke` boots the producer's
  worker on the consumer's behalf. Rate-limit / account against the producer's
  `workers.maxConcurrent`? An in-process path for pure-query verbs?
- **Blanket `kb.read` end state.** Is there a date/flag at which "Require scoped
  reads" flips ON by default, and what migration aid (e.g. generating grants
  from observed read history in the audit log) ships to make that safe?
- **`providers.json` global vs per-Space.** A global directory means cross-Space
  discovery exists even for project-scoped utilities; grants are scope-bound to
  mitigate access, but is per-Space ownership a better fit for local-first?

## See also

- [architecture.md](architecture.md) — the two homes, the broker boundary.
- [host-api.md](host-api.md) — the method surface and the audit trail.
- [utilities.md](utilities.md) — manifest, permissions, extensions, cards.
- [kb.md](kb.md) — KB kinds and the `createdBy` stamp.
