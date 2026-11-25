import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@conduit/core", "@conduit/nodes", "@conduit/engine", "@conduit/runtime"],
  // The MongoDB driver has optional native deps; keep it out of the server bundle.
  serverExternalPackages: ["mongodb", "isolated-vm", "undici", "baileys"],
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
