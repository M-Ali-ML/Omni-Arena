"use client";

import {
  ExportedMessageRepository,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  clearPersistedArena,
  readPersistedArena,
} from "./persistence";
import { fetchConversation, type ConversationSnapshot } from "./protocol";
import { arenaStore } from "./store";

/**
 * Rebuild the assistant-ui thread from OmniArena's conversation GET after a
 * reload. Persisted `conversationId` is the only handle; the endpoint is
 * session-scoped, so a mismatched session gets a 403 and we clear local state.
 */
export function createArenaHistoryAdapter(
  threadId: string,
): ThreadHistoryAdapter {
  return {
    async load() {
      const { conversationId } = readPersistedArena();
      if (!conversationId) return { headId: null, messages: [] };

      const result = await fetchConversation(conversationId);
      if (!result.ok) {
        clearPersistedArena();
        return { headId: null, messages: [] };
      }

      arenaStore.hydrateConversation(threadId, result.conversation);
      const messages = conversationToMessages(result.conversation);
      if (messages.length === 0) return { headId: null, messages: [] };

      return ExportedMessageRepository.fromBranchableArray(
        messages.map((message, index) => ({
          message,
          parentId: index === 0 ? null : messages[index - 1]!.id!,
        })),
        { headId: messages.at(-1)!.id! },
      );
    },
    async append() {
      // Arena history is server-owned; the client only rehydrates.
    },
  };
}

function conversationToMessages(
  conversation: ConversationSnapshot,
): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];
  for (const turn of conversation.turns) {
    messages.push({
      id: `user:${turn.matchupId}`,
      role: "user",
      content: [{ type: "text", text: turn.prompt }],
    });
    // The live aggregator adopts the first slot's message id as the assistant
    // message id (`<matchupId>:A`), so reload must use the same convention for
    // `matchupIdFromMessageId` to keep finding the round.
    const answers =
      turn.answers.length > 0
        ? turn.answers
        : [
            { slot: "A" as const, content: "", error: null },
            { slot: "B" as const, content: "", error: null },
          ];
    messages.push({
      id: `${turn.matchupId}:${answers[0]!.slot}`,
      role: "assistant",
      content: answers.map((answer) => ({
        type: "text" as const,
        text: answer.error
          ? `[omni-arena:slot-error] ${answer.error}`
          : answer.content,
      })),
    });
  }
  return messages;
}
