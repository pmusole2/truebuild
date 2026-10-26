import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        environment: 'node',
        include: [
            'packages/contracts/src/**/*.test.ts',
            'api/src/**/*.test.ts',
            'app/src/**/*.test.ts',
            'tools/**/*.test.ts',
        ],
        exclude: ['**/node_modules/**', '**/*.native.test.ts'],
        restoreMocks: true,
    },
})
