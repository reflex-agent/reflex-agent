import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { reflexHome } from "@/lib/reflex/home";
import { loadSettings } from "@/lib/settings/store";
import {
  startOrchestratorTurn,
  type Attachment,
} from "@/lib/server/agents/start-turn";
import { agentManager } from "@/lib/server/agents/manager";
import { readEvents } from "@/lib/server/agents/events-log";
import type { NotifyPayload } from "./index";

/**
 * Telegram channel: outbound `sendMessage` + an inbound long-poll loop
 * that turns Telegram into a full chat surface for Reflex. Replies run a
 * real orchestrator turn in a persistent "Telegram" topic (so the
 * conversation has memory + KB + tools) and come back in the chat.
 *
 * The poller is a process singleton booted from `app/layout.tsx`, mirror
 * of `startScheduler()` — guarded by a global, `.unref()`'d so it never
 * holds the process open.
 */

interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  rootId: string;
}

const TURN_TIMEOUT_MS = 4 * 60_000;
const POLL_TIMEOUT_S = 30; // long-poll window
const STATE_FILE = path.join(reflexHome(), "notify", "telegram-state.json");

// ---------------------------------------------------------------------------
// Outbound

function api(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

export async function sendTelegram(
  cfg: TelegramConfig,
  payload: NotifyPayload,
): Promise<void> {
  const parts: string[] = [];
  if (payload.title) parts.push(`*${escapeMd(payload.title)}*`);
  parts.push(escapeMd(payload.body));
  if (payload.link) parts.push(payload.link);
  await sendMessage(cfg.botToken, cfg.chatId, parts.join("\n\n"));
}

const TG_MAX = 4000;

async function tgCall(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; result?: { message_id?: number } }> {
  try {
    const res = await fetch(api(token, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return (await res.json()) as {
      ok: boolean;
      result?: { message_id?: number };
    };
  } catch {
    return { ok: false };
  }
}

async function sendMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const body = text.slice(0, TG_MAX);
  const r = await tgCall(token, "sendMessage", {
    chat_id: chatId,
    text: body,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
  // Retry once as plain text — a stray `*`/`_` can 400 the Markdown parse.
  if (!r.ok) {
    await tgCall(token, "sendMessage", { chat_id: chatId, text: body });
  }
}

/** Send a plain-text message and return its message_id (for later edits). */
async function sendPlain(
  token: string,
  chatId: string,
  text: string,
): Promise<number | null> {
  const r = await tgCall(token, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, TG_MAX),
    disable_web_page_preview: true,
  });
  return r.ok && r.result?.message_id ? r.result.message_id : null;
}

/** Edit a previously-sent message's plain text. Best-effort. */
async function editPlain(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  await tgCall(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, TG_MAX),
    disable_web_page_preview: true,
  });
}

interface InlineButton {
  text: string;
  data: string;
}

/** Send a plain message with an inline keyboard (rows of buttons). */
async function sendKeyboard(
  token: string,
  chatId: string,
  text: string,
  rows: InlineButton[][],
): Promise<number | null> {
  const r = await tgCall(token, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, TG_MAX),
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: rows.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.data })),
      ),
    },
  });
  return r.ok && r.result?.message_id ? r.result.message_id : null;
}

/** Replace a message's text and drop its keyboard (post-answer). */
async function resolveKeyboardMessage(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  await tgCall(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, TG_MAX),
    disable_web_page_preview: true,
  });
}

/** Prompt the user to reply (force_reply) — used for open answers / secrets. */
async function forceReply(
  token: string,
  chatId: string,
  text: string,
): Promise<number | null> {
  const r = await tgCall(token, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, TG_MAX),
    reply_markup: { force_reply: true },
  });
  return r.ok && r.result?.message_id ? r.result.message_id : null;
}

async function answerCallback(token: string, callbackId: string): Promise<void> {
  await tgCall(token, "answerCallbackQuery", { callback_query_id: callbackId });
}

