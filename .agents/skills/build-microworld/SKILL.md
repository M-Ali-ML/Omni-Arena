---
name: build-microworld
description: Builds a small interactive environment for learning a complex code path by manipulating inputs and stepping through state. Use when prose or a raw diff is insufficient to understand streaming, state machines, migrations, algorithms, or multi-component behavior.
---

# Build a Code Micro-world

Create an ephemeral teaching tool whose purpose is to help a human form an accurate mental model of a system. The artifact is for exploration, not production.

Inspired by Geoffrey Litt's “Understanding is the new bottleneck” talk and Seymour Papert's idea of learning by inhabiting a microworld.

## When to use

Use a micro-world when the target has meaningful state transitions, timing, branching, transformations, or interactions across boundaries. Good OmniArena candidates include:

- multiplexed SSE events from two providers;
- conversation continuation after a vote;
- matchmaking eligibility and pair selection;
- provider configuration and routing;
- database migration and persistence flows;
- rating or style-control calculations.

Do not create one for a simple rename, static configuration change, or behavior already obvious from a short explanation.

## Workflow

1. Identify the exact behavior the reader needs to understand.
2. Inspect implementation, tests, types, and documentation. Record invariants and edge cases from source rather than guessing.
3. Choose the smallest interactive model that preserves those important behaviors.
4. Create one self-contained HTML file at `artifacts/YYYY-MM-DD-microworld-<slug>.html`.
5. Validate the model against at least two checked-in examples or tests, including one edge case.
6. Hand control to the learner: the interface must require them to step, choose, drag, edit, or replay—not merely watch an animation.

## Required interface

- A one-paragraph learning objective.
- Editable or selectable toy inputs with realistic defaults.
- Step, back, reset, and replay controls when the behavior is sequential.
- A visible state view that distinguishes current state, the triggering event, and the next consequence.
- A concise explanation tied to each step.
- A source map linking modeled concepts to repository files and tests.
- At least two guided scenarios and one free-exploration mode.

## Design rules

- Prefer a focused simulator over a miniature copy of the product.
- Use real domain terms and representative values.
- Keep the model deterministic unless randomness is the concept being taught; expose the seed when randomness matters.
- Show boundaries and transformations explicitly.
- Never hide complexity that changes the conclusion. Label any intentional simplification.
- Use semantic HTML, inline CSS and JavaScript, keyboard-accessible controls, visible focus states, and no external dependencies.
- Do not use the artifact as evidence that production code is correct. Production tests remain authoritative.

## Learning check

End with three scenario questions that ask the learner to predict the next state before revealing it. Use misconceptions observed in tests or code paths as plausible alternatives.

## Handoff

Return a clickable artifact link and list:

- the source files and tests used;
- behaviors faithfully modeled;
- simplifications made;
- scenarios validated.
