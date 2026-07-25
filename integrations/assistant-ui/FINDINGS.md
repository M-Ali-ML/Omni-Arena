# What driving a real AG-UI client at OmniArena turned up

Everything below came out of wiring `examples/with-ag-ui` from the upstream
assistant-ui monorepo (commit `a3bb2e31`, `@assistant-ui/react-ag-ui` 0.0.45,
`@ag-ui/client` 0.0.57) at `/api/arena/chat?protocol=ag-ui`, plus a headless
`@ag-ui/client` probe (`tools/agui-probe.ts`). Reproductions assume the mock
harness on port 3011 (`npm run arena`).

Each item is written as it was observed, before anything was changed.

> **Since then, findings 1, 2, 5, 6, 8, 9 and 11 have been fixed** — 1, 2, 5, 6, 8
> and 11 in `server/` (and 6 and 9 in `packages/react-sdk` too). Finding 1: the
> AG-UI path accepts a stock `RunAgentInput` via `agUiRequestAdapter` — prompt
> from the last user message, arena inputs from `forwardedProps` — so the envelope
> no longer has to be translated client-side; `threadId` is deliberately *not*
> mapped onto `conversationId` (clients mint their own thread ids, and that
> mapping would 404 every first turn). Finding 9: `@omni-arena/react` now ships
> the protocol-agnostic core the finding asked for (`getSessionId`, `useArenaVote`,
> reveal types, plus `protocol` / `session` / `stream` / `vote` modules);
> `useArenaChat` itself still owns a native-SSE message state machine and is not
> a drop-in for a third-party runtime, but the package is no longer unusable
> beside one. AG-UI now emits `RUN_ERROR` — including for pre-stream failures,
> which arrive in-band at 200 because a non-2xx is a dead transport to an AG-UI
> client; a dead slot also arrives as text prefixed `[omni-arena:slot-error]`,
> since mainstream runtimes discard `CUSTOM`; a non-votable round omits
> `matchupToken` / `conversationId` / `turnIndex` instead of shipping empty or
> unusable ones. Finding 8 is only half-fixed: the `409` continuation refusal now
> arrives as a `RUN_ERROR` with the machine-readable code
> `conversation_not_ready`, but no `continuable` flag was added, so the
> "left|right ⇒ decisive" rule is still the client's to encode. Finding 11 is
> fixed outright: the mock provider's answer text is identity-free, and
> `server/src/blindness.test.ts` guards it. This integration's overlay,
> `tests/protocol.spec.ts` and `tests/arena.spec.ts` were updated accordingly.
> Findings 3, 4, 7 and 10 stand.

**Headline:** the adapter's *output* is good. Two concurrent slot messages in one
run pass `@ag-ui/client`'s event verifier unmodified, reach `RUN_FINISHED`, and
land in assistant-ui as one assistant message with two text parts — the blind
side-by-side arena maps onto AG-UI cleanly, which was the open question. The
ingress half of finding 1 is fixed; what remains on the input path is getting
arena props into a run that `useAgUiRuntime` builds itself, and the metadata
channel (finding 4) is still the load-bearing gap for voting.

---

## 1. The adapter is output-only: no AG-UI client can call it (resolved)

`?protocol=ag-ui` changes how the response is framed but not what the request
must look like. The route still requires OmniArena's own body
(`server/src/routes/chat.ts`: `prompt`, `sessionId`, `conversationId`), so the
canonical AG-UI request — `RunAgentInput` — is rejected:

```bash
curl -s -X POST "http://127.0.0.1:3011/api/arena/chat?protocol=ag-ui" \
  -H 'content-type: application/json' \
  -d '{"threadId":"t1","runId":"r1","state":{},"messages":[{"id":"m1","role":"user","content":"hello"}],"tools":[],"context":[],"forwardedProps":{}}'
# 400 {"error":"Invalid request","details":{"prompt":["Invalid input: expected string, received undefined"]}}
```

Consequence: `new HttpAgent({ url })` — the two-line integration every AG-UI doc
shows, and the one `useAGUIRuntime({ url })` performs for you — cannot talk to
OmniArena. Neither can CopilotKit's or LangGraph's AG-UI transports, which build
the same body. Every consumer must subclass the agent and translate
(`overlay/examples/with-ag-ui/lib/arena/agent.ts`), which also means re-deriving
"the prompt" from the message list and re-inventing where `conversationId` and
the arena opt-in live (we put them in `forwardedProps`-equivalent client state
and an `x-arena` header).

`docs/md/integration.md` says the adapter "suits agentic frontends that speak
AG-UI — CopilotKit, LangGraph, CrewAI, and assistant-ui's first-party
`@assistant-ui/react-ag-ui` runtime". As written that is not true out of the box;
none of them can post a body OmniArena accepts.

