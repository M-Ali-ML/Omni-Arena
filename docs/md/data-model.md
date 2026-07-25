# Data model

PostgreSQL owns all arena state. Migrations are plain SQL files in
`server/src/db/migrations/`, applied in filename order by
`npm run db:migrate --workspace server` and tracked in `schema_migrations`.

Related: [Architecture](architecture.md) · [API](api.md) · [Rating methodology](rating-methodology.md) · [Integration](integration.md) · [Setup](setup.md) · [SDK](sdk.md)

## Migrations

Each file is applied once, inside its own transaction, and recorded in
`schema_migrations` (`server/src/db/migrations.ts`).

| File | What it creates |
|---|---|
| `001_initial.sql` | `models`, `matchups`, `responses`, `preferences`, index `preferences_winner_idx` |
| `002_conversations_and_turns.sql` | `conversations`, `turns`, index `turns_conversation_idx`; adds `matchups.harness_version` and the six response metrics columns; backfills one conversation + turn 0 per pre-existing matchup |
| `003_model_ratings.sql` | `model_ratings` |
| `004_style_ratings.sql` | `model_style_ratings`, `style_control_coefficients` |
| `005_rating_history.sql` | `model_rating_history`, index `model_rating_history_computed_idx` |

Migrations 002–004 were renamed after they had already shipped, so the runner
first rewrites the legacy rows (`002_phase_one.sql`, `003_phase_two.sql`,
`004_phase_three.sql`) to the current filenames. An existing database therefore
does not re-run them. Never edit an applied migration; add the next
`NNN_description.sql` instead.

## Who writes what

