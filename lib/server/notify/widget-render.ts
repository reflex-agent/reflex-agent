import "server-only";
import type {
  WidgetRecord,
  WidgetData,
  MarkdownData,
  NewsListData,
  LinkListData,
  KpiData,
  ChecklistData,
  QuoteData,
  KbPinnedData,
  ProgressData,
  ImageData,
  StatTableData,
  MapData,
  ActionListData,
  UtilityCardData,
} from "@/lib/server/widgets/types";

/**
 * Render a dashboard widget to Telegram. The web dashboard draws rich
 * cards; on the phone we flatten each widget kind to a formatted text
 * block (consumed by `mdToTelegramHtml`). `action-list` items that carry
 * an action become tappable inline buttons — but only when the widget
 * has a utility context (it's the inner of a `utility-card`), mirroring
 * the web rule that buttons need a utility to invoke against.
 */

/** One actionable item, flattened across groups — index-aligned with buttons. */
export interface WidgetActionRef {
  itemId: string;
  label: string;
  actionName: string;
  args?: Record<string, unknown>;
  confirm?: string;
}

export interface RenderedWidget {
  /** Markdown body, fed through `mdToTelegramHtml` before sending. */
  text: string;
  /** Present only for actionable utility-card widgets. */
  utility?: { id: string; scope: "global" | "project" };
  /** Flattened actionable items in button order. */
  actions: WidgetActionRef[];
}

export function renderWidget(record: WidgetRecord): RenderedWidget {
  const header = widgetHeader(record.title, record.description);
  // utility-card carries the utility context + an inner widget to draw.
  if (record.kind === "utility-card") {
    const card = record.data as UtilityCardData;
    const inner = card.inner;
    const body = renderBody(inner.kind, inner.data);
    const actions =
      inner.kind === "action-list"
        ? flattenActions(inner.data as ActionListData)
        : [];
    return {
      text: [header, body].filter(Boolean).join("\n"),
      utility: { id: card.utilityId, scope: card.utilityScope },
      actions,
    };
  }
  return {
    text: [header, renderBody(record.kind, record.data)]
      .filter(Boolean)
      .join("\n"),
    actions: [],
  };
}

function widgetHeader(title: string, description?: string): string {
  const lines = [`**${title}**`];
  if (description) lines.push(`_${description}_`);
  return lines.join("\n");
}

/** Pull every item that carries an action, in stable group→item order. */
function flattenActions(data: ActionListData): WidgetActionRef[] {
  const out: WidgetActionRef[] = [];
  for (const group of data.groups ?? []) {
    for (const item of group.items ?? []) {
      if (!item.action) continue;
      out.push({
        itemId: item.id,
        label: item.action.label,
        actionName: item.action.actionName,
        ...(item.action.args ? { args: item.action.args } : {}),
        ...(item.action.confirm ? { confirm: item.action.confirm } : {}),
      });
    }
  }
  return out;
}

function renderBody(kind: string, data: unknown): string {
  switch (kind as WidgetData["kind"]) {
    case "markdown":
      return (data as MarkdownData).body ?? "";
    case "kpi":
      return renderKpi(data as KpiData);
    case "quote":
      return renderQuote(data as QuoteData);
    case "checklist":
      return renderChecklist(data as ChecklistData);
    case "progress":
      return renderProgress(data as ProgressData);
    case "stat-table":
      return renderStatTable(data as StatTableData);
    case "news-list":
      return renderNewsList(data as NewsListData);
    case "link-list":
      return renderLinkList(data as LinkListData);
    case "kb-pinned":
      return renderKbPinned(data as KbPinnedData);
    case "image":
      return renderImage(data as ImageData);
    case "map":
      return renderMap(data as MapData);
    case "action-list":
      return renderActionList(data as ActionListData);
    default:
      return "";
  }
}

