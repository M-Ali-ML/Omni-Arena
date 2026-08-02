"use client";

import type { AbstractAgent, Message } from "@ag-ui/client";
import {
  clearPersistedArena,
  persistThreadId,
  readPersistedArena,
} from "./persistence";
import {
  fetchConversation,
  type ConversationSnapshot,
} from "./protocol";
import { arenaStore } from "./store";

/**
 * Rebuild the CopilotKit agent thread from OmniArena's conversation GET after
 * a reload. Persisted `conversationId` is the only handle; the endpoint is
 * session-scoped, so a mismatched session gets a 403 and we clear local state.
 */
export async function rehydrateArenaThread(
  agent: AbstractAgent,
): Promise<boolean> {
  const persisted = readPersistedArena();
  if (!persisted.conversationId) return false;

  const result = await fetchConversation(persisted.conversationId);
  if (!result.ok) {
    const threadId = persisted.threadId;
    clearPersistedArena();
    if (threadId) persistThreadId(threadId);
    return false;
  }

  arenaStore.hydrateConversation(result.conversation);
  agent.setMessages(conversationToMessages(result.conversation));
  return true;
}

/**
 * User + per-slot assistant messages. Slot message ids stay
 * `<matchupId>:A|B` so `ArenaAssistantMessage` / `parseSlotMessageId` keep
 * finding the round after reload.
 */
export function conversationToMessages(
  conversation: ConversationSnapshot,
): Message[] {
  const messages: Message[] = [];
  for (const turn of conversation.turns) {
    messages.push({
      id: `user:${turn.matchupId}`,
      role: "user",
      content: turn.prompt,
    });
    const answers =
      turn.answers.length > 0
        ? turn.answers
        : [
            { slot: "A" as const, content: "", error: null },
            { slot: "B" as const, content: "", error: null },
          ];
    for (const answer of answers) {
      messages.push({
        id: `${turn.matchupId}:${answer.slot}`,
        role: "assistant",
        content: answer.error
          ? `[omni-arena:slot-error] ${answer.error}`
          : answer.content,
      });
    }
  }
  return messages;
}
