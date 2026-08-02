"use client";

import { useEffect, useMemo, useState } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import {
  CopilotChat,
  CopilotChatAssistantMessage,
} from "@copilotkit/react-core/v2";
import { ArenaAssistantMessage } from "@/components/arena/arena-assistant-message";
import { ArenaControls } from "@/components/arena/arena-controls";
import { ArenaMatchupBridge } from "@/components/arena/arena-matchup-bridge";
import { getSessionId } from "@/lib/arena/protocol";
import { arenaStore, useArenaThread } from "@/lib/arena/store";

// SlotValue wants `typeof CopilotChatAssistantMessage` (with static subcomponents).
// Our replacement only needs the props surface; cast keeps the stock slot typing.
const AssistantSlot =
  ArenaAssistantMessage as unknown as typeof CopilotChatAssistantMessage;

/**
 * CopilotKit provider + stock CopilotChat, with arena headers injected on
 * every runtime request so the server-side ArenaHttpAgent can populate
 * `forwardedProps` / `x-arena`.
 */
export function ArenaApp() {
  const thread = useArenaThread();
  const [threadId] = useState(() => crypto.randomUUID());
  const sessionId = useMemo(() => getSessionId(), []);

  useEffect(() => {
    arenaStore.setThreadId(threadId);
  }, [threadId]);

  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      agent="arena"
      threadId={threadId}
      headers={() => ({
        "x-arena": thread.arenaEnabled ? "on" : "off",
        "x-arena-session": sessionId,
        "x-arena-thread": threadId,
        ...(thread.conversationId
          ? { "x-arena-conversation": thread.conversationId }
          : {}),
      })}
    >
      <div className="arena-shell">
        <ArenaControls />
        <ArenaMatchupBridge />
        <div className="arena-chat">
          <CopilotChat
            agentId="arena"
            threadId={threadId}
            labels={{
              chatInputPlaceholder: "Ask anything — both models answer blind…",
              welcomeMessageText:
                "One prompt, two anonymous answers. Vote to reveal the models.",
            }}
            messageView={{
              assistantMessage: AssistantSlot,
            }}
          />
        </div>
      </div>
    </CopilotKit>
  );
}