**Suggested fix:** when the selected protocol is AG-UI, accept `RunAgentInput`
as an alternative body shape — last user message → `prompt`, `threadId` →
`conversationId`, `forwardedProps.sessionId` / `forwardedProps.arena` → session
and trigger opt-in. That single change turns the adapter from "an SSE format we
emit" into "an AG-UI agent", and makes `useAGUIRuntime({ url: "…?protocol=ag-ui" })`
work with zero custom code. Failing that, the docs should state plainly that the
AG-UI path requires a custom transport and show the ~25 lines it takes.

> **Resolved in `server/`** (with one deliberate divergence from the suggested
> fix). `agUiRequestAdapter` in `server/src/adapters/ag-ui.ts` accepts
> `RunAgentInput`: last user message → `prompt`, arena inputs
> (`sessionId` / `conversationId` / `arena`) from `forwardedProps`. It does *not*
> map `threadId` onto `conversationId` — clients mint their own thread ids
> (assistant-ui mints a UUID), and treating one as an arena conversation would
> 404 every stock client's first turn (`adapters.test.ts`: "never reads a
> client-minted threadId as a conversation id"). The envelope no longer has to
> be translated client-side. What this integration's `ArenaHttpAgent` subclass is
> still for is getting those per-request inputs *into* the run: `useAgUiRuntime`
> builds `RunAgentInput` itself and fills `forwardedProps` only from its own
> model context (`callSettings` / `config` / `runConfig.custom`), and there is no
> hook for a request header. Overriding `requestInit` is where the app attaches
> the thread's session id, continuation `conversationId`, arena opt-in and the
> `x-arena` header. So a stock `new HttpAgent({ url })` with empty
> `forwardedProps` can start a first turn; arena session / continuation /
> trigger still need a thin agent (or equivalent) to populate `forwardedProps`
> and headers.

## 2. `RUN_ERROR` is never emitted; failures leave AG-UI clients hanging

`server/src/adapters/ag-ui.ts` has no `RUN_ERROR` in its event union, and the
route's error paths all return JSON with a non-200 status *before* hijacking the
socket:

- `400` invalid body, `404` unknown conversation, `403` session mismatch,
- `409` `"Vote for a winning response before continuing this conversation"`
  (what you get for continuing after a tie/skip), `409` conversation conflict.

An AG-UI client sees a fetch-level failure, not a protocol event, so the runtime
has nothing to render and the pending message can be left mid-run. Worse,
`chat.ts` writes `matchup_started` *before* streaming and then ends the response
in a `finally` — if `core.stream()` or `saveResponse()` throws mid-run, the
stream ends after `RUN_STARTED` with **no** `RUN_FINISHED` and no `RUN_ERROR`.

assistant-ui's aggregator *does* handle `RUN_ERROR`
(`packages/react-ag-ui/src/runtime/adapter/run-aggregator.ts`), so this is free
to fix and immediately useful. This integration's proxy has to paper over it:
`overlay/examples/with-ag-ui/app/api/arena/chat/route.ts` converts any non-200
into a synthetic `RUN_ERROR` frame so the runtime settles.

**Suggested fix:** for AG-UI (and any streaming protocol), emit an in-band
terminal error event when the run cannot start or dies mid-flight, and add
`RUN_ERROR` to the adapter's taxonomy. `PublicArenaEvent` has no `run_error`
member today, so this is a core-events change, not just an adapter one.

## 3. Slot identity survives only by convention in `messageId`

