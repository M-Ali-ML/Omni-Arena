import { createA2uiAdapter } from "./a2ui.js";
import { agUiRequestAdapter, createAgUiAdapter } from "./ag-ui.js";
import type { EventAdapter } from "./event-adapter.js";
import { createOpenAiSseAdapter, openAiRequestAdapter } from "./openai-sse.js";
import type { RequestAdapter } from "./request-adapter.js";
import { sseAdapter } from "./sse.js";
import { createVercelAiAdapter, vercelAiRequestAdapter } from "./vercel-ai.js";

export type ProtocolName = "sse" | "agui" | "a2ui" | "vercel" | "openai";

interface AdapterEntry {
  /** Builds a fresh adapter per request (native SSE reuses one stateless one). */
  create: () => EventAdapter;
  /**
   * Parser for this protocol's *own* request envelope, when it has a canonical
   * one. Absent means the protocol is output-only on ingress: it still accepts
   * OmniArena's body, which is all native SSE and A2UI clients ever send.
   */
  request?: RequestAdapter;
  /** Accepted `?protocol=` values. */
  aliases: string[];
  /** `Accept`-header media types that select this protocol. */
  mediaTypes: string[];
}

/**
 * The pluggable adapter layer (docs/md/architecture.md §Egress): every wire
 * protocol is one module over the same internal PublicArenaEvent stream, and —
 * where the protocol defines one — over its own request envelope too. Native SSE
 * is the default so existing clients are byte-for-byte unaffected.
 */
const registry: Record<ProtocolName, AdapterEntry> = {
  sse: {
    create: () => sseAdapter,
    aliases: ["sse", "native", "native-sse"],
    mediaTypes: ["text/event-stream"],
  },
  agui: {
    create: createAgUiAdapter,
    request: agUiRequestAdapter,
    aliases: ["agui", "ag-ui"],
    mediaTypes: ["application/vnd.ag-ui+json"],
  },
  a2ui: {
    create: createA2uiAdapter,
    aliases: ["a2ui"],
    mediaTypes: ["application/vnd.a2ui+json", "application/x-ndjson"],
  },
  vercel: {
    create: createVercelAiAdapter,
    request: vercelAiRequestAdapter,
    aliases: ["vercel", "vercel-ai", "ai-sdk"],
    mediaTypes: ["application/vnd.vercel.ai.ui-message-stream+json"],
  },
  openai: {
    create: createOpenAiSseAdapter,
    request: openAiRequestAdapter,
    aliases: ["openai", "openai-sse"],
    mediaTypes: ["application/vnd.openai.chat-chunk+json"],
  },
};

/** Every protocol the arena can speak, so callers can iterate all of them. */
export const PROTOCOL_NAMES: ProtocolName[] = [
  "sse",
  "agui",
  "a2ui",
  "vercel",
  "openai",
];

const byAlias = new Map<string, ProtocolName>();
const byMediaType = new Map<string, ProtocolName>();
for (const name of PROTOCOL_NAMES) {
  const entry = registry[name];
  for (const alias of entry.aliases) {
    byAlias.set(alias, name);
  }
  for (const mediaType of entry.mediaTypes) {
    byMediaType.set(mediaType, name);
  }
}

/** The protocol used when neither the query param nor Accept header selects one. */
export const DEFAULT_PROTOCOL: ProtocolName = "sse";

function resolveProtocol(
  protocol: string | undefined,
  accept: string | undefined,
): ProtocolName {
  const requested = protocol?.trim().toLowerCase();
  if (requested) {
    return byAlias.get(requested) ?? DEFAULT_PROTOCOL;
  }
  for (const part of accept?.split(",") ?? []) {
    const mediaType = part.split(";")[0]?.trim().toLowerCase();
    const matched = mediaType ? byMediaType.get(mediaType) : undefined;
    if (matched) {
      return matched;
    }
  }
  return DEFAULT_PROTOCOL;
}

/** Both halves of one protocol, resolved together for a single request. */
export interface SelectedProtocol {
  name: ProtocolName;
  /** Response framing. */
  adapter: EventAdapter;
  /** Request parsing, when this protocol has a native envelope of its own. */
  request: RequestAdapter | undefined;
}

/**
 * Pick a protocol from the `?protocol=` query param, falling back to the
 * `Accept` header, then to native SSE. Unknown protocols fall back to SSE so a
 * bad value never breaks the default path. Egress and ingress are resolved from
 * the same decision, so a client that asks for AG-UI framing is also the one
 * allowed to post an AG-UI body.
 */
export function selectProtocol(
  protocol: string | undefined,
  accept: string | undefined,
): SelectedProtocol {
  const name = resolveProtocol(protocol, accept);
  const entry = registry[name];
  return { name, adapter: entry.create(), request: entry.request };
}

/** Response framing only, for callers with no request body to parse. */
export function selectAdapter(
  protocol: string | undefined,
  accept: string | undefined,
): EventAdapter {
  return registry[resolveProtocol(protocol, accept)].create();
}
