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
| `provider` | TEXT | Provider registry key (currently `google`) |
| `provider_model_id` | TEXT | e.g. `gemini-3.5-flash`; unique with `provider` |
| `enabled` | BOOLEAN | Only enabled models enter matchmaking |
| `created_at` | TIMESTAMPTZ | |

### matchups

One blind head-to-head instantiation per prompt.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `prompt` | TEXT | |
| `model_a_id` / `model_b_id` | UUID FK | The selected pair |
| `slot_a_model_id` / `slot_b_model_id` | UUID FK | Randomized display assignment |
| `matchup_token_hash` | TEXT | SHA-256 of the signed matchup token; the token itself is never stored |
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
| `content` | TEXT | Full generated text |
| `latency_ms` | INTEGER | Total stream duration for the slot |
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

### schema_migrations

Bookkeeping for the migration runner: `name` (filename, PK) and `applied_at`.

## Leaderboard semantics

The leaderboard is a SQL aggregation in `PostgresRepository.getLeaderboard()`:

- **win** — `winner_model_id` equals the model
- **loss** — a `left`/`right` vote where the winner was the opponent
- **tie** — `both_good` or `both_bad`
- **skip** — counted separately, excluded from `winRate`
- `winRate = wins / (wins + losses + ties)`, `0` when there are no votes
