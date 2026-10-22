import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "packages/templates/tests/**/*.test.ts",
      "packages/local-adapters/tests/**/*.test.ts",
      "packages/search/tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
