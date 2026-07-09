import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // longest key first: plain "@platform/storage" would also prefix-match the subpath
      "@platform/storage/conformance": p("./packages/storage/src/conformance.ts"),
      "@platform/auth": p("./packages/auth/src/index.ts"),
      "@platform/core": p("./packages/core/src/index.ts"),
      "@platform/storage": p("./packages/storage/src/index.ts"),
      "@platform/model-gateway": p("./packages/model-gateway/src/index.ts"),
      "@platform/tool-registry": p("./packages/tool-registry/src/index.ts"),
      "@platform/telemetry": p("./packages/telemetry/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
