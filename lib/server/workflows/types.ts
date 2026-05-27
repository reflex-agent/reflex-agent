/**
 * Workflows = linear "recipes" the user composes from a handful of typed
 * nodes (ask-agent, http-request, kb-write, text-template, web-fetch).
 * Designed for non-programmers — no DAGs, no branching syntax, no code
 * mode. The agent can compose them via `<<reflex:workflow-create>>`, the
 * UI lets the user tweak steps after creation.
 *
 * State flow: each step produces a JSON `output`. Subsequent steps see
 * all prior outputs via the `{{steps.<id>.output}}` mustache-like syntax
 * (or `{{prev}}` for the immediately preceding step's output). The
 * runner renders params before invoking the node handler.
 */

export type WorkflowTrigger = "manual" | "hourly" | "daily" | "weekly";

export type WorkflowStepKind =
  | "text-template"
  | "http-request"
  | "web-fetch"
  | "ask-agent"
  | "kb-write"
  | "utility-call"
  | "image-generate"
  | "image-search";

export interface WorkflowStep {
  /** Stable id within the workflow — referenced by templates and run logs. */
  id: string;
  kind: WorkflowStepKind;
  /** User-visible label, shown on the step card. */
  label: string;
  /** Kind-specific JSON params. Strings inside are template-rendered. */
  params: Record<string, unknown>;
}

export interface WorkflowDef {
  id: string;
  label: string;
  description?: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  /** Topic that authored or last edited this workflow (pencil → chat). */
  sourceTopicId?: string;
  /**
   * Scheduler-only flag. When `false`, the background ticker skips this
   * workflow even if the trigger interval has elapsed. Manual runs
   * (run button, /workflow command, runWorkflow API) still fire. Defaults
   * to `true` if absent — keeps backward compat with workflows written
   * before this field existed.
   */
  enabled?: boolean;
}

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface StepRunResult {
  stepId: string;
  status: StepStatus;
  output?: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Resolved params (after template rendering) — useful for debugging. */
  renderedParams?: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowLabel: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  steps: StepRunResult[];
  /** Optional initial payload from the trigger source. */
  initialInput?: unknown;
}

export interface WorkflowKindMeta {
  kind: WorkflowStepKind;
  label: string;
  description: string;
  /** Sample params used when adding the step via "+" picker. */
  defaultParams: Record<string, unknown>;
  /** Field hints for the params editor (kind → input type). */
  fields: Array<{
    key: string;
    label: string;
    type: "string" | "text" | "url" | "json" | "select";
    hint?: string;
    options?: string[];
    placeholder?: string;
  }>;
}