function renderKpi(data: KpiData): string {
  const arrow = (d?: string) =>
    d === "up" ? " 📈" : d === "down" ? " 📉" : d === "flat" ? " ➡️" : "";
  return (data.items ?? [])
    .map((i) => {
      const hint = i.hint ? ` _(${i.hint})_` : "";
      return `• ${i.label}: **${i.value}**${arrow(i.delta)}${hint}`;
    })
    .join("\n");
}

function renderQuote(data: QuoteData): string {
  const attr = data.attribution ? `\n— ${data.attribution}` : "";
  return `_“${data.text}”_${attr}`;
}

function renderChecklist(data: ChecklistData): string {
  return (data.items ?? [])
    .map((i) => `${i.done ? "☑" : "☐"} ${i.text}`)
    .join("\n");
}

function renderProgress(data: ProgressData): string {
  return (data.items ?? [])
    .map((i) => {
      const unit = i.unit ? ` ${i.unit}` : "";
      const pct =
        i.target > 0 ? Math.max(0, Math.min(1, i.current / i.target)) : 0;
      const filled = Math.round(pct * 10);
      const bar = "█".repeat(filled) + "░".repeat(10 - filled);
      return `${i.label}: ${i.current}/${i.target}${unit}\n${bar} ${Math.round(pct * 100)}%`;
    })
    .join("\n");
}

function renderStatTable(data: StatTableData): string {
  const rows = data.rows ?? [];
  if (rows.length === 0) return "";
  // Emit a GFM table — mdToTelegramHtml's table converter formats it.
  const cols = data.columns ?? [];
  const lines: string[] = [];
  if (cols.length > 0) {
    lines.push(`| ${cols.join(" | ")} |`);
    lines.push(`| ${cols.map(() => "---").join(" | ")} |`);
  }
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function renderNewsList(data: NewsListData): string {
  return (data.items ?? [])
    .map((i) => {
      const title = i.url ? `[${i.title}](${i.url})` : i.title;
      const meta = [i.source, i.date].filter(Boolean).join(", ");
      const tail = [i.summary, meta ? `_(${meta})_` : ""]
        .filter(Boolean)
        .join(" — ");
      const dot = i.read ? "◦" : "•";
      return tail ? `${dot} ${title} — ${tail}` : `${dot} ${title}`;
    })
    .join("\n");
}

function renderLinkList(data: LinkListData): string {
  return (data.items ?? [])
    .map((i) => {
      const link = `[${i.title}](${i.url})`;
      return i.hint ? `• ${link} — ${i.hint}` : `• ${link}`;
    })
    .join("\n");
}

function renderKbPinned(data: KbPinnedData): string {
  return (data.items ?? [])
    .map((i) => {
      const title = i.title ?? i.rel;
      const snippet = i.snippet ? ` — ${i.snippet}` : "";
      return `• ${title} \`${i.rel}\`${snippet}`;
    })
    .join("\n");
}

function renderImage(data: ImageData): string {
  const label = data.caption ?? data.alt ?? "image";
  return `🖼 [${label}](${data.url})`;
}

function renderMap(data: MapData): string {
  const pts = data.points ?? [];
  const head = `📍 ${pts.length} point${pts.length === 1 ? "" : "s"}`;
  const list = pts
    .slice(0, 10)
    .map((p) => {
      const desc = p.description ? ` — ${p.description}` : "";
      return `• ${p.title} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})${desc}`;
    })
    .join("\n");
  return [head, list].filter(Boolean).join("\n");
}

function renderActionList(data: ActionListData): string {
  const parts: string[] = [];
  for (const group of data.groups ?? []) {
    const items = group.items ?? [];
    parts.push(`**${group.label}**`);
    if (items.length === 0) {
      if (group.emptyText) parts.push(`_${group.emptyText}_`);
      continue;
    }
    for (const item of items) {
      const badge = item.badge ? `[${item.badge}] ` : "";
      const sub = item.subtitle ? ` — ${item.subtitle}` : "";
      parts.push(`• ${badge}${item.title}${sub}`);
    }
  }
  return parts.join("\n");
}
