import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import projectRules from "./tools/eslint-rules.js";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"] },
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ["*.{js,mjs,cjs}", "backend/**/*.{js,mjs,cjs}", "frontend/*.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["frontend/**/*.{js,jsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { react, "react-hooks": reactHooks },
    rules: {
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ["frontend/tests/**/*.{js,jsx}"],
    languageOptions: { globals: globals.node },
  },
  stylistic.configs.customize({ indent: 2, quotes: "double", semi: true, jsx: true }),
  {
    plugins: { project: projectRules },
    rules: {
      "project/function-spacing": "error",
      "@stylistic/lines-between-class-members": ["error", "always"],
      "curly": ["error", "all"],
      "@stylistic/brace-style": ["error", "stroustrup", { allowSingleLine: false }],
      "@stylistic/comma-dangle": ["error", "always-multiline"],
      "@stylistic/linebreak-style": ["error", "unix"],
      "@stylistic/jsx-one-expression-per-line": "off",
    },
  },
];
