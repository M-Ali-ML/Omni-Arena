import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This example lives inside a monorepo; pin tracing to its own dir so Next
  // doesn't infer the repo root from a sibling lockfile.
  outputFileTracingRoot: here,
};

export default nextConfig;
