import { useCallback, useEffect, useRef, useState } from "react";
import {
  isDecisiveVote,
  parseArenaMatchup,
  type ArenaSlot,
  type ArenaStreamEvent,
  type ArenaVote,
  type RevealedModel,
} from "./protocol.js";
import { getSessionId } from "./session.js";
import { createArenaSseDecoder } from "./stream.js";
import { submitArenaVote } from "./vote.js";

export type {
  ArenaSlot,
  ArenaVote,
  RevealedModel,
} from "./protocol.js";

export interface SlotState {
  content: string;
  status: "idle" | "streaming" | "done" | "error";
  error: string | null;
}

export interface UseArenaChatOptions {
  /**
   * Origin (or path prefix) the arena API is served from, e.g.
   * `https://arena.example.com`. Defaults to "" so requests hit the
   * same-origin `/api/arena/*` routes the demo app proxies.
   */
  baseUrl?: string;
}

const emptySlots = (): Record<ArenaSlot, SlotState> => ({
  A: { content: "", status: "idle", error: null },
  B: { content: "", status: "idle", error: null },
});

/** A cancelled slot keeps the tokens it produced; a failed one keeps its error. */
const settleSlot = (slot: SlotState): SlotState =>
  slot.status === "streaming" ? { ...slot, status: "done" } : slot;

/**
 * Absolute ws:// or wss:// URL for the control plane. `baseUrl` may be an
 * absolute origin, a path prefix, or empty (same origin), so resolve it against
 * the page first and then swap the scheme — a plain string concatenation would
 * produce a relative URL that `WebSocket` rejects.
 */
function controlSocketUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/api/arena/control`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Control channel unavailable")),
      { once: true },
    );
    socket.addEventListener(
      "close",
      () => reject(new Error("Control channel closed")),
      { once: true },
    );
  });
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
  // `token` is null on a round with nothing to vote on: `id` still identifies
  // the stream to the control plane, so `stop()` keeps working.
  const matchup = useRef<{ id: string; token: string | null } | null>(null);
  const conversation = useRef<{ id: string; turnIndex: number } | null>(null);
  const currentRequest = useRef<AbortController | null>(null);
  const controlSocket = useRef<WebSocket | null>(null);

  const closeControlSocket = useCallback((): void => {
    controlSocket.current?.close();
    controlSocket.current = null;
  }, []);

  // A consumer that never cancels anything never opens a socket, so the channel
  // is created on the first `stop` and reused while it stays up.
  const openControlSocket = useCallback(async (): Promise<WebSocket> => {
    if (typeof WebSocket === "undefined") {
      throw new Error("Stopping a matchup requires WebSocket support");
    }
    const existing = controlSocket.current;
    if (existing?.readyState === WebSocket.OPEN) {
      return existing;
    }
    if (existing?.readyState === WebSocket.CONNECTING) {
      await waitForOpen(existing);
      return existing;
    }

    const socket = new WebSocket(controlSocketUrl(baseUrl));
    controlSocket.current = socket;
    socket.addEventListener("message", (event: MessageEvent) => {
      let ack: { type?: string };
      try {
        ack = JSON.parse(String(event.data)) as { type?: string };
      } catch {
        return;
      }
      // The `stopped` ack is the last thing this channel is for — the stream it
      // aborted has ended, so the socket goes with it. A negative ack only
      // means the matchup had already finished, which the local state below
      // reflects either way.
      if (ack.type === "stopped") {
        socket.close();
        if (controlSocket.current === socket) {
          controlSocket.current = null;
        }
      }
    });

    await waitForOpen(socket);
    return socket;
  }, [baseUrl]);

  // Nothing outlives the component: an unmount mid-stream must not leave a
  // socket open against the server.
  useEffect(() => closeControlSocket, [closeControlSocket]);

  const handleEvent = useCallback((event: ArenaStreamEvent) => {
    if (event.type === "matchup_started") {
      const started = parseArenaMatchup(event);
      if (!started || (started.votable && !started.matchupToken)) {
        throw new Error("Server returned an invalid matchup");
      }
      matchup.current = {
        id: started.matchupId,
        token: started.matchupToken,
      };
      // A round the server did not persist (a `single` one) carries no
      // conversation id, so there is nothing to continue from: the next prompt
      // starts fresh rather than sending back an id that answers 404.
      conversation.current = started.conversationId
        ? { id: started.conversationId, turnIndex: started.turnIndex ?? 0 }
        : null;
      setConversationId(started.conversationId);
      setCanVote(started.votable);
      setSlots((current) => ({
        A: {
          ...current.A,
          status: started.slots.includes("A") ? "streaming" : "idle",
        },
        B: {
          ...current.B,
          status: started.slots.includes("B") ? "streaming" : "idle",
        },
      }));
      return;
    }

    // A terminal failure: the stream ends here, with no `matchup_done` and no
    // per-slot event to settle the view.
    if (event.type === "run_error") {
      setError(event.message ?? "The arena run failed");
      setIsStreaming(false);
      setCanVote(false);
      setSlots((current) => ({
        A: settleSlot(current.A),
        B: settleSlot(current.B),
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
        const decoder = createArenaSseDecoder();

        while (true) {
          const { done, value } = await reader.read();
          const events = done
            ? decoder.flush()
            : decoder.push(value ?? new Uint8Array());
          for (const event of events) {
            handleEvent(event);
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
      const { id: matchupId, token: matchupToken } = matchup.current;
      if (!matchupToken) {
        throw new Error("This round cannot be voted on");
      }
      setError(null);
      const reveal = await submitArenaVote({
        matchupId,
        matchupToken,
        vote: selectedVote,
        baseUrl,
      }).catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : "Vote failed";
        setError(message);
        throw new Error(message);
      });
      setRevealedModels(reveal.models);
      setCanVote(false);
      if (!isDecisiveVote(selectedVote)) {
        conversation.current = null;
        setConversationId(undefined);
      }
    },
    [baseUrl],
  );

  /**
   * Cancel the running matchup through the WebSocket control plane. Errors land
   * in `error` rather than throwing, so a stop button can call it directly.
   */
  const stop = useCallback(async (): Promise<void> => {
    const active = matchup.current;
    if (!active) {
      return;
    }
    try {
      const socket = await openControlSocket();
      socket.send(JSON.stringify({ type: "stop", matchupId: active.id }));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not stop the matchup",
      );
      return;
    }
    // The server aborts by closing the SSE body without a terminal event, so
    // settle the local view here instead of waiting for one that never comes.
    currentRequest.current?.abort();
    setSlots((current) => ({
      A: settleSlot(current.A),
      B: settleSlot(current.B),
    }));
    setIsStreaming(false);
  }, [openControlSocket]);

  const resetConversation = useCallback((): void => {
    currentRequest.current?.abort();
    currentRequest.current = null;
    closeControlSocket();
    matchup.current = null;
    conversation.current = null;
    setConversationId(undefined);
    setSlots(emptySlots());
    setRevealedModels(undefined);
    setCanVote(false);
    setIsStreaming(false);
    setError(null);
  }, [closeControlSocket]);

  return {
    sendPrompt,
    vote,
    stop,
    resetConversation,
    slots,
    isStreaming,
    revealedModels,
    canVote,
    conversationId,
    error,
  };
}
