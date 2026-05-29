import "server-only";
import { z, type ZodTypeAny } from "zod";

/**
 * CapabilityRegistry (north-star Layer 2) — the single contract that agents,
 * utilities, and workflows declare against and invoke through. Today the same
 * operations are dispatched three+ ways (the `<<reflex:*>>` marker switch in
 * manager.ts, the host-api method switch, the workflow NODE_HANDLERS). They
 * converge here over later phases; this module is the contract + the registry.
 *
 * TWO kinds, deliberately (a single "invoke()" contract was the original
 * plan's core design error — verified against the code): permission/question/
 * mcp-add SUSPEND the turn and resolve out-of-band, whereas kb/memory/notify
 * fire-and-return a value.
 *
 * Pure: depends only on zod. No imports of higher layers — surfaces/impls
 * register their capabilities by importing THIS (a Layer-4→2 import, allowed),
 * so the registry never reaches "up".
 */

export type Caller = "agent" | "utility" | "workflow" | "user";

export interface CapabilityContext {
  caller: Caller;
  rootId?: string;
  rootPath?: string;
  topicId?: string;
  /** Links the invocation across the audit trail. */
  correlationId?: string;
}

/** How an invocation is recorded. */
export type AuditMode = "always" | "event" | "silent";

/** Fire-and-return: kb.add, memory.write, notify, image.generate, widget.upsert… */
export interface SyncCapability<I = unknown, O = unknown> {
  kind: "sync";
  id: string;
  /** zod schema for `input`; validated in invoke() when present. */
  input?: ZodTypeAny;
  audit?: AuditMode;
  /** One-line description for describe()/prompt generation. */
  doc?: string;
  run(input: I, ctx: CapabilityContext): Promise<O> | O;
}

/** Suspend-and-resolve: permission, question, mcp-add, route, report. */
export interface InteractiveDirective<I = unknown, R = unknown> {
  kind: "interactive";
  id: string;
  input?: ZodTypeAny;
  audit?: AuditMode;
  doc?: string;
  /** Emit a request (suspends the turn). Returns its requestId. */
  open(input: I, ctx: CapabilityContext): Promise<{ requestId: string }> | { requestId: string };
  /** Resolve a previously-opened request (out-of-band, possibly a later turn). */
  resolve(
    requestId: string,
    response: R,
    ctx: CapabilityContext,
  ): Promise<void> | void;
  /**
   * Stable key derived from content so a respawn/re-scan can't open a duplicate
   * request. Defaults to the agent-supplied id when omitted.
   */
  idempotencyKey?(input: I, ctx: CapabilityContext): string;
}

export type Capability = SyncCapability | InteractiveDirective;

export interface CapabilityDescriptor {
  id: string;
  kind: Capability["kind"];
  audit: AuditMode;
  doc?: string;
}

export class CapabilityRegistry {
  private readonly caps = new Map<string, Capability>();

  register(cap: Capability): void {
    if (this.caps.has(cap.id)) {
      throw new Error(`capability already registered: ${cap.id}`);
    }
    this.caps.set(cap.id, cap);
  }

  has(id: string): boolean {
    return this.caps.has(id);
  }

  get(id: string): Capability | undefined {
    return this.caps.get(id);
  }

  /** Invoke a SYNC capability; throws for unknown ids or interactive ones. */
  async invoke<O = unknown>(
    id: string,
    input: unknown,
    ctx: CapabilityContext,
  ): Promise<O> {
    const cap = this.caps.get(id);
    if (!cap) throw new Error(`unknown capability: ${id}`);
    if (cap.kind !== "sync") {
      throw new Error(`capability ${id} is interactive — use open()/resolve()`);
    }
    const parsed = cap.input ? cap.input.parse(input) : input;
    return (await cap.run(parsed, ctx)) as O;
  }

  /** Open an INTERACTIVE directive; throws for unknown ids or sync ones. */
  async open(
    id: string,
    input: unknown,
    ctx: CapabilityContext,
  ): Promise<{ requestId: string }> {
    const cap = this.caps.get(id);
    if (!cap) throw new Error(`unknown capability: ${id}`);
    if (cap.kind !== "interactive") {
      throw new Error(`capability ${id} is sync — use invoke()`);
    }
    const parsed = cap.input ? cap.input.parse(input) : input;
    return cap.open(parsed, ctx);
  }

  /** Resolve a previously-opened interactive directive. */
  async resolve(
    id: string,
    requestId: string,
    response: unknown,
    ctx: CapabilityContext,
  ): Promise<void> {
    const cap = this.caps.get(id);
    if (!cap) throw new Error(`unknown capability: ${id}`);
    if (cap.kind !== "interactive") {
      throw new Error(`capability ${id} is sync — has no resolve()`);
    }
    await cap.resolve(requestId, response, ctx);
  }

  /** Stable key for an interactive directive (content-derived when provided). */
  idempotencyKey(id: string, input: unknown, ctx: CapabilityContext): string {
    const cap = this.caps.get(id);
    if (cap?.kind === "interactive" && cap.idempotencyKey) {
      const parsed = cap.input ? cap.input.parse(input) : input;
      return cap.idempotencyKey(parsed, ctx);
    }
    return `${id}:${JSON.stringify(input)}`;
  }

  /** Catalog for prompt/proxy/step-picker generation. */
  describe(): CapabilityDescriptor[] {
    return [...this.caps.values()]
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        audit: c.audit ?? (c.kind === "sync" ? "event" : "always"),
        ...(c.doc ? { doc: c.doc } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

// Process singleton (HMR-safe), mirroring the other Reflex registries.
declare global {
  // eslint-disable-next-line no-var
  var __reflexCapabilityRegistry: CapabilityRegistry | undefined;
}

export function capabilityRegistry(): CapabilityRegistry {
  return (globalThis.__reflexCapabilityRegistry ??= new CapabilityRegistry());
}

/** Convenience for tests / scoped composition. */
export { z as zod };