export const WORKFLOW_KINDS: WorkflowKindMeta[] = [
  {
    kind: "text-template",
    label: "Text template",
    description:
      "Assembles text from a template with substitutions from previous steps. Use as glue between steps before the next one.",
    defaultParams: { template: "Hello {{prev}}" },
    fields: [
      {
        key: "template",
        label: "Template",
        type: "text",
        hint: "Substitutions: {{prev}}, {{steps.<id>.output}}, {{input.<field>}}",
        placeholder: "Summary: {{prev}}",
      },
    ],
  },
  {
    kind: "http-request",
    label: "HTTP request",
    description:
      "Makes an HTTP request (GET by default). Puts the response body into output as a string or JSON if application/json.",
    defaultParams: { url: "https://api.example.com/", method: "GET" },
    fields: [
      { key: "url", label: "URL", type: "url", placeholder: "https://…" },
      {
        key: "method",
        label: "Method",
        type: "select",
        options: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      {
        key: "headers",
        label: "Headers (JSON)",
        type: "json",
        hint: "Example: {\"Authorization\":\"Bearer …\"}",
      },
      { key: "body", label: "Body", type: "text", hint: "Leave empty for GET" },
    ],
  },
  {
    kind: "web-fetch",
    label: "Fetch page",
    description:
      "Requests a URL and returns the textual content. Convenient for parsing pages without HTTP-config pain.",
    defaultParams: { url: "https://example.com" },
    fields: [
      { key: "url", label: "URL", type: "url", placeholder: "https://…" },
    ],
  },
  {
    kind: "ask-agent",
    label: "Ask the agent",
    description:
      "Runs a headless orchestrator agent with the given question. Output is the agent's reply (the full assistant text).",
    defaultParams: { prompt: "Briefly summarize: {{prev}}" },
    fields: [
      {
        key: "prompt",
        label: "Question for the agent",
        type: "text",
        placeholder: "Use {{prev}} to pass the input",
      },
    ],
  },
  {
    kind: "kb-write",
    label: "Write to KB",
    description:
      "Saves to the knowledge base as a Markdown file with frontmatter (kind, title, body). Use the previous step's output as `body`.",
    defaultParams: {
      kind: "note",
      title: "From workflow {{workflow.label}}",
      body: "{{prev}}",
    },
    fields: [
      { key: "kind", label: "Kind", type: "string", placeholder: "note" },
      {
        key: "title",
        label: "Title",
        type: "string",
        placeholder: "{{workflow.label}}",
      },
      {
        key: "body",
        label: "Body (Markdown)",
        type: "text",
        placeholder: "{{prev}}",
      },
    ],
  },
  {
    kind: "utility-call",
    label: "Call a mini-app",
    description:
      "Runs a named server action of an installed utility with the given args. Output = the action's result. utility-call lets the workflow use mini-app functions as a library.",
    defaultParams: {
      utilityId: "",
      utilityScope: "global",
      actionName: "",
      args: "{}",
    },
    fields: [
      {
        key: "utilityId",
        label: "Utility (id)",
        type: "string",
        placeholder: "my-utility",
      },
      {
        key: "utilityScope",
        label: "Scope",
        type: "select",
        options: ["global", "project"],
      },
      {
        key: "actionName",
        label: "Action",
        type: "string",
        placeholder: "name from manifest.serverActions",
      },
      {
        key: "args",
        label: "Arguments (JSON)",
        type: "json",
        hint: "Passed as the first argument to the action. {{prev}} substitutions work inside JSON strings.",
      },
    ],
  },
  {
    kind: "image-generate",
    label: "Generate an image",
    description:
      "Generates an image via Gemini Nano Banana or Codex `$imagegen`. Output: {url, sha, mime, provider} — `url` can be inserted into a kb-write body as `![]({{steps.<id>.output.url}})`.",
    defaultParams: {
      prompt: "cute raccoon in a spacesuit, watercolor",
      provider: "gemini",
      aspectRatio: "1:1",
    },
    fields: [
      {
        key: "prompt",
        label: "Prompt",
        type: "text",
        placeholder: "Image description",
      },
      {
        key: "provider",
        label: "Provider",
        type: "select",
        options: ["gemini", "codex"],
      },
      {
        key: "aspectRatio",
        label: "Aspect ratio",
        type: "select",
        options: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"],
      },
      {
        key: "size",
        label: "Size (opt.)",
        type: "string",
        placeholder: "1024x1024",
      },
    ],
  },
  {
    kind: "image-search",
    label: "Search images on the web",
    description:
      "Searches for ready-made images by query (Unsplash by default, Pexels as fallback). Output: {results: [{url, thumb, attribution}…]}.",
    defaultParams: {
      query: "mountains sunrise",
      provider: "unsplash",
      count: 6,
    },
    fields: [
      {
        key: "query",
        label: "Query",
        type: "string",
        placeholder: "mountains sunrise",
      },
      {
        key: "provider",
        label: "Provider",
        type: "select",
        options: ["unsplash", "pexels", "brave"],
      },
      {
        key: "count",
        label: "Result count",
        type: "string",
        placeholder: "6",
      },
    ],
  },
];

export function getKindMeta(kind: WorkflowStepKind): WorkflowKindMeta | null {
  return WORKFLOW_KINDS.find((k) => k.kind === kind) ?? null;
}
