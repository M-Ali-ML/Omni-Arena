import { checkBotId } from "botid/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import {
  MATCHUP_HEADER,
  parseMatchupHeader,
} from "@/lib/arena/protocol";
import { arenaFetch } from "@/lib/arena/server";
import { createArenaStreamTransform } from "@/lib/arena/stream";
import { getChatById, saveChat, saveMessages } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import { generateUUID } from "@/lib/utils";

export const maxDuration = 60;

const TITLE_MAX_LENGTH = 80;

const arenaChatRequest = z.object({
  /** Per-request opt-in; honoured by ARENA_TRIGGER=manual deployments. */
  arena: z.boolean().default(true),
  /** OmniArena conversation to continue; only valid after a decisive vote. */
  arenaConversationId: z.string().uuid().nullish(),
  id: z.string().uuid(),
  message: z.object({
    id: z.string(),
    parts: z.array(z.record(z.string(), z.unknown())),
    role: z.literal("user"),
  }),
  selectedVisibilityType: z.enum(["private", "public"]).default("private"),
});

function promptFromParts(parts: Record<string, unknown>[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("")
    .trim();
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n")[0].trim();
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1)}…`
    : firstLine || "New chat";
}

/**
 * Arena mode's chat endpoint: the app's own persistence and auth, but the model
 * call replaced by one OmniArena matchup streamed over the AI SDK adapter.
 *
 * Unlike the template's `/api/chat` this route never touches a provider (no AI
 * Gateway key needed) and skips LLM title generation — the title is derived
 * from the prompt so a key-free arena deployment works out of the box.
 */
export async function POST(request: Request) {
  let body: z.infer<typeof arenaChatRequest>;
  try {
    body = arenaChatRequest.parse(await request.json());
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const [botIdResult, session] = await Promise.all([
      checkBotId().catch(() => null),
      auth(),
    ]);

    if (botIdResult?.isBot) {
      return new ChatbotError("forbidden:api").toResponse();
    }
    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    const prompt = promptFromParts(body.message.parts);
    if (!prompt) {
      return new ChatbotError("bad_request:api").toResponse();
    }

    const chat = await getChatById({ id: body.id });
    if (chat && chat.userId !== session.user.id) {
      return new ChatbotError("forbidden:chat").toResponse();
    }
    if (!chat) {
      await saveChat({
        id: body.id,
        title: titleFromPrompt(prompt),
        userId: session.user.id,
        visibility: body.selectedVisibilityType,
      });
    }

    await saveMessages({
      messages: [
        {
          attachments: [],
          chatId: body.id,
          createdAt: new Date(),
          id: body.message.id,
          parts: body.message.parts,
          role: "user",
        },
      ],
    });

    const upstream = await arenaFetch("/api/arena/chat?protocol=vercel-ai", {
      body: JSON.stringify({
        // The opt-in a manual-trigger deployment reads; an `always` deployment
        // runs a matchup regardless.
        arena: body.arena,
        conversationId: body.arenaConversationId ?? undefined,
        prompt,
        sessionId: session.user.id,
      }),
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        ...(body.arena ? { "x-arena": "on" } : {}),
      },
      method: "POST",
      signal: request.signal,
    });

    if (!upstream.body) {
      throw new ChatbotError("offline:chat", "OmniArena returned no stream");
    }

    // Same payload as `data-arena-meta`; used when the stream omits it and
    // forwarded so a client can hydrate without a CUSTOM / data-part subscriber.
    const matchupHeader = upstream.headers.get(MATCHUP_HEADER);
    const headerMeta = parseMatchupHeader(matchupHeader);

    const assistantMessageId = generateUUID();
    const stream = upstream.body.pipeThrough(
      createArenaStreamTransform({
        headerMeta,
        messageId: assistantMessageId,
        onComplete: async ({ meta, slotA, slotB, errors }) => {
          if (!meta) {
            return;
          }
          try {
            await saveMessages({
              messages: [
                {
                  attachments: [],
                  chatId: body.id,
                  createdAt: new Date(),
                  id: assistantMessageId,
                  // Slot B streams one data part per token; it is stored as a
                  // single compacted part, which the reader concatenates the
                  // same way as the live stream.
                  parts: [
                    { data: meta, type: "data-arena-meta" },
                    { text: slotA, type: "text" },
                    { data: { text: slotB }, type: "data-arena-b-delta" },
                    ...errors.map((error) => ({
                      data: error,
                      type: "data-arena-error",
                    })),
                  ],
                  role: "assistant",
                },
              ],
            });
          } catch (error) {
            console.error("Failed to persist arena matchup", error);
          }
        },
      }),
    );

    return new Response(stream, {
      headers: {
        "cache-control": "no-cache, no-transform",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        "x-vercel-ai-ui-message-stream": "v1",
        ...(matchupHeader ? { [MATCHUP_HEADER]: matchupHeader } : {}),
      },
    });
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }
    console.error("Unhandled error in arena chat API:", error);
    return new ChatbotError("offline:chat").toResponse();
  }
}
