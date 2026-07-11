# Code Simplification Reference

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (`code-simplification`), itself derived from Anthropic's official Code Simplifier plugin.

Simplify code by reducing complexity while preserving exact behavior. The goal is not fewer lines — it's code that is easier to read, understand, modify, and debug. Test for every simplification: "Would a new team member understand this faster than the original?"

## The Five Principles

1. **Preserve behavior exactly.** Same outputs, same error behavior, same side effects and ordering. All existing tests must pass without modification. If unsure a change preserves behavior, don't make it.
2. **Follow project conventions.** Study neighboring code first: import style, naming, error handling, type annotation depth. Simplification that breaks project consistency is churn, not simplification.
3. **Prefer clarity over cleverness.** Explicit code beats compact code when the compact version needs a mental pause to parse. Replace dense ternary chains with if/else; replace chained reduces with named intermediate steps.
4. **Maintain balance.** Over-simplification traps: inlining a helper that gave a concept a name; merging two simple functions into one complex one; removing abstractions that exist for testability; optimizing for line count.
5. **Scope to what changed.** Simplify recently modified code by default. No drive-by refactors of unrelated code unless asked.

## Process

### Step 1: Understand before touching (Chesterton's Fence)

Before changing or removing anything, understand why it exists. Answer: What is this code's responsibility? What calls it? What are the edge cases? Why might it have been written this way (performance, platform constraint, history — check git blame)? If you can't answer these, read more context first.

### Step 2: Identify opportunities

**Structural complexity:**

| Pattern | Simplification |
|---------|----------------|
| Deep nesting (3+ levels) | Guard clauses or helper functions |
| Long functions (50+ lines) | Split into focused, well-named functions |
| Nested ternaries | if/else chains, switch, or lookup objects |
| Boolean parameter flags `doThing(true, false)` | Options objects or separate functions |
| Repeated conditionals | Extract a well-named predicate |

**Naming and readability:**

| Pattern | Simplification |
|---------|----------------|
| Generic names (`data`, `result`, `temp`) | Rename to describe content |
| Misleading names (a `get` that mutates) | Rename to reflect actual behavior |
| Comments explaining *what* | Delete — the code should be clear |
| Comments explaining *why* | Keep — they carry intent the code can't |

**Redundancy:**

| Pattern | Simplification |
|---------|----------------|
| Duplicated logic (same 5+ lines) | Extract a shared function |
| Dead code | Remove (after confirming it's truly dead) |
| Pass-through wrappers | Inline; call the underlying function |
| Strategy-with-one-strategy, factory-for-a-factory | Replace with the direct approach |

### Step 3: Apply incrementally

One simplification at a time; run tests after each. If tests fail, revert and reconsider. Submit refactoring separately from feature or bug-fix changes.

**The Rule of 500:** if a refactoring would touch more than 500 lines, use automation (codemods, AST transforms) rather than hand edits.

### Step 4: Verify the whole

Is the result genuinely easier to understand? Is the diff clean and reviewable? Consistent with the codebase? If the "simplified" version is harder to follow, revert — not every attempt succeeds.

## Red Flags

- Simplification that requires modifying tests to pass (you changed behavior)
- "Simplified" code that is longer and harder to follow than the original
- Removing error handling because "it makes the code cleaner"
- Simplifying code you don't fully understand
- Batching many simplifications into one large, hard-to-review commit
