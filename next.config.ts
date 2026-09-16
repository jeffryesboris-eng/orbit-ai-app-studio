import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // TypeScript is checked explicitly with `tsc --noEmit` before production builds.
  // This keeps Next's build compatible with restricted Windows environments that
  // cannot start the separate type-checking child process.
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    workerThreads: true,
    turbopackPluginRuntimeStrategy: "workerThreads",
  },
};

export default nextConfig;
