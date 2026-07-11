---
name: code-quality
description: Enforces clean design and best engineering patterns on all code written or changed. Use when writing new code, refactoring, reviewing changes, or before considering any feature done. Covers correctness, readability, architecture, security, and performance, grounded in Clean Code, A Philosophy of Software Design, and Google's code review standards.
---

# Code Quality

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (`code-review-and-quality`), which encodes Google's code review standards and principles from Clean Code, The Pragmatic Programmer, and A Philosophy of Software Design.

## Overview

Every change gets evaluated across five axes before it is considered done: correctness, readability, architecture, security, and performance.

**The standard:** A change is good when it definitely improves overall code health, even if it isn't perfect. Perfect code doesn't exist — the goal is continuous improvement. Deep modules, shallow interfaces; complexity should be pulled downward, not exposed to callers.

## The Five-Axis Review

### 1. Correctness

- Does it match the spec or task requirements?
- Are edge cases handled (null, empty, boundary values)?
- Are error paths handled (not just the happy path)?
- Does it pass all tests? Are the tests actually testing the right things?
- Are there off-by-one errors, race conditions, or state inconsistencies?

### 2. Readability & Simplicity

- Are names descriptive and consistent with project conventions? (No `temp`, `data`, `result` without context)
- Is the control flow straightforward (avoid nested ternaries, deep callbacks)?
- Are there any "clever" tricks that should be simplified?
- **Could this be done in fewer lines?** (1000 lines where 100 suffice is a failure)
- **Are abstractions earning their complexity?** (Don't generalize until the third use case)
- Comments explain non-obvious *why*, never obvious *what*.
- No dead code artifacts: no-op variables, backwards-compat shims, `// removed` comments.
- **Is a new conditional bolted onto an unrelated flow?** That's a design smell — push the logic into its own helper, state, or policy.
- **Do repeated conditionals on the same shape appear?** They signal a missing model or dispatcher. A "temporary" branch is usually permanent debt.

### 3. Architecture

- Does it follow existing patterns or introduce a new one? If new, is it justified?
- Does it maintain clean module boundaries? Dependencies flow one direction, no cycles.
- Is there code duplication that should be shared?
- **Does a refactor reduce complexity or just relocate it?** Count the concepts a reader must hold. Prefer the restructuring that makes whole branches, modes, or layers disappear. Prefer deleting an abstraction to polishing it.
- **Is feature-specific logic leaking into a shared module?** Keep logic in its owning layer; reuse the existing canonical helper instead of a near-duplicate.
- **Are type boundaries explicit?** Question gratuitous `any`/casts and silent fallbacks that paper over an unclear invariant.

### 4. Security

- Is user input validated at system boundaries?
- Secrets out of code, logs, and version control.
- Auth checks where needed; SQL parameterized; outputs encoded against XSS.
- Data from external sources (APIs, user content, config) treated as untrusted.

### 5. Performance

- Any N+1 query patterns, unbounded loops, or unconstrained data fetching?
- Any synchronous operations that should be async?
- Missing pagination on list endpoints? Unnecessary re-renders in UI components?

## Structural Remedies

When you flag a structural problem, propose the move — not just the problem:

- **Replace a chain of conditionals** with a typed model or an explicit dispatcher.
- **Collapse duplicate branches** into a single clearer flow.
- **Separate orchestration from business logic** so each reads on its own.
- **Move feature-specific logic** out of a shared module into the package that owns the concept.
- **Make a type boundary explicit** so downstream branching disappears.
- **Delete a pass-through wrapper** that adds indirection without clarifying the API.
- **Extract a helper, or split a large file** into focused modules.

Prefer the remedy that removes moving pieces over one that spreads the same complexity around.

## Change Sizing

```
~100 lines changed   → Good. Reviewable in one sitting.
~300 lines changed   → Acceptable if it's a single logical change.
~1000 lines changed  → Too large. Split it.
```

**Watch file size, not just diff size.** Around 1000 total lines in a single file is an inspection signal. When a change materially grows an already-large file, extract helpers or modules *first*, then add.

**Separate refactoring from feature work.** A change that refactors and adds behavior is two changes — submit them separately.

## Process

1. **Understand the context** — what is the change trying to accomplish?
2. **Review the tests first** — do they test behavior, cover edge cases, and would they catch a regression?
3. **Walk the implementation** through the five axes, file by file.
4. **Categorize findings** by severity: **Critical** (blocks merge), *required* (no prefix), **Nit:**, **Consider:**, **FYI**. Lead with what matters — one structural problem outweighs ten nits.
5. **Verify:** tests pass, build succeeds, lints clean, dead code removed.

## Dependency Discipline

Before adding any dependency: does the existing stack solve this? How large is it? Actively maintained? Known vulnerabilities? Compatible license? **Prefer the standard library and existing utilities — every dependency is a liability.** Upgrade dependencies one per change, read the changelog (semver is a promise, not a guarantee), and review the lockfile diff.

## Honesty

- Don't rubber-stamp. Don't soften real issues.
- Quantify problems when possible ("this N+1 adds ~50ms per item" beats "this could be slow").
- Push back on approaches with clear problems — sycophancy is a failure mode.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It works, that's good enough" | Unreadable, insecure, or architecturally wrong code creates compounding debt. |
| "We'll clean it up later" | Later never comes. Require cleanup before merge. |
| "The tests pass, so it's good" | Tests don't catch architecture, security, or readability problems. |
| "The refactor makes it cleaner" | Relocating complexity isn't reducing it. Look for the version where branches disappear. |
| "It's only a small addition to this file" | Small diffs still push files past a healthy size. Judge the resulting structure, not the diff size. |
| "AI-generated code is probably fine" | It needs more scrutiny, not less — it's confident and plausible, even when wrong. |

## Additional Resources

- For behavior-preserving simplification and refactoring workflow (Chesterton's Fence, Rule of 500, pattern tables), see [simplification.md](simplification.md).
