# Integration guide

OmniArena streams one blind matchup — two anonymous models, one connection — and
frames that single internal event stream in **five wire protocols** through a
pluggable egress-adapter layer (`server/src/adapters/`). This guide covers each
protocol: what it emits on the wire, how a client selects it, how Model A and
Model B are carried, how to obtain the matchup token and cast a vote, and which
frontends and stacks it suits.

Related: [API](api.md) · [Architecture](architecture.md) · [SDK](sdk.md) · [Rating methodology](rating-methodology.md) · [Setup](setup.md)

## One stream, five framings

Every protocol carries the **same** internal event sequence over the same two
slots (A, B):

```
matchup_started → token* → slot_error? → slot_done → matchup_done
```

Only the framing differs. Each adapter validates every frame against the zod
`publicArenaEventSchema` (`server/src/core/events.ts`) before writing it, so a
malformed chunk fails loudly instead of reaching a client. Native SSE is the
default and is preserved **byte-for-byte**, so existing clients (the demo and the
`@omni-arena/react` SDK) are unaffected by the other adapters.

### Selecting a protocol

The chat route (`POST /api/arena/chat`) picks an adapter with this precedence
(`server/src/adapters/registry.ts` → `selectAdapter`):

1. `?protocol=` query parameter (case-insensitive alias).
2. The request `Accept` header media type.
3. Default: **native SSE**.

An unknown `?protocol=` value falls back to native SSE, so a bad value never
breaks the default path.

| Protocol | `?protocol=` aliases | `Accept` media type(s) | Response `content-type` |
|---|---|---|---|
| Native SSE *(default)* | `sse`, `native`, `native-sse` | `text/event-stream` | `text/event-stream` |
| AG-UI | `agui`, `ag-ui` | `application/vnd.ag-ui+json` | `text/event-stream` |
| A2UI | `a2ui` | `application/vnd.a2ui+json`, `application/x-ndjson` | `application/x-ndjson` |
| Vercel AI SDK | `vercel`, `vercel-ai`, `ai-sdk` | `application/vnd.vercel.ai.ui-message-stream+json` | `text/event-stream` (+ `x-vercel-ai-ui-message-stream: v1`) |
| OpenAI SSE | `openai`, `openai-sse` | `application/vnd.openai.chat-chunk+json` | `text/event-stream` |

## Model A vs Model B, and the vote flow

Both models are **anonymous** while streaming. Each protocol tags its two slots
so a client can render them in two columns; identities are only revealed after a
vote. How the two slots are carried differs per protocol (see each section
below), but the voting flow is always the same three steps:

1. **Obtain the matchup token.** `POST /api/arena/vote` needs the `matchupId`
   and the signed `matchupToken` minted when the round started. Where that token
   appears on the wire depends on the protocol.
2. **Let the user pick a winner** once both slots finish: `left`, `right`,
   `both_good`, `both_bad`, or `skip`.
3. **`POST /api/arena/vote`** with `{ matchupId, matchupToken, vote }`. On
   success it returns `{ accepted: true, models: { A, B } }` — the reveal. See
   [API → vote](api.md).

> **Vote-token availability differs by protocol.** Native SSE, A2UI, and the
> Vercel AI SDK adapter all put the `matchupToken` on the wire, so those paths
> are self-contained and votable. **The AG-UI and OpenAI SSE adapters do NOT
> expose the vote token** — their event/chunk vocabularies have no field for it.
> Voting over those protocols requires obtaining the matchup token from another
> channel (e.g. a parallel native-SSE request, or a server-side wrapper that
> mints and tracks it). This is verified in the adapter code:
> `vercel-ai.ts` includes `matchupToken` in its `data-arena-meta` part;
> `ag-ui.ts` and `openai-sse.ts` emit no token-bearing field.

---

## Native SSE (default)

**Select:** nothing (default), or `?protocol=sse`, or `Accept: text/event-stream`.
**Adapter:** `server/src/adapters/sse.ts`.

Each internal event becomes one `event:`/`data:` pair. There is no trailing
sentinel. This is the canonical shape documented in the [API](api.md).

