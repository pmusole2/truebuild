import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    {
        ignores: [
            '**/node_modules/**',
            '**/.next/**',
            '**/.expo/**',
            '**/dist/**',
            '**/coverage/**',
            '**/next-env.d.ts',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{ts,tsx}'],
        rules: {
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/explicit-function-return-type': 'error',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['**/*.{js,cjs,mjs}'],
        languageOptions: {
            globals: { module: 'readonly', require: 'readonly', __dirname: 'readonly', process: 'readonly' },
        },
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
)
