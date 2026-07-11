---
name: agent-log
description: Appends a brief entry to the centralized AGENT_LOG.md at the end of every agent run that changes the repo or discovers something. Use after adding, changing, or deleting code or files, fixing or discovering bugs, running research, or learning notable information about the project.
---

# Agent Log

## Purpose

`AGENT_LOG.md` at the repo root is the centralized, chronological record of what every agent did on this codebase. It lets any agent (or human) catch up on recent activity in seconds without reading git history or old conversations.

## When to Log

At the **end of a run**, append one entry if the run did any of:

- Added, changed, or deleted code, files, config, or docs
- Fixed a bug, or **discovered** a bug (even if not fixed — especially then)
- Ran research and produced findings
- Learned notable information (a constraint, a decision, a gotcha future agents should know)

Do **not** log pure Q&A runs with no changes and no findings. One entry per run, even if the run touched many files.

## Entry Format

Newest entries go at the **top**, directly under the `---` separator:

```markdown
## YYYY-MM-DD HH:MM · <Agent name> · <Model>
**Type:** feat | fix | refactor | docs | chore | bug-found | research | discovery
- <1-5 terse bullets: what changed / what was found and where>
```

Rules:

- **Brief.** Bullets are one line each, max 5 per entry. Mention key file paths inline.
- **Log intent and discoveries, not diffs.** Git already stores the diff; the log stores the *why* and anything git can't show (bugs spotted, research findings, dead ends, decisions).
- **Model** is the model powering the run (e.g. `Fable 5`, `GPT-5.3 Codex`, `Composer 2.5`). If genuinely unknown, write `unknown`.
- Multiple types allowed, comma-separated: `**Type:** feat, bug-found`.
- Unfixed bugs and gotchas are the most valuable entries — always include where they live and how they manifest.

## Example Entries

```markdown
## 2026-07-12 10:03 · Cursor Agent · Fable 5
**Type:** feat
- Added tie-vote support: `server/src/routes/vote.ts`, new `ties` column in leaderboard.
- Docs pair updated: `docs/md/api.md` + `docs/html/api.html`.

## 2026-07-12 09:40 · Claude Code · Claude Opus 4.8
**Type:** bug-found, discovery
- SSE stream in `server/src/routes/chat.ts` never closes if one provider errors mid-stream; client hangs. Not fixed.
- Gemini flash-lite rejects `temperature > 1.0` — seed values must stay ≤ 1.0 (`server/src/db/seed.ts`).
```

## Reading the Log

When starting work on this repo, skim the top ~10 entries of `AGENT_LOG.md` to pick up recent changes, open bugs, and gotchas before making changes.
