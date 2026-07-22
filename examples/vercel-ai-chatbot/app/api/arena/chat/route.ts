const OMNIARENA_URL = process.env.OMNIARENA_URL ?? "http://127.0.0.1:3001";

interface UiPart {
  type: string;
  text?: string;
}
interface UiMessage {
  role: string;
  parts?: UiPart[];
}

/**
 * Server route that stands in for the Vercel AI Chatbot template's own
 * `app/(chat)/api/chat/route.ts`. A stock AI SDK `useChat` client POSTs its
 * UI messages here; we forward the latest user prompt to OmniArena's Vercel AI
 * SDK adapter (`?protocol=vercel-ai`) and pipe the UI Message Stream straight
 * back to the browser. Slot A rides the main text channel; slot B arrives as
 * `data-arena-b-*` parts (see the client component).
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { messages?: UiMessage[]; id?: string };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = (lastUser?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");

  const upstream = await fetch(
    `${OMNIARENA_URL}/api/arena/chat?protocol=vercel-ai`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, sessionId: body.id ?? "vercel-example" }),
    },
  );

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "text/event-stream",
      "x-vercel-ai-ui-message-stream":
        upstream.headers.get("x-vercel-ai-ui-message-stream") ?? "v1",
      "cache-control": "no-cache, no-transform",
    },
  });
}
