# Agent Log

Chronological record of agent activity on this repo. Newest entries at the top.

---

## 2026-07-15 22:35 · Cursor Agent · Opus 4.8
**Type:** feat, refactor, docs
- Phase 3 rating engine (`worker/omniarena_rating/`): `style.py` joint style-controlled BT regression (position/verbosity/formatting/latency covariates folded into the same Rao-Kupper logistic fit, ridge on all coeffs, Fisher CIs) and `anomaly.py` pre-fit session screen (Poisson volume, two-sided binomial position, median inter-vote-gap speed tests, Bonferroni α/3). Wired into `aggregate.py` (session exclusion), `writeback.py`, `__main__.py` (`--style`, `--no-anomaly-filter`). New tests: `test_style.py`, `test_anomaly.py` (33 pytest total, all green).
- Style pass runs on **raw** votes (`preferences ⋈ matchups ⋈ responses`), not the O(pairs) aggregation — persisted to new `model_style_ratings` + `style_control_coefficients` tables (migration `004_phase_three.sql`).
- Smart matchmaking: `server/src/matchmaking/smart.ts` `SmartMatchmaker` behind the existing `MatchmakingPort`, samples pairs ∝ coldness (1/(1+games)) + rating-interval width via new `MatchmakingStatsPort` on `PostgresRepository`. Default; `MATCHMAKER=random` keeps `RandomMatchmaker`.
- Leaderboard gained `styleControlledRating`/StdError/CI (LEFT JOIN `model_style_ratings`), surfaced in `web` hook + `App.tsx`.
- **Removed PII scrubbing entirely**: deleted `server/src/privacy/noop.ts`, `PiiScrubberPort`, and all `.scrub()` wiring in chat/app/server + tests; prompts/responses now persist as received. Grep-confirmed no `Pii`/`scrub`/`privacy` refs remain in code.
- Gotcha: style control is only identifiable when a confounder varies *within* pairs — a model that is *always* more verbose is statistically indistinguishable from a stronger model (the first synthetic test had to use overlapping token distributions).
- Verification: `pytest` 33 passed; `npm run typecheck`, `npm test` (server 23 + web 5), `npm run build` all green. Docs-sync pass updated all four `docs/md` + `docs/html` pairs; plan `p3-style`/`p3-integrity` marked completed (PII scope dropped).
