import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * This repo has no `@talentscout/eslint-config` to extend — that package is
 * unpublished and private to the monorepo. `typescript-eslint`'s recommended
 * set is the same underlying ruleset the monorepo's config re-exports, minus
 * the Next.js/React chain this CLI has no use for.
 */
export default defineConfig([
  tseslint.configs.recommended,
  // Disables ESLint rules that conflict with Prettier. Must stay last.
  prettier,
  globalIgnores(["node_modules/**", "coverage/**"]),
]);
