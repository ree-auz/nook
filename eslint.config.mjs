import js from "@eslint/js";
import globals from "globals";

// Checks for mistakes, not for style: the rules that are on catch code that does not do what it says.
export default [
  { ignores: ["node_modules/", "tests/corpus/"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.node },
    rules: {
      // `catch {}` is how this code says "then it is not there"; the reason stands beside it.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `({ blame: _, ...rest })` drops a field on purpose.
      "no-unused-vars": ["error", { args: "after-used", caughtErrors: "none", varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      // Tests match output that is indented with spaces.
      "no-regex-spaces": "off",
    },
  },
];
