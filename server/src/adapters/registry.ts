import { createA2uiAdapter } from "./a2ui.js";
import { createAgUiAdapter } from "./ag-ui.js";
import type { EventAdapter } from "./event-adapter.js";
import { createOpenAiSseAdapter } from "./openai-sse.js";
import { sseAdapter } from "./sse.js";
import { createVercelAiAdapter } from "./vercel-ai.js";

export type ProtocolName = "sse" | "agui" | "a2ui" | "vercel" | "openai";

interface AdapterEntry {
  /** Builds a fresh adapter per request (native SSE reuses one stateless one). */
  create: () => EventAdapter;
  /** Accepted `?protocol=` values. */
  aliases: string[];
  /** `Accept`-header media types that select this protocol. */
  mediaTypes: string[];
}

/**
 * The pluggable egress layer (vision §2.2 / architecture.md): every wire protocol
 * is one `EventAdapter` module over the same internal PublicArenaEvent stream.
 * Native SSE is the default so existing clients are byte-for-byte unaffected.
 */
const registry: Record<ProtocolName, AdapterEntry> = {
  sse: {
    create: () => sseAdapter,
    aliases: ["sse", "native", "native-sse"],
    mediaTypes: ["text/event-stream"],
  },
  agui: {
    create: createAgUiAdapter,
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
    aliases: ["vercel", "vercel-ai", "ai-sdk"],
    mediaTypes: ["application/vnd.vercel.ai.ui-message-stream+json"],
  },
  openai: {
    create: createOpenAiSseAdapter,
    aliases: ["openai", "openai-sse"],
    mediaTypes: ["application/vnd.openai.chat-chunk+json"],
  },
};

const PROTOCOL_NAMES: ProtocolName[] = [
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

/**
 * Pick an adapter from the `?protocol=` query param, falling back to the
 * `Accept` header, then to native SSE. Unknown protocols fall back to SSE so a
 * bad value never breaks the default path.
 */
export function selectAdapter(
  protocol: string | undefined,
  accept: string | undefined,
): EventAdapter {
  return registry[resolveProtocol(protocol, accept)].create();
}
