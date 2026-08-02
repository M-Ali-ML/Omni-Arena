# What driving CopilotKit's AG-UI runtime at OmniArena turned up

Everything below came out of wiring an owned Next.js App Router chat app
(`@copilotkit/react-core` / `react-ui` / `runtime` **1.63.2**, `@ag-ui/client`
**0.0.57**, `next` **16.2.10**) at `/api/arena/chat?protocol=ag-ui`, plus a
headless `ArenaHttpAgent` probe (`tools/probe.ts`). Reproductions assume the
mock harness on port 3031 (`npm run arena`).

---

## 1. Vote token: CUSTOM reaches the browser; header capture remains load-bearing

OmniArena repeats matchup metadata (including `matchupToken`) on both:

- a `CUSTOM` event named `arena_matchup`, and
- the `x-arena-matchup` response header (CORS-exposed).

With CopilotKit the AG-UI HTTP call happens **server-side** inside
`CopilotRuntime` → `ArenaHttpAgent`. The browser talks to `/api/copilotkit`, so
it cannot read `x-arena-matchup` off the OmniArena response.

**Increment 2 finding (Playwright):** CopilotKit's runtime→frontend proxy **does
forward** `CUSTOM arena_matchup` to the browser. `ArenaMatchupBridge`'s
`agent.subscribe({ onCustomEvent })` receives it (`window.__arenaMatchupViaCustom
=== true` in `tests/protocol.spec.ts`). The run-finished poll of
`GET /api/arena/matchup` also succeeds on every run — both paths hydrate the
store. Unlike assistant-ui (aggregator silently drops `CUSTOM`), pinned
CopilotKit 1.63.2 keeps arbitrary CUSTOM names end-to-end.

**What we ship anyway:** `ArenaHttpAgent`'s custom `fetch` captures
`x-arena-matchup` server-side, stashes it in an in-process map keyed by
CopilotKit `threadId`, and exposes `GET /api/arena/matchup?threadId=…`. The
client still polls after `onRunFinishedEvent` as belt-and-suspenders — the
header-capture path stays load-bearing if a future CopilotKit release tightens
CUSTOM filtering, and it is what works when the browser never sees OmniArena's
response headers.

The cache is **in-process and single-instance**: a multi-instance deploy needs
shared storage or sticky sessions. Fine for an example; stated here so nobody
copies it into production blindly.

**Clone gotcha (Increment 2 app fix):** CopilotRuntime runs
`agents[id].clone()` before each run. Stock `HttpAgent.clone` copies only
url/headers/fetch — custom `context` was dropped and `requestInit` crashed with
`Cannot destructure property 'arenaEnabled' of 'this.context'`. `ArenaHttpAgent`
now overrides `clone()` to share `context` + the matchup-cache thread ref.

## 2. Per-request agent context needs an AgentsFactory

A stock `new HttpAgent({ url })` cannot attach OmniArena's `forwardedProps`
(`sessionId`, `conversationId`, `arena`) or the `x-arena` header.
`ArenaHttpAgent` overrides `requestInit` for that — same adaptation as
assistant-ui.

Because the agent lives on the server, those fields have to arrive per
request. CopilotRuntime's `agents` config accepts an **AgentsFactory**
`({ request }) => ({ arena: … })`. The client puts `x-arena`,
`x-arena-session`, `x-arena-conversation`, and `x-arena-thread` on the
`<CopilotKit headers={…}>` prop; the factory reads them when minting the
agent. That is the whole remaining glue.

## 3. Two concurrent slot messages stay two messages

Unlike assistant-ui's AG-UI aggregator (one assistant message, two text parts),
CopilotKit keeps OmniArena's `<matchupId>:A` and `<matchupId>:B` as **two**
assistant messages. The custom `assistantMessage` slot renders A as a dual
column and returns `null` for B so the list does not stack two bubbles.

## 4. Stock chat UI is usable; arena chrome is host-owned

`CopilotChat` from `@copilotkit/react-core/v2` (also re-exported through the
compatibility `<CopilotKit agent="arena">` provider) accepts a `messageView`
slot for `assistantMessage`. Vote bar, arena toggle, and run-error surface sit
outside CopilotKit's message tree in a thin host store — CopilotKit has nowhere
to put matchup metadata.

---

## Pinned versions (Increment 1)

| Package | Version |
| --- | --- |
| `@copilotkit/react-core` | 1.63.2 |
| `@copilotkit/react-ui` | 1.63.2 |
| `@copilotkit/runtime` | 1.63.2 |
| `@ag-ui/client` | 0.0.57 |
| `next` | 16.2.10 |
| `react` / `react-dom` | 19.2.8 |

`next` 16.2.10 matches the assistant-ui pin and satisfies CopilotKit 1.63.2's
React 18/19 peer range. `@copilotkit/react-ui` is pinned for the flagship
surface even though the v2 chat primitives now live in `react-core/v2`.