```
event: matchup_started
data: {"type":"matchup_started","matchupId":"m1","matchupToken":"eyJ….sig","conversationId":"c1","turnIndex":0,"slots":["A","B"]}

event: token
data: {"type":"token","slot":"A","token":"He"}

event: token
data: {"type":"token","slot":"B","token":"Yo"}

event: slot_done
data: {"type":"slot_done","slot":"A"}

event: matchup_done
data: {"type":"matchup_done"}
```

- **Model A vs B:** every `token`, `slot_error`, and `slot_done` event carries a
  `slot` field (`"A"` or `"B"`); route on it.
- **Vote token:** the `matchup_started` event carries `matchupId` **and**
  `matchupToken` directly — this path is self-contained and votable.
- **Suits:** the OmniArena demo, the [`@omni-arena/react`](sdk.md) SDK, and any
  custom `EventSource`/`fetch`-reader client. The simplest option and the one to
  use when you control both ends.

---

## AG-UI

**Select:** `?protocol=ag-ui` (alias `agui`) or `Accept: application/vnd.ag-ui+json`.
**Adapter:** `server/src/adapters/ag-ui.ts`. **Transport:** SSE (one `data:`
line per typed AG-UI event).

The two arena slots become two concurrent AG-UI text messages inside one run.
The adapter emits the subset of the [AG-UI](https://ag-ui.com) event taxonomy the
arena needs: run lifecycle, text streaming, and a `CUSTOM` event for a
single-slot error.

```
data: {"type":"RUN_STARTED","threadId":"c1","runId":"m1"}

data: {"type":"TEXT_MESSAGE_START","messageId":"m1:A","role":"assistant","slot":"A"}

data: {"type":"TEXT_MESSAGE_START","messageId":"m1:B","role":"assistant","slot":"B"}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1:A","delta":"He","slot":"A"}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1:B","delta":"Yo","slot":"B"}

data: {"type":"CUSTOM","name":"slot_error","value":{"slot":"B","message":"boom"}}

data: {"type":"TEXT_MESSAGE_END","messageId":"m1:A","slot":"A"}

data: {"type":"RUN_FINISHED","threadId":"c1","runId":"m1"}
```

- **Event mapping:** `matchup_started` → `RUN_STARTED` + one
  `TEXT_MESSAGE_START` per slot; `token` → `TEXT_MESSAGE_CONTENT`
  (`delta`, `slot`); `slot_error` → `CUSTOM` named `slot_error`
  (`{ slot, message }`, so the surviving slot keeps streaming); `slot_done` →
  `TEXT_MESSAGE_END`; `matchup_done` → `RUN_FINISHED`.
- **Model A vs B:** each message is tagged `slot` (`"A"`/`"B"`) and has a stable
  `messageId` of `"<runId>:<slot>"`; `runId` is the matchup id and `threadId`
  the conversation id.
- **Vote token:** **not exposed.** The AG-UI vocabulary has no token field, so
  voting over pure AG-UI requires obtaining the matchup token from another
  channel. (You could smuggle it in a `CUSTOM` event in a fork, but the shipped
  adapter does not.)
- **Suits:** agentic frontends that speak AG-UI — CopilotKit, LangGraph,
  CrewAI, and assistant-ui's first-party
  [`@assistant-ui/react-ag-ui`](https://github.com/assistant-ui/assistant-ui)
  runtime (see the [integration research](../../artifacts/research/2026-07-15-integration-targets.md)).
  The [`examples/assistant-ui/`](../../examples/assistant-ui/) app runs on
  assistant-ui; it uses the AI SDK runtime for the votable round-trip, but
  assistant-ui also ships the AG-UI runtime that consumes this adapter.

---

## A2UI

**Select:** `?protocol=a2ui` or `Accept: application/vnd.a2ui+json` /
`application/x-ndjson`.
**Adapter:** `server/src/adapters/a2ui.ts`. **Transport:** **NDJSON**
(`application/x-ndjson`) — one flat, self-describing JSON object per line.

Each line is a versioned (`a2ui/1`) message that paints one of two side-by-side
**surfaces** (one per slot), so a generative-UI frontend can render each side
with its own local design system.

```
{"v":"a2ui/1","kind":"surface_init","matchupId":"m1","conversationId":"c1","turnIndex":0,"surfaces":["A","B"]}
{"v":"a2ui/1","kind":"text_append","surface":"A","text":"He"}
{"v":"a2ui/1","kind":"text_append","surface":"B","text":"Yo"}
{"v":"a2ui/1","kind":"error","surface":"B","message":"boom"}
{"v":"a2ui/1","kind":"surface_done","surface":"A"}
{"v":"a2ui/1","kind":"session_done"}
```

- **Event mapping:** `matchup_started` → `surface_init`; `token` →
  `text_append`; `slot_error` → `error`; `slot_done` → `surface_done`;
  `matchup_done` → `session_done`.
- **Model A vs B:** every message names its `surface` (`"A"`/`"B"`);
  `surface_init` lists the surfaces to create up front.
- **Vote token:** the `surface_init` message carries `matchupId`,
  `conversationId`, and `turnIndex`. It does **not** currently carry the signed
  `matchupToken`, so obtain the token from `surface_init.matchupId` plus a
  token-bearing channel (native SSE or a server wrapper) to vote.
- **Parsing:** split the body on `\n`; each non-empty line is a complete JSON
  object (no `data:` prefix, no SSE framing).
- **Suits:** generative-UI / "agent-to-UI" frontends that want a schema-first,
  design-system-agnostic stream and paint their own components per surface.

---

## Vercel AI SDK

**Select:** `?protocol=vercel-ai` (aliases `vercel`, `ai-sdk`) or
`Accept: application/vnd.vercel.ai.ui-message-stream+json`.
**Adapter:** `server/src/adapters/vercel-ai.ts`. **Transport:** the AI SDK
**UI Message Stream** over SSE, with header `x-vercel-ai-ui-message-stream: v1`
and a trailing `data: [DONE]` sentinel.

A stock [`useChat`](https://sdk.vercel.ai) client can consume the arena
directly. Slot A rides the primary text channel; slot B is multiplexed through
custom `data-*` parts so a sidecar renderer can paint it beside the main answer.

```
data: {"type":"start"}

data: {"type":"data-arena-meta","data":{"matchupId":"m1","matchupToken":"eyJ….sig","conversationId":"c1","turnIndex":0,"mainSlot":"A","dataSlot":"B"}}

data: {"type":"text-start","id":"m1"}

data: {"type":"text-delta","id":"m1","delta":"He"}

data: {"type":"data-arena-b-delta","data":{"text":"Yo"}}

data: {"type":"text-delta","id":"m1","delta":"llo"}

data: {"type":"data-arena-error","data":{"slot":"B","message":"boom"}}

data: {"type":"data-arena-b-done","data":{}}

data: {"type":"text-end","id":"m1"}

data: {"type":"finish"}

data: [DONE]
```

- **Model A vs B:** **Model A** is the primary assistant text
  (`text-start`/`text-delta`/`text-end`); **Model B** streams through custom
  data parts (`data-arena-b-delta` with `{ text }`, then `data-arena-b-done`).
  Read A off the message's `text` parts and B off its `data-arena-b-delta`
  parts.
- **Errors:** a single-slot failure is a `data-arena-error` part
  (`{ slot, message }`); the surviving slot keeps streaming.
- **Vote token:** the `data-arena-meta` part carries `matchupId` **and**
  `matchupToken` (plus `conversationId`, `turnIndex`, and which slot is `main`
  vs `data`) — so the AI SDK path is **votable** without a second channel.
- **Suits:** the React + Vercel AI SDK family — the
  [Vercel AI Chatbot template](https://github.com/vercel/ai-chatbot), Lobe Chat,
  and any `useChat` app. The highest-leverage surface per the
  [integration research](../../artifacts/research/2026-07-15-integration-targets.md).
- **Runnable example:** [`examples/vercel-ai-chatbot/`](../../examples/vercel-ai-chatbot/)
  — a Next.js 16 App Router app whose server route forwards to this adapter and
  pipes the UI Message Stream straight to a stock `useChat` client.

---

## OpenAI-compatible SSE

**Select:** `?protocol=openai` (alias `openai-sse`) or
`Accept: application/vnd.openai.chat-chunk+json`.
**Adapter:** `server/src/adapters/openai-sse.ts`. **Transport:** SSE with
`chat.completion.chunk` frames and a trailing `data: [DONE]` sentinel.

The arena masquerades as a normal OpenAI streaming endpoint so an
OpenAI-compatible chat UI can drive it. The two slots map onto two `choices`
entries of one dual-stream completion (**slot A → `index` 0**, **slot B →
`index` 1**).

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1770000000,"model":"omni-arena","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1770000000,"model":"omni-arena","choices":[{"index":0,"delta":{"content":"He"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1770000000,"model":"omni-arena","choices":[{"index":1,"delta":{"content":"Yo"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1770000000,"model":"omni-arena","choices":[{"index":1,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

- **Model A vs B:** slot A is `choices[0]`, slot B is `choices[1]`; `role:
  "assistant"` on start, `content` deltas per token, `finish_reason: "stop"`
  on `slot_done`. (`matchup_done` emits nothing; the `[DONE]` sentinel closes
  the stream.)
- **Errors:** a single-slot error is surfaced inline as `content` on that
  choice while the other keeps streaming (no dedicated error frame).
- **Vote token:** **not exposed.** The OpenAI chunk schema has no place for it,
  so voting over this protocol requires obtaining the matchup token from another
  channel. This adapter is best where you want arena *streaming* inside an
  existing OpenAI-shaped client and handle voting elsewhere (or not at all).
- **Suits:** the OpenAI-compatible chat-UI "big three" — Open WebUI (the largest
  audience, SvelteKit + FastAPI, reachable only via this adapter), LibreChat, and
  Lobe Chat — plus Chatbot-UI-class frontends. The universal fallback that
  reaches non-React stacks cheaply (see the
  [integration research](../../artifacts/research/2026-07-15-integration-targets.md)).

---

## Reference example apps

Two runnable integrations ship in [`examples/`](../../examples/). Both talk to a
running OmniArena server; for a zero-key local run, start the server with the
deterministic **mock provider** (`ARENA_MOCK_PROVIDER=1` +
`npm run db:seed:mock --workspace server`, provider name `"mock"`). See
[Setup → Mock provider](setup.md).

| Example | Stack | Adapter | Notes |
|---|---|---|---|
| [`examples/vercel-ai-chatbot/`](../../examples/vercel-ai-chatbot/) | Next.js 16 App Router + `@ai-sdk/react` `useChat` | Vercel AI SDK (`?protocol=vercel-ai`) | A server route forwards to OmniArena and pipes the UI Message Stream back; Model A on the main text channel, Model B from `data-arena-b-delta` parts, vote token from `data-arena-meta`. Mirrors wiring arena mode into the Vercel AI Chatbot template. |
| [`examples/assistant-ui/`](../../examples/assistant-ui/) | Vite + React + assistant-ui | Vercel AI SDK via `useAISDKRuntime` (`?protocol=vercel-ai`) | assistant-ui's `<ThreadPrimitive>` renders Model A through its AI SDK runtime; Model B renders alongside from the same `data-arena-b-delta` parts. assistant-ui also ships an AG-UI runtime that consumes the AG-UI adapter. |

Both examples are exercised by the repository e2e suite: `npm run e2e` from the
repo root boots OmniArena with the mock provider (pg-mem) plus both example
servers and drives the full arena flow (stream → vote → reveal) in a headless
Chromium via Playwright (`e2e/`). The suite also asserts the raw `vercel-ai`
and `ag-ui` wire streams over HTTP.

## See also

- [API](api.md) — the full request/response contract for `chat`, `vote`,
  `leaderboard`, and the `control` WebSocket, including the protocol-selection
  table.
- [Architecture → Egress: the protocol-adapter layer](architecture.md) — how
  the single internal stream is fanned out through the `EventAdapter` port.
- [SDK](sdk.md) — the headless `@omni-arena/react` hooks that consume the default
  native SSE stream.
- [Rating methodology](rating-methodology.md) — how the votes these adapters
  collect become a leaderboard.
