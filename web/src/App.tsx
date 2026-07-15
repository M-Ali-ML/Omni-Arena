import { useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  useArenaChat,
  type ArenaSlot,
  type ArenaVote,
} from "./useArenaChat";
import { useArenaLeaderboard } from "./useArenaLeaderboard";

const voteOptions: Array<{ vote: ArenaVote; label: string }> = [
  { vote: "left", label: "A is better" },
  { vote: "right", label: "B is better" },
  { vote: "both_good", label: "Both good" },
  { vote: "both_bad", label: "Both bad" },
  { vote: "skip", label: "Skip" },
];

export default function App() {
  const [prompt, setPrompt] = useState("");
  const arena = useArenaChat();
  const leaderboard = useArenaLeaderboard();

  const submitPrompt = (event: FormEvent): void => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt && !arena.isStreaming && !arena.canVote) {
      void arena.sendPrompt(trimmedPrompt);
      setPrompt("");
    }
  };

  const submitVote = async (vote: ArenaVote): Promise<void> => {
    try {
      await arena.vote(vote);
      await leaderboard.refresh();
    } catch {
      // The hook exposes the request error for the inline status.
    }
  };

  return (
    <main>
      <header className="hero">
        <p className="eyebrow">OMNIARENA / LOCAL MVP</p>
        <h1>Compare answers, not labels.</h1>
        <p className="intro">
          Send one prompt to two anonymous models, then vote before their
          identities are revealed.
        </p>
      </header>

      <form className="prompt-form" onSubmit={submitPrompt}>
        <label htmlFor="prompt">Prompt</label>
        <textarea
          id="prompt"
          rows={4}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Explain a difficult idea in simple terms…"
          disabled={arena.isStreaming || arena.canVote}
        />
        <button
          className="primary"
          type="submit"
          disabled={!prompt.trim() || arena.isStreaming || arena.canVote}
        >
          {arena.isStreaming
            ? "Models are responding…"
            : arena.conversationId
              ? "Continue comparison"
              : "Start comparison"}
        </button>
        {arena.conversationId && !arena.isStreaming && (
          <button
            type="button"
            onClick={() => {
              arena.resetConversation();
              setPrompt("");
            }}
          >
            New conversation
          </button>
        )}
      </form>

      {arena.error && <p className="error-banner">{arena.error}</p>}

      <section className="responses" aria-label="Model responses">
        {(["A", "B"] as ArenaSlot[]).map((slot) => (
          <article className="response-card" key={slot}>
            <div className="card-header">
              <span className="slot">Response {slot}</span>
              <span className={`status status-${arena.slots[slot].status}`}>
                {arena.slots[slot].status}
              </span>
            </div>
            <div className="response-content">
              {arena.slots[slot].content ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {arena.slots[slot].content}
                </ReactMarkdown>
              ) : (
                <span className="placeholder">Waiting for a prompt.</span>
              )}
              {arena.slots[slot].error && (
                <p className="slot-error">{arena.slots[slot].error}</p>
              )}
            </div>
            {arena.revealedModels?.[slot] && (
              <p className="reveal">
                {arena.revealedModels[slot].displayName}
              </p>
            )}
          </article>
        ))}
      </section>

      <section className="voting" aria-labelledby="vote-heading">
        <h2 id="vote-heading">Which response was better?</h2>
        <div className="vote-buttons">
          {voteOptions.map((option) => (
            <button
              type="button"
              key={option.vote}
              onClick={() => void submitVote(option.vote)}
              disabled={!arena.canVote || arena.isStreaming}
            >
              {option.label}
            </button>
          ))}
        </div>
        {arena.revealedModels && (
          <p className="accepted">
            Vote recorded.{" "}
            {arena.conversationId
              ? "Your next prompt will continue from the winning response."
              : "This result has no single winner, so the next prompt starts a new conversation."}
          </p>
        )}
      </section>

      <section className="leaderboard" aria-labelledby="leaderboard-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">LIVE COUNTS</p>
            <h2 id="leaderboard-heading">Leaderboard</h2>
          </div>
          <button type="button" onClick={() => void leaderboard.refresh()}>
            Refresh
          </button>
        </div>
        {leaderboard.error && <p className="slot-error">{leaderboard.error}</p>}
        <ol>
          {leaderboard.models.map((model) => (
            <li key={model.id}>
              <span className="model-name">{model.displayName}</span>
              <span className="record">
                {model.wins}W · {model.losses}L · {model.ties}T
              </span>
              {model.rating !== null ? (
                <strong title="Bradley-Terry rating (95% CI)">
                  {Math.round(model.rating)}
                  {model.confidenceInterval &&
                    ` ±${Math.round(
                      (model.confidenceInterval.upper -
                        model.confidenceInterval.lower) /
                        2,
                    )}`}
                </strong>
              ) : (
                <strong>{Math.round(model.winRate * 100)}%</strong>
              )}
              {model.styleControlledRating !== null && (
                <span
                  className="style-rating"
                  title="Style-controlled rating (verbosity, formatting, latency, and position regressed out)"
                >
                  style {Math.round(model.styleControlledRating)}
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
