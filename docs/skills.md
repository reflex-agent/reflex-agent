# Skills

Skills are reusable procedural snippets — "how to do X". The
orchestrator loads them on demand by id; the user (or the agent) types
`/skill <id>` and the skill's body is injected into the next turn's
system prompt.

The split between memory and skills mirrors Hermes Agent's distinction
between **declarative** memory ("what is true") and **procedural**
memory ("how to do things"). Both layers feed the system prompt; only
skills are scoped per-invocation.

## File layout

```
$REFLEX_HOME/skills/                     — global, available in every Space
└── <skill-id>.md

<root>/.reflex/skills/                   — project, available only in this Space
└── <skill-id>.md

manifest.extensions.skills[]             — utility-shipped skills
```

Each `.md` skill is markdown with optional YAML frontmatter:

```yaml
---
id: deep-research
label: Deep research
description: Use when the user wants a thorough, multi-source dive.
applies: ["bug", "research"]    # optional task-type nudge
---
You're doing a deep research pass. Steps:
1. Generate 3-5 angle queries.
2. For each angle, ...
```

`id` is required. `label` and `description` fall back to derivations
from the id. The body (everything after the frontmatter) is what gets
injected into the system prompt when the skill is loaded.

## Loading

`loadSkill(id, {rootId?})` resolves in this order:

1. Project scope (if `rootId` given).
2. Global scope.
3. Utility-shipped (any installed utility's
   `manifest.extensions.skills[]`).

First match wins. The user can override a global skill by writing one
with the same id under `<root>/.reflex/skills/`.

`listSkills({rootId?})` returns the deduped union, with each entry
tagged by source.

## Invocation

In a chat message, the user types:

```
/skill deep-research summarise the OAuth refresh paper
```

The manager:

1. Strips the `/skill <id>` prefix.
2. Loads the skill body.
3. Prepends it to the system prompt for the upcoming turn (one-shot —
   not persisted to subsequent turns).
4. Sends the remaining user text as the actual prompt.

The agent sees: `[skill-body]\n\nuser: summarise the OAuth refresh paper`.

## Authoring via marker

The agent can create a skill mid-turn:

```
<<reflex:skill-create>>
{
  "scope": "global",
  "id": "morning-routine-summary",
  "label": "Morning summary",
  "description": "Roll up overnight changes into a 5-line brief.",
  "body": "When asked for the morning summary, ..."
}
<</reflex:skill-create>>
```

The manager calls `writeSkill(scope, id, content)` which:

- Writes the `.md` file at the appropriate path.
- Refuses overwrites unless the marker carries `"overwrite": true`.
- Re-indexes the skills cache so the new skill is loadable in the same
  conversation.

## Utility-shipped skills

A utility can ship skills in its manifest:

```json
{
  "extensions": {
    "skills": [
      {
        "id": "task-board:pickup-prompt",
        "label": "Auto-pickup reasoning",
        "description": "...",
        "body": "When ranking tasks for auto-pickup, ..."
      }
    ]
  }
}
```

These are visible in `listSkills()` and loadable via `/skill <id>`
just like file-based skills. They're read-only; to modify, fork the
utility or override with a local copy.

## Skill vs workflow vs memory

| Layer | When |
|---|---|
| **Memory** | The fact is durably true (about the user, about the project). The agent should know it without being asked. |
| **Skill** | The process is reusable but situational. The agent loads it on demand for a specific kind of task. |
| **Workflow** | The process is structured, repeatable, runnable WITHOUT the agent in the loop. |

A "deep-research" approach is a skill. A "fetch HN front page, summarise,
save to KB" is a workflow. The user lives in Berlin is memory.

## UI

- `/settings → Skills` — list, edit, scope toggle.
- `/skill <id>` autocomplete in the chat palette pulls from
  `listSkills({rootId})`.
- Skill bodies render as markdown in the settings panel for review.
