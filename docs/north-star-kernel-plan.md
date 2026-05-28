# Reflex Kernel — North-Star Convergence Plan

> Provenance: produced 2026-05-29 by a 20-agent analysis workflow (10 subsystem
> readers → 5 cross-cutting lenses → 1 architect → 3 adversarial critics → 1
> reviser). Every load-bearing claim was verified against source. Goal chosen by
> the user: **consolidate the fragmented codebase into one cohesive monolithic
> core**, zero-friction for **non-technical** users. This is the plan, not yet code.

---

## Reflex Kernel — North-Star Convergence Plan (definitive)

> One core, four layers, thin surfaces. Built by strangling — every layer ships behind its current public surface, the app stays working at every step, and the highest-risk invariant (per-topic seq monotonicity) is protected before anything else moves.

---

## 0. The one decision the plan must make first: monolith shape

**Decision: modular monolith with *enforced* import-direction zones, not a renamed god-object.**

The first critic is right that "cohesive kernel" is aspirational unless the layering is structurally guaranteed. `manager.ts` (2226 lines, verified) already violates layering by runtime-importing ~10 subsystems. We therefore commit to four named zones with a one-way dependency rule, enforced by a lint check landed in **Phase 0**:

```
Layer 1  lib/reflex/store/**, lib/reflex/{ids,paths}.ts      (SpaceStore)
Layer 2  lib/server/capabilities/**                          (CapabilityRegistry)
Layer 3  lib/server/agents/{bus,turn-engine,directives}/**   (TurnEngine + EventBus)
Layer 4  surfaces: app/api/**, notify/**, headless, share    (adapters)

Allowed import direction: 4 → 3 → 2 → 1   (never the reverse)
```

Enforcement: an `eslint-plugin-boundaries` (or a `dependency-cruiser` rule) config that fails CI if a lower layer imports a higher one. This is a build gate, not a convention. Without it the four layers re-tangle exactly like `manager.ts` did. We do **not** split into npm packages — single repo, single build, single `globalThis` runtime — but the import-direction rule gives us the cohesion guarantee a single monolith cannot assert on its own.

---

## 1. Target architecture

A single, named **Reflex Kernel**. Today there is already a *de-facto* single brain (`globalThis.__reflexAgentManager`) over per-topic `events.jsonl`, but it is wrapped in ~20 ad-hoc stores, three duplicated background loops, six divergent id sanitizers, a stringly-typed 20-marker control plane dispatched inline, and 2–4 parallel render/scan paths per surface. The kernel extracts the brain cleanly and makes every surface a thin client.

### Layer 1 — SpaceStore (storage + addressing)
- `lib/reflex/ids.ts` — **named** sanitizers, not one parameterized function. Verified divergence: `topics.ts:81` strip `/[^A-Za-z0-9_-]/→''`; `widgets/store.ts:38` + `workflows/store.ts:28` dash+slice(80); `tasks/store.ts:246` lowercase-dash; `kb-writer.ts:77` unicode-aware `\p{L}\p{N}`; `skills.ts:464` `[a-z0-9-]`. Export `sanitizeIdStrip`, `sanitizeIdDash`, `slugify`, `slugifyUnicode` from one module. **Cohesion of location, not forced cohesion of implementation** — a single `mode` enum risks subtle unicode drift that silently renames files.
- `lib/reflex/paths.ts` — the **sole** `.reflex` constructor. Add `topicsDir/widgetsDir/workflowsDir/memoryDir/skillsDir/taskDir/assetsDir/attachmentsDir/worktreesDir` helpers + a `homePaths` object enumerating every `$REFLEX_HOME` artifact. Migrate the 8 hardcoded `path.join(rootPath,'.reflex',...)` bypass sites.
- `lib/reflex/store/json-store.ts` — generic versioned store. **Generalize the existing proven primitive** `utilities/transactional-update.ts` (`.bak.<ts>` rename) rather than reinventing tmp+rename — it is the one battle-tested atomic-write pattern in the codebase. Adds zod validation, a `migrate(fromVersion,data)` chain, one shared `isNotFound` ENOENT guard, and **per-file write serialization** via an in-memory mutex registry (required because `dashboard-layout.json` is written on every drag and atomic-rename does not serialize concurrent read-modify-write — last writer silently wins otherwise).
- `lib/reflex/store/frontmatter.ts` — gray-matter wrapper; delete hand-rolled regex parsers in `system-tasks.ts`, `templates/registry.ts`.
- `TopicStore` — merges `topics.ts` + `agents/events-log.ts` (same `(rootPath,topicId)` keyspace).
- `reflex.db` (promoted from `sessions.db`) — numbered-migrations table. **Holds ONLY the FTS index.** Cursors and the pending-interactions queue stay file-backed (see Layer-3 durability decision).

