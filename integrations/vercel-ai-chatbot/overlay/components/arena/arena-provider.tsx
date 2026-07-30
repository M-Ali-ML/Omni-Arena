"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  arenaRevealFromUnknown,
  type ArenaMeta,
  type ArenaReveal,
  type ArenaVote,
  isDecisiveVote,
} from "@/lib/arena/protocol";

const STORAGE_KEY = "omniarena-mode";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export type ArenaVoteState = {
  status: "idle" | "pending" | "recorded" | "error";
  vote?: ArenaVote;
  reveal?: ArenaReveal;
  error?: string;
};

type ArenaContextValue = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** Endpoint + extra body fields for the chat transport. */
  prepareRequest: (chatId: string) => { api?: string; body: object };
  ingestDataPart: (chatId: string, part: { type: string; data?: unknown }) => void;
  voteState: (matchupId: string) => ArenaVoteState;
  castVote: (input: {
    chatId: string;
    messageId: string;
    meta: ArenaMeta;
    vote: ArenaVote;
  }) => Promise<void>;
  /** Restores continuation state for a matchup replayed from the database. */
  hydrate: (chatId: string, meta: ArenaMeta, reveal: ArenaReveal | null) => void;
};

const ArenaContext = createContext<ArenaContextValue | null>(null);

const IDLE: ArenaVoteState = { status: "idle" };

export function ArenaProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(true);
  // OmniArena only continues a conversation from a decisively voted turn, so a
  // chat's conversation id is held back until such a vote lands.
  const [continuation, setContinuation] = useState<Record<string, string>>({});
  const [voteStates, setVoteStates] = useState<Record<string, ArenaVoteState>>(
    {},
  );

  // Read after mount: the toggle is persisted client-side and must not change
  // the server-rendered markup.
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "on" || stored === "off") {
      setEnabledState(stored === "on");
    }
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  }, []);

  // Every message goes to the arena service; `arena` is the per-request opt-in
  // OmniArena reads (body `arena: true` / header `x-arena: on`). A deployment
  // running ARENA_TRIGGER=always runs a matchup either way; a `manual` one
  // answers with a single model when the toggle is off.
  const prepareRequest = useCallback(
    (chatId: string) => ({
      api: `${basePath}/api/arena/chat`,
      body: {
        arena: enabled,
        arenaConversationId: continuation[chatId] ?? null,
      },
    }),
    [continuation, enabled],
  );

  const ingestDataPart = useCallback(
    (chatId: string, part: { type: string; data?: unknown }) => {
      if (part.type !== "data-arena-meta") {
        return;
      }
      // A fresh round is not continuable until it is voted on.
      setContinuation((current) => {
        if (!(chatId in current)) {
          return current;
        }
        const { [chatId]: _dropped, ...rest } = current;
        return rest;
      });
    },
    [],
  );

  const voteState = useCallback(
    (matchupId: string) => voteStates[matchupId] ?? IDLE,
    [voteStates],
  );

  const castVote = useCallback(
    async ({
      chatId,
      messageId,
      meta,
      vote,
    }: {
      chatId: string;
      messageId: string;
      meta: ArenaMeta;
      vote: ArenaVote;
    }) => {
      setVoteStates((current) => ({
        ...current,
        [meta.matchupId]: { status: "pending", vote },
      }));

      try {
        const response = await fetch(`${basePath}/api/arena/vote`, {
          body: JSON.stringify({
            chatId,
            matchupId: meta.matchupId,
            matchupToken: meta.matchupToken,
            messageId,
            vote,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const payload = (await response.json()) as Record<string, unknown> & {
          message?: string;
          cause?: string;
        };
        const reveal = arenaRevealFromUnknown({ ...payload, vote });
        if (!response.ok || !reveal) {
          throw new Error(
            payload.cause ?? payload.message ?? "Vote was not accepted",
          );
        }

        setVoteStates((current) => ({
          ...current,
          [meta.matchupId]: {
            reveal,
            status: "recorded",
            vote,
          },
        }));

        // Continuation is stated by the server (`continuable` + `conversationId`),
        // falling back to isDecisiveVote(vote) & meta.conversationId.
        const isContinuable = reveal.continuable ?? isDecisiveVote(vote);
        const targetConversationId =
          reveal.conversationId ?? meta.conversationId;
        setContinuation((current) =>
          isContinuable && targetConversationId
            ? { ...current, [chatId]: targetConversationId }
            : current,
        );
      } catch (error) {
        setVoteStates((current) => ({
          ...current,
          [meta.matchupId]: {
            error: error instanceof Error ? error.message : String(error),
            status: "error",
            vote,
          },
        }));
      }
    },
    [],
  );

  const hydrate = useCallback(
    (chatId: string, meta: ArenaMeta, reveal: ArenaReveal | null) => {
      if (reveal) {
        setVoteStates((current) =>
          current[meta.matchupId]
            ? current
            : {
                ...current,
                [meta.matchupId]: {
                  reveal,
                  status: "recorded",
                  vote: reveal.vote,
                },
              },
        );
        const isContinuable = reveal.continuable ?? isDecisiveVote(reveal.vote);
        const continueFrom = reveal.conversationId ?? meta.conversationId;
        if (isContinuable && continueFrom) {
          setContinuation((current) =>
            current[chatId] === continueFrom
              ? current
              : { ...current, [chatId]: continueFrom },
          );
        }
        return;
      }

      // If no stored reveal is present, check if the round was voted on server-side
      if (!meta.matchupId || meta.votable === false) {
        return;
      }

      void fetch(`${basePath}/api/arena/matchups/${meta.matchupId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const fetchedReveal = arenaRevealFromUnknown(data);
          if (!fetchedReveal) {
            return;
          }
          setVoteStates((current) =>
            current[meta.matchupId]?.status === "recorded"
              ? current
              : {
                  ...current,
                  [meta.matchupId]: {
                    reveal: fetchedReveal,
                    status: "recorded",
                    vote: fetchedReveal.vote,
                  },
                },
          );
          const isContinuable =
            fetchedReveal.continuable ?? isDecisiveVote(fetchedReveal.vote);
          const continueFrom =
            fetchedReveal.conversationId ?? meta.conversationId;
          if (isContinuable && continueFrom) {
            setContinuation((current) =>
              current[chatId] === continueFrom
                ? current
                : { ...current, [chatId]: continueFrom },
            );
          }
        })
        .catch(() => {
          // Ignore network errors on round lookup
        });
    },
    [],
  );

  const value = useMemo<ArenaContextValue>(
    () => ({
      castVote,
      enabled,
      hydrate,
      ingestDataPart,
      prepareRequest,
      setEnabled,
      voteState,
    }),
    [
      castVote,
      enabled,
      hydrate,
      ingestDataPart,
      prepareRequest,
      setEnabled,
      voteState,
    ],
  );

  return <ArenaContext.Provider value={value}>{children}</ArenaContext.Provider>;
}

export function useArena(): ArenaContextValue {
  const context = useContext(ArenaContext);
  if (!context) {
    throw new Error("useArena must be used within ArenaProvider");
  }
  return context;
}
