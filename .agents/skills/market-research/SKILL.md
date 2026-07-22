---
name: market-research
description: Conducts deep web research on the product being built — market landscape, competitors, alternatives, demand signals, pricing, positioning, and trends. Use when the user asks to research the market, find competitors or alternatives, validate demand, size an opportunity, or compare the product against existing solutions.
---

# Market Research

## Overview

Strong, evidence-based market research using live web search. Every claim must be backed by a source; every conclusion must distinguish fact from inference. The output is a decision-ready report, not a link dump.

Before starting, read the product context so the research is grounded in what is actually being built: `README.md`, `artifacts/pre-docs/PRD.md`, `artifacts/pre-docs/mvp.md`, and `artifacts/pre-docs/user-stories.md` (local-only, gitignored — or their equivalents in the current project).

## Research Dimensions

Cover whichever of these the question demands — for a full market scan, cover all of them:

1. **Competitive landscape** — direct competitors, indirect alternatives, and the "do nothing / DIY" option. For each: what it does, target user, pricing, strengths, weaknesses, traction signals (stars, funding, reviews, community size).
2. **Demand signals** — search trends, community discussions (Reddit, Hacker News, X, Discord), job postings, GitHub activity, waitlists, complaints about existing tools. Complaints about incumbents are the strongest demand signal.
3. **Market size and growth** — TAM/SAM estimates from credible reports, adoption curves, funding activity in the space. Flag when numbers come from vendor marketing.
4. **Positioning gaps** — what do users complain about across all incumbents? What niche, price point, or workflow is underserved? Where does the product being built genuinely differ?
5. **Pricing landscape** — how competitors charge (per seat, usage, freemium, open core), typical price points, what users say prices should be.
6. **Trends and risks** — where is the space heading? Platform risk, commoditization risk, incumbent-adds-the-feature risk.

## Method

1. **Frame the question.** State what decision this research informs (build vs. skip, positioning, pricing, feature priority).
2. **Search wide, then deep.** Start with 3–5 broad queries, then follow the strongest threads. Use multiple phrasings and include the current year for freshness. Search both product names and problem descriptions ("compare LLMs side by side" as well as "LMArena alternatives").
3. **Triangulate.** No important claim rests on a single source. Prefer primary sources (official docs, pricing pages, repos, filings) over blog roundups and SEO listicles.
4. **Date-check everything.** Note publication dates; the AI/software market shifts in months. Discard stale claims or mark them as such.
5. **Steelman the competition.** Describe competitors at their best, not their worst — flattering research produces bad decisions.

## Report Format

Use this structure for the chat answer and for any saved file:

```markdown
# Market Research: [Topic]

## TL;DR
[3-5 sentences: the answer to the framing question, with the key evidence]

## Competitive Landscape
| Product | What it is | Target user | Pricing | Traction | Key weakness |
|---------|-----------|-------------|---------|----------|--------------|

## Demand Signals
[Evidence of demand or its absence, with sources]

## Gaps & Opportunities
[Where the product being built can win — grounded in the evidence above]

## Risks
[What could make this space hard to win]

## Recommendation
[Concrete, opinionated next step]

## Sources
[Linked list, with dates]
```

## Writing the report (do this when done)

When you finish substantial research, **write the report file** — do not stop at
a chat answer or a mere offer. Save it under `artifacts/research/` as
`YYYY-MM-DD-<short-slug>.md`, using the Report Format skeleton above.

- `artifacts/` is git-ignored, so reports persist locally without cluttering the
  repo history — write there by default, no need to ask first.
- If the user explicitly wants the report tracked in git, save it somewhere
  outside `artifacts/` (e.g. a tracked `docs/` path) and tell them it will be
  committed.
- After writing, tell the user the path and give a one-line summary. For trivial
  or exploratory questions that don't warrant a file, just answer in chat.
- Cross-link related reports in the same directory when relevant.

**Saved reports must be a concise ≤5-minute read** (~800–1,000 words max;
prefer under ~900). Enforce that by:

- Keeping the same section skeleton above — do not add extra top-level sections.
- Cap the competitor table at **6–8 rows** (merge or drop weak/noise entries).
- Bullet lists only: **≤5 bullets** per section (Demand, Gaps, Risks).
- One short Recommendation block (numbered steps OK if ≤5).
- Sources: **≤12 links**, each with a date; no commentary paragraphs.
- Cut restated background, long quotes, and duplicate evidence. Link out
  instead of pasting.
- Prefer tight tables and bullets over prose paragraphs.

If the chat draft is longer, **compress on save** — do not dump the full
conversation writeup into `artifacts/research/`.

## Quality Bar

- Every factual claim carries a source link.
- Clearly separate **fact** (sourced), **inference** (reasoned from facts), and **opinion** (judgment call).
- Include negative findings — "I found no evidence of demand for X" is a valid and valuable result.
- If the research is substantial, **write** the report under `artifacts/research/` (see "Writing the report") so it persists beyond the conversation. Reminder: the saved file must meet the ≤5-minute read rule above.
