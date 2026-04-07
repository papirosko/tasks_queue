// eslint.config.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import scats from 'eslint-plugin-scats';
import prettierConfig from 'eslint-config-prettier';

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default [
    js.configs.recommended,

    // Конфигурация для исходного кода (src/**/*.ts)
    {
        files: ['src/**/*.ts'],
        ignores: ['**/src/api/*'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: './tsconfig-eslint.json',
                tsconfigRootDir,
                sourceType: 'module',
            },
            globals: {
                node: true,
                fetch: 'readonly',
                Buffer: 'readonly',
                process: 'readonly',
                global: 'readonly',
                setInterval: 'readonly',
                setTimeout: 'readonly',
                setImmediate: 'readonly',
                clearInterval: 'readonly',
                clearTimeout: 'readonly',
                NodeJS: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': typescriptEslint,
            prettier: prettier,
            scats: scats,
        },
        rules: {
            ...typescriptEslint.configs.recommended.rules,
            ...scats.configs.strict.rules,
            ...prettierConfig.rules,
            'prettier/prettier': 'error',

            '@typescript-eslint/interface-name-prefix': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-namespace': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/prefer-readonly': ['error'],
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '_' }],

            // Обновляем правило camelcase
            camelcase: ['error', { properties: 'never' }], // Разрешаем snake_case для свойств объектов
            'no-labels': 'error',
            'no-continue': 'error',
            'no-lonely-if': 'error',
            'no-multi-assign': 'error',
            'no-nested-ternary': 'error',
            'no-new-object': 'error',
            'no-unneeded-ternary': 'error',
            'nonblock-statement-body-position': 'error',
            'no-undef': ['error'],
        },
    },

    // Конфигурация для тестов (test/**/*.ts)
    {
        files: ['test/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: './tsconfig-eslint.json',
                tsconfigRootDir,
                sourceType: 'module',
            },
            globals: {
                node: true,
                fetch: 'readonly',
                Buffer: 'readonly',
                process: 'readonly',
                global: 'readonly',
                setInterval: 'readonly',
                setTimeout: 'readonly',
                clearInterval: 'readonly',
                clearTimeout: 'readonly',
                NodeJS: 'readonly',
                describe: 'readonly',
                it: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': typescriptEslint,
            prettier: prettier,
            scats: scats,
        },
        rules: {
            ...typescriptEslint.configs.recommended.rules,
            ...scats.configs.strict.rules,
            ...prettierConfig.rules,
            'prettier/prettier': 'error',

            '@typescript-eslint/interface-name-prefix': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-namespace': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/prefer-readonly': ['error'],
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '_' }],

            camelcase: ['error', { properties: 'never' }],
            'no-labels': 'error',
            'no-continue': 'error',
            'no-lonely-if': 'error',
            'no-multi-assign': 'error',
            'no-nested-ternary': 'error',
            'no-new-object': 'error',
            'no-unneeded-ternary': 'error',
            'nonblock-statement-body-position': 'error',
            'no-undef': ['error'],
        },
    },
];
