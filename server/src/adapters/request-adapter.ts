import { z } from "zod";

/**
 * The ingress half of the adapter layer. Each wire protocol may also parse *its
 * own* request envelope, so a stock client of that protocol can post an
 * unmodified native body to `POST /api/arena/chat` with no translating
 * transport in front of it. Every protocol translates into the one
 * `ArenaChatRequest` below, so the route keeps a single code path and the
 * arena's semantics (anonymous session, conversation continuation, trigger
 * opt-in) are expressed exactly once.
 *
 * OmniArena's own body stays the default: a protocol parser is consulted only
 * when the body is unmistakably that protocol's envelope (see `claims`), so
 * existing clients are unaffected.
 */
export const arenaChatRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  sessionId: z.string().trim().min(1).max(200).optional(),
  conversationId: z.string().uuid().optional(),
  arena: z.boolean().optional(),
  /**
   * Opt in to being served as one half of a matchup shared with a sibling
   * request — the shape a client with a compare view sends when it fans a turn
   * out into one request per model (see `arena/join.ts`). Absent on every
   * existing client, so the single-connection dual-slot flow is untouched.
   */
  joinKey: z.string().trim().min(1).max(200).optional(),
});

export type ArenaChatRequest = z.infer<typeof arenaChatRequestSchema>;

/** Field-keyed errors, in the shape zod's `flatten()` produces. */
export type RequestFieldErrors = Record<string, string[] | undefined>;

export type RequestParseResult =
  | { ok: true; request: ArenaChatRequest }
  | { ok: false; fieldErrors: RequestFieldErrors };

export interface RequestAdapter {
  /**
   * Whether this body is the protocol's own request envelope rather than
   * OmniArena's. Detection is deliberately narrow — see `isProtocolEnvelope` —
   * because a false positive would change the meaning of a request an existing
   * client already sends.
   */
  claims(body: unknown): boolean;
  /**
   * Strictly translate a claimed body. Validation stays at the boundary: the
   * fields the arena reads are typed exactly, unknown members (an OpenAI
   * `temperature`, an AG-UI `tools`) are ignored rather than rejected, and
   * anything malformed comes back as `fieldErrors` instead of a silent default.
   */
  parse(body: unknown): RequestParseResult;
}

export function invalidRequest(error: z.ZodError): RequestParseResult {
  return { ok: false, fieldErrors: error.flatten().fieldErrors };
}

/**
 * Every protocol envelope the arena accepts carries a `messages` array, and
 * OmniArena's own body has no such field — so its presence is the whole
 * discriminator. A body that also carries `prompt` is treated as OmniArena's
 * own, which keeps a client that sends both (belt-and-braces transports do)
 * on exactly the path it has always been on.
 */
export function isProtocolEnvelope(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  return Array.isArray(candidate.messages) && !("prompt" in candidate);
}

/**
 * A chat message as AG-UI, OpenAI, and the AI SDK all express it: `content` is
 * either a plain string or an array of typed parts, and the AI SDK's UIMessage
 * puts those parts under `parts` instead. Non-text parts (images, tool calls)
 * are carried by every one of those protocols and are ignored here rather than
 * rejected — the arena is text-only today, so a multimodal message contributes
 * its text and nothing else.
 */
const contentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

const messageContentSchema = z.union([z.string(), z.array(contentPartSchema)]);

export const protocolMessageSchema = z.object({
  role: z.string(),
  content: messageContentSchema.nullish(),
  parts: z.array(contentPartSchema).nullish(),
});

export type ProtocolMessage = z.infer<typeof protocolMessageSchema>;

function textOf(message: ProtocolMessage): string {
  const { content } = message;
  if (typeof content === "string") {
    return content;
  }
  const parts = content ?? message.parts ?? [];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * The prompt for this round. Only the newest user message is used: earlier
 * messages are the client's own transcript, and on a multi-turn round the arena
 * reconstructs history from the *winning* responses it persisted (gated on a
 * decisive vote), so trusting a client-supplied transcript would let a caller
 * choose which of the two blind answers becomes the shared context.
 */
export function lastUserPrompt(messages: ProtocolMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    const text = textOf(message).trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

/** The arena fields a protocol carries in its own extension slot. */
export const arenaPropsSchema = z.object({
  sessionId: z.string().trim().min(1).max(200).optional(),
  conversationId: z.string().uuid().optional(),
  arena: z.boolean().optional(),
  joinKey: z.string().trim().min(1).max(200).optional(),
});

export type ArenaProps = z.infer<typeof arenaPropsSchema>;

/**
 * Finish a protocol translation: the extracted prompt plus the arena props go
 * through the same schema an OmniArena-native body does, so both paths enforce
 * one set of limits.
 */
export function toArenaChatRequest(
  prompt: string | null,
  props: ArenaProps | null | undefined,
  promptField: string,
): RequestParseResult {
  if (prompt === null) {
    return {
      ok: false,
      fieldErrors: {
        [promptField]: ["No user message with text content to answer"],
      },
    };
  }
  const parsed = arenaChatRequestSchema.safeParse({ prompt, ...props });
  return parsed.success
    ? { ok: true, request: parsed.data }
    : invalidRequest(parsed.error);
}

/**
 * Parse the request body for the selected protocol. The protocol's own envelope
 * is used when it claims the body; otherwise this is OmniArena's native shape,
 * unchanged.
 */
export function parseChatRequest(
  body: unknown,
  adapter: RequestAdapter | undefined,
): RequestParseResult {
  if (adapter?.claims(body)) {
    return adapter.parse(body);
  }
  const parsed = arenaChatRequestSchema.safeParse(body);
  return parsed.success
    ? { ok: true, request: parsed.data }
    : invalidRequest(parsed.error);
}
