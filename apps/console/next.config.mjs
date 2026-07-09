/** @type {import('next').NextConfig} */
const nextConfig = {
  // minimal self-contained server for the artifact image (ticket 011)
  output: "standalone",
  // workspace packages ship TypeScript source; Next transpiles them
  transpilePackages: ["@platform/auth", "@platform/core", "@platform/storage"],
  webpack: (config) => {
    // workspace packages use ESM ".js" import specifiers for ".ts" sources
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  // same mapping for the turbopack dev server
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
  },
};

export default nextConfig;
