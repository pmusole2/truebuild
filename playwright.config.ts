import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 45_000,
    use: {
        baseURL: 'http://localhost:8081',
        trace: 'retain-on-failure',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: [
        {
            command: 'npm run dev:api',
            url: 'http://127.0.0.1:3001/api/health',
            reuseExistingServer: false,
            timeout: 120_000,
            env: { NEXT_TELEMETRY_DISABLED: '1', TRUEBUILD_ENABLE_MODELS: '0', TRUEBUILD_OWNER_ACTION: 'none' },
        },
        {
            command: 'npm run dev:web',
            url: 'http://localhost:8081',
            reuseExistingServer: false,
            timeout: 120_000,
            env: { CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1' },
        },
    ],
})
