import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        // docs/ is the Docusaurus site of imapkit.com, a project of its own (docs/package.json)
        ignores: ['dist/**', 'node_modules/**', '.claude/**', 'docs/**']
    },
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.cjs', '**/*.ts'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.node
            }
        },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            'no-prototype-builtins': 'off',
            'no-var': 'error',
            'prefer-const': 'error',
            'prefer-arrow-callback': 'error',
            'one-var': ['error', 'never'],
            eqeqeq: ['error', 'always', { null: 'ignore' }]
        }
    },
    {
        // the shims of the browser bundle
        files: ['scripts/browser/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.browser
            }
        }
    },
    {
        files: ['**/*.cjs'],
        languageOptions: {
            sourceType: 'commonjs'
        },
        rules: {
            strict: ['error', 'global']
        }
    },
    {
        files: ['**/*.ts'],
        extends: [tseslint.configs.recommended],
        rules: {
            // handled by the TypeScript compiler
            'no-undef': 'off',
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            '@typescript-eslint/no-explicit-any': 'off'
        }
    },
    prettier
);