| Writer | Tables |
|---|---|
| Chat route (`POST /api/arena/chat`) | `conversations`, `matchups`, `turns`, `responses` |
| Vote route (`POST /api/arena/vote`) | `preferences` |
| Model seed (`db:seed`, `db:seed:mock`) | `models` |
| Rating worker, default pass | `model_ratings` (upsert) + `model_rating_history` (append), one transaction |
| Rating worker, `--style` pass | `model_style_ratings`, `style_control_coefficients` (upsert) |
| Demo-data seeder (`db:seed:demo`) | all of the above except `models` — see [Setup → Demo data](setup.md#demo-data) |

The split is strict in both directions: the server only ever reads the four
worker-owned rating tables (via LEFT JOIN), and the worker only ever reads the
request-path tables. The demo seeder is the single exception — it writes both
sides, which is why it is opt-in and never runs automatically.

## Tables

### models

The catalog of comparable models. Seeded by `server/src/db/seed.ts`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Minted with `randomUUID()` by the seed, so it differs per deployment |
| `display_name` | TEXT | Shown only after a vote |
| `provider` | TEXT | Registry key: `google`, `openai`, `ollama`, `vllm`, `host-proxy`, or `mock` (demos/e2e; see [Setup](setup.md)) |
| `provider_model_id` | TEXT | e.g. `gemini-3.5-flash`; unique with `provider` |
| `enabled` | BOOLEAN | Default `TRUE`; only enabled models enter matchmaking, the roster route, and the leaderboard |
| `created_at` | TIMESTAMPTZ | Default `NOW()`; the roster's sort key (`created_at, id`) |

Every column is `NOT NULL`. Nothing else references `models` with a cascade
except the four worker-written rating tables, so a model row cannot be deleted
while it has matchups or responses.

### conversations

The linear chat container. `id` is returned in `matchup_started`; an optional
`anonymous_session_id` prevents a different browser session from continuing
the conversation.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `anonymous_session_id` | TEXT NULL | Null when the client sent no `sessionId`; a null-session conversation is continuable by anyone who knows its id |
| `created_at` | TIMESTAMPTZ | |

A row is inserted only on turn 0, in the same transaction as the matchup and
the turn.

### turns

Maps each matchup into one ordered conversation turn.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `conversation_id` | UUID FK | Cascades on conversation delete |
| `matchup_id` | UUID FK, UNIQUE | One matchup per turn |
| `parent_response_id` | UUID FK, UNIQUE, NULL | Null only at turn 0; later turns point to the preceding winning response |
| `turn_index` | INTEGER | Zero-based, `CHECK (turn_index >= 0)`; unique per conversation |
| `prompt` | TEXT | Persisted as received |
| `created_at` | TIMESTAMPTZ | |

A table-level check ties the two together: `turn_index = 0` requires a null
`parent_response_id`, and any later turn requires a non-null one. Indexed on
`(conversation_id, turn_index)` (`turns_conversation_idx`).

The API derives the next parent from the stored decisive vote. Uniqueness on
`parent_response_id` and `(conversation_id, turn_index)` prevents concurrent
follow-ups from creating branches; `PostgresRepository.createMatchup()` also
re-reads the conversation's latest turn inside the insert transaction and turns
either a mismatch or a unique violation (SQLSTATE `23505`) into a
`conversation_conflict` 409.

### matchups

One blind head-to-head instantiation per prompt.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `prompt` | TEXT | |
| `model_a_id` / `model_b_id` | UUID FK | The selected pair |
| `slot_a_model_id` / `slot_b_model_id` | UUID FK | Randomized display assignment |
| `matchup_token_hash` | TEXT | SHA-256 of the signed matchup token; the token itself is never stored |
| `harness_version` | TEXT | Default `'v1'`; the configured `HARNESS_VERSION` of the run (`'demo'` for rows written by the demo-data seeder) |
| `created_at` | TIMESTAMPTZ | |

Checks enforce that the pair and the slot assignment are distinct models.
Non-votable `single` rounds write no row here at all, which is why they produce
no rating signal.

### responses

One row per slot per matchup, written when a slot finishes streaming.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `matchup_id` | UUID FK | Cascades on delete; unique with `slot` |
| `slot` | TEXT | `A` or `B` |
| `model_id` | UUID FK | |
| `content` | TEXT | Full generated text, persisted as received |
| `latency_ms` | INTEGER | Backward-compatible total stream duration; `CHECK (latency_ms >= 0)` |
| `ttft_ms` | INTEGER NULL | Time to first emitted text token; null if no text arrived. `CHECK (ttft_ms >= 0)` |
| `stream_duration_ms` | INTEGER | Total stream duration; `CHECK (stream_duration_ms >= 0)` |
| `output_token_count` | INTEGER | Provider-reported count when available, otherwise deterministic lexical estimate; `CHECK (… >= 0)` |
| `token_count_source` | TEXT | `provider` or `estimated` (enforced by check) |
| `markdown_density` | DOUBLE PRECISION | Markdown marker characters divided by non-whitespace characters; `CHECK (0 ≤ … ≤ 1)` |
| `model_version` | TEXT NULL | Provider-reported model/checkpoint identity from the stream |
| `error` | TEXT NULL | Set when the slot failed mid-stream |
| `created_at` | TIMESTAMPTZ | |

`ttft_ms`, `model_version`, and `error` are the only nullable columns: migration
002 added six columns, backfilled four of them, and made those four `NOT NULL`.
Writes are idempotent — `saveResponse()` inserts `ON CONFLICT (matchup_id, slot)
DO NOTHING`, so a replayed `slot_done` cannot duplicate or overwrite a row.

### preferences

One vote per matchup, enforced by a unique constraint on `matchup_id`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `matchup_id` | UUID FK, UNIQUE | One vote per matchup; cascades on matchup delete |
| `vote` | TEXT | `left`, `right`, `both_good`, `both_bad`, `skip` (enforced by check) |
| `winner_model_id` | UUID FK NULL | Null for ties and skips. Derived server-side from the voted slot, never taken from the client |
| `position_bias_meta` | JSONB | `NOT NULL DEFAULT '{}'`; currently `{ selectedSlot: "A" \| "B" \| null }` |
| `anonymous_session_id` | TEXT NULL | From the matchup token claims; the unit the worker's anomaly screen operates on |
| `created_at` | TIMESTAMPTZ | |

Indexed on `winner_model_id` (`preferences_winner_idx`). A duplicate insert
raises `23505`, which the vote route reports as HTTP 409.

### model_ratings

Bradley-Terry ratings written by the Python worker (`worker/`, migration
`003_model_ratings.sql`). One row per model, upserted on every refit. A missing row
means the worker has not yet rated that model — either because it has not run,
or because that model has no comparisons to rate (a non-votable `single` round
persists no `matchups` row, so it produces nothing pairwise; see
[Rating methodology → what the engine cannot
rate](rating-methodology.md#what-the-engine-cannot-rate)). The leaderboard then
returns null rating fields.

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
wins_hi, ties)` triples — never from raw vote rows. Because this table is
upserted, it only ever holds the **latest** fit; the per-refit trail lives in
`model_rating_history`.

### model_rating_history

Append-only snapshot of every rating the worker writes, one row per model per
refit (migration `005_rating_history.sql`). `model_ratings` keeps only the
latest fit, so this table is what rating-over-time charts and
`GET /api/arena/analytics/rating-history` read. The worker inserts the
snapshot in the same transaction as the `model_ratings` upsert; `NOW()` is
transaction-stable, so all rows from one refit share a `computed_at`.

| Column | Type | Notes |
|---|---|---|
| `model_id` | UUID FK | References `models(id)`, cascades on delete |
| `rating` | DOUBLE PRECISION | Elo-like display scale, as in `model_ratings` |
| `rating_stderr` | DOUBLE PRECISION | Standard error (≥ 0) |
| `ci_lower` / `ci_upper` | DOUBLE PRECISION | 95% CI bounds; `ci_lower ≤ ci_upper` enforced |
| `component_id` | INTEGER | Connected-component id at fit time |
| `games` | INTEGER | Non-skip votes involving the model at fit time (≥ 0) |
| `computed_at` | TIMESTAMPTZ | Refit timestamp; primary key with `model_id`, indexed for range scans |

### model_style_ratings

Style-controlled Bradley-Terry ratings written by the worker's heavier periodic
pass (`worker/style.py`, migration `004_style_ratings.sql`). Kept in a sibling
table (not merged into `model_ratings`) because the style fit is a slower,
separate computation over raw votes and may lag the default leaderboard. A
missing row means the style pass has not rated that model; the leaderboard then
returns null style fields.

| Column | Type | Notes |
|---|---|---|
| `model_id` | UUID PK, FK | References `models(id)`, cascades on delete |
| `style_controlled_rating` | DOUBLE PRECISION | Elo-like display scale with style confounders regressed out |
| `style_controlled_stderr` | DOUBLE PRECISION | Standard error on the display scale (≥ 0) |
| `style_ci_lower` / `style_ci_upper` | DOUBLE PRECISION | 95% CI bounds; `style_ci_lower ≤ style_ci_upper` enforced |
| `component_id` | INTEGER | Connected-component id over the style vote graph |
| `games` | INTEGER | Non-skip votes involving the model (≥ 0) |
| `computed_at` | TIMESTAMPTZ | Style-pass timestamp |

### style_control_coefficients

The fitted style-confounder coefficients, one row per feature (`position`,
`verbosity`, `formatting`, `latency_ttft`, `latency_duration`), upserted each
style pass. Persisted for the rating-methodology docs and the explain-diff view.

| Column | Type | Notes |
|---|---|---|
| `feature` | TEXT PK | Covariate name |
| `coefficient` | DOUBLE PRECISION | Fitted joint-regression coefficient (standardized-feature scale) |
| `computed_at` | TIMESTAMPTZ | Style-pass timestamp |

### schema_migrations

Bookkeeping for the migration runner: `name` (filename, PK) and `applied_at`
(`TIMESTAMPTZ NOT NULL DEFAULT NOW()`). The runner creates the table on first
use and, on an existing database, rewrites the three legacy phase-era filenames
to their current names before deciding what to apply — see
[Migrations](#migrations).

## Indexes

Only what the read paths need; everything else is served by primary keys and
unique constraints.

| Index | Table | Purpose |
|---|---|---|
| `preferences_winner_idx` | `preferences (winner_model_id)` | Win/loss aggregation on the leaderboard |
| `turns_conversation_idx` | `turns (conversation_id, turn_index)` | Reconstructing a conversation's history in turn order |
| `model_rating_history_computed_idx` | `model_rating_history (computed_at)` | `?since=` range scans for the rating-over-time chart |

## Leaderboard semantics

The leaderboard is a SQL aggregation in `PostgresRepository.getLeaderboard()`:

- **win** — `winner_model_id` equals the model
- **loss** — a `left`/`right` vote where the winner was the opponent
- **tie** — `both_good` or `both_bad`
- **skip** — counted separately, excluded from `winRate`
- `winRate = wins / (wins + losses + ties)`, `0` when there are no votes

Only `enabled` models appear. When `model_ratings` rows exist, the query LEFT
JOINs them so each entry also carries `rating`, `ratingStdError`,
`confidenceInterval`, and `componentId` (null until the worker runs). It also
LEFT JOINs `model_style_ratings` to surface `styleControlledRating`,
`styleControlledStdError`, and `styleControlledConfidenceInterval` (null until
the style pass runs). The sort is `rating DESC NULLS LAST`, then `wins DESC`,
`total_votes DESC`, `display_name` — so an unrated model always sorts below a
rated one, and a fresh install is ordered purely by its win-rate record.

### Rating context

`LeaderboardPort` has a second method, `getRatingContext()`, which reads the two
qualifiers a client needs before comparing any of those numbers:

- **`components`** — `count` of connected components spanned by the rated roster
  (null before the worker has run) plus per-component head-counts, grouped in
  SQL over `model_ratings.component_id`. Ratings are only comparable inside one
  component.
- **`styleControl`** — the `style_control_coefficients` rows restated on the
  display scale (log-odds, rating points, and — where the vote-level deltas carry
  enough spread — per interpretable unit such as 100 output tokens), with the
  number of votes that backed the per-unit conversion and the coefficients'
  `computed_at`. Empty until the style pass has run.

### Aggregate reads

`AnalyticsPort` is implemented by the same `PostgresRepository` over the same
tables. No aggregate exposes per-user data — only model-level totals.

| Port method | Reads | Notes |
|---|---|---|
| `getSummary()` | `matchups`, `preferences`, `models`, `model_ratings` | Arena-wide totals, the slot-A/slot-B decisive split, pairs sampled vs possible (`n·(n−1)/2`), rating components |
| `getHeadToHead()` | `preferences ⋈ matchups` | Canonical (unordered) pair records |
| `getModelMetrics()` | `responses`, `preferences ⋈ matchups` | p50/p90 TTFT and stream duration, mean output tokens and Markdown density, per-slot win record. Skips failed slots (`WHERE error IS NULL`) |
| `getActivity(bucket)` | `preferences ⋈ matchups` | Vote volume by outcome plus cumulative games, bucketed by `day` or `hour` |
| `getStyleControl()` | `style_control_coefficients`, `model_ratings`, `model_style_ratings` | Coefficients plus the models rated in both the raw and style-controlled pass |
| `getRatingHistory(since)` | `model_rating_history` | The only reader of the append-only trail |

Percentiles and time bucketing are computed in TypeScript rather than SQL so
every analytics query stays runnable under `pg-mem` in tests.
