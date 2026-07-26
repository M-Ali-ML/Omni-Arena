---
name: next-steps
description: >-
  Rewrites artifacts/NEXT_STEPS.md so the next session can pick up cold.
  Invoke at sign-off / end of a run (before or with agent-log), when the user
  says "update next steps", "sign off", "wrap up", or "where do we stand",
  or after finishing a chunk of work that changes priorities.
---

# Next Steps (sign-off)

## Purpose

`artifacts/NEXT_STEPS.md` is the **current** pickup queue for this repo (gitignored under `artifacts/`). It answers: where we stand, what to do next, and which bugs/gotchas are still open. It is not a changelog — that is `artifacts/AGENT_LOG.md`.

Invoke this skill **before signing off** any run that changed code, closed/opened work, or shifted priorities. Pure Q&A with no new findings: skip.

## When to run

- User asks to sign off, wrap up, update next steps, or “where do we stand”
- End of a run that landed work, discovered gaps, or closed items on the queue
- Starting a long session after a cold pickup (read the doc first; rewrite only if stale)

Pair with **agent-log**: log what happened this run; rewrite next-steps so the *queue* matches reality. Order: update next-steps, then append agent-log (or reverse — both must happen when both apply).

## Workflow

1. **Read** `artifacts/NEXT_STEPS.md` (create from the template below if missing).
2. **Skim evidence** for this run only — do not re-audit the whole repo unless the doc is clearly rotten:
   - Top of `artifacts/AGENT_LOG.md`
   - Diff / files touched this conversation
   - Integration FINDINGS / README “does not work” if this run touched that host
3. **Rewrite** the doc in place (full file replace is fine). Keep it scannable in under two minutes.
4. **Bump** `Last updated` to now + agent name + model.
5. Tell the user in one short line that next-steps was refreshed and point at the top “Do next” item.

## Doc rules

- **Living queue, not a log.** Drop or demote finished P0–P2 items; move them to a one-line “Resolved recently” note only if someone might re-open them by mistake. Do not append dated sections forever.
- **Priority by impact.** P0 = blocks drop-in / core product claims. P1 = host polish / operator pain. P2 = planned seams (`sampled`, `shadow`, steer). P3 = launch/optional.
- **Every open item needs a pointer** (path, FINDINGS §, or plan doc) so the next agent does not rediscover it.
- **Honest “Where we stand”** — 5–10 lines on what is actually shipped on `main` (or the branch you are on). Mention dirty tree / unpushed work if relevant.
- **One “Suggested next session”** with 2–4 concrete picks (not a laundry list).
- Keep the whole file roughly ≤200 lines. Cut detail; link out.
- Do **not** invent work. If unsure whether something is fixed, check the cited source or leave it marked open with “verify”.
- Do **not** commit `artifacts/` (gitignored). The skill file under `.agents/skills/` is what gets committed.

## Required shape

```markdown
# Next Steps

Living pickup doc for OmniArena. Read this first when resuming work.
Update it via the `next-steps` skill before signing off (`.agents/skills/next-steps/SKILL.md`).
Chronological history lives in `artifacts/AGENT_LOG.md` — this file is the *current* queue, not a log.

**Last updated:** YYYY-MM-DD HH:MM · <Agent name> · <Model>

---

## Where we stand

<short snapshot>

---

## Do next (priority order)

### P0 — …
1. …

### P1 — …
…

### P2 — …
…

### P3 — …
…

---

## Open bugs / gotchas (still true)

| Item | Where | Notes |
| --- | --- | --- |
| … | … | … |

Resolved recently: <comma-separated short list, or "none this pass">

---

## Suggested next session

1. …
2. …

---

## Pointers

| Doc | Why |
| --- | --- |
| `artifacts/AGENT_LOG.md` | Recent agent activity |
| … | … |
```

Optional subsections only if useful: “In flight / uncommitted”, “Blocked on upstream”.

## Anti-patterns

- Dumping the full git diff or a second agent log into this file
- Leaving done P0 items in “Do next” because the FINDINGS.md still has the old prose (check the “Resolved” callouts)
- Vague items (“improve DX”, “more tests”) with no file or acceptance hint
- Updating next-steps but skipping agent-log when the run changed the repo
