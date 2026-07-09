/** @type {import('next').NextConfig} */
const nextConfig = {
  // workspace packages ship TypeScript source; Next transpiles them
  transpilePackages: ["@platform/core", "@platform/storage"],
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