async function deleteMessage(
  token: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  await tgCall(token, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

/** Markdown-v1 escape for the few chars that break Telegram parsing. */
function escapeMd(s: string): string {
  return s.replace(/([*_`\[])/g, "\\$1");
}

// ---------------------------------------------------------------------------
// Interactive state (in-memory)

// Per-topic serialized turn queue — keeps the poll loop non-blocking so a
// callback_query (button tap) can be received WHILE a turn streams.
const topicQueues = new Map<string, Promise<void>>();

function enqueueTurn(topicId: string, fn: () => Promise<void>): void {
  const prev = topicQueues.get(topicId) ?? Promise.resolve();
  const next = prev
    .then(fn)
    .catch((err) =>
      console.error(
        "[telegram] turn:",
        err instanceof Error ? err.message : err,
      ),
    );
  topicQueues.set(topicId, next);
}

// One streaming watcher per topic — tracks which interactions it already
// surfaced so it doesn't re-send a keyboard for the same request.
interface Watcher {
  presented: Set<string>;
}
const watchers = new Map<string, Watcher>();

// callback_data is capped at 64 bytes, so buttons carry a short id that
// maps back to the full interaction here.
interface RegEntry {
  agentId: string;
  topicId: string;
  rootPath: string;
  chatId: string;
  requestId: string;
  kind: "permission" | "question" | "mcp-add";
  /** permission decision / question answer carried by the button. */
  value?: string;
  scope?: "once" | "always";
}
const registry = new Map<string, RegEntry>();
let cbCounter = 0;

function register(entry: RegEntry): string {
  const id = `i${cbCounter++}`;
  registry.set(id, entry);
  return id;
}

// Awaiting a force_reply (open answer or a secret value), keyed by chatId.
interface PendingReply {
  agentId: string;
  topicId: string;
  rootPath: string;
  chatId: string;
  kind: "answer" | "secret";
  requestId: string;
  /** secret: env key currently being collected. */
  secretKey?: string;
  /** secret: remaining keys to collect after this one. */
  remaining?: string[];
  /** secret: values gathered so far. */
  collected?: Record<string, string>;
  /** message_id of the prompt, deleted with the reply for secrets. */
  promptMsgId?: number;
}
const pendingReplies = new Map<string, PendingReply>();

// ---------------------------------------------------------------------------
// Inbound poller (singleton)

interface PollerHandle {
  running: boolean;
  stop: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __reflexTelegramPoller: PollerHandle | undefined;
}

export function startTelegramPoller(): void {
  if (globalThis.__reflexTelegramPoller) return;
  const handle: PollerHandle = { running: false, stop: false };
  globalThis.__reflexTelegramPoller = handle;
  // Detach — the loop awaits getUpdates (30s long-poll) forever.
  void loop(handle);
}

export function stopTelegramPoller(): void {
  if (globalThis.__reflexTelegramPoller) {
    globalThis.__reflexTelegramPoller.stop = true;
    globalThis.__reflexTelegramPoller = undefined;
  }
}

async function loop(handle: PollerHandle): Promise<void> {
  if (handle.running) return;
  handle.running = true;
  let offset = await readOffset();
  while (!handle.stop) {
    let cfg: TelegramConfig | null = null;
    try {
      cfg = (await loadSettings()).notify?.telegram ?? null;
    } catch {
      /* settings unreadable — back off */
    }
    if (!cfg || !cfg.enabled || !cfg.botToken) {
      await sleep(15_000); // disabled — idle-poll the config
      continue;
    }
    try {
      const updates = await getUpdates(cfg.botToken, offset);
      for (const u of updates) {
        offset = u.update_id + 1;
        await writeOffset(offset);
        // Dispatch WITHOUT awaiting — turns run on a per-topic queue,
        // callbacks resolve inline. The poll loop must stay free to fetch
        // the next callback_query while a turn is still streaming.
        dispatchUpdate(cfg, u);
      }
    } catch (err) {
      console.error(
        "[telegram] getUpdates:",
        err instanceof Error ? err.message : err,
      );
      await sleep(5_000);
    }
  }
  handle.running = false;
}

interface TgMessage {
  message_id?: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number }>;
  chat?: { id: number };
  reply_to_message?: { message_id?: number };
}

interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id: number }; message_id?: number };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

function dispatchUpdate(cfg: TelegramConfig, u: TgUpdate): void {
  if (u.callback_query) {
    void handleCallback(cfg, u.callback_query).catch((err) =>
      console.error(
        "[telegram] callback:",
        err instanceof Error ? err.message : err,
      ),
    );
    return;
  }
  if (u.message?.chat) {
    void handleMessage(cfg, u.message).catch((err) =>
      console.error(
        "[telegram] message:",
        err instanceof Error ? err.message : err,
      ),
    );
  }
}

async function getUpdates(token: string, offset: number): Promise<TgUpdate[]> {
  const url = `${api(token, "getUpdates")}?timeout=${POLL_TIMEOUT_S}&offset=${offset}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000),
  });
  if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
  const body = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
  return body.result ?? [];
}

async function handleMessage(cfg: TelegramConfig, msg: TgMessage): Promise<void> {
  const chatId = msg.chat?.id;
  if (chatId === undefined) return;
  const photos = msg.photo ?? [];
  let text = (msg.text ?? msg.caption ?? "").trim();

  let allowedChatId = cfg.chatId;
  // First-message auto-bind (unchanged): connect on first text.
  if (!allowedChatId) {
    allowedChatId = String(chatId);
    try {
      const { loadSettings, saveSettings } = await import("@/lib/settings/store");
      const s = await loadSettings();
      await saveSettings({
        ...s,
        notify: {
          ...s.notify,
          telegram: { ...s.notify.telegram, chatId: allowedChatId },
        },
      });
    } catch {
      /* best-effort */
    }
    await sendMessage(
      cfg.botToken,
      allowedChatId,
      "Connected ✅ — I'll answer here from now on.",
    );
  }
  if (String(chatId) !== String(allowedChatId)) return;

  // If we're waiting on a force_reply (open answer / secret), this message
  // is that reply — route it instead of starting a new turn.
  const waiting = pendingReplies.get(allowedChatId);
  if (waiting && text) {
    await handleReplyInput(cfg, allowedChatId, waiting, text, msg.message_id);
    return;
  }

  if (!text && photos.length === 0) return;
  if (!text && photos.length > 0) text = "What's in this image?";

  const { getDispatcherTopic } = await import("@/lib/server/home/dispatcher");
  const d = await getDispatcherTopic();

  const attachments: Attachment[] = [];
  if (photos.length > 0) {
    const largest = photos[photos.length - 1]!;
    const att = await downloadTelegramPhoto(
      cfg.botToken,
      largest.file_id,
      d.rootPath,
    ).catch(() => null);
    if (att) attachments.push(att);
  }

  // Serialize per topic so two messages don't spawn two streamers.
  enqueueTurn(d.topicId, () =>
    runTurn(
      cfg.botToken,
      allowedChatId,
      d.rootId,
      d.rootPath,
      d.topicId,
      text,
      attachments,
    ),
  );
}

/** A tapped inline button — resolve the matching interaction. */
async function handleCallback(
  cfg: TelegramConfig,
  cq: TgCallbackQuery,
): Promise<void> {
  await answerCallback(cfg.botToken, cq.id);
  const chatId = cq.message?.chat?.id;
  const entry = cq.data ? registry.get(cq.data) : undefined;
  if (!entry || chatId === undefined) {
    if (chatId !== undefined && cq.message?.message_id) {
      await resolveKeyboardMessage(
        cfg.botToken,
        String(chatId),
        cq.message.message_id,
        "↻ This prompt expired (restart). Ask again.",
      );
    }
    return;
  }
  registry.delete(cq.data!);
  const msgId = cq.message?.message_id;
  try {
    if (entry.kind === "permission") {
      const decision = entry.value === "deny" ? "deny" : "allow";
      await agentManager.respondPermission(entry.agentId, {
        requestId: entry.requestId,
        decision,
        ...(entry.scope ? { scope: entry.scope } : {}),
      });
      if (msgId) {
        const label =
          decision === "deny"
            ? "❌ Denied"
            : entry.scope === "always"
              ? "✅ Allowed (always)"
              : "✅ Allowed once";
        await resolveKeyboardMessage(cfg.botToken, String(chatId), msgId, label);
      }
    } else if (entry.kind === "question") {
      await agentManager.respondQuestion(entry.agentId, {
        questionId: entry.requestId,
        answer: entry.value ?? "",
      });
      if (msgId) {
        await resolveKeyboardMessage(
          cfg.botToken,
          String(chatId),
          msgId,
          `✅ ${entry.value ?? ""}`,
        );
      }
    } else if (entry.kind === "mcp-add") {
      if (entry.value === "reject") {
        await agentManager.respondMcpAdd(entry.agentId, {
          requestId: entry.requestId,
          decision: "reject",
        });
        if (msgId) {
          await resolveKeyboardMessage(
            cfg.botToken,
            String(chatId),
            msgId,
            "❌ Skipped",
          );
        }
      } else {
        // approve — collect required secrets via force_reply, else connect now.
        if (msgId) {
          await resolveKeyboardMessage(
            cfg.botToken,
            String(chatId),
            msgId,
            "🔐 Connecting…",
          );
        }
        await beginSecretCollection(cfg, entry);
      }
    }
  } catch (err) {
    if (msgId) {
      await resolveKeyboardMessage(
        cfg.botToken,
        String(chatId),
        msgId,
        `⚠️ ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Route a force_reply: an open question answer or a secret value. */
async function handleReplyInput(
  cfg: TelegramConfig,
  chatId: string,
  waiting: PendingReply,
  text: string,
  replyMsgId?: number,
): Promise<void> {
  pendingReplies.delete(chatId);
  if (waiting.kind === "answer") {
    await agentManager
      .respondQuestion(waiting.agentId, {
        questionId: waiting.requestId,
        answer: text,
      })
      .catch((err) => console.error("[telegram] respondQuestion:", err));
    return;
  }

  // Secret value — record it, then scrub both the value and the prompt
  // from the chat so the secret doesn't linger in Telegram.
  const collected = { ...(waiting.collected ?? {}) };
  if (waiting.secretKey) collected[waiting.secretKey] = text;
  if (replyMsgId) await deleteMessage(cfg.botToken, chatId, replyMsgId);
  if (waiting.promptMsgId)
    await deleteMessage(cfg.botToken, chatId, waiting.promptMsgId);

  const remaining = waiting.remaining ?? [];
  if (remaining.length > 0) {
    const [next, ...rest] = remaining;
    const promptMsgId = await forceReply(
      cfg.botToken,
      chatId,
      `Paste value for \`${next}\``,
    );
    pendingReplies.set(chatId, {
      ...waiting,
      secretKey: next,
      remaining: rest,
      collected,
      ...(promptMsgId ? { promptMsgId } : { promptMsgId: undefined }),
    });
    return;
  }

  // All collected → approve the mcp-add with the secret values.
  await agentManager
    .respondMcpAdd(waiting.agentId, {
      requestId: waiting.requestId,
      decision: "approve",
      secretValues: collected,
    })
    .catch((err) => console.error("[telegram] respondMcpAdd:", err));
  await sendMessage(cfg.botToken, chatId, "✅ Connected.");
}

/**
 * Begin (or skip) secret collection for an approved mcp-add. Reads the
 * request's declared secret slots; prompts the first via force_reply, or
 * connects immediately when none are required.
 */
async function beginSecretCollection(
  cfg: TelegramConfig,
  entry: RegEntry,
): Promise<void> {
  const events = await readEvents(entry.rootPath, entry.topicId);
  const req = events.find(
    (e): e is Extract<typeof events[number], { type: "mcp-add-request" }> =>
      e.type === "mcp-add-request" && e.requestId === entry.requestId,
  );
  const keys = (req?.secrets ?? [])
    .filter((s) => s.required !== false)
    .map((s) => s.envKey);
  if (keys.length === 0) {
    await agentManager
      .respondMcpAdd(entry.agentId, {
        requestId: entry.requestId,
        decision: "approve",
        secretValues: {},
      })
      .catch((err) => console.error("[telegram] respondMcpAdd:", err));
    await sendMessage(cfg.botToken, entry.chatId, "✅ Connected.");
    return;
  }
  const [first, ...rest] = keys;
  const promptMsgId = await forceReply(
    cfg.botToken,
    entry.chatId,
    `Paste value for \`${first}\` (it'll be deleted from the chat right after).`,
  );
  pendingReplies.set(entry.chatId, {
    agentId: entry.agentId,
    topicId: entry.topicId,
    rootPath: entry.rootPath,
    chatId: entry.chatId,
    kind: "secret",
    requestId: entry.requestId,
    secretKey: first,
    remaining: rest,
    collected: {},
    ...(promptMsgId ? { promptMsgId } : {}),
  });
}

async function downloadTelegramPhoto(
  token: string,
  fileId: string,
  rootPath: string,
): Promise<Attachment | null> {
  const meta = await tgCall(token, "getFile", { file_id: fileId });
  const filePath = (meta as { result?: { file_path?: string } }).result
    ?.file_path;
  if (!meta.ok || !filePath) return null;
  const res = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const dir = path.join(rootPath, ".reflex", "attachments");
  await fs.mkdir(dir, { recursive: true });
  const name = `tg-${Date.now().toString(36)}-${path.basename(filePath)}`;
  const abs = path.join(dir, name);
  await fs.writeFile(abs, bytes);
  return {
    name,
    absPath: abs,
    size: bytes.length,
    mime: filePath.endsWith(".png") ? "image/png" : "image/jpeg",
  };
}

const EDIT_THROTTLE_MS = 1500;
// Generous cap — a turn that pauses on a permission/question waits here
// for the user's tap. Normal turns break as soon as the agent idles.
const INTERACTIVE_TIMEOUT_MS = 15 * 60_000;

/**
 * Run a turn and stream it into Telegram. Edits a placeholder message as
 * the assistant text grows (Telegram's stand-in for token streaming) AND
 * surfaces any interaction the agent raises (question / permission /
 * mcp-add) as inline keyboards — so the turn can pause for the user and
 * resume after a tap, all in one thread. One runTurn per topic at a time
 * (serialized by the topic queue).
 */
async function runTurn(
  token: string,
  chatId: string,
  rootId: string,
  rootPath: string,
  topicId: string,
  message: string,
  attachments: Attachment[] = [],
): Promise<void> {
  const before = (await readEvents(rootPath, topicId)).length;
  const res = await startOrchestratorTurn({ rootId, topicId, message, attachments });
  if ("error" in res) {
    await sendMessage(token, chatId, `⚠️ ${res.error}`);
    return;
  }

  const watcher: Watcher = { presented: new Set() };
  watchers.set(topicId, watcher);
  const messageId = await sendPlain(token, chatId, "💭…");
  const collect = async (): Promise<string> => {
    const events = await readEvents(rootPath, topicId);
    const text = events
      .slice(before)
      .filter(
        (e): e is Extract<(typeof events)[number], { type: "assistant-delta" }> =>
          e.type === "assistant-delta",
      )
      .map((e) => e.text)
      .join("");
    return stripMarkers(text);
  };

  const deadline = Date.now() + INTERACTIVE_TIMEOUT_MS;
  let lastShown = "";
  let lastEditAt = 0;
  await sleep(400);
  try {
    while (Date.now() < deadline) {
      const cur = await collect();
      const head = cur.slice(0, TG_MAX);
      if (
        messageId &&
        head &&
        head !== lastShown &&
        Date.now() - lastEditAt >= EDIT_THROTTLE_MS
      ) {
        await editPlain(token, chatId, messageId, head);
        lastShown = head;
        lastEditAt = Date.now();
      }
      const open = await presentInteractions(
        token,
        chatId,
        rootPath,
        topicId,
        watcher,
      );
      const active = agentManager.isActive(topicId);
      // Keep watching while the agent runs OR an interaction is still
      // waiting for the user. Otherwise the turn is done.
      if (!active && !open) break;
      await sleep(700);
    }
    await sleep(300); // flush trailing deltas

    const finalText = await collect();
    const head = finalText.slice(0, TG_MAX);
    if (messageId) {
      if (head && head !== lastShown) {
        await editPlain(token, chatId, messageId, head);
      } else if (!head) {
        // No assistant prose (e.g. the turn was only an interaction) —
        // drop the placeholder so it isn't left as "💭…".
        await deleteMessage(token, chatId, messageId);
      }
    } else if (head) {
      await sendMessage(token, chatId, head);
    }
    for (let i = TG_MAX; i < finalText.length; i += TG_MAX) {
      await sendMessage(token, chatId, finalText.slice(i, i + TG_MAX));
    }
  } finally {
    watchers.delete(topicId);
  }
}

interface OpenInteraction {
  kind: "permission" | "question" | "mcp-add";
  requestId: string;
  tool?: string;
  description?: string;
  prompt?: string;
  choices?: string[];
  options?: Array<{ label: string }>;
  label?: string;
  secrets?: Array<{ envKey: string; label: string; required?: boolean }>;
}

/**
 * Surface any not-yet-presented open interaction as a keyboard / prompt.
 * Returns true if there is at least one OPEN interaction (so the turn
 * loop knows to keep waiting for the user).
 */
async function presentInteractions(
  token: string,
  chatId: string,
  rootPath: string,
  topicId: string,
  watcher: Watcher,
): Promise<boolean> {
  const open = openInteractions(await readEvents(rootPath, topicId));
  if (open.length === 0) return false;
  const agentId = agentIdForTopic(topicId);
  for (const it of open) {
    if (watcher.presented.has(it.requestId) || !agentId) continue;
    watcher.presented.add(it.requestId);
    if (it.kind === "permission") {
      const base = {
        agentId,
        topicId,
        rootPath,
        chatId,
        requestId: it.requestId,
        kind: "permission" as const,
      };
      const rows: InlineButton[][] = [
        [
          { text: "✅ Allow once", data: register({ ...base, value: "allow", scope: "once" }) },
          { text: "✅ Always", data: register({ ...base, value: "allow", scope: "always" }) },
        ],
        [{ text: "❌ Deny", data: register({ ...base, value: "deny" }) }],
      ];
      const title = it.tool ? `🔐 Allow \`${it.tool}\`?` : "🔐 Permission?";
      await sendKeyboard(
        token,
        chatId,
        it.description ? `${title}\n${it.description}` : title,
        rows,
      );
    } else if (it.kind === "question") {
      const labels = (it.options?.map((o) => o.label) ?? it.choices ?? []).filter(
        Boolean,
      );
      const head = `❓ ${it.prompt ?? "Question"}`;
      if (labels.length > 0) {
        const rows: InlineButton[][] = labels
          .slice(0, 8)
          .map((l) => [
            {
              text: l.slice(0, 60),
              data: register({
                agentId,
                topicId,
                rootPath,
                chatId,
                requestId: it.requestId,
                kind: "question",
                value: l,
              }),
            },
          ]);
        await sendKeyboard(token, chatId, head, rows);
      } else {
        const promptMsgId = await forceReply(token, chatId, head);
        pendingReplies.set(chatId, {
          agentId,
          topicId,
          rootPath,
          chatId,
          kind: "answer",
          requestId: it.requestId,
          ...(promptMsgId ? { promptMsgId } : {}),
        });
      }
    } else if (it.kind === "mcp-add") {
      const base = {
        agentId,
        topicId,
        rootPath,
        chatId,
        requestId: it.requestId,
        kind: "mcp-add" as const,
      };
      const need = (it.secrets ?? []).filter((s) => s.required !== false);
      const rows: InlineButton[][] = [];
      if (need.length > 0) {
        rows.push([
          { text: "🔐 Enter secrets", data: register({ ...base, value: "approve" }) },
        ]);
      } else {
        rows.push([
          { text: "✅ Connect", data: register({ ...base, value: "approve" }) },
        ]);
      }
      rows.push([{ text: "Skip", data: register({ ...base, value: "reject" }) }]);
      const slots = need.length
        ? `\nSecrets: ${need.map((s) => s.envKey).join(", ")}`
        : "";
      await sendKeyboard(
        token,
        chatId,
        `🔐 Connect ${it.label ?? "a service"}?${slots}`,
        rows,
      );
    }
  }
  return true;
}

/** Scan events for still-open interactions, with full payloads. */
function openInteractions(
  events: import("@/lib/server/agents/types").AgentEvent[],
): OpenInteraction[] {
  const open = new Map<string, OpenInteraction>();
  for (const e of events) {
    if (e.type === "permission-request") {
      open.set(`p:${e.requestId}`, {
        kind: "permission",
        requestId: e.requestId,
        ...(e.tool ? { tool: e.tool } : {}),
        ...(e.description ? { description: e.description } : {}),
      });
    } else if (e.type === "permission-response") {
      open.delete(`p:${e.requestId}`);
    } else if (e.type === "question") {
      open.set(`q:${e.questionId}`, {
        kind: "question",
        requestId: e.questionId,
        prompt: e.prompt,
        ...(e.choices ? { choices: e.choices } : {}),
        ...(e.options ? { options: e.options } : {}),
      });
    } else if (e.type === "answer") {
      open.delete(`q:${e.questionId}`);
    } else if (e.type === "mcp-add-request") {
      open.set(`m:${e.requestId}`, {
        kind: "mcp-add",
        requestId: e.requestId,
        label: e.label,
        ...(e.secrets ? { secrets: e.secrets } : {}),
      });
    } else if (e.type === "mcp-add-response") {
      open.delete(`m:${e.requestId}`);
    }
  }
  return [...open.values()];
}

/** The agent currently (or most recently) running this topic. */
function agentIdForTopic(topicId: string): string | null {
  const list = agentManager.list({ topicId });
  if (list.length === 0) return null;
  const running = list.find((a) => a.status === "running" || a.status === "starting");
  return (running ?? list[list.length - 1])?.id ?? null;
}

function stripMarkers(text: string): string {
  return text
    .replace(/<{1,2}reflex:[a-z-]+>{1,2}[\s\S]*?<{1,2}\/reflex:[a-z-]+>{1,2}/g, "")
    // Drop a trailing, not-yet-closed marker so half-streamed JSON doesn't flash.
    .replace(/<{1,2}reflex:[a-z-]+>{1,2}[\s\S]*$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// State (poll offset + persistent topic id)

interface TgState {
  offset?: number;
  topicId?: string;
  rootId?: string;
}

async function readState(): Promise<TgState> {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8")) as TgState;
  } catch {
    return {};
  }
}

async function writeState(state: TgState): Promise<void> {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function readOffset(): Promise<number> {
  return (await readState()).offset ?? 0;
}

async function writeOffset(offset: number): Promise<void> {
  const state = await readState();
  await writeState({ ...state, offset });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
