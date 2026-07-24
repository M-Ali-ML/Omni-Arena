import { useCallback, useRef, useState } from "react";

export type ArenaSlot = "A" | "B";
export type ArenaVote =
  | "left"
  | "right"
  | "both_good"
  | "both_bad"
  | "skip";

export interface SlotState {
  content: string;
  status: "idle" | "streaming" | "done" | "error";
  error: string | null;
}

export interface RevealedModel {
  id: string;
  displayName: string;
}

export interface UseArenaChatOptions {
  /**
   * Origin (or path prefix) the arena API is served from, e.g.
   * `https://arena.example.com`. Defaults to "" so requests hit the
   * same-origin `/api/arena/*` routes the demo app proxies.
   */
  baseUrl?: string;
}

interface StreamEvent {
  type:
    | "matchup_started"
    | "token"
    | "slot_error"
    | "slot_done"
    | "matchup_done";
  matchupId?: string;
  matchupToken?: string;
  conversationId?: string;
  turnIndex?: number;
  slots?: ArenaSlot[];
  mode?: "matchup" | "single" | "shadow";
  votable?: boolean;
  slot?: ArenaSlot;
  token?: string;
  message?: string;
}

const emptySlots = (): Record<ArenaSlot, SlotState> => ({
  A: { content: "", status: "idle", error: null },
  B: { content: "", status: "idle", error: null },
});

function getSessionId(): string {
  const key = "omni-arena-session";
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }
  const created = `anon_${crypto.randomUUID()}`;
  localStorage.setItem(key, created);
  return created;
}

export function useArenaChat(options: UseArenaChatOptions = {}) {
  const { baseUrl = "" } = options;
  const [slots, setSlots] = useState(emptySlots);
  const [isStreaming, setIsStreaming] = useState(false);
  const [revealedModels, setRevealedModels] = useState<
    Record<ArenaSlot, RevealedModel> | undefined
  >();
  const [error, setError] = useState<string | null>(null);
  const [canVote, setCanVote] = useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const matchup = useRef<{ id: string; token: string } | null>(null);
  const conversation = useRef<{ id: string; turnIndex: number } | null>(null);
  const currentRequest = useRef<AbortController | null>(null);

  const handleEvent = useCallback((event: StreamEvent) => {
    if (event.type === "matchup_started") {
      // `votable` defaults to true so streams from servers that predate arena
      // modes (which omit the field) still expose voting.
      const votable = event.votable ?? true;
      const activeSlots = event.slots ?? ["A", "B"];
      if (
        !event.matchupId ||
        (votable && !event.matchupToken) ||
        !event.conversationId ||
        event.turnIndex === undefined
      ) {
        throw new Error("Server returned an invalid matchup");
      }
      matchup.current = { id: event.matchupId, token: event.matchupToken ?? "" };
      conversation.current = {
        id: event.conversationId,
        turnIndex: event.turnIndex,
      };
      setConversationId(event.conversationId);
      setCanVote(votable);
      setSlots((current) => ({
        A: {
          ...current.A,
          status: activeSlots.includes("A") ? "streaming" : "idle",
        },
        B: {
          ...current.B,
          status: activeSlots.includes("B") ? "streaming" : "idle",
        },
      }));
      return;
    }

    if (!event.slot && event.type !== "matchup_done") {
      return;
    }
    if (event.type === "token" && event.slot) {
      setSlots((current) => ({
        ...current,
        [event.slot as ArenaSlot]: {
          ...current[event.slot as ArenaSlot],
          content:
            current[event.slot as ArenaSlot].content + (event.token ?? ""),
        },
      }));
    } else if (event.type === "slot_error" && event.slot) {
      setSlots((current) => ({
        ...current,
        [event.slot as ArenaSlot]: {
          ...current[event.slot as ArenaSlot],
          status: "error",
          error: event.message ?? "Model failed",
        },
      }));
    } else if (event.type === "slot_done" && event.slot) {
      setSlots((current) => ({
        ...current,
        [event.slot as ArenaSlot]: {
          ...current[event.slot as ArenaSlot],
          status:
            current[event.slot as ArenaSlot].status === "error"
              ? "error"
              : "done",
        },
      }));
    } else if (event.type === "matchup_done") {
      setIsStreaming(false);
    }
  }, []);

  const sendPrompt = useCallback(
    async (prompt: string): Promise<void> => {
      currentRequest.current?.abort();
      const controller = new AbortController();
      currentRequest.current = controller;
      matchup.current = null;
      setSlots(emptySlots());
      setRevealedModels(undefined);
      setCanVote(false);
      setError(null);
      setIsStreaming(true);

      try {
        const response = await fetch(`${baseUrl}/api/arena/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt,
            sessionId: getSessionId(),
            conversationId: conversation.current?.id,
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(
            (await response.text()) || `Request failed (${response.status})`,
          );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";

          for (const block of blocks) {
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data) {
              handleEvent(JSON.parse(data) as StreamEvent);
            }
          }
          if (done) {
            break;
          }
        }
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(caught instanceof Error ? caught.message : "Request failed");
        }
      } finally {
        if (currentRequest.current === controller) {
          setIsStreaming(false);
        }
      }
    },
    [handleEvent, baseUrl],
  );

  const vote = useCallback(
    async (selectedVote: ArenaVote): Promise<void> => {
      if (!matchup.current) {
        throw new Error("No active matchup");
      }
      setError(null);
      const response = await fetch(`${baseUrl}/api/arena/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          matchupId: matchup.current.id,
          matchupToken: matchup.current.token,
          vote: selectedVote,
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        models?: Record<ArenaSlot, RevealedModel>;
      };
      if (!response.ok || !payload.models) {
        const message = payload.error ?? "Vote failed";
        setError(message);
        throw new Error(message);
      }
      setRevealedModels(payload.models);
      setCanVote(false);
      if (selectedVote !== "left" && selectedVote !== "right") {
        conversation.current = null;
        setConversationId(undefined);
      }
    },
    [baseUrl],
  );

  const resetConversation = useCallback((): void => {
    currentRequest.current?.abort();
    currentRequest.current = null;
    matchup.current = null;
    conversation.current = null;
    setConversationId(undefined);
    setSlots(emptySlots());
    setRevealedModels(undefined);
    setCanVote(false);
    setIsStreaming(false);
    setError(null);
  }, []);

  return {
    sendPrompt,
    vote,
    resetConversation,
    slots,
    isStreaming,
    revealedModels,
    canVote,
    conversationId,
    error,
  };
}