**Credential stores join the migration (closing critic-3's gap).** `oauth/{clients,tokens}`, `api-keys/<provider>.json`, `utilities/secrets-store`, **and `settings.json`** all route through `json-store.ts` with mode `0o600`. Verified asymmetry: `settings/store.ts:29` writes the Telegram bot token in plaintext with no mode, while oauth/api-keys are `0o600`. Consolidation is the moment to normalize this — and Phase 6's rename already *must* rewrite `secrets/project/<rootId>/`, so secrets cannot be out of scope.

### Layer 2 — CapabilityRegistry (the contracts — *plural*)
The plan's single weakest claim was "one contract." Verified at `manager.ts:424-461`: `respondPermission` returns `Promise<void>` and resolves out-of-band via `emit` + `continueTurn`; `permission`/`question` **suspend** within the turn. But `kb.add`/`notify` (verified `host-api.ts:362`, returns a value) are fire-and-return. **Two kinds, not one:**

```ts
interface SyncCapability {        // kb.add, memory.write, notify, image.generate,
  id; input: ZodSchema;           // widget.upsert, task.create/update, suggestion.add
  permission: PermissionRef;
  audit: 'always'|'event'|'silent';
  run(input, ctx): Promise<Result>;   // returns a value
}
interface InteractiveDirective {  // permission, question, mcp-add, route, report
  id; input: ZodSchema;
  permission: PermissionRef;
  open(input, ctx): { requestId };    // emits a request event, suspends
  resolve(requestId, response, ctx);  // out-of-band, later turn
  idempotencyKey(input, ctx): string; // (turnId, content-hash) — NOT shortId()
}
```

The marker extractor, the `host-api.ts:343` switch, and `NODE_HANDLERS` collapse into thin adapters resolving to `registry.invoke(id, payload, ctx)` (sync) or `registry.open/resolve` (interactive). `ctx.caller` is `agent | utility | workflow | user`. **Return-channel is caller-specific by design** (the maps prove it): agent markers return nothing mid-turn; host-api returns a value to the iframe; workflow nodes return values feeding `{{steps.x.output}}`. `registry.describe()` generates the agent prompt directive list, the `host-api.mjs` proxy, the workflow step picker, and the slash palette from one source.

### Layer 3 — TurnEngine + EventBus (orchestration)
Keep `AgentManager` as the `globalThis` singleton (load-bearing for HMR + subprocess kill handles — verified at manager.ts top). Extract:
- **TurnBus** — the **sole seq authority for ALL writers**, including the agent-less relay path. Verified hazard: `relay.ts:45` imports `nextSeq` directly and writes `agentId:"dispatcher-relay"` (never in `agents` map), so `emit()`'s counter can never own it. The bus's seq assignment is a **synchronous read-and-increment with zero awaits between read and enqueue** (`const seq = this.seqByTopic.get(t)!; this.seqByTopic.set(t, seq+1)` — *then* await append). Verified bug it fixes: `emit()` at manager.ts:1968-1970 does `await nextSeq()` → `await appendEvent()` with no lock; two concurrent emits read the same length and append duplicate seqs. This is a **correctness fix, not a perf optimization** (and it also kills the O(N) per-emit full-file re-read in `events-log.ts:53`).
- **DirectiveProcessor** — one handler module per capability, replacing the 220-line `detectInteractionDirectives` god-method (`manager.ts:984`).
- **ContextContributor registry** — replaces the hand-maintained `[...].filter(Boolean).join` system-prompt array in `start-turn.ts:182-213`. Memory, utility promptBlocks, skill, focus-file, youtube, dispatcher each self-gate.
- **TurnQueue** — promote Telegram's `topicQueues` to engine-owned per-topic, closing the cross-surface concurrent-turn race (web `/send` and Telegram can both pass the non-atomic `isActive` guard today).
- **`projectTranscript(events,{summaryPrefix?})`** — replaces `buildTranscript` (manager.ts:2177) + `renderTranscript` (start-turn.ts:536).
- **Mid-turn grant contract is per-harness** (critic-3 must-fix). Verified: `registerKiller` is wired only in `runtime/claude-code.ts:128`; codex/ollama have none. The TurnEngine declares: claude-code uses kill-and-respawn; codex/ollama use **recorded-but-deferred-to-next-turn, surfaced to the user**. No surface ever shows "the bot ignored my answer."

### Layer 4 — Surface adapters (thin clients) — *with one acknowledged exception*
Web SSE is already a correct push subscriber. Telegram's 700ms poll loop and headless's `sleep(400)/isActive` loop become bus subscriptions. One `InteractionPresenter` contract (web cards + Telegram keyboards) reads one `listOpenInteractions(events)`. One `renderWidgetModel(record)` feeds both `registry.tsx` and `notify/widget-render.ts`.

**Exception (closing critic-1's counterexample): the Share surface is pull-only and stays pull-only.** `shares/store.ts` serves anonymous, cookie-auth, read-only project views; it can never subscribe to an in-process bus. The "push, not poll" principle applies to *authenticated live surfaces*. Share consumes the same `renderWidgetModel` (verified `shared-project-view.tsx:67` currently renders blank `kind: {w.kind} · id: {w.id}` stubs — a ~5-line fix) and must harden its sidebar-leak (currently a `pathname.startsWith('/share/')` string check), but it is a read model, not a bus client.

### Background runtime + boot
One `BackgroundRuntime` registry (single `setInterval`, single overlap-guard, single `listRoots()` walk) absorbs `workflows/scheduler.ts`, `widgets/scheduler.ts` (near-clone), the Telegram poller, and dispatcher compaction, with disk-backed last-run state so cold starts respect intervals.

**Boot caveat — proven, not assumed.** Verified: `reflex start` uses a programmatic `createServer` + warmup self-ping (`commands/start.ts:34,47`), **not** `next start`. Next.js `instrumentation.ts` may not fire under a custom programmatic server. Therefore: Phase 0 runs a **GO/NO-GO spike** to prove instrumentation fires under the custom server. **The warmup self-ping is NOT deleted until that spike is green AND both boot paths have soaked one release.** Both paths stay (idempotent-guarded) permanently if cheaper than betting the Telegram-only first-message promise on one new hook.

The dispatcher stops being `isHomeRoot('home')` branches (verified scattered in `start-turn.ts` and `manager.ts:1104`) — it becomes a registered `ContextContributor` + a `relayPolicy` on topics flagged `dispatchedFromDispatcher`, self-gating at the edge. The literal id `'home'` stays stable.

---

## 2. Today → target, per concern

### Storage
| | Today | Target |
|---|---|---|
| Layer | ~20 ad-hoc stores; 37 non-atomic `writeFile`; no migration framework (all stamp `version:1`, none read v2); copy-pasted ENOENT guard | One SpaceStore: named ids, sole paths authority, versioned+atomic json-store (generalizing `transactional-update.ts`), shared frontmatter, TopicStore, reflex.db (FTS only) |
| Ids | 6 divergent sanitizers (verified strip/dash+slice/lowercase-dash/unicode) | 4 named exports from `ids.ts` |
| Seq | `nextSeq()` re-reads whole log per emit (O(N)); duplicate-seq race under concurrency | O(1) sync in-memory counter on the bus; sole authority for all writers incl. relay |
| Credentials | `settings.json` plaintext token; oauth/api-keys/secrets `0o600`; none versioned/atomic | All through json-store, all `0o600` |
| Identity | `rootId = SHA1(path)`; move folder → orphan everything | `rootRef` indirection + dual-read rename window |
| Assets | images/attachments bare `writeFile`, no GC, no rename handling, no UI | Behind paths helpers, in trash/undo + rename migration + GC/management view |

### Capabilities
| | Today | Target |
|---|---|---|
| Registries | 4 independent: ~20 markers + extractors inline; `host-api.ts:343` 40-case switch (19 `ensurePermission`); manifest extensions; 9 `NODE_HANDLERS` | One registry, two kinds (Sync + Interactive); marker/host-api/node become adapters |
| Permission | 3 regimes: agent ungated, host-api gated, nodes trust-rendered | One PermissionModel against a **frozen grant matrix** decided before Phase 2 |
| Audit | 3 trails (events.jsonl, audit JSONL with start/end + parentCorrelationId, workflow runs) | `registry.invoke` writes one record; `/audit` reader keeps correlationId-pair shape (keyspace mismatch handled, not asserted away) |
| OAuth | `$oauth:<provider>` hydration in MCP configs — capability-adjacent secret flow, uncovered | Registered as a gated `oauth.token` capability in the model + audit |

### Orchestration
| | Today | Target |
|---|---|---|
| Engine | `AgentManager` 2226 lines; 220-line directive god-method; `isHomeRoot` branches in core; 2 transcript builders; per-topic concurrency only on Telegram path | TurnEngine inside preserved singleton: DirectiveProcessor, ContextContributor, engine-owned TurnQueue, one `projectTranscript` |
| Seq | placeholder `seq:0` at ~50 sites, overwritten | bus owns seq; caller never sets it |
| Mid-turn grant | kill-and-respawn (claude-code only) | per-harness contract; deferred-to-next-turn for codex/ollama |
| Idempotency | `requestId = p.id ?? shortId()` → respawn dupes cards | content-derived `(turnId, hash)` key |

### Surfaces
| | Today | Target |
|---|---|---|
| Web | correct push subscriber (`subscribeTopic` + `?since=`) | unchanged |
| Telegram | 700ms poll, re-derives projection, re-implements interaction scan | bus subscriber + turn-end `readEvents` reconciliation fallback; cursor re-derived correctly |
| Headless | `sleep(400)/isActive` loop | `subscribeAgent` + turn-end promise |
| Interaction | forked 3 ways (web cards, Telegram keyboards, dashboard badge) | one `InteractionPresenter` over one `listOpenInteractions` |
| Widgets | rendered twice (React + Telegram text) | one `renderWidgetModel` |
| Share | blank widget stubs, sidebar leak via string check, pull-only | fixed via `renderWidgetModel`, hardened auth — explicitly stays pull-only |

### UX
| | Today | Target |
|---|---|---|
| Boot | workers boot on first browser render; Telegram-only depends on warmup ping | deterministic boot (proven under custom server) + retained ping until soak |
| Errors | typo'd marker leaks raw JSON | typed directive-error event, friendly line |
| Surprises | "Always allow" kills+respawns (agent vanishes mid-sentence); agent widgets hidden; deletes permanent | TurnQueue/bus legibility; one keep/dismiss; trash+undo |
| Setup | Telegram 3 manual steps; 4 utility install paths; 3 harnesses with no frame | one-tap bind (auto-bind surfaced); one install flow; **zero-config default harness** |
| Legibility | no scheduler/status surface | calm status as a first-class home affordance (not buried in Settings) |
| Data safety | move folder orphans all; 37 non-atomic writes corrupt | atomic store + rootRef dual-read |

---

## 3. The strangler roadmap

Honest framing (per critic-2): this is **four roughly-independent blocks with two hard internal couplings**, not seven free-standing phases. Phases 2↔4 are coupled by the shared PermissionModel; Phases 3↔6 by cursor/`events.length` semantics; Phases 5↔6 by the dispatcher contributor + `rootId`/home-as-entry.

### Phase 0 — Harness, seams, GO/NO-GO spikes (no behavior change)
- **Adversarial concurrency test first** (not the happy-path single turn): N parallel emits on one topic, *plus a relay write interleaved with a dispatcher turn*, asserting seqs form a contiguous unique sequence. This is the bug the single-turn replay cannot catch.
- Single-turn smoke test (web Space + home dispatcher) asserting events.jsonl shape + SSE `?since=` replay.
- **Capability-id / host-api-method golden snapshot test**: capture every string method id reachable from the `host-api.mjs` proxy + persisted `manifest.serverActions`; later assert `registry.describe()` reproduces them byte-identically.
- Regression fixture of real Claude-Code tool-denied strings (protects the permission heuristic).
- **GO/NO-GO spike**: prove `instrumentation.ts` actually fires under `reflex start`'s programmatic `createServer`. Failure invalidates warmup-ping deletion and forces an explicit `/api/startup` route strategy.
- Land the **import-direction lint rule** (Layer 4→1 only) so all later work is boundary-checked.
- Add `instrumentation.ts` additively, calling existing start fns idempotently; keep layout.tsx side-effects.
- **Deliverable:** concurrency + replay + golden-id tests green, denial fixture, boot spike verdict, boundary lint enforced, additive instrumentation.
- **Risk:** Low — pure additive, except the spike whose *result* gates Phase 5.

### Phase 1 — SpaceStore foundations (mechanical, behind existing surfaces)
- `ids.ts` with 4 named sanitizers; replace 6 copies, each output byte-identical.
- `paths.ts` sole authority + `homePaths`; migrate 8 bypass sites.
- `json-store.ts` generalizing `transactional-update.ts`; **per-file mutex registry** (survives HMR via globalThis). Migrate leaf stores (settings, registry, shares, mcp-registry, suggestions, pending-mcp-adds) **plus credential stores** (oauth, api-keys, secrets) behind current signatures, normalizing to `0o600`. **First-contact zod is lenient/coerce**, not strict, because widget/settings data was never validated (`store.ts:54` raw cast) — strict validation on never-validated on-disk data would drop user widgets on upgrade.
- **Decide each store's failure policy explicitly** (critic-2): `config.ts:31` throws today; `settings/store.ts` silent-resets. Document which becomes which — a throwing config that goes lenient hides corruption; a silent-reset settings that goes throwing bricks boot.
- O(1) seq counter on the bus. **Migrate `relay.ts:45` onto the bus in this same phase** (do not let the counter own the dispatcher topic while relay still calls `nextSeq` directly — that produces duplicate seqs between Phase 1 and 5). Keep `nextSeq()` as cold-read fallback.
- **Per-artifact rollback contract** (critic-2): every store gaining a new version reads old format for ≥1 release; writes stay old-format until a designated cutover release, so `npm install @older` never corrupts the user's view.
- **Deliverable:** unified ids/paths/atomic-store/credentials/seq, byte-identical on-disk output, relay on the bus, rollback contract documented.
- **Risk:** Medium — atomic writes + concurrency on hot files; seq reseed correctness (covered by Phase-0 concurrency test).

### Phase 2 — CapabilityRegistry + DirectiveProcessor (additive routing)
- `capabilities/registry.ts` with **both** `SyncCapability` and `InteractiveDirective` kinds. Register high-traffic, low-risk sync capabilities first (kb.add, memory.write, notify, image.generate, task.create/update, suggestion.add, widget.upsert).
- Generic extractor maps each legacy `<<reflex:name>>` to a capabilityId; **legacy markers stay primary** (the LLM is *instructed* each turn via `registry.describe()`, not trained — but we keep markers as the native emitted syntax; quarantine-only fallback parsing for malformed input). Migrate the **directive vocabulary as versioned**, so a future single-syntax migration is *possible* but not forced.
- Extract `detectInteractionDirectives` handler-by-handler into `directives/<name>.ts`. Migrate safe sync handlers first; **interactive handlers (permission/question/mcp-add) use `(turnId, content-hash)` idempotency keys**, closing the `?? shortId()` respawn-dupe bug.
- **Freeze the permission grant matrix here** (couples to Phase 4): enumerate per-capability what agent/host-api/workflow are allowed *today*. Ship the model **inert** (no enforcement, no Settings UI) — surfacing read-only grants that do nothing is friction-now-for-benefit-maybe-later. Enforcement + UI land only when the tightening pass is scheduled.
- Emit typed directive-error events (friendly text) on malformed markers; strip raw marker from the bubble.
- **Deliverable:** registry backing the agent path with two contract kinds; idempotent interactive directives; frozen grant matrix; friendly errors.
- **Risk:** Medium-high — agent path is ungated today (verified: zero `ensurePermission` in manager.ts); default must be permissive-parity or flows break. Keep markers verbatim.

### Phase 3 — EventBus + one projection + push surfaces
- Promote emit + EventEmitter into TurnBus (append+fanout+seq atomic); all producers write through it.
- Export `projectTranscript(events,{summaryPrefix?})`; delete the two builders. **Freeze projection logic at the end of this phase** — Phase 6's FTS re-point depends on a stable projection (do not delete .md while projection still evolves).
- `listOpenInteractions(events)`; fold `pending-mcp-adds.json` into a **file-backed** unified pending queue with a discriminated `kind` (NOT reflex.db — see durability decision). Web cards + dashboard badge + Telegram consume it.
- Telegram poll → bus subscription, **keeping the turn-end `readEvents` reconciliation** (the poll self-heals today; subscription can miss a mid-turn force_reply edit, so reconciliation at turn-end is mandatory and must be as correct as the poll). Keep callback_data `p:/q:/m:/w:` byte-identical.
- Headless `sleep(400)/isActive` → `subscribeAgent` + turn-end promise. **Also convert the `dispatchSubAgents` ephemeral lifecycle** (same poll pattern) to a shared `runEphemeralAgent` — otherwise a second poll path survives.
- **Pin cursor semantics** (critic-2): the Telegram catch-up cursor and dispatcher `summaryCoveredCount` are **array-indices into `events.length`/`events.slice(0,cut)`** (verified `dispatcher.ts:128`), NOT seqs. When malformed-line quarantine (Phase 2) or dual-file collapse (Phase 6) shifts `readEvents()` output, they re-deliver or skip. Re-derive them against a stable key (seq, not index). Add a regression test: after quarantine and after collapse, the last Telegram answer is neither re-sent nor skipped.
- **Deliverable:** one bus, one projection (frozen), one file-backed pending model, push Telegram+headless+sub-agents, cursor semantics pinned.
- **Risk:** High — Telegram self-heal loss; cursor re-derivation; callback_data stability.

### Phase 4 — Collapse host-api + nodes onto the registry
- Rewrite `dispatchHostCall` (`host-api.ts:343`) as a `registry.invoke` adapter with `caller:'utility'`; fold `ensurePermission` into the registry permission check, `auditCall` into the `audit:'always'` wrapper. **The frozen grant matrix from Phase 2 governs the merge** — the unification must not loosen host-api's gating (utility privilege escalation) nor tighten the agent's (broken flows). These phases are coupled by the matrix; not independently shippable without it.
- Generate `host-api.mjs` proxy + prompt list + step picker from `registry.describe()`. **Golden-id test (Phase 0) gates this.** Already-built bundles pin the old proxy by string — newly-generated ids must reproduce the snapshot byte-identically, and `manifest.serverActions` (persisted at install) needs a migration or stays read-compatible.
- Convert capability `NODE_HANDLERS` to `registry.invoke` with `caller:'workflow'`; pure-transform nodes (text-template, http-request, web-fetch) stay node-local. Note: routing utility-call nodes here makes the registry indirectly own worker-thread spin-up + the `dist/.esm-cache` stale-CDN risk — flag, don't fix, in this phase.
- Unify audit: one write record. **Preserve the `/audit` reader's start/end correlationId-pair + parentCorrelationId shape** (per-utility, per-day keyspace) — do not naively merge into per-topic events.jsonl; keep distinct read formats valid.
- Collapse the 12-kind widget enum (duplicated 4×) into one `WIDGET_KINDS`; one `renderWidgetModel` feeding React + Telegram + Share.
- **Deliverable:** one capability definition across agents/utilities/workflows; golden-id-stable proxy; one widget model; audit keyspaces preserved.
- **Risk:** Medium-high — proxy id stability; persisted manifest format migration.

### Phase 5 — One background runtime + dispatcher as plugin + deterministic boot
- Merge schedulers + Telegram poller + dispatcher compaction into one `BackgroundRuntime` with `register(handler, intervalMs)` and disk-backed last-run state (file-backed, not reflex.db).
- **Switch sole boot to instrumentation.ts ONLY IF the Phase-0 spike was GO.** Otherwise wire an explicit `/api/startup` route the custom server hits. Remove warmup ping only after one release of soak with both paths live.
- ContextContributor registry replaces the `start-turn.ts:182-213` prompt array; dispatcher self-gates on `isHomeRoot`.
- Replace `processRoutes/processDispatchedReport` (`manager.ts:1104`) with a `relayPolicy` on `dispatchedFromDispatcher` topics; keep gating exactly home-only.
- Status surface as a **first-class home affordance** (not buried in Settings, which simple-mode users avoid): last tick, next fires, last run status/error.
- **Deliverable:** one scheduler, proven-deterministic boot, dispatcher as plugin, legible status on the home page.
- **Risk:** Medium — boot equivalence (de-risked by Phase 0 spike); home-only gating; globalThis guards vs HMR double-boot. Note: deterministic boot **cannot** start the external Codex App Server — a codex user retains that out-of-band dependency the convergence cannot absorb.

### Phase 6 — Topic dual-file collapse + rootRef + zero-friction UX
- **Topic collapse, sequenced AFTER projection is frozen (Phase 3).** Dual-index window: run the new FTS (projected transcript) **in parallel** with the legacy .md-body index for a validation soak. `.md`-body deletion is a **separate, later, opt-in release** — never in the same step that re-points the indexer. The validation oracle: the old .md-body index is ground truth; the dual-index window compares result sets before any deletion.
- **rootRef indirection with a committed dual-read window** (not a one-shot atomic migrator — atomicity across SQLite + a `0o600` secrets tree + JSON widgets + live browser URLs is impossible). Both old `SHA1(path)` and new `rootId` resolve during the window. **Complete strand inventory** (critic-3): registry entry, reflex.db FTS rows, `secrets/project/<rootId>/`, `ai-suggestions $REFLEX_HOME/roots/<rootId>/`, `<root>/.reflex/assets/images`, `.reflex/attachments`, `.reflex/worktrees` + copied memory, widget ids `utility:<id>`, URL segments. A partial migrator strands a credential or asset — worse than today's honest "Space not found."
- **Home as a real rootRef-backed entry from the start** (critic-3 disagreement accepted): do not ship a new indirection with one permanent `'home'` exception — that recreates the special-casing we are deleting. Keep the literal id `'home'` value stable (bookmarks/callbacks) but back it by the same rootRef machinery.
- Trash/undo for topic + widget deletion via the atomic store. **Extend to binary assets** (images + attachments) with a GC/management view — undo for topics but unbounded orphaned binaries fails the "data is safe" promise.
- Guided onboarding: **commit to a zero-config default harness** (auto-detect-and-pick-one, hide the three-way choice in simple mode — verified `detectEnginesAction` probes three CLIs with dev-doc links). One-tap Telegram bind (auto-bind surfaced). One install flow. One keep/dismiss for agent widgets.
- Fix the Share surface (`renderWidgetModel` + hardened auth boundary) and surface the active data dir + reset in Settings > Storage; collapse the two suggestion stores.
- **Deliverable:** single canonical topic store, safe rename/move via dual-read, undoable deletion incl. binaries, zero-config onboarding, working Share, legible storage UI.
- **Risk:** High — topic collapse (dual-index + opt-in delete mitigates); rootRef (dual-read window mitigates); both touch irreplaceable data.

---

## 4. Risks & mitigations (top-level)

1. **Duplicate seq under concurrency (real bug, not perf).** Sync read-and-increment, bus as sole authority incl. relay (migrated in Phase 1), adversarial concurrency test in Phase 0.
2. **Telegram poll→push loses self-healing.** Keep turn-end `readEvents` reconciliation; the cursor (array-index, re-derived to seq) stays the crash-idempotency guard.
3. **Node-floor / reflex.db hard dependency.** Verified sessions.db degrades to no-op when node:sqlite absent. **Pending queue + cursors stay file-backed** so a vanished card is impossible; only FTS (search) degrades gracefully. Different durability tiers, different stores.
4. **Proxy/bundle break on registry id generation.** Golden-id snapshot test (Phase 0) gates Phase 4; ids frozen/aliased.
5. **Permission-matrix merge silently loosens or tightens.** Matrix frozen in Phase 2; model ships inert; Phases 2+4 coupled around it.
6. **Destructive Phase-6 migrations.** Dual-index (FTS) + dual-read (rootRef) windows; opt-in delete only after soak; complete strand inventory.
7. **Boot non-equivalence under custom server.** Phase-0 GO/NO-GO spike; warmup ping retained until soak; `/api/startup` fallback.
8. **First-contact zod on never-validated data drops user widgets.** Lenient/coerce first pass; explicit per-store failure policy.
9. **Mid-turn grant divergence across harnesses.** Per-harness contract (kill-respawn for claude-code; defer-and-surface for codex/ollama).
10. **Atomic writes race on hot files.** Per-file mutex registry on globalThis.

---

## 5. The zero-friction end-state (non-technical)

The user opens Reflex and there is **one thing: a chat** (web or Telegram, same thread). They never see *harness, marker, root, seq, directive, scope*. Each friction removed maps to a seam removed:

- **It just starts.** Deterministic boot (Phase 5, gated by the Phase-0 spike) + retained ping until proven — "I messaged the bot and it answered" works first time, no browser.
- **It never shows garbage.** Strict-but-friendly directive parsing (Phase 2): a typo becomes "I couldn't complete that — retrying," never raw JSON.
- **Nothing vanishes.** TurnQueue + bus (Phase 3), per-harness mid-turn grant contract, trash/undo + one keep/dismiss (Phase 6) — every change is legible and reversible. No mid-sentence vanish on any harness.
- **Setup is one tap.** Zero-config default harness + auto-bind Telegram + one install flow (Phases 4 & 6).
- **Data is safe and movable.** Atomic store + rootRef dual-read (Phases 1 & 6); a crash can't corrupt config; moving a folder just works; secrets normalized to `0o600`.
- **The black box is legible.** Disk-backed BackgroundRuntime + status on the home page (Phase 5) — one calm "what's running / when / last result," not buried in Settings.
- **Sharing works.** Share renders real widgets via the one `renderWidgetModel` and no longer leaks the sidebar (Phases 4 & 6).

The throughline: a non-technical product needs **exactly one correct code path per behavior**. Consolidation produces that path — which is what makes "it just works" real rather than a veneer over six divergent implementations.

---

## 6. Open questions

1. **Pending-queue store:** committed to file-backed (not reflex.db) to preserve graceful degradation — confirm this is acceptable given it diverges from the "promote sessions.db" instinct.
2. **rootRef dual-read horizon:** how many releases does the old `SHA1(path)` continue to resolve before removal?
3. **Permission-tightening schedule:** the model ships inert; when (if ever) is the tightening pass scheduled, and which capabilities gate first (mcp.add, utility install, memory.write)?
4. **Marker vocabulary versioning:** we version the directive vocabulary so a single-syntax future is *possible* — do we ever actually migrate off legacy `<<reflex:name>>`, or is the cost never worth it?
5. **Two-install convergence (`~/.reflex` dev vs `~/.reflex-agent` prod):** in scope to merge registries, or only surface which dir is active?
6. **Codex external dependency:** the Codex App Server is out-of-band and unstartable by the kernel — do we bundle/manage it, or accept it as a codex-only prerequisite the "it just starts" promise excludes?
7. **OAuth-as-capability:** `$oauth:<provider>` hydration becomes a gated `oauth.token` capability — does it need its own audit/consent UX distinct from other capabilities given it is the most security-sensitive surface?

---

## Appendix A — Adversarial-review checklist (must-fixes by lens)

These are the concrete corrections the three critics flagged; the plan body already folds them in. Kept here as a verification checklist.

### Architectural soundness — verdict: needs-work
- Split the Capability contract into Sync + Interactive **before** Phase 2; do not present "one contract" as the thesis.
- State the seq invariant explicitly and prove it in **Phase 0** (synchronous read-and-increment, bus is sole authority for ALL writers incl. relay + sub-agent emits); add a concurrent-emit stress test.
- Make idempotency first-class for interactive directives: `(turnId, content-hash)`, not `?? shortId()`.
- Decide & enforce the boundary model (modular monolith + dependency-direction lint in Phase 0).
- Separate durability tiers: pending-queue must NOT share node:sqlite's silent-degrade with FTS.
- Sequence topic-collapse AFTER `projectTranscript` is frozen; ship rootId decoupling with a committed dual-read window.

### Migration feasibility & risk — verdict: needs-work
- Define a concrete per-artifact rollback contract before any forward migration.
- Fix seq phase-ordering: migrate `relay.ts` onto the bus in Phase 1 (or exclude dispatcher topic until Phase 5).
- Resolve the Node-floor / reflex.db dependency before Phase 3 (file fallback OR announced floor bump).
- Pin `deliveredCount` semantics (line-index, not seq) and re-derive on `readEvents()` shape change; regression test.
- Add capability-id / host-api-method golden snapshot test in Phase 0 (before Phase 4).
- Freeze the unified permission grant matrix before Phase 2's permissive default.
- Prove `instrumentation.ts` fires under `reflex start`'s custom server.
- Specify the FTS-collapse validation oracle before deleting any `.md` body.

### Completeness vs maps + non-technical UX — verdict: needs-work
- Add ALL credential/secret stores to the migration and normalize to `0o600` (incl. `settings.json` plaintext token).
- Enumerate the COMPLETE set of rootId-keyed strands before Phase 6 (registry, FTS rows, secrets, suggestions, assets, attachments, worktrees, widget ids, URLs).
- Resolve mid-turn permission/answer contract per harness (kill-respawn = claude-code only; codex/ollama = defer + surface).
- Commit to a zero-config default harness in onboarding (auto-detect-and-pick-one for simple mode).
- Fix the Share surface (blank widget stubs + sidebar string-check leak) as part of convergence.
- Scope binary-asset lifecycle (images + attachments) into the storage layer with GC/management UI.

---

## Appendix B — Subsystems mapped (ground truth)

Agents core / orchestration / protocol · Central Dispatcher + Home Space + Cross-Space Routing · Spaces / Topics Storage / Registry / Paths · Utilities · Widgets + Dashboard · Memory taxonomy + hygiene + sessions search · Workflows + durable scheduler · Notify channels (Telegram + push) · Settings / CLI / boot / npm distribution · Web app surface (routes / UI / server actions)
