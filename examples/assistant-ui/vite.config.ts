import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser only ever talks to this app; `/api` and `/health` are proxied to
// the OmniArena server (override with ARENA_TARGET). Applies to both the dev
// server and `vite preview` (used by the repo e2e suite).
const target = process.env.ARENA_TARGET ?? "http://127.0.0.1:3001";
const proxy = {
  "/api": target,
  "/health": target,
};

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});
