import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { matchupCache } from "./matchup-cache";
import { MATCHUP_HEADER, parseMatchupHeader } from "./protocol";
import { arenaUrl } from "./server";

export type ArenaAgentContext = {
  arenaEnabled: boolean;
  conversationId: string | null;
  sessionId: string;
};

/**
 * Thin `HttpAgent` subclass. OmniArena already accepts a stock `RunAgentInput`;
 * what CopilotKit's runtime cannot do is put arena session / continuation /
 * trigger into `forwardedProps` or attach `x-arena`. Overriding `requestInit`
 * is the whole remaining adaptation.
 *
 * The vote token is read from `x-arena-matchup` in the custom `fetch` below —
 * the AG-UI call is server-side inside CopilotRuntime, so the browser never
 * sees that header. See FINDINGS.md for the CUSTOM-event check.
 */
export class ArenaHttpAgent extends HttpAgent {
  context: ArenaAgentContext;
  /** Updated from RunAgentInput so the fetch wrapper can key the matchup cache. */
  private activeThreadId: string;

  constructor(
    context: ArenaAgentContext,
    options?: { url?: string; threadId?: string },
  ) {
    const self = { agent: null as ArenaHttpAgent | null };
    const fetchWithMatchup: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const matchup = parseMatchupHeader(response.headers.get(MATCHUP_HEADER));
      const threadId = self.agent?.activeThreadId || options?.threadId;
      if (matchup && threadId) matchupCache.set(threadId, matchup);
      return response;
    };

    super({
      url: options?.url ?? `${arenaUrl()}/api/arena/chat?protocol=ag-ui`,
      ...(options?.threadId ? { threadId: options.threadId } : {}),
      fetch: fetchWithMatchup,
    });

    this.context = context;
    this.activeThreadId = options?.threadId ?? "";
    self.agent = this;
  }

  protected override requestInit(input: RunAgentInput): RequestInit {
    if (input.threadId) this.activeThreadId = input.threadId;

    const { arenaEnabled, conversationId, sessionId } = this.context;
    const init = super.requestInit({
      ...input,
      forwardedProps: {
        ...(input.forwardedProps as Record<string, unknown> | undefined),
        sessionId,
        arena: arenaEnabled,
        ...(arenaEnabled && conversationId ? { conversationId } : {}),
      },
    });
    const headers = new Headers(init.headers);
    headers.set("x-arena", arenaEnabled ? "on" : "off");
    return { ...init, headers };
  }
}

/** Build an agent from inbound CopilotKit request headers (AgentsFactory). */
export function arenaAgentFromRequest(request: Request): ArenaHttpAgent {
  const arenaEnabled = request.headers.get("x-arena") !== "off";
  const sessionId =
    request.headers.get("x-arena-session") ?? "copilotkit-anonymous";
  const conversationId = request.headers.get("x-arena-conversation");
  // Client-minted thread id, so the matchup cache key matches the poll URL
  // even before RunAgentInput arrives.
  const threadId = request.headers.get("x-arena-thread") ?? undefined;
  return new ArenaHttpAgent(
    {
      arenaEnabled,
      sessionId,
      conversationId:
        conversationId && conversationId.length > 0 ? conversationId : null,
    },
    threadId ? { threadId } : undefined,
  );
}
