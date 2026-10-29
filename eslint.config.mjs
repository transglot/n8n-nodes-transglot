// Self-contained flat ESLint config for this package. Kept local (not inherited from
// the monorepo root) so `npm run lint` is governed only by the node package's own rules.
//
// This is a light TypeScript sanity pass. The canonical gate for the n8n community
// registry is the official linter (`@n8n/eslint-plugin-community-nodes` /
// `eslint-plugin-n8n-nodes-base`) — run that before publishing.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
	{
		ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'test/**', '*.js', '*.mjs'],
	},
	{
		files: ['credentials/**/*.ts', 'nodes/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: 2022,
				sourceType: 'module',
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
		},
	},
];
