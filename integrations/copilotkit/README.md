# OmniArena × CopilotKit (AG-UI flagship)

Owned Next.js App Router chat app using CopilotKit's stock UI, pointed at
OmniArena's AG-UI adapter (`/api/arena/chat?protocol=ag-ui`).

> Full README (quickstart screenshots, real-models section, docs row) lands in
> Increment 3. This note is enough to run Increment 1.

## Pinned versions

| Package | Version | Why |
| --- | --- | --- |
| `@copilotkit/react-core` | **1.63.2** | Current latest at scaffold time; v2 chat + `useAgent` |
| `@copilotkit/react-ui` | **1.63.2** | Pinned with the core line (styles / legacy surface) |
| `@copilotkit/runtime` | **1.63.2** | `CopilotRuntime` + `ExperimentalEmptyAdapter` |
| `@ag-ui/client` | **0.0.57** | Same pin as CopilotKit 1.63.2 and assistant-ui |
| `next` | **16.2.10** | Compatible with CK 1.63; matches assistant-ui |
| `react` / `react-dom` | **19.2.8** | Next 16 peer range |

## Quickstart (mock, no keys)

```bash
cd integrations/copilotkit
npm install
# ensure packages/react-sdk is built: npm run build --workspace @omni-arena/react

npm run arena        # OmniArena on :3031
npm run dev          # app on :3300
```

Open <http://127.0.0.1:3300>.

```bash
npm run probe        # headless agent → stream → vote → continue
```

## Layout

```
integrations/copilotkit/
  app/api/copilotkit/     CopilotRuntime + ArenaHttpAgent (AgentsFactory)
  app/api/arena/matchup/  server-side matchup cache read (vote-token path)
  app/api/arena/vote/     same-origin vote proxy
  components/arena/       dual-column message, vote bar, controls, bridge
  lib/arena/              agent, protocol, store, matchup-cache
  harness/arena.ts        OmniArena on pg-mem + mock, port 3031
  tools/probe.ts          headless PASS/FAIL proof
  FINDINGS.md             CopilotKit × AG-UI observations
```

See [FINDINGS.md](./FINDINGS.md) for the vote-token decision (header capture +
poll, with CUSTOM as a best-effort subscribe).
