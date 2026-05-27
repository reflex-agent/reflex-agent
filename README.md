# Reflex

Local-first knowledge base. You point Reflex at a directory; an agent (Codex via agent-use or Claude Code in agent mode) walks it and materializes a hierarchical `.reflex/` of Markdown files describing what's there. Background watchers keep it fresh, with a debounce floor (≥ 30 min, configurable) so the agent never runs too often. Per-folder chats let you query the KB the same way you'd query ChatGPT/Codex, but scoped to that subdirectory.

## Install

Prerequisites:

- **Node.js 20+** ([nodejs.org](https://nodejs.org/) or via `nvm`/`fnm`/`volta`)
- **Codex CLI** authenticated — `npm i -g @openai/codex && codex login`

Install Reflex globally:

```sh
npm i -g reflex-agent
# or: pnpm add -g reflex-agent
# or: yarn global add reflex-agent
```

Then launch the web UI:

```sh
reflex start            # opens http://localhost:3210 in your browser
reflex start --port 4000 --no-open
```

Home page lists registered "Reflex roots". Add a directory via the built-in
file picker, then click **Run init** on the detail page to have the agent
build the KB. The left sidebar shows the resulting MD tree under `.reflex/`;
clicking a file renders it.

## CLI

```sh
reflex start                  # launch the web UI
reflex init <dir>             # scaffold .reflex/ and run initial agent pass
reflex watch <dir>            # watch dir and refresh KB on changes
reflex chat <dir>             # open a chat scoped to dir's KB
```

## Develop from source

```sh
pnpm install
pnpm dev     # http://localhost:3210 (Next dev server with HMR)
pnpm build   # produce dist/ + .next/standalone for `reflex start`
```

## Layout produced

```
<your-dir>/
├── .reflexignore            # gitignore-syntax — same rules
└── .reflex/
    ├── config.json          # debounce, agent backend, etc.
    ├── INDEX.md             # description of the whole dir
    └── <subdir>/
        ├── INDEX.md         # description of this subdir
        └── *.md             # topic-structured notes
```

## Config (`.reflex/config.json`)

```json
{
  "watchDebounceMs": 1800000,
  "agentBackend": "codex",
  "ignoreFile": ".reflexignore"
}
```

`watchDebounceMs` defaults to 30 minutes (`1800000`). You can lower it in `.reflex/config.json` if you want a tighter loop; the only enforced minimum is 1 second (anti-thrash).
