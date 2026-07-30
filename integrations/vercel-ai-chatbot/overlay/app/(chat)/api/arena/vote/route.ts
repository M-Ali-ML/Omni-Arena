import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { arenaRevealFromUnknown } from "@/lib/arena/protocol";
import { arenaFetch } from "@/lib/arena/server";
import { getChatById, getMessageById, updateMessage } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

const arenaVoteRequest = z.object({
  chatId: z.string().uuid(),
  matchupId: z.string().uuid(),
  matchupToken: z.string().min(1),
  /** The assistant message the reveal belongs to, so it survives a reload. */
  messageId: z.string().uuid(),
  vote: z.enum(["left", "right", "both_good", "both_bad", "skip"]),
});

/**
 * Records one arena vote and reveals the two model identities. The reveal is
 * appended to the stored assistant message so reopening the chat still shows
 * who was who (and which side won).
 */
export async function POST(request: Request) {
  let body: z.infer<typeof arenaVoteRequest>;
  try {
    body = arenaVoteRequest.parse(await request.json());
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const session = await auth();
    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    const chat = await getChatById({ id: body.chatId });
    if (!chat || chat.userId !== session.user.id) {
      return new ChatbotError("forbidden:vote").toResponse();
    }

    const response = await arenaFetch("/api/arena/vote", {
      body: JSON.stringify({
        matchupId: body.matchupId,
        matchupToken: body.matchupToken,
        vote: body.vote,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json()) as Record<string, unknown>;
    const reveal = arenaRevealFromUnknown({ ...payload, vote: body.vote });
    if (!reveal) {
      throw new ChatbotError("bad_request:api", "OmniArena returned no reveal");
    }

    const revealData = {
      models: reveal.models,
      vote: reveal.vote,
      continuable: reveal.continuable,
      ...(reveal.conversationId ? { conversationId: reveal.conversationId } : {}),
    };

    const [stored] = await getMessageById({ id: body.messageId });
    if (stored) {
      const parts = stored.parts as Record<string, unknown>[];
      await updateMessage({
        id: body.messageId,
        parts: [
          ...parts.filter((part) => part.type !== "data-arena-reveal"),
          {
            data: revealData,
            type: "data-arena-reveal",
          },
        ],
      });
    }

    return Response.json(revealData);
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }
    console.error("Unhandled error in arena vote API:", error);
    return new ChatbotError("offline:chat").toResponse();
  }
}
