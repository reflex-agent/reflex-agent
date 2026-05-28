import "server-only";
import path from "node:path";

/**
 * Relay a message from a dispatched Space agent back to the central
 * dispatcher: push it to the user's channels (Telegram) AND drop a line
 * into the dispatcher thread so the web view + the dispatcher's own
 * context see it. This is the return leg of the dispatcher↔Space link.
 */
export async function relayToDispatcher(args: {
  spaceName: string;
  body: string;
  status?: "done" | "question" | "update" | "blocked";
  /** Deep link to the Space chat where the work happened. */
  link?: string;
}): Promise<void> {
  const icon =
    args.status === "done"
      ? "✅"
      : args.status === "question" || args.status === "blocked"
        ? "❓"
        : "📨";
  const title = `${icon} ${args.spaceName}`;

  // Push to channels (Telegram etc.) — the "весточка".
  try {
    const { notify } = await import("@/lib/server/notify");
    await notify({
      title,
      body: args.body,
      ...(args.link ? { link: args.link } : {}),
    });
  } catch {
    /* notify is best-effort */
  }

  // Record it in the dispatcher thread so the web chat shows it and the
  // dispatcher has it as context on its next turn.
  try {
    const { getDispatcherTopic } = await import("./dispatcher");
    const { appendEventSeq } = await import("@/lib/server/agents/events-log");
    const d = await getDispatcherTopic();
    // Same seq authority as the agent emit path — the dispatcher topic has two
    // writers (agent turns + this relay), so both MUST share it or they mint
    // colliding seqs on the dispatcher's log.
    await appendEventSeq(d.rootPath, d.topicId, {
      type: "system",
      text: `[${args.spaceName}] ${args.body}`,
      agentId: "dispatcher-relay",
      ts: new Date().toISOString(),
      seq: 0,
    });
  } catch {
    /* best-effort */
  }
}

export function spaceNameFromPath(rootPath: string): string {
  return path.basename(rootPath) || rootPath;
}
