import { defineConfig } from "vitest/config";

// Vite does not read tsconfig.json's `paths` unless told to, and without it
// every `@/` import fails to resolve under test.
export default defineConfig({
  resolve: { tsconfigPaths: true },
});
