import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@platform/core": p("./packages/core/src/index.ts"),
      "@platform/storage": p("./packages/storage/src/index.ts"),
      "@platform/model-gateway": p("./packages/model-gateway/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
