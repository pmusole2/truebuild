import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        environment: 'node',
        include: [
            'packages/contracts/src/**/*.test.ts',
            'api/src/**/*.test.ts',
            'app/src/**/*.test.ts',
            'gates/**/*.test.ts',
        ],
        exclude: ['**/node_modules/**', '**/*.native.test.ts'],
        // Keep TS-loading child-process integration tests and large manual fixtures within a bounded CPU budget.
        maxWorkers: 4,
        restoreMocks: true,
    },
})
