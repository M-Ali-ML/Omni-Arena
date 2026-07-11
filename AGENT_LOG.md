# Agent Log

Centralized, brief log of every agent run on this repo. Newest entries first.
Format and rules: `.agents/skills/agent-log/SKILL.md`.

---

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
