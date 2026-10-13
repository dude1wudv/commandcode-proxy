import js from '@eslint/js';
import globals from 'globals';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/protocols.mjs', '**/dist/**', '**/node_modules/**', '**/tests/**'] },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  ...pluginVue.configs['flat/essential'],
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'], sourceType: 'module' },
    },
  },
  { files: ['**/*.mjs'], rules: { '@typescript-eslint/no-unused-vars': 'off' } },
];