The adapter tags `TEXT_MESSAGE_START/CONTENT/END` with a non-standard top-level
`slot` field. It survives `@ag-ui/client`'s zod schemas (they are `passthrough`)
— the probe prints ``slot` field survived client-side schema validation: [ 'A',
'B' ]`` — but assistant-ui's own parser whitelists known fields
(`packages/react-ag-ui/src/runtime/event-parser.ts:112`), so by the time events
reach the runtime the slot is gone. The only thing that survives into rendered
message state is the id convention `"<matchupId>:<slot>"`, which the docs
describe as a nicety rather than the load-bearing channel it actually is.

Not a bug, but worth stating normatively in `docs/md/integration.md`: **parse the
`messageId`; do not rely on `slot`.** Our UI does exactly that
(`lib/arena/protocol.ts: matchupIdFromMessageId`).

## 4. The vote token rides a `CUSTOM` event that conformant runtimes discard

`arena_matchup` (with `matchupToken`) is a `CUSTOM` event. assistant-ui parses
`CUSTOM` and dispatches it into the run aggregator, which has **no case for it**
— the aggregator handles `RUN_*`, `TEXT_MESSAGE_*`, `THINKING_*`, `REASONING_*`,
`TOOL_CALL_*` and `ACTIVITY_SNAPSHOT`, and silently drops everything else, `CUSTOM`
and `STATE_SNAPSHOT` included. So through the runtime's public surface — messages,
parts, metadata — the token does not exist, and the AG-UI path is **not** votable
the way `docs/md/integration.md` implies.

The workaround (`lib/arena/agent.ts`) is to construct the `HttpAgent` yourself and
attach a raw `AgentSubscriber` alongside the runtime, mirroring the matchup
metadata into a module-level store. That works, but it means the arena's most
important payload lives outside the runtime's state model, and any consumer that
uses the convenience path (`useAGUIRuntime({ url })`, CopilotKit's provider) gets
a stream it can render and cannot vote on.

**Suggested fixes**, roughly in order of value:

1. Also return the matchup metadata as a response header (e.g.
   `x-arena-matchup: {json}`). Any proxy or fetch-level wrapper can read it
   without the runtime's cooperation — that is all this integration's Next.js
   route would have needed.
2. Add a small REST read: `GET /api/arena/matchups/:id` returning
   `{ mode, votable, conversationId, turnIndex }` (token excluded), so a client
   that only has the `messageId` can recover the round's shape.
3. Keep `CUSTOM` as the primary channel — it is the right AG-UI-native choice —
   but document that mainstream runtimes drop it and that a raw subscriber is
   required.

## 5. A dead slot is invisible

`slot_error` is also a `CUSTOM` event (same drop path as #4) and is *not*
accompanied by anything in the text-message taxonomy. A conformant client
therefore renders a slot that failed as an empty, permanently blank column with
no explanation; ours only shows the error because it reads raw events. Emitting
the error text as `TEXT_MESSAGE_CONTENT` on the failed slot (or ending that
message and surfacing the failure in the final `RUN_FINISHED` payload) would
degrade far better.

## 6. Non-votable rounds still ship an empty token

A `single` round emits `arena_matchup` with `matchupToken: ""`, `slots: ["A"]`,
`votable: false`. Clients must special-case the empty string rather than a missing
field, and the surviving slot is still labelled `A`, which reads oddly in a
non-comparison context (we relabel it "SINGLE MODEL"). Omitting `matchupToken`
when there is no token would be cleaner and type-safe (`matchupToken?: string`).

## 7. `threadId` / `runId` are server-minted and ignore the client's

`RUN_STARTED.threadId` is OmniArena's `conversationId` and `runId` is the
`matchupId`. The ingress now reads `RunAgentInput` (finding 1), but it still does
not echo the client's `threadId`/`runId` into `RUN_STARTED` — the AG-UI contract
expects them echoed, and clients use them to correlate runs they started. It gets
stranger across turns: after a tie the next turn starts a *new* conversation, so
the stream's `threadId` changes underneath what assistant-ui still considers one
thread. Nothing broke in practice, but any consumer keying state off `threadId`
will.

## 8. Continuation rules are implicit, and failure is an HTTP 409

Only a decisive vote (`left`/`right`) leaves a winning response, and only then may
the next turn pass `conversationId`; otherwise the arena answers
`409 "Vote for a winning response before continuing this conversation"`. Nothing
in the stream tells a client which case it is in — `arena_matchup` carries
`votable` but no `continuable`, so every consumer has to re-encode the rule
"left|right ⇒ decisive" (see `lib/arena/protocol.ts: isDecisive`). Since the 409
also isn't an AG-UI event (#2), guessing wrong produces a transport error rather
than something renderable.

**Suggested fix:** put the answer in the vote response (`POST /api/arena/vote`
already returns `{ accepted, models }` — add `continuable: boolean` and echo the
`conversationId` to continue with), or add `continuable` to the next round's
`arena_matchup`.

## 9. `@omni-arena/react` cannot be used with any third-party runtime (resolved)

`packages/react-sdk/src/useArenaChat.ts` hardcodes `fetch(baseUrl + "/api/arena/chat")`
with the native SSE protocol and owns the whole message state machine. In an
assistant-ui app the runtime owns messages, so the SDK is unusable — we
re-implemented the parts that are protocol-independent anyway: anonymous session
id persistence, the vote POST + reveal, and matchup bookkeeping (~200 lines in
`lib/arena/`).

**Suggested fix:** split the SDK. A protocol-agnostic core — `getSessionId()`,
`useArenaVote({ matchupId, matchupToken })`, the reveal types, and a matchup
store — would drop straight into assistant-ui, CopilotKit or a custom UI, with
`useArenaChat` becoming the batteries-included native-SSE wrapper on top. As it
stands, "we ship a React SDK" does not help the frontends the adapters exist to
court.

> **Resolved in `packages/react-sdk`.** The package now exports exactly that
> protocol-agnostic surface from `packages/react-sdk/src/index.ts`:
> `getSessionId` / `session`, `useArenaVote` / `vote`, reveal and matchup parsers
> in `protocol`, plus `stream` helpers. `useArenaChat` remains the
> batteries-included native-SSE wrapper and still cannot be dropped into a
> third-party runtime that owns its own messages — that is a different claim from
> "the package has no usable surface beside its own chat hook," which is no
> longer true. This integration's overlay still carries its own thin
> `lib/arena/` store and vote path (written before the split); the SDK core is
> what a new AG-UI / CopilotKit host would reach for.

## 10. No conversation rehydration (missing feature, not a bug)

Reload the page and the thread is gone. OmniArena has the conversation server-side
(`conversationId`, turns, winning responses) but exposes no read endpoint, and the
AG-UI stream emits no `MESSAGES_SNAPSHOT`. For assistant-ui specifically — whose
thread list and persistence are headline features — this is the biggest gap:
there is no way to build a real arena app with history on top of the current API.

## 11. The mock provider defeats blind testing (resolved)

`ARENA_MOCK_PROVIDER` replies with `"Mock reply from Mock Model Alpha…"`, i.e. the
model's display name is in the response body before any vote. It makes the arena
runnable without credits (very valuable — this whole integration is verified on
it), but it means no automated test can assert the core product invariant "the
model identity is not visible before voting", and screenshots of the mock path
look like the blindness is broken. Neutral canned text (`"Response A"`/`"Response
B"`, or lorem keyed by slot) with the identity only in the reveal payload would
fix it.

