# Data model

PostgreSQL owns all arena state. Migrations are plain SQL files in
`server/src/db/migrations/`, applied in filename order by
`npm run db:migrate --workspace server` and tracked in `schema_migrations`.

Related: [Architecture](architecture.md) · [API](api.md) · [Setup](setup.md)

## Tables

### models

The catalog of comparable models. Seeded by `server/src/db/seed.ts`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `display_name` | TEXT | Shown only after a vote |
| `provider` | TEXT | Registry key: `google`, `openai`, `ollama`, `vllm`, or `host-proxy` |
| `provider_model_id` | TEXT | e.g. `gemini-3.5-flash`; unique with `provider` |
| `enabled` | BOOLEAN | Only enabled models enter matchmaking |
| `created_at` | TIMESTAMPTZ | |

### conversations

The linear chat container. `id` is returned in `matchup_started`; an optional
`anonymous_session_id` prevents a different browser session from continuing
the conversation.

### turns

Maps each matchup into one ordered conversation turn.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `conversation_id` | UUID FK | Cascades on conversation delete |
| `matchup_id` | UUID FK, UNIQUE | One matchup per turn |
| `parent_response_id` | UUID FK, UNIQUE, NULL | Null only at turn 0; later turns point to the preceding winning response |
| `turn_index` | INTEGER | Zero-based; unique per conversation |
| `prompt` | TEXT | PII-scrubbed before persistence |
| `created_at` | TIMESTAMPTZ | |

The API derives the next parent from the stored decisive vote. Uniqueness on
`parent_response_id` and `(conversation_id, turn_index)` prevents concurrent
follow-ups from creating branches.

### matchups

One blind head-to-head instantiation per prompt.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `prompt` | TEXT | |
| `model_a_id` / `model_b_id` | UUID FK | The selected pair |
| `slot_a_model_id` / `slot_b_model_id` | UUID FK | Randomized display assignment |
| `matchup_token_hash` | TEXT | SHA-256 of the signed matchup token; the token itself is never stored |
| `harness_version` | TEXT | Version of the prompt/orchestration harness used for this comparison |
| `created_at` | TIMESTAMPTZ | |

Checks enforce that the pair and the slot assignment are distinct models.

### responses

One row per slot per matchup, written when a slot finishes streaming.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `matchup_id` | UUID FK | Cascades on delete; unique with `slot` |
| `slot` | TEXT | `A` or `B` |
| `model_id` | UUID FK | |
| `content` | TEXT | Full generated text, passed through the configured PII scrubber |
| `latency_ms` | INTEGER | Backward-compatible total stream duration |
| `ttft_ms` | INTEGER NULL | Time to first emitted text token; null if no text arrived |
| `stream_duration_ms` | INTEGER | Total stream duration |
| `output_token_count` | INTEGER | Provider-reported count when available, otherwise deterministic lexical estimate |
| `token_count_source` | TEXT | `provider` or `estimated` |
| `markdown_density` | DOUBLE PRECISION | Markdown marker characters divided by non-whitespace characters, clamped to 0–1 |
| `model_version` | TEXT NULL | Provider-reported model/checkpoint identity from the stream |
| `error` | TEXT NULL | Set when the slot failed mid-stream |
| `created_at` | TIMESTAMPTZ | |

### preferences

One vote per matchup, enforced by a unique constraint on `matchup_id`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `matchup_id` | UUID FK, UNIQUE | One vote per matchup |
| `vote` | TEXT | `left`, `right`, `both_good`, `both_bad`, `skip` |
| `winner_model_id` | UUID FK NULL | Null for ties and skips |
| `position_bias_meta` | JSONB | Currently `{ selectedSlot: "A" \| "B" \| null }` |
| `anonymous_session_id` | TEXT NULL | From the matchup token claims |
| `created_at` | TIMESTAMPTZ | |

### model_ratings

Bradley-Terry ratings written by the Python worker (`worker/`, migration
`003_phase_two.sql`). One row per model, upserted on every refit. A missing row
means the worker has not yet rated that model; the leaderboard then returns
null rating fields.

| Column | Type | Notes |
|---|---|---|
| `model_id` | UUID PK, FK | References `models(id)`, cascades on delete |
| `rating` | DOUBLE PRECISION | Elo-like display scale (`1000 + (400/ln10)·r`) |
| `rating_stderr` | DOUBLE PRECISION | Standard error on the display scale (≥ 0) |
| `ci_lower` / `ci_upper` | DOUBLE PRECISION | 95% CI bounds; `ci_lower ≤ ci_upper` enforced |
| `component_id` | INTEGER | Connected-component id; ratings only comparable within a component |
| `games` | INTEGER | Non-skip votes involving the model (≥ 0) |
| `computed_at` | TIMESTAMPTZ | Refit timestamp |

The worker computes these from aggregated `(model_lo, model_hi, wins_lo,
wins_hi, ties)` triples — never from raw vote rows.

### schema_migrations

Bookkeeping for the migration runner: `name` (filename, PK) and `applied_at`.

## Leaderboard semantics

The leaderboard is a SQL aggregation in `PostgresRepository.getLeaderboard()`:

- **win** — `winner_model_id` equals the model
- **loss** — a `left`/`right` vote where the winner was the opponent
- **tie** — `both_good` or `both_bad`
- **skip** — counted separately, excluded from `winRate`
- `winRate = wins / (wins + losses + ties)`, `0` when there are no votes

When `model_ratings` rows exist, the query LEFT JOINs them so each entry also
carries `rating`, `ratingStdError`, `confidenceInterval`, and `componentId`
(null until the worker runs), ordered by `rating` (nulls last) then wins.
