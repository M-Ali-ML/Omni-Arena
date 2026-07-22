import { useChat } from "@ai-sdk/react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useState } from "react";

type ArenaPart = {
  type: string;
  text?: string;
  data?: { text?: string; matchupId?: string; matchupToken?: string };
};

type Reveal = {
  A: { displayName: string };
  B: { displayName: string };
};

function lastUserPrompt(messages: UIMessage[]): string {
  const user = [...messages].reverse().find((m) => m.role === "user");
  return ((user?.parts ?? []) as ArenaPart[])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

// OmniArena's chat endpoint wants `{ prompt }`, not the AI SDK message array —
// so we reshape the outgoing request here. Everything else (parsing the UI
// Message Stream, driving assistant-ui) is stock AI SDK.
const transport = new DefaultChatTransport<UIMessage>({
  api: "/api/arena/chat?protocol=vercel-ai",
  prepareSendMessagesRequest: ({ messages }) => ({
    body: { prompt: lastUserPrompt(messages), sessionId: "assistant-ui-example" },
  }),
});

function UserMessage() {
  return (
    <div style={{ alignSelf: "flex-end", margin: "6px 0", color: "#9db2ff" }}>
      <MessagePrimitive.Root>
        <MessagePrimitive.Parts />
      </MessagePrimitive.Root>
    </div>
  );
}

function AssistantMessage() {
  return (
    <div style={{ margin: "6px 0" }}>
      <strong style={{ color: "#6ad39f" }}>Model A · </strong>
      <MessagePrimitive.Root>
        <MessagePrimitive.Parts />
      </MessagePrimitive.Root>
    </div>
  );
}

export function App() {
  const chat = useChat({ transport });
  const runtime = useAISDKRuntime(chat);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);

  const assistant = [...chat.messages].reverse().find((m) => m.role === "assistant");
  const parts = (assistant?.parts ?? []) as ArenaPart[];
  const slotB = parts
    .filter((p) => p.type === "data-arena-b-delta")
    .map((p) => p.data?.text ?? "")
    .join("");
  const meta = parts.find((p) => p.type === "data-arena-meta")?.data;
  const canVote = chat.status === "ready" && !!meta?.matchupToken && !reveal;

  async function castVote(vote: string): Promise<void> {
    if (!meta?.matchupId || !meta?.matchupToken) {
      return;
    }
    setVoteError(null);
    const response = await fetch("/api/arena/vote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchupId: meta.matchupId,
        matchupToken: meta.matchupToken,
        vote,
      }),
    });
    const payload = (await response.json()) as {
      error?: string;
      models?: Reveal;
    };
    if (!response.ok || !payload.models) {
      setVoteError(payload.error ?? "Vote failed");
      return;
    }
    setReveal(payload.models);
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main
        style={{
          maxWidth: 900,
          margin: "0 auto",
          padding: "40px 20px",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          color: "#e7e9ee",
        }}
      >
        <h1 style={{ marginBottom: 4 }}>OmniArena × assistant-ui</h1>
        <p style={{ color: "#93a0b4", marginTop: 0 }}>
          assistant-ui's AI SDK runtime renders Model A; the arena's second
          model streams alongside it. Vote to reveal both.
        </p>

        <section style={{ display: "flex", gap: 16, marginTop: 24 }}>
          <div
            data-testid="thread"
            style={{
              flex: 1,
              minWidth: 0,
              background: "#141821",
              border: "1px solid #232a37",
              borderRadius: 12,
              padding: 16,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <ThreadPrimitive.Root style={{ display: "flex", flexDirection: "column" }}>
              <ThreadPrimitive.Viewport
                style={{ display: "flex", flexDirection: "column", minHeight: 120 }}
              >
                <ThreadPrimitive.Messages
                  components={{ UserMessage, AssistantMessage }}
                />
              </ThreadPrimitive.Viewport>

              <ComposerPrimitive.Root
                style={{ display: "flex", gap: 8, marginTop: 12 }}
              >
                <ComposerPrimitive.Input
                  data-testid="composer-input"
                  placeholder="Ask both models something…"
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid #2a3342",
                    background: "#0e1219",
                    color: "#e7e9ee",
                    resize: "none",
                  }}
                />
                <ComposerPrimitive.Send
                  data-testid="composer-send"
                  style={{
                    padding: "10px 18px",
                    borderRadius: 8,
                    border: "none",
                    background: "#4c7dff",
                    color: "white",
                    cursor: "pointer",
                  }}
                >
                  Send
                </ComposerPrimitive.Send>
              </ComposerPrimitive.Root>
            </ThreadPrimitive.Root>
          </div>

          <div
            style={{
              flex: 1,
              minWidth: 0,
              background: "#141821",
              border: "1px solid #232a37",
              borderRadius: 12,
              padding: 16,
            }}
          >
            <strong style={{ color: "#e0a86a" }}>Model B (arena challenger)</strong>
            <div data-testid="slot-b" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
              {slotB || "…"}
            </div>
          </div>
        </section>

        <section style={{ display: "flex", gap: 8, marginTop: 16 }}>
          {[
            { vote: "left", label: "A is better" },
            { vote: "right", label: "B is better" },
            { vote: "both_good", label: "Both good" },
            { vote: "both_bad", label: "Both bad" },
            { vote: "skip", label: "Skip" },
          ].map((option) => (
            <button
              key={option.vote}
              data-testid={`vote-${option.vote}`}
              disabled={!canVote}
              onClick={() => void castVote(option.vote)}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid #2a3342",
                background: canVote ? "#1b2230" : "#12161e",
                color: "#e7e9ee",
                cursor: canVote ? "pointer" : "not-allowed",
              }}
            >
              {option.label}
            </button>
          ))}
        </section>

        {reveal && (
          <p data-testid="reveal" style={{ color: "#6ad39f", marginTop: 12 }}>
            Model A was {reveal.A.displayName}; Model B was {reveal.B.displayName}.
          </p>
        )}
        {voteError && (
          <p data-testid="vote-error" style={{ color: "#ff7b7b" }}>
            {voteError}
          </p>
        )}
      </main>
    </AssistantRuntimeProvider>
  );
}
