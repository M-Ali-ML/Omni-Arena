/** Server-only: where OmniArena listens. Never shipped to the browser. */
export function arenaUrl(): string {
  return (process.env.OMNIARENA_URL ?? "http://127.0.0.1:3031").replace(
    /\/$/,
    "",
  );
}