> **Resolved in `server/`.** The mock now opens with `Mock answer, variant
> <tag>`, where `<tag>` is `mockVariantTag(providerModelId)` — an FNV-1a hash
> truncated to four hex digits (`952e` for `mock-alpha`, `7de8` for `mock-beta`),
> exported from `server/src/providers/mock.ts`. No display name, provider, or
> provider model id reaches the answer body, and the two slots are still told
> apart, so a pre-vote assertion can name a slot without naming a model.
> `server/src/blindness.test.ts` now enforces the invariant directly, and this
> integration's `tests/arena.spec.ts` asserts the per-slot tags where it used to
> match the leaked prefix. The showcase provider behind `ARENA_SHOWCASE=1` stays,
> but only for stream pacing — the stock mock's four undelayed tokens leave no
> mid-stream frame to photograph.

---

## What worked, and is worth keeping

- **Two concurrent `TEXT_MESSAGE_*` streams in one run are legal and survive the
  real client.** `@ag-ui/client`'s `verifyEvents` accepts interleaved messages
  distinguished by `messageId`; the probe shows
  `RUN_STARTED → CUSTOM → START ×2 → CONTENT interleaved → END ×2 → RUN_FINISHED`
  and `result.newMessages` containing both slots. This was the main risk going in
  and it is a genuine strength of the AG-UI mapping — a Vercel-AI-style protocol
  needs a side channel (`data-arena-b-delta`) to say the same thing.
- **`slot_done` is always emitted, even after `slot_error`**, so `TEXT_MESSAGE_END`
  always balances `TEXT_MESSAGE_START` and the verifier never trips.
- **Content negotiation works**: `Accept: application/vnd.ag-ui+json` selects the
  adapter with no query param, which is how a stock AG-UI client would ask.
- **The token/vote/reveal round-trip is solid**: signed token in, `{accepted,
  models}` out, 200 on the first vote, and the reveal payload has exactly what a
  UI needs (`id` + `displayName` per slot).

## Which runtime is the better integration story

The AG-UI path is the better *protocol* fit — one run, two typed message streams,
a sanctioned escape hatch for metadata — and it is the only path where the vote
token travels in-band. But today it still needs more client code than the AI SDK
path (`examples/assistant-ui/`), mostly because of #4: a raw subscriber (or
equivalent) is required to receive the matchup metadata mainstream runtimes drop.
Finding 1's envelope gap is closed, but `useAgUiRuntime` still builds
`RunAgentInput` itself and only fills `forwardedProps` from its own model
context, so a thin agent subclass remains the way to attach session id,
continuation id, arena opt-in and `x-arena`. Fix the metadata channel (#4) and
that remaining injection gap, and `useAgUiRuntime` becomes a genuinely drop-in
consumer, at which point AG-UI is clearly the story to lead with for agentic
frontends.
