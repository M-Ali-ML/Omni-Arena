import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace package ships compiled ESM; keep Next from treating it as opaque.
  transpilePackages: ["@omni-arena/react"],
};

export default nextConfig;
