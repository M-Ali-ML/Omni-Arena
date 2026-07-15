---
name: explain-diff-html
description: Creates a rich, self-contained HTML explanation of a code change, diff, branch, or pull request. Use when someone needs the background, intuition, implementation flow, diagrams, or quiz-based reinforcement for a software change.
---

# Explain Diff HTML

Produce a single long-form HTML page that teaches a reader how a specified code change works. Investigate the surrounding system before explaining the diff: the page should make sense to a beginner while giving an experienced engineer a concise route to the changed behavior.

Adapted from Geoffrey Litt's `explain-diff-html` skill:
[https://gist.github.com/geoffreylitt/a29df1b5f9865506e8952488eac3d524](https://gist.github.com/geoffreylitt/a29df1b5f9865506e8952488eac3d524)

## Workflow

1. Identify the change and its scope from the checkout, diff, branch, PR, or user-supplied files. If the target is ambiguous, state the assumption in the page.
2. Explore the relevant code, tests, configuration, callers, data models, and documentation. Trace old and new execution paths far enough to explain behavior rather than listing edits.
3. Build a narrative:
  - the problem or constraint motivating the change;
  - the prior behavior;
  - the smallest useful mental model of the new behavior;
  - how the implementation realizes that model;
  - edge cases, trade-offs, and observable consequences.
4. Write one complete HTML document with inline CSS and JavaScript and no external dependencies.
5. Save it at `artifacts/YYYY-MM-DD-explanation-<slug>.html`. This directory is intentionally local and gitignored.
6. Validate that the file exists, works offline, contains no external assets, preserves code whitespace, and has functioning quiz interactions.



## Required structure

Include a title, short summary, table of contents, and these sections:

1. **Background** — Begin with an optional beginner mental model, then narrow to the components, contracts, and previous behavior involved.
2. **Intuition** — Explain the core idea before implementation details. Use small concrete inputs and outputs, including before/after behavior when useful.
3. **Code** — Walk through conceptual groups in execution or dependency order. Include precise file references, but do not dump the diff.
4. **Quiz** — Include exactly five medium-difficulty multiple-choice questions. Selecting an option must immediately show whether it is correct and explain the reasoning.

Use plain, precise systems-oriented prose. Explain jargon on first use. Use callouts for definitions, invariants, edge cases, and practical consequences. Keep the page responsive and continuous; do not use top-level tabs.

## Diagrams

Use a small set of semantic HTML/CSS diagram patterns:

- request, data, or control-flow diagrams;
- before/after panels;
- labeled cards for system boundaries;
- compact tables for mappings, invariants, and toy data.

Never use ASCII diagrams. Label arrows and show example values when depicting data movement. Add captions so meaning does not depend on visual inspection alone.

## Quiz quality

- Balance correct-answer positions across the five questions.
- Randomize each question's visible option order, deterministically if needed [Important].
- Keep options comparable in length, grammar, specificity, and confidence.
- Make distractors plausible and based on real misunderstandings.
- Test behavior, causality, contracts, edge cases, or trade-offs—not trivia.
- Do not use “all/none of the above.”
- Reveal feedback only after selection, without exposing correctness in source ordering, labels, styling, or accessibility text.



## HTML constraints

- Escape code- and user-derived text for its HTML or JavaScript context.
- Use `<pre><code>...</code></pre>` for code and explicitly set `white-space: pre` or `pre-wrap`.
- Keep JavaScript dependency-free and use event listeners.
- Include visible focus states and sufficient contrast.
- Do not encode correctness using color alone.
- Distinguish source-backed facts from interpretation.



## Handoff

Return a clickable link to the generated artifact. State what was inspected, assumptions made, and any validation limitations.