# Contributing to OmniArena

Thanks for taking an interest. Bug reports, protocol adapters, provider
integrations, and rating-engine improvements are all welcome.

## Getting a dev environment

Two supported paths, both documented in the [README](README.md).

### Docker (closest to production)

Requirements: Docker with Compose v2.

```bash
cp .env.example .env
# Add GOOGLE_API_KEY and a MATCHUP_TOKEN_SECRET
docker compose up
```

This waits for Postgres, applies migrations, seeds the model lineup, and serves
the API and web UI together on <http://localhost:3001>.

### npm (hot reloading)

Requirements: Node.js 20+, npm, and Docker for Postgres. Python 3.10+ only if
you want to run the rating worker outside Docker. Those are the floors the
manifests declare (root `package.json` `engines`, `worker/pyproject.toml`
`requires-python`); CI runs Node 22 and Python 3.11, so developing on those
versions is the closest match to what will gate your pull request.

```bash
cp .env.example .env
npm install
docker compose up -d postgres worker
npm run db:migrate --workspace server
npm run db:seed --workspace server
npm run dev
```

The web app is on <http://localhost:5173> and Vite proxies `/api` to the API on
port 3001.

You only need a provider API key to talk to real models. The test suites and the
end-to-end run use the deterministic mock provider and need no keys.

## Repository layout

| Path | What it is |
| --- | --- |
| `server/` | Fastify + TypeScript API: routes, protocol adapters, providers, matchmaking, slot join, Postgres repository, migrations. |
| `packages/react-sdk/` | `@omni-arena/react` — React-free protocol primitives plus the hooks built on them (`useArenaChat`, `useArenaVote`, `useArenaLeaderboard`, one per analytics endpoint). No UI, no styling. |
| `web/` | Vite + React demo, leaderboard, and lazily-loaded `/insights` dashboard; the reference consumer of the SDK. |
| `worker/` | Python Bradley-Terry rating worker (NumPy/SciPy). Not an npm workspace. |
| `e2e/` | Playwright suite plus a harness that boots the real server over pg-mem. |
| `examples/` | Runnable reference integrations (Next.js + Vercel AI SDK, Vite + assistant-ui). |
| `integrations/` | The arena layered onto real upstream chat apps (assistant-ui, Open WebUI, vercel/ai-chatbot), each pinned to an exact upstream version, with their own suites. |
| `docs/` | Paired documentation: Markdown sources in `docs/md/`, condensed HTML in `docs/html/`, and the `docs/index.html` landing page GitHub Pages serves. |
| `.github/` | CI workflow, issue forms, and the pull request template. |

`server`, `packages/react-sdk`, and `web` are npm workspaces, so `npm install` at
the root installs all three. `e2e/`, `examples/*`, and `integrations/*` are
deliberately outside the workspaces: each has its own `package.json` and lockfile
and is installed on demand by its own script, so a root `npm install` stays fast
and none of them can break the published build.

## Running the tests

```bash
npm test                          # all workspace Vitest suites
npm run test --workspace server   # server only
npm run typecheck                 # strict tsc across the workspaces
npm run build                     # server, SDK, and web production builds
npm run e2e                       # Playwright end-to-end suite
```

The `web` suite runs with `--passWithNoTests`, so it is green on a checkout with
no web specs; it exists so web-side tests cannot land unrun.

`npm run e2e` (`e2e/run.mjs`) installs and builds both example apps, installs
Playwright's Chromium, and drives the full arena flow — streaming, voting,
identity reveal, multi-turn continuation — against a server booted on in-memory
Postgres (pg-mem) and the mock provider. No database and no API keys required.

Rating worker:

```bash
cd worker
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m pytest
```

The pytest suite is pure Python: no live database.

Build the SDK before typechecking `web` on a clean checkout — `web` resolves
`@omni-arena/react` to `packages/react-sdk/dist`, so the declaration files have
to exist. `npm run build` at the root does this in the right order.

All of the above runs in CI on every pull request and on every push to `main`
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), split into three jobs:
Node (build, typecheck, unit tests), Python (the worker's pytest suite), and
end-to-end (Playwright). No job needs a secret — every suite runs against the
mock provider and in-memory Postgres, so CI works unchanged on a fork. Please
make sure it is green before asking for review.

## Code conventions

These are the habits the existing code follows — matching them makes review fast.

**TypeScript is strict.** `tsconfig.base.json` turns on `strict` and
`noUncheckedIndexedAccess`. Don't reach for `any` or a non-null assertion to get
past the compiler; narrow the type instead. ESM throughout, with `.js` extensions
on relative imports.

**Validate at protocol boundaries with Zod.** Anything crossing the wire — HTTP
request bodies, WebSocket control frames, adapter event payloads — is parsed into
a typed value at the edge (`server/src/routes/`, `server/src/core/events.ts`,
`server/src/adapters/`). Inside that boundary the types are trusted and not
re-checked.

**Ports and adapters.** `server/src/core/ports.ts` defines the interfaces;
providers, repositories, matchmakers, and protocol adapters are implementations
behind them. A new wire format is a new adapter registered in
`server/src/adapters/registry.ts`, not a branch in the chat route. A new model
backend is a new provider, not a special case in the core.

**Aggregate before you compute.** Reduction belongs in SQL. The rating worker
collapses `preferences` ⋈ `matchups` into one canonical row per model pair with a
single `GROUP BY`, so the fit sees roughly `3·C(n,2)` rows regardless of how many
millions of votes exist. Leaderboard and analytics queries follow the same rule.
Don't pull raw rows into application memory to count them.

**Vectorized NumPy and standard solvers.** The Bradley-Terry fit uses
`scipy.optimize.minimize(method="L-BFGS-B")` with an analytic gradient, and
confidence intervals come from the inverse Hessian (observed Fisher information).
Prefer vectorized array expressions and well-understood SciPy routines to
hand-rolled Python loops or bespoke gradient descent. Statistical changes should
come with a test that recovers a known synthetic ground truth — see
`worker/tests/`.

**Comments explain intent, not mechanics.** Write down why a decision was made,
what invariant holds, or which constraint forced the shape of the code. Skip
comments that restate the line below them.

**Tests live next to the code** (`*.test.ts` beside the source; Vitest for
TypeScript, pytest for Python). New behaviour needs a test; bug fixes need a test
that fails before the fix.

**Docs come in pairs.** Every topic in `docs/` is two files with the same base
name: `docs/md/<topic>.md` is the complete prose source of truth, and
`docs/html/<topic>.html` is a condensed, self-contained visual rendering of the
*same* information (what GitHub Pages serves). Update both in the same pass —
touching only one is how the two drift apart. `.agents/skills/docs-sync/SKILL.md`
has the full convention, including the design tokens the HTML follows.

## Pull requests

- Branch from `main`, keep the change focused, and describe the *why* in the
  description.
- Update the docs when you change behaviour they describe — the `docs/md/` page
  and its `docs/html/` counterpart together.
- Fill in the pull request template; it is short on purpose.
- Bug reports and feature requests have issue forms
  ([`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/)); usage questions and
  open-ended ideas belong in Discussions instead.

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
