const OMNIARENA_URL = process.env.OMNIARENA_URL ?? "http://127.0.0.1:3001";

/** Thin proxy to OmniArena's vote endpoint; reveals both model identities. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const upstream = await fetch(`${OMNIARENA_URL}/api/arena/vote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
