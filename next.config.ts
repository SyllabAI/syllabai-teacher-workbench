import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Vercel repair (2026-09-15): the API routes read their datasets through
  // COMPUTED fs paths (path.join(process.cwd(), ...)) which the file tracer
  // cannot statically see — every /api/* route ENOENT-crashed on the deployed
  // lambda while pages served fine. Declare the traced trees explicitly.
  // data/ is git-tracked (never vercelignored); download/ stays excluded.
  outputFileTracingIncludes: {
    "/api/**": ["./data/**/*"],
  },
};

export default nextConfig;
