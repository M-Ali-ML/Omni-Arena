# Agent Log

Centralized, brief log of every agent run on this repo. Newest entries first.
Format and rules: `.agents/skills/agent-log/SKILL.md`.

---

## 2026-07-15 14:42 · Cursor Agent · GPT-5.6 Sol
**Type:** chore, research
- Added `explain-diff-html` and `build-microworld` teaching skills under `.agents/skills/`.
- Summarized Geoffrey Litt's understanding workflow in local-only `artifacts/understanding-is-the-new-bottleneck.md`.

## 2026-07-14 16:40 · Cursor Agent · Fable 5
**Type:** chore, docs
- Moved `pre-docs/vision.md` → `artifacts/vision.md` (untracked from git via `git rm --cached`; `artifacts/` is already gitignored) since vision is a personal/local planning doc, not meant to be committed.
- Updated references in `docs/md/architecture.md` and `README.md` to point at the new local-only path.

## 2026-07-14 16:20 · Cursor Agent · Fable 5
**Type:** feat, docs, chore
- Phase 0 of the MVP-to-vision roadmap: committed pending work (markdown rendering, `server/src/env.ts` root-.env loader, seed lineup).
- Versioned migrations: `server/src/db/migrations/001_initial.sql` + `runMigrations()` in `server/src/db/migrations.ts` (transactional, tracked in `schema_migrations`); replaced the one-shot `schema.sql` apply.
- New tests: `RandomMatchmaker`, migration runner, and web `useArenaChat` hook (jsdom + SSE-stream fetch stubs); root `npm test` now runs both workspaces.
- Gotcha: Node 24's experimental `localStorage` global shadows jsdom's with `undefined` in Vitest — web tests must stub it. pg-mem also fails AST coverage on repeat `CREATE TABLE IF NOT EXISTS`, so the migration runner uses an information_schema existence check.
- Bootstrapped `docs/`: paired md/html for architecture, api, data-model, setup per the docs-sync skill; README now links them.

## 2026-07-11 17:05 · Cursor Agent · Fable 5
**Type:** docs
- Added a future-consideration callout on temporal drift to `pre-docs/vision.md` §4 (silent checkpoint swaps, harness drift; capture versioned model IDs + `harness_version` now, defer windowed/dynamic ratings). Explicitly not planned for now.

## 2026-07-11 16:55 · Cursor Agent · Fable 5
**Type:** docs
- Rewrote `pre-docs/vision.md` §4 rating engine: dropped the `np.add.at`/anti-sklearn framing (misleading — dedup, not scatter-add, is the real win) for O(votes)→O(pairs) SQL aggregation, L-BFGS/MM solver, Fisher-information CIs with multinomial bootstrap as validation, Rao-Kupper/Davidson tie modeling, anchoring + comparison-graph connectivity.
- Style control now joint covariates inside the BT regression (LMSYS-style) instead of a separate post-hoc ridge regression; noted style features break pair-level aggregation, so style-controlled leaderboard is a heavier periodic pass.
- Synced §1 (thin-proxy vision: swap only the model call, optional headless UI, best-practice comparisons), §5 agent instructions, §6 Reddit pitch + resume bullets; replaced trailing stack question with the decided TypeScript-router/Python-worker split.

## 2026-07-11 16:24 · Cursor Agent · Fable 5
**Type:** chore
- Created `AGENT_LOG.md` and the `agent-log` skill so every agent run is logged here.

## 2026-07-11 16:20 · Cursor Agent · Fable 5
**Type:** chore
- Created three cross-agent skills in `.agents/skills/`: `docs-sync` (paired md/html docs following `pre-docs/design.md`), `code-quality` (five-axis review adapted from addyosmani/agent-skills), `market-research` (evidence-based market/competitor research).
