# Changelog

All notable changes to Reflex are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semver.

## [0.19.1] — 2026-05-29

Ships the Share Plane's user interface and reorganizes settings.

### Added

- **Settings → Sharing** — review every cross-utility grant (consumer →
  provider, plane, scope, revoked/expired state) and revoke any in place; a
  `requireScopedReads` toggle; and a read-only directory of installed providers
  (their data kinds + exported verbs).
- **Just-in-time consent** — when a utility's Share Plane call lacks a grant,
  the host raises an unspoofable consent prompt in the iframe wrapper and, on
  approval, records the grant and transparently retries the original call.
  Works regardless of install order (dynamic / late-bound).
- **Install-preview transparency** — the GitHub install dialog now surfaces the
  sensitive permission slots (tasks / worktree / shares.consume) and a
  Cross-utility access section (what a utility provides + may consume).
- **Tabbed settings** — the settings page is grouped into General, Agents &
  models, Integrations, Notifications & sharing, and Advanced, each with a short
  description of what it covers.

### Notes / limitations

- JIT consent currently covers utility **iframe** host calls. **Worker**
  (server-action) and **scheduled-workflow** contexts can't prompt, so they rely
  on a grant created earlier (an iframe prompt or Settings → Sharing).
- Grants are persistent ("Allow"); "allow once" and interface-level ("any
  provider of this kind") grants are not yet offered.
- The `writer-studio` utility and `task-board`'s `provides` / slot declarations
  still ship in their own repos.

## [0.19.0] — 2026-05-29

The headline of this release is the **Share Plane** — a governed, dynamic way
for installable utilities to share data and call each other — plus the security
hardening that made it safe to build. See [docs/sharing.md](docs/sharing.md) for
the full design.

### Added

- **Share Plane (cross-utility data sharing).** Sandboxed utilities can now,
  with the user's consent, read another utility's data and call verbs it
  exports — without blanket access to the rest of a Space. Two planes over one
  consent/grant/audit broker:
  - **DATA plane** — `kb.scopedList` / `kb.scopedRead` return only a provider's
    own entries for a granted `kind`, filtered by the host-stamped, unspoofable
    `createdBy`.
  - **CAPABILITY plane** — `capabilities.invoke` runs a provider's exported
    verb inside the provider's own sandbox (its dir/data/secrets), never the
    caller's; `capabilities.listProviders` is metadata-only discovery.
  - Manifests gain `provides` (claim data kinds / export verbs) and `consumes`
    (declare intent — grants nothing, never fails install if the provider is
    absent, binds by interface at runtime).
  - New substrate: a grant ledger (`$REFLEX_HOME/grants.json`, 0600) and a
    self-healing provider directory (`$REFLEX_HOME/providers.json`) with
    first-claim-wins kind ownership.
- **Permission slots** `permissions.tasks` (`read`/`write`/`dispatch`),
  `permissions.worktree`, and `permissions.shares.consume`.
- **Opt-in `requireScopedReads` posture** (Settings; default off) that narrows
  blanket `kb.read`/`kb.list` to a utility's own entries plus granted ones,
  closing the blanket-read backdoor without breaking existing utilities.
- **Grant lifecycle server actions** (`listGrantsAction` / `revokeGrantAction`
  / `listProvidersAction`) for a forthcoming Settings → Sharing page.
- `reflex-agent/utility-registry` repo seeded as the remote curated-utility
  registry (overlays the inline baseline).

### Changed

- **`tasks.*` and `git.worktree.*` are now gated by real permission slots**
  (fix B) instead of a hard-coded `task-board` id check — any utility can
  request them and the user consents at install. An un-upgraded `task-board`
  is grandfathered in until it ships its declarations.
- `kb.add` is **owner-enforced**: once a provider claims a kind, only that
  provider may write it (unclaimed/legacy kinds are unaffected).
- Install/uninstall refresh the provider directory; uninstall also prunes every
  grant touching the utility.
- Project + utility repositories migrated to the `reflex-agent` GitHub org;
  all in-code addresses (curated registry, `package.json`, docs) updated.

### Security

- **Closed a privilege-escalation hole:** `tasks.dispatch` (spawns a subprocess
  agent) and `git.worktree.*` (mutate the user's real repo) carried no
  id/permission check despite the docs claiming "task-board only" — any
  installed utility could call them. Now gated at `dispatchHostCall` (the single
  iframe + worker entry); denied calls are audited. Read-only
  `git.isRepo`/`hasRemote`/`hasGhCli` stay open.

### Not yet shipped (follow-up)

- React surfaces: the install-time consent dialog, the just-in-time
  `grant-request` directive shown in chat, and the Settings → Sharing revoke
  page (its server actions already exist).
- The `writer-studio` consumer utility and `task-board`'s `provides` + slot
  declarations land in their own repos.

[0.19.1]: https://github.com/reflex-agent/reflex-agent/releases/tag/v0.19.1
[0.19.0]: https://github.com/reflex-agent/reflex-agent/releases/tag/v0.19.0
