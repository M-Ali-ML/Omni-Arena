import { arenaUrl } from "@/lib/arena/server";
import { MATCHUP_HEADER } from "@/lib/arena/protocol";

/**
 * Same-origin reverse proxy onto OmniArena's AG-UI stream.
 *
 * The browser posts a stock AG-UI `RunAgentInput` (with arena fields in
 * `forwardedProps`); this route pipes `?protocol=ag-ui` back byte-for-byte and
 * forwards `x-arena-matchup` so the client can vote without a `CUSTOM`
 * subscriber. It exists to keep the arena URL server-side and the browser
 * same-origin.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * A request that never streams (bad prompt, a conversation with no decisive
 * vote, arena down) still has to reach the user *inside* the thread. AG-UI's
 * verifier accepts `RUN_ERROR` as a first event, so a one-event stream is the
 * well-formed way to say "this run failed".
 */
function runError(message: string): Response {
  return new Response(
    `data: ${JSON.stringify({ type: "RUN_ERROR", message })}\n\n`,
    { status: 200, headers: SSE_HEADERS },
  );
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${arenaUrl()}/api/arena/chat?protocol=ag-ui`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(request.headers.get("x-arena")
          ? { "x-arena": request.headers.get("x-arena") as string }
          : {}),
      },
      body,
      signal: request.signal,
    });
  } catch (error) {
    return runError(
      `Cannot reach OmniArena at ${arenaUrl()}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    const parsed = safeJson(detail);
    return runError(
      `OmniArena refused the run (${upstream.status}): ${
        parsed?.error ?? detail.slice(0, 200) ?? "unknown error"
      }`,
    );
  }

  const headers: Record<string, string> = { ...SSE_HEADERS };
  const matchup = upstream.headers.get(MATCHUP_HEADER);
  if (matchup) headers[MATCHUP_HEADER] = matchup;

  return new Response(upstream.body, { status: 200, headers });
}

function safeJson(text: string): { error?: string } | null {
  try {
    return JSON.parse(text) as { error?: string };
  } catch {
    return null;
  }
}
