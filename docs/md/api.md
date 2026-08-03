# API

Base URL: `http://localhost:3001` (`PORT`). All bodies are JSON. The web dev
server proxies `/api` and `/health` to the API.

Related: [Architecture](architecture.md) · [Integration](integration.md) · [Rating methodology](rating-methodology.md) · [Data model](data-model.md) · [Setup](setup.md) · [SDK](sdk.md)

## No authentication

No endpoint requires an API key, token, or session cookie. The only credential
anywhere in the API is the **matchup token**: an HMAC-signed capability
(`MATCHUP_TOKEN_SECRET`) minted on `matchup_started` and required by
`POST /api/arena/vote`, which is what stops a caller voting on a matchup it
never saw. Everything else — the leaderboard, the model list, the analytics
aggregates — is public, and exposes model-level data only. The two read
endpoints that return a caller's own rounds are the exception to "model-level
only": [`GET /api/arena/matchups/:id`](#get-apiarenamatchupsmatchupid) needs the
round's unguessable UUID and never returns its token, and
[`GET /api/arena/conversations/:id`](#get-apiarenaconversationsconversationid)
is additionally scoped to the anonymous session that owns the conversation.

Browser callers are gated by CORS instead: the server allows exactly one
origin, `WEB_ORIGIN` (default `http://localhost:5173`), and only the `GET` and
`POST` methods. Server-to-server callers are unaffected. See
[Setup](setup.md) for the environment variables.

Every error response body is `{ "error": "<message>" }`. The chat route's
validation `400` additionally carries `details`, zod's field-keyed error map:
`{ "error": "Invalid request", "details": { "prompt": ["…"] } }`. Other routes'
`400`s are the plain one-key shape.

## POST /api/arena/chat

Starts a blind matchup and streams both responses over one SSE connection.

Request:

```json
{
  "prompt": "Explain JWTs in simple terms",
  "sessionId": "anon_123",
  "conversationId": "optional UUID from an earlier matchup_started event",
  "arena": true,
  "joinKey": "chat-7f3a"
}
```

- `prompt` — required, 1–20,000 characters after trimming.
- `sessionId` — optional anonymous session identifier (1–200 characters).
- `conversationId` — optional UUID. Omit it to start a conversation. Supply the
  previous value after a decisive `left`/`right` vote to continue from that
  winning response.
- `arena` — optional. The per-request opt-in read only under
  `ARENA_TRIGGER=manual`, where a request that does not opt in is served as a
  `single` round instead (the `x-arena: on` header does the same job for
  clients that cannot change the body). Ignored under `ARENA_TRIGGER=always`
  and `ARENA_TRIGGER=sampled`. See [arena modes](architecture.md) and
  [Setup → Trigger and exposure](setup.md#trigger-and-exposure).
- `joinKey` — optional (1–200 characters). Opts this request into being served
  as **one half** of a matchup shared with a sibling request — see
  [serving one matchup over two requests](#serving-one-matchup-over-two-requests-joinkey).

Unknown members are ignored rather than rejected, so a client can send extra
fields of its own.

The server loads prior prompts and only the winning response for each completed
turn. Client-provided message history is never accepted. A tie, both-bad, skip,
or unvoted matchup has no single winning response and cannot be continued.

Response: `200` with `content-type: text/event-stream`. Each event has an
`event:` name and a JSON `data:` payload that repeats the type:

| Event | Payload | Notes |
|---|---|---|
| `matchup_started` | `{ type, matchupId, matchupToken?, conversationId?, turnIndex?, slots, mode, votable }` | First event. No model identities. Save `conversationId` for a follow-up. |
| `token` | `{ type, slot, token }` | One token for slot `A` or `B`, interleaved. |
| `slot_error` | `{ type, slot, message }` | That slot failed; the other keeps streaming. |
| `slot_done` | `{ type, slot }` | Content and latency are stripped from the public event. |
| `steered` | `{ type, instruction }` | Mid-stream steer took effect; both slots are about to re-run. Reset slot buffers. |
| `run_error` | `{ type, code, message }` | Terminal: the whole round failed. No `matchup_done` follows. |
| `matchup_done` | `{ type }` | Every slot on this connection finished; stream closes. |

Every response also repeats the round's metadata in an **`x-arena-matchup`**
header — the same JSON as `matchup_started` minus its `type`, on every protocol.
It exists because mainstream agentic runtimes drop the in-band metadata:
assistant-ui's AG-UI aggregator discards `CUSTOM` events wholesale, so on the
convenience path (`useAgUiRuntime({ url })`) the vote token reaches the browser
and dies there. A header is readable by anything that can see the response — a
fetch wrapper, a Next.js route handler, a proxy — with no cooperation from the
runtime that owns the stream. It carries the token when the round has one and
omits it (along with `conversationId` / `turnIndex`) when it does not, exactly
like the event. Browser callers get it through
`Access-Control-Expose-Headers`; a client that only kept a `matchupId` can read
the round back from [`GET /api/arena/matchups/:matchupId`](#get-apiarenamatchupsmatchupid)
instead.

`slots` lists the slots **this connection** streams, and only events for those
slots follow: `["A", "B"]` on a normal matchup, `["A"]` on a `single` or
`shadow` round or on the leader of a
[slot join](#serving-one-matchup-over-two-requests-joinkey), `["B"]` on that
join's sibling. `mode` is `matchup`, `single`, or `shadow` (the last under
`ARENA_EXPOSURE=shadow` — see [Setup → Trigger and
exposure](setup.md#trigger-and-exposure)). `votable` is `true` only for engaged
blind matchups the client may send to `POST /api/arena/vote`; `single` and
`shadow` rounds emit `false` (shadow rows are also rejected at vote time with
`403` even if a token were presented).

### Identifiers are only sent when they can be used

`matchupToken`, `conversationId`, and `turnIndex` on `matchup_started` are
**omitted** — not empty-stringed, not nulled — when the round they describe has
nothing behind them. A `single` round (see [arena modes](architecture.md))
persists no matchup, so there is no token to vote with and no conversation to
continue; sending those ids anyway earned callers a `404 Conversation not found`
on the next turn. A `shadow` round persists the matchup and conversation but
still omits `matchupToken` (`votable: false`); `conversationId` / `turnIndex`
remain. Treat absence as authoritative and pair a missing token with
`votable: false`. A `single` round is also invisible to the rating worker — a
Bradley-Terry fit needs a comparison, and none was recorded (see [rating
methodology → what the engine cannot
rate](rating-methodology.md#what-the-engine-cannot-rate)).

### Serving one matchup over two requests (`joinKey`)

Some chat UIs with a compare view fan a multi-model turn out into **one request
per model** sharing a conversation identifier (Open WebUI v0.10 is the measured
case). Each of those requests has exactly one answer channel, so the default
shape — both slots interleaved on one connection — cannot serve them.

Sending the same `joinKey` on both requests pairs them server-side into **one**
matchup: the first arrival claims slot A, the second slot B, each streams only
its own slot over its own connection, and there is one `matchups` row and one
vote. Matchmaking, blindness, conversation handling, and persistence all happen
once, on the first request's path — which also means slot B still completes and
is still recorded if the sibling disconnects. Both connections receive the same
`matchupId`, `matchupToken`, `conversationId`, and `turnIndex`, so either one
can cast the (single) vote.

- A join is scoped to the **anonymous session + conversation + exact prompt**,
  not to the `joinKey` alone, so knowing another caller's key buys nothing:
  a mismatch on any of those simply produces a separate matchup.
- `joinKey` therefore **requires** `sessionId` (`400 join_requires_session`).
- The rendezvous window is `ARENA_JOIN_WINDOW_MS` (default 2000). If it closes
  with no sibling, the round degrades to exactly the default shape — both slots
  on that one connection, `slots: ["A", "B"]`, votable — so nothing is wasted.
  `ARENA_JOIN_WINDOW_MS=0` disables joining entirely and a `joinKey` is then
  ignored. At most `ARENA_JOIN_MAX_PENDING` (default 256) unpaired scopes are
  tracked.
- The field is absent on every existing client, so the single-connection
  two-slot flow is untouched.
- `joinKey` rides each protocol's own extension slot too (`forwardedProps` for
  AG-UI, `omni_arena` for OpenAI, the top level for `useChat`), so a compare
  view speaking a stock protocol can use it — see the
  [integration guide](integration.md#which-protocols-accept-their-own-request-body).

Errors before streaming. A JSON response carries only `{ "error": "<message>" }`
(plus `details` on a validation `400`); the `code` column is the
machine-readable reason the in-band protocols carry instead — see the AG-UI
exception below.

| Status | `code` | Meaning |
|---|---|---|
| `400` | `invalid_request` | Invalid request body |
| `400` | `join_requires_session` | `joinKey` sent without `sessionId` |
| `403` | `conversation_forbidden` | `sessionId` does not own the requested conversation |
| `404` | `conversation_not_found` | Unknown `conversationId` |
| `409` | `conversation_not_ready` | The prior turn has no decisive vote |
| `409` | `conversation_conflict` | Another request already advanced the conversation |
| `409` | `join_slots_exhausted` | Both slots of this join scope are already claimed |
| `409` | `join_expired` | The join window closed before this request arrived |
| `500` | `default_model_missing` | `ARENA_DEFAULT_MODEL` is not in the enabled roster (`single` / `shadow` rounds) |
| `500` | `shadow_challenger_missing` | Matchmaker could not pick a challenger ≠ `ARENA_DEFAULT_MODEL` (`shadow` only) |
| `500` | `join_failed` | The request holding the shared matchup failed for an unclassified reason |
| `503` | `join_unavailable` | Too many unpaired joins in flight; retry without `joinKey` |
| `504` | `join_leader_timeout` | The request holding the shared matchup never started it |

A failure on the request that owns a shared matchup is forwarded to its
sibling, so both halves of one turn fail identically instead of leaving one
parked on a matchup that was never created.

**Exception — AG-UI.** An AG-UI client settles a run on the taxonomy's terminal
`RUN_ERROR` event and treats a non-2xx response as a dead transport with nothing
to render, so for `?protocol=ag-ui` these failures are delivered **in-band**: a
`200` stream whose single event is `RUN_ERROR` carrying the same message plus
the `code` from the table above. Every other protocol keeps the status codes.

A failure **after** streaming has started cannot use a status code at all: the
response is already committed at `200`. Those arrive as a terminal `run_error`
(`stream_failed`) in whichever protocol's idiom is in use, so a client settles
instead of waiting for a `matchup_done` that will never come.

### Protocol selection

The same matchup stream can be framed in five wire protocols. Selection precedence:

1. `?protocol=` query parameter (case-insensitive alias).
2. The request `Accept` header media type.
3. Default: **native SSE**.

An unknown `?protocol=` value falls back to native SSE, so a bad value never
breaks the default path. Native SSE is byte-for-byte unchanged, so existing
clients (including the demo and the SDK) are unaffected — the table above still
describes the default stream.

| Protocol | `?protocol=` aliases | `Accept` media type(s) | Response `content-type` |
|---|---|---|---|
| Native SSE *(default)* | `sse`, `native`, `native-sse` | `text/event-stream` | `text/event-stream` |
| AG-UI | `agui`, `ag-ui` | `application/vnd.ag-ui+json` | `text/event-stream` |
| A2UI | `a2ui` | `application/vnd.a2ui+json`, `application/x-ndjson` | `application/x-ndjson` |
| Vercel AI SDK | `vercel`, `vercel-ai`, `ai-sdk` | `application/vnd.vercel.ai.ui-message-stream+json` | `text/event-stream` (+ `x-vercel-ai-ui-message-stream: v1`) |
| OpenAI SSE | `openai`, `openai-sse` | `application/vnd.openai.chat-chunk+json` | `text/event-stream` |

The **internal event semantics are identical across protocols** — the same
`matchup_started` / `token` / `slot_error` / `slot_done` / `run_error` /
`matchup_done` sequence over the same two slots (A, B). Only the framing
differs, and every frame is schema-validated at the transport boundary before it
is written.

Three adapters are **bidirectional**: AG-UI accepts a canonical `RunAgentInput`,
the OpenAI adapter a standard `/chat/completions` body, and the Vercel adapter the
body `useChat` posts — so a stock client of those protocols can call the endpoint
with no translating transport. OmniArena's own body above keeps working on every
protocol; the two shapes are told apart by whether the body carries a `messages`
array. Native SSE and A2UI accept OmniArena's body only. Per-protocol details —
where `sessionId`, `conversationId`, and the `arena` opt-in ride, and what is
ignored — are in the
[integration guide](integration.md#which-protocols-accept-their-own-request-body).

The arena is additionally served at **`POST /chat/completions`** and
**`POST /v1/chat/completions`** with the OpenAI protocol implied by the path,
since an OpenAI client appends that path to a base URL and cannot pass
`?protocol=`. A matchup is two live streams with no buffered
`chat.completion` object to return, so `"stream": false` is refused with a
`400` naming the field rather than answered with a stream the client will not
read; omit `stream` or set it to `true`. Sampling knobs (`temperature`,
`max_tokens`, `tools`, …) are accepted and ignored — the arena chooses the
models and the sampling — and `user` seeds `sessionId`.

Per-protocol framing, at a conceptual level:

- **Native SSE** (default, unchanged): `event:`/`data:` pairs, one per event;
  no trailing sentinel. This is the event table above.
- **AG-UI**: typed AG-UI events, one `data:` line each, over SSE. `matchup_started`
  → `RUN_STARTED`, then a `CUSTOM` event named `arena_matchup` carrying the
  matchup metadata, then one `TEXT_MESSAGE_START` per slot (role `assistant`,
  tagged `slot` A/B); `token` → `TEXT_MESSAGE_CONTENT` (`delta`, `slot`);
  `slot_error` → `CUSTOM` named `slot_error` (`{ slot, message }`, so the
  surviving slot keeps streaming, plus the same text as marked
  `TEXT_MESSAGE_CONTENT` so a runtime that ignores `CUSTOM` still shows the
  failure); `slot_done` → `TEXT_MESSAGE_END`; `run_error` → `RUN_ERROR`
  (`message`, `code`); `matchup_done` → `RUN_FINISHED`. `threadId` and `runId`
  are the client's own when its `RunAgentInput` carried them — AG-UI's contract
  is that a server echoes them, and clients key run state off them — falling
  back to the conversation id (then the matchup id) and the matchup id
  respectively. The slot channel is unaffected: `messageId` is always
  `<matchupId>:<slot>`, which is what a consumer parses the slot out of.
- **A2UI**: schema-validated **NDJSON** (`application/x-ndjson`) — one flat,
  self-describing JSON object per line, versioned `a2ui/1`, painting two
  surfaces A/B. `surface_init` (`matchupId`, `matchupToken`, `conversationId`,
  `turnIndex`, `surfaces`, `mode`, `votable`) → `text_append` (`surface`,
  `text`) → `error` (`surface`, `message`) → `surface_done` (`surface`) →
  `session_done`, with a terminal `run_error` becoming `session_error`
  (`code`, `message`).
- **Vercel AI SDK**: the AI SDK **UI Message Stream** (header
  `x-vercel-ai-ui-message-stream: v1`) over SSE. Slot A rides the primary text
  channel (`start` → `data-arena-meta` → `text-start` → `text-delta` →
  `text-end`); the `data-arena-meta` part also carries the round's `mode` and
  `votable` flags; slot B is multiplexed through custom data parts
  (`data-arena-b-delta` / `data-arena-b-done`); a single-slot failure is a
  `data-arena-error` part and a terminal `run_error` an `error` part; the run
  ends with `finish` and a trailing `data: [DONE]` sentinel.
- **OpenAI SSE**: `chat.completion.chunk` frames so an OpenAI-style client can
  drive the arena. **Every** frame carries one choice per active slot in slot
  order, so on a two-slot round `choices[0]` is always slot A and `choices[1]`
  always slot B: real clients read `choices[0]` positionally rather than
  demultiplexing on `index`, and one-choice-per-frame framing spliced both
  models into one incoherent message. A slot with nothing to say in a frame
  gets an empty `delta`, and a finished slot keeps its `finish_reason: "stop"`
  in later frames rather than retracting it. On a one-slot round (`single`, or
  one half of a slot join) that slot is the only choice, still carrying its own
  `index` (`0` for A, `1` for B) — so a positional reader gets that slot's text
  either way. The first chunk also carries an optional top-level `omni_arena`
  object with the matchup metadata (including `conversationId` / `turnIndex`,
  so multi-turn works here too), a failed slot adds `omni_arena_error`, and a
  terminal `run_error` becomes an `{ "error": { message, type, code } }` frame.
  Ends with a trailing `data: [DONE]` sentinel.

The [`@omni-arena/react`](sdk.md) SDK and the demo app consume the default
native SSE stream. For a per-protocol walkthrough — concrete wire examples, how
Model A vs B is carried, how to vote, which stacks each suits, and the two
shipped example apps — see the [integration guide](integration.md).

**Every protocol carries the vote token** when there is one, each in its own
idiom, so no path needs a second channel to vote: native SSE on
`matchup_started`, the Vercel AI SDK in the `data-arena-meta` part, A2UI on
`surface_init`, AG-UI in a `CUSTOM` event named `arena_matchup`, and OpenAI SSE
in an optional `omni_arena` object on the first chunk. All five also carry `mode`
and `votable` and all five omit the token on a non-votable (`single`) round, so a
client can hide the vote controls. Every one of them additionally repeats the
metadata in the `x-arena-matchup` header, which is the path of last resort for a
runtime that discards the in-band copy. See the
[integration guide](integration.md).

## GET /api/arena/control (WebSocket)

The **control plane**: a bidirectional WebSocket that acts on an in-flight
matchup out-of-band from the token stream. Connect a WebSocket to
`/api/arena/control`; messages are JSON in both directions.

**`stop`** — abort an in-flight matchup:

```json
{ "type": "stop", "matchupId": "<uuid>" }
```

Aborts the matchup's stream via the matchup registry's `AbortController`
(the `AbortSignal` is threaded through `ArenaCore.stream`). Reply:

```json
{ "type": "stopped", "matchupId": "<uuid>", "ok": true }
```

`ok` is `false` when the matchup is unknown — never started, already finished,
or already stopped.

`@omni-arena/react` wraps this as `stop()` on `useArenaChat`: it derives the
`ws://`/`wss://` URL from the hook's `baseUrl`, opens the socket on first use,
and closes it on the `stopped` reply or on unmount.

**`steer`** — mid-stream steering (abort-and-restart):

```json
{ "type": "steer", "matchupId": "<uuid>", "instruction": "be more concise" }
```

Delivers the instruction to the running matchup via `MatchupRegistry.steer`.
When accepted, `ArenaCore` cancels the current generation (without closing the
HTTP stream), emits a public `steered` event, and re-runs **both** slots with
the identical instruction appended as a `system` operator turn so the comparison
stays blind. The instruction is also appended to `matchups.steers` for later
analysis. Reply:

```json
{ "type": "steer_ack", "matchupId": "<uuid>", "accepted": true }
```

`accepted` is `false` (with a `reason`) when the matchup is unknown/expired, not
yet accepting steer, or has already completed a slot — never when steering is
merely "unimplemented".

`stop` semantics are unchanged: a stop still aborts the whole stream via the
registry's `AbortController`.
Errors: invalid JSON returns `{ "type": "error", "message": "Invalid JSON control message" }`;
an unknown or malformed message (including a `matchupId` that is not a UUID)
returns `{ "type": "error", "message": "Unknown or malformed control message" }`.

## POST /api/arena/vote

Records one vote and reveals model identities.

Request:

```json
{
  "matchupId": "3f6e...",
  "matchupToken": "eyJt....sig",
  "vote": "left"
}
```

`vote` is one of `left`, `right`, `both_good`, `both_bad`, `skip`.

`matchupToken` is the value from `matchup_started`: a `payload.signature` pair
(base64url JSON claims, HMAC-SHA256 over them) whose SHA-256 hash is stored on
the matchup row, so a token has to be both well-signed and the one this matchup
was served with. It expires **15 minutes** after issue — a vote cast later gets
a `401`.

Success response:

```json
{
  "accepted": true,
  "models": {
    "A": { "id": "…", "displayName": "Gemini 3.5 Flash" },
    "B": { "id": "…", "displayName": "Gemini 3 Flash" }
  },
  "continuable": true,
  "conversationId": "…"
}
```

`continuable` is the server's own answer to "may the next turn pass this
`conversationId`?" — true for `left`/`right`, false for `both_good`,
`both_bad`, and `skip`. It is stated rather than implied because every client
otherwise re-encoded the rule by hand and paid for a wrong guess with a `409
conversation_not_ready` on the following turn. `conversationId` is echoed so a
client that only kept the matchup handles knows what to send back.

Errors:

| Status | Meaning |
|---|---|
| `400` | Invalid body — `matchupId` must be a UUID and `vote` one of the five values above |
| `401` | Bad signature, expired token, or claims that don't match the stored matchup (its id or either slot's model) |
| `403` | Shadow matchups are not votable (`matchups.mode='shadow'`; human votes are rejected) |
| `404` | Unknown `matchupId` |
| `409` | A vote was already recorded for this matchup |

A `left`/`right` vote records the winning model; `both_good`, `both_bad`, and
`skip` record no winner, which is also why only a decisive vote lets a
conversation continue. The anonymous session credited with the vote comes from
the token's claims, not the request body.

## GET /api/arena/matchups/:matchupId

Reads one round back out of band: its shape, whether it is still open, and —
only against a recorded vote — the identities. This is what a client uses when
its runtime dropped the stream's metadata (AG-UI `CUSTOM` events) or when a
reload left it holding nothing but a `matchupId` parsed out of a `messageId`.

```json
{
  "matchupId": "3f6e…",
  "conversationId": "…",
  "turnIndex": 0,
  "mode": "matchup",
  "votable": false,
  "continuable": true,
  "vote": "left",
  "models": {
    "A": { "id": "…", "displayName": "Gemini 3.5 Flash" },
    "B": { "id": "…", "displayName": "Gemini 3 Flash" }
  }
}
```

- `votable` is `true` until a vote is recorded; `vote` is `null` for the same
  span and `models` is `null` with it — the blindness rule, enforced on every
  read path, is that identities travel only with a vote.
- `continuable` follows the same `left`/`right` rule as the vote response.
- `mode` on this read path is always the wire value `matchup` (including rows
  whose DB `matchups.mode` is `shadow`). A `single` round writes no row and is
  therefore never readable here (`404`). The stream's `matchup_started` still
  reports `mode: "shadow"` for shadow rounds; use that (or the DB column) when
  you need the exposure axis.
- **No `matchupToken`.** The token is the capability that authorises a vote,
  minted once onto the stream that served the round. An unauthenticated read
  that returned it would let anyone holding a matchup id vote on a round they
  never saw.

Errors: `400` for a `matchupId` that is not a UUID, `404` for an unknown one.

## GET /api/arena/conversations/:conversationId

Rehydrates a whole thread after a reload — every turn, both blind answers per
turn, the vote, and the reveal where one exists. Without it a host either lost
the thread on refresh or rebuilt it from client-only state it had invented.

Query: `sessionId` (optional, 1–200 characters).

```json
{
  "conversationId": "…",
  "continuable": false,
  "nextTurnIndex": 2,
  "turns": [
    {
      "turnIndex": 0,
      "matchupId": "…",
      "prompt": "Explain JWTs in simple terms",
      "votable": false,
      "vote": "left",
      "answers": [
        { "slot": "A", "content": "…", "error": null },
        { "slot": "B", "content": "…", "error": null }
      ],
      "models": {
        "A": { "id": "…", "displayName": "Gemini 3.5 Flash" },
        "B": { "id": "…", "displayName": "Gemini 3 Flash" }
      }
    },
    {
      "turnIndex": 1,
      "matchupId": "…",
      "prompt": "Go deeper",
      "votable": true,
      "vote": null,
      "answers": [
        { "slot": "A", "content": "…", "error": null },
        { "slot": "B", "content": "…", "error": null }
      ],
      "models": null
    }
  ]
}
```

- The **last turn comes back even when it has no vote**: a pending pair
  awaiting a decision is precisely the state a reload has to restore. Its
  `models` is `null`, so restoring the thread cannot leak the round it is still
  blind on.
- `continuable` and `nextTurnIndex` describe the *next* turn: whether it may
  pass this `conversationId` at all, and the index it will be given.
- Unlike the leaderboard and the analytics aggregates, this read returns a
  caller's own prompts and answers, so it is **scoped to the anonymous
  session** that owns the conversation — the same check
  [`POST /api/arena/chat`](#post-apiarenachat) makes before continuing one. A
  conversation started without a `sessionId` is readable without one.

Errors: `400` (malformed id or `sessionId`), `403` `Conversation session
mismatch`, `404` `Conversation not found`.

## GET /models · GET /v1/models

The enabled roster in OpenAI's model-list shape, for the OpenAI-compatible
clients the [OpenAI SSE adapter](integration.md) exists to serve. Open WebUI
probes `GET {base}/models` on connect and shows an empty model picker without it.

```json
{
  "object": "list",
  "data": [
    {
      "id": "8b0f…",
      "object": "model",
      "created": 1770000000,
      "owned_by": "google",
      "name": "Gemini 3.5 Flash"
    }
  ]
}
```

`id` is OmniArena's model id — the same id the
[leaderboard](#get-apiarenaleaderboard) and the vote reveal use. `name` is a
non-standard extension Open WebUI renders when present; OpenAI clients that don't
know it ignore it. Listing the roster reveals no secret: the leaderboard is
already public, and what stays hidden is which two models a given round used.

`created` is the server's boot time — the roster has no creation timestamp of
its own and OpenAI's model object requires one. `owned_by` is the model's
provider key (`google`, `openai`, `mock`, …). Both paths are served because a
deployment may configure the arena's base URL with or without the `/v1` prefix.

Naming a model in a chat request body does nothing — matchmaking picks both
slots — so there is no `GET /models/{id}`. The chat-completions surface those
clients need is
[`POST /chat/completions` · `POST /v1/chat/completions`](#post-apiarenachat).

### Unmatched paths

An unmatched `GET` is answered with `index.html` only when a built web bundle is
being served **and** the path does not look like an API path (`/api/*`,
`/health`, `/v1/*`, `/models`, `/chat/completions`, `/completions`,
`/embeddings`). Those get a JSON `404` instead, because a missing route answered
as HTML at `200` reads to a client as a mimetype bug rather than a 404.

## GET /api/arena/leaderboard

Returns win/loss/tie counts, win rate, and (when the rating worker has run)
Bradley-Terry ratings per enabled model, plus the context needed to read those
ratings honestly. Only enabled models appear. Models are ordered by `rating`
(nulls last), then `wins`, then `totalVotes`, then `displayName`.

```json
{
  "components": {
    "count": 1,
    "groups": [{ "componentId": 0, "models": 4 }]
  },
  "styleControl": {
    "effects": [
      {
        "feature": "position",
        "logOdds": 0.05,
        "points": 8.7,
        "basis": "absolute",
        "perUnit": null
      },
      {
        "feature": "verbosity",
        "logOdds": 0.1,
        "points": 17.4,
        "basis": "per_std_dev",
        "perUnit": { "points": 34.7, "unit": "100 output tokens" }
      }
    ],
    "votesObserved": 412,
    "computedAt": "2026-07-24T09:00:00.000Z"
  },
  "models": [
    {
      "id": "…",
      "displayName": "Gemini 3.5 Flash",
      "wins": 12,
      "losses": 8,
      "ties": 3,
      "skips": 1,
      "totalVotes": 24,
      "winRate": 0.5217,
      "rating": 1184.3,
      "ratingStdError": 41.7,
      "confidenceInterval": { "lower": 1102.6, "upper": 1266.0 },
      "componentId": 0,
      "styleControlledRating": 1147.9,
      "styleControlledStdError": 44.2,
      "styleControlledConfidenceInterval": { "lower": 1061.3, "upper": 1234.5 }
    }
  ]
}
```

`winRate = wins / (wins + losses + ties)`; skips are excluded from the
denominator, and the value is `0` when that denominator is zero. The win-rate
fields are always present. `totalVotes` counts every vote — skips included — on
matchups the model appeared in; see [rating methodology → where the
leaderboard's counts come
from](rating-methodology.md#where-the-leaderboards-counts-come-from).

The rating fields are populated by the Python rating worker (`worker/`):

| Field | Meaning |
|---|---|
| `rating` | Bradley-Terry rating on an Elo-like scale (`1000 + (400/ln10)·r`) |
| `ratingStdError` | Standard error of the rating (same scale) |
| `confidenceInterval` | 95% CI `{ lower, upper }` from Fisher information |
| `componentId` | Connected-component id; ratings only comparable within a component |
| `styleControlledRating` | Bradley-Terry rating with verbosity/formatting/latency/position confounders regressed out jointly, from the worker's heavier style pass |
| `styleControlledStdError` | Standard error of the style-controlled rating (same scale) |
| `styleControlledConfidenceInterval` | 95% CI `{ lower, upper }` for the style-controlled rating |

The `rating*`/`componentId` fields are `null` until the default worker pass has
rated the model; the `styleControlled*` fields are `null` until the heavier
style pass has run. They also stay `null` for a model the worker has no
comparisons for: a model only ever served on non-votable (`single`) rounds is
never compared, so it remains unrated however much traffic it answers. Clients
must treat all of them as optional and keep using `winRate` as a fallback. See
the [rating methodology](rating-methodology.md) for how these numbers are
computed and [what the engine cannot
rate](rating-methodology.md#what-the-engine-cannot-rate).

### `components` — is the leaderboard comparable at all?

Bradley-Terry ratings are identified only up to an additive constant *per
connected component* of the comparison graph, so ratings from different
components sit on unrelated scales and must never be compared.

| Field | Meaning |
|---|---|
| `count` | Components spanned by the rated roster, or `null` before the worker has run |
| `groups` | `{ componentId, models }` per component, ascending by id; `models` counts rated models |

`count: 1` is the healthy case. Anything higher means the matchmaker has not yet
played games bridging the groups, and a client showing the ratings should say so
(the demo UI labels each row with its group and shows a banner).

### `styleControl` — what superficial style is worth

The worker fits voter biases as covariates *inside* the Bradley-Terry regression
(see [rating-methodology.md](rating-methodology.md)) and stores them in `style_control_coefficients`. `effects` restates
each one in leaderboard points, ordered as the worker fits them: `position`,
`verbosity`, `formatting`, `latency_ttft`, `latency_duration`.

| Field | Meaning |
|---|---|
| `logOdds` | The fitted coefficient exactly as stored |
| `points` | `logOdds` on the rating scale (`(400/ln10)·logOdds`) — read it per `basis` |
| `basis` | `absolute` for constant covariates (`position`, i.e. the outright left-slot advantage) or `per_std_dev` for the standardised per-vote deltas |
| `perUnit` | `{ points, unit }` restating the effect per readable amount of the raw feature, e.g. `100 output tokens`; `null` when it cannot be derived |
| `votesObserved` | Votes whose deltas backed the `perUnit` conversion |
| `computedAt` | When the worker last wrote the coefficients; `null` when it never has |

A positive value favours the response with more of the trait: `+34.7 points per
100 output tokens` means 100 extra tokens buy as much apparent strength as a
34.7-point rating gap. The `unit` each feature is restated in:

| `feature` | `basis` | `perUnit.unit` |
|---|---|---|
| `position` | `absolute` | — (`perUnit` is always `null`) |
| `verbosity` | `per_std_dev` | `100 output tokens` |
| `formatting` | `per_std_dev` | `0.1 markdown density` |
| `latency_ttft` | `per_std_dev` | `100 ms of TTFT` |
| `latency_duration` | `per_std_dev` | `second of streaming` |

A feature the worker adds later that the server has no unit for is still
returned, with `basis: "per_std_dev"`, `perUnit: null`, and ordered last.

`perUnit` needs one caveat. The worker z-scales its continuous covariates before
fitting and does not persist the scale, so the stored coefficient is per standard
deviation of the vote-level delta. The server recovers that standard deviation
from today's non-skip votes to produce `perUnit`. That sample is a superset of
the worker's whenever its anomaly screen excluded sessions or a model was later
disabled, so `logOdds`/`points` are exact while `perUnit` is indicative and will
drift as votes accumulate. `perUnit` is `null` for `position` (no underlying
unit) and whenever the deltas have no spread to un-standardise with.

`effects` is `[]` and `votesObserved` is `0` on a fresh install; `components.count`
is `null`. Both keys are always present.

## GET /api/arena/analytics/*

Read-only aggregates behind the insights dashboard (`/insights` in the demo
UI). Like the leaderboard, these endpoints expose **model-level aggregates
only** — no per-user or per-session data — and carry no auth, matching the
leaderboard. All are implemented by `AnalyticsPort` on `PostgresRepository` and
registered in `server/src/routes/analytics.ts`. The shipped server always wires
that port; an embedding host that omits it gets a `404` on this whole prefix
rather than a half-working dashboard.

### GET /api/arena/analytics/summary

Arena-wide health numbers:

```json
{
  "totalMatchups": 48,
  "totalVotes": 44,
  "decisiveVotes": 35,
  "tieVotes": 8,
  "skipVotes": 1,
  "slotAWins": 18,
  "slotBWins": 17,
  "enabledModels": 5,
  "pairsSampled": 10,
  "pairsPossible": 10,
  "ratingComponents": 1
}
```

- `slotAWins` / `slotBWins` split decisive votes by which **UI slot** won —
  `slotAWins / (slotAWins + slotBWins)` far from 0.5 is global position bias.
- `pairsSampled` counts distinct canonical model pairs with at least one
  non-skip vote; `pairsPossible` is `n·(n−1)/2` over the enabled roster.
- `ratingComponents` counts distinct `component_id`s in `model_ratings`, `null`
  before the worker has run. It spans every rated model, where the
  leaderboard's `components.count` covers the enabled roster only, so the two
  can differ after a model is disabled.

### GET /api/arena/analytics/head-to-head

Per canonical (unordered) pair record. Pairs the matchmaker has never sampled
are simply absent.

```json
{
  "models": [{ "id": "…", "displayName": "Gemini 3.5 Flash" }],
  "pairs": [
    { "modelAId": "…", "modelBId": "…", "aWins": 4, "bWins": 2, "ties": 1, "games": 7 }
  ]
}
```

`modelAId` is always the lexicographically smaller id; `ties` counts
`both_good` + `both_bad`; `games = aWins + bWins + ties` (skips excluded).

### GET /api/arena/analytics/model-metrics

Per enabled model: response pace/verbosity/formatting profile plus the win
record split by display slot.

```json
{
  "models": [
    {
      "id": "…",
      "displayName": "Gemini 3.5 Flash",
      "responses": 19,
      "ttftMsP50": 320, "ttftMsP90": 610,
      "durationMsP50": 4100, "durationMsP90": 7900,
      "meanOutputTokens": 412.3,
      "meanMarkdownDensity": 0.34,
      "slotAWins": 6, "slotAGames": 9,
      "slotBWins": 5, "slotBGames": 10
    }
  ]
}
```

Only error-free responses count; the pace fields are `null` until the model has
at least one. Percentiles are computed server-side (linear interpolation).

### GET /api/arena/analytics/activity?bucket=day|hour

Vote volume and sampling progress over time. `bucket` defaults to `day`; any
other value is a `400`.

```json
{
  "bucket": "day",
  "models": [{ "id": "…", "displayName": "…" }],
  "votes": [
    { "bucketStart": "2026-07-21T00:00:00.000Z",
      "left": 5, "right": 3, "bothGood": 1, "bothBad": 1, "skip": 0, "total": 10 }
  ],
  "cumulativeGames": [
    { "bucketStart": "2026-07-21T00:00:00.000Z", "games": { "<modelId>": 12 } }
  ]
}
```

`cumulativeGames` is a running total of non-skip games per model at the end of
each bucket (buckets are UTC).

### GET /api/arena/analytics/style-control

The raw fitted style coefficients plus each model rated by **both** worker
passes:

```json
{
  "coefficients": [
    { "feature": "verbosity", "coefficient": 0.284, "computedAt": "…" }
  ],
  "models": [
    { "id": "…", "displayName": "…", "rating": 1184.3, "styleControlledRating": 1147.9 }
  ]
}
```

This returns the `style_control_coefficients` rows as stored
(standardized-feature scale). For the reader-friendly points-per-unit
interpretation, use the leaderboard's `styleControl` block above.

### GET /api/arena/analytics/rating-history?since=<ISO 8601>

Append-only rating snapshots, one per model per worker refit, from
`model_rating_history` — this is what the rating-over-time chart reads.
`since` (optional) filters to snapshots at or after that instant and must be an
ISO 8601 timestamp **with a timezone** (`2026-07-01T00:00:00Z`); anything else
is a `400`.

```json
{
  "models": [{ "id": "…", "displayName": "…" }],
  "points": [
    { "modelId": "…", "rating": 1102.4, "ciLower": 1010.1, "ciUpper": 1194.7,
      "games": 12, "computedAt": "2026-07-21T09:00:00.000Z" }
  ]
}
```

Points are ordered by `computedAt`, then model id; every row written by one
refit shares a `computedAt`. `models` is the current enabled roster (a
convenience for labelling the series), so it may name models with no points yet
and omit a disabled model that older points still reference. The list is empty
until the worker's first refit after migration `005_rating_history.sql`. See
[rating methodology → rating history](rating-methodology.md#rating-history).

## GET /health

Returns `{ "status": "ok" }`. Used by tooling and the dev proxy.
