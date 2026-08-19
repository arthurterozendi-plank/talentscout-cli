/** @type {import("prettier").Config} */
const config = {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 100,
  tabWidth: 2,

  plugins: ["@ianvs/prettier-plugin-sort-imports"],

  importOrder: ["^node:", "<THIRD_PARTY_MODULES>", "^[./]"],
  importOrderParserPlugins: ["typescript"],
  importOrderTypeScriptVersion: "5.9.3",
};

export default config;
