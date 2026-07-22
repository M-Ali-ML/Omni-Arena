"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
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

const card: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "#141821",
  border: "1px solid #232a37",
  borderRadius: 12,
  padding: 16,
  whiteSpace: "pre-wrap",
};

export default function Page() {
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/arena/chat" }),
  });
  const [input, setInput] = useState("");
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);

  const assistant = [...messages].reverse().find((m) => m.role === "assistant");
  const parts = (assistant?.parts ?? []) as ArenaPart[];
  const slotA = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
  const slotB = parts
    .filter((p) => p.type === "data-arena-b-delta")
    .map((p) => p.data?.text ?? "")
    .join("");
  const meta = parts.find((p) => p.type === "data-arena-meta")?.data;
  const canVote = status === "ready" && !!meta?.matchupToken && !reveal;

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
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "40px 20px" }}>
      <h1 style={{ marginBottom: 4 }}>OmniArena × Vercel AI SDK</h1>
      <p style={{ color: "#93a0b4", marginTop: 0 }}>
        One prompt, two anonymous models, streamed over the AI SDK adapter.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const prompt = input.trim();
          if (prompt && status !== "streaming") {
            setReveal(null);
            setVoteError(null);
            void sendMessage({ text: prompt });
            setInput("");
          }
        }}
        style={{ display: "flex", gap: 8, margin: "20px 0" }}
      >
        <input
          data-testid="prompt-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask both models something…"
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #2a3342",
            background: "#0e1219",
            color: "#e7e9ee",
          }}
        />
        <button
          data-testid="send"
          type="submit"
          disabled={status === "streaming"}
          style={{
            padding: "10px 18px",
            borderRadius: 8,
            border: "none",
            background: "#4c7dff",
            color: "white",
            cursor: "pointer",
          }}
        >
          {status === "streaming" ? "Streaming…" : "Send"}
        </button>
      </form>

      <div data-testid="status" style={{ color: "#6b7688", fontSize: 13 }}>
        status: {status}
      </div>

      <section style={{ display: "flex", gap: 16, margin: "16px 0" }}>
        <article style={card}>
          <strong>Model A (main text channel)</strong>
          <div data-testid="slot-a" style={{ marginTop: 8 }}>
            {slotA || "…"}
          </div>
          {reveal && (
            <p data-testid="reveal-a" style={{ color: "#6ad39f", marginTop: 12 }}>
              {reveal.A.displayName}
            </p>
          )}
        </article>
        <article style={card}>
          <strong>Model B (data-arena-b parts)</strong>
          <div data-testid="slot-b" style={{ marginTop: 8 }}>
            {slotB || "…"}
          </div>
          {reveal && (
            <p data-testid="reveal-b" style={{ color: "#6ad39f", marginTop: 12 }}>
              {reveal.B.displayName}
            </p>
          )}
        </article>
      </section>

      <section style={{ display: "flex", gap: 8 }}>
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

      {voteError && (
        <p data-testid="vote-error" style={{ color: "#ff7b7b" }}>
          {voteError}
        </p>
      )}
    </main>
  );
}
