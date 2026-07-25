import { connection } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { arenaFetch } from "@/lib/arena/server";
import { ChatbotError } from "@/lib/errors";

/**
 * Read-only passthrough of OmniArena's leaderboard. Proxied rather than fetched
 * from the browser so the arena service never has to be exposed publicly or
 * CORS-configured for this app's origin.
 */
export async function GET() {
  // The template enables `cacheComponents`, which prerenders argument-less GET
  // handlers at build time; live ratings must be served per request instead.
  // (`dynamic = "force-dynamic"` is rejected under that flag.) Kept outside the
  // try so the build-time bailout it throws is not swallowed as a 500.
  await connection();

  try {
    const session = await auth();
    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    const response = await arenaFetch("/api/arena/leaderboard", {
      headers: { accept: "application/json" },
      method: "GET",
    });

    return Response.json(await response.json(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }
    console.error("Unhandled error in arena leaderboard API:", error);
    return new ChatbotError("offline:chat").toResponse();
  }
}
