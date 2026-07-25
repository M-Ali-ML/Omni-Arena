import "server-only";
import { ChatbotError, type ErrorCode } from "@/lib/errors";

/** Where the OmniArena service lives; same variable the repo's other examples use. */
export function arenaBaseUrl(): string {
  return process.env.OMNIARENA_URL ?? "http://localhost:3001";
}

export function arenaUrl(path: string): string {
  return new URL(path, arenaBaseUrl()).toString();
}

/**
 * OmniArena's status codes mapped onto this app's error taxonomy. The app has
 * no `conflict` error type, so 409 (the prior turn was never decisively voted,
 * or another request already advanced the conversation) is flattened to a bad
 * request and the real reason is carried in `cause`.
 */
function arenaErrorCode(status: number): ErrorCode {
  if (status === 401 || status === 403) {
    return "forbidden:chat";
  }
  if (status === 404) {
    return "not_found:chat";
  }
  if (status === 429) {
    return "rate_limit:chat";
  }
  if (status >= 500) {
    return "offline:chat";
  }
  return "bad_request:chat";
}

async function readArenaError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `OmniArena responded ${response.status}`;
  } catch {
    return `OmniArena responded ${response.status}`;
  }
}

export async function arenaFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(arenaUrl(path), init);
  } catch (cause) {
    throw new ChatbotError(
      "offline:chat",
      `Could not reach OmniArena at ${arenaBaseUrl()}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  if (!response.ok) {
    throw new ChatbotError(
      arenaErrorCode(response.status),
      await readArenaError(response),
    );
  }

  return response;
}
