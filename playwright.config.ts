import { defineConfig, devices } from '@playwright/test'

// Synthetic, public demo key for fixture tests only. It is not a credential: fixture mode calls no model and the same
// value is visible in the app bundle by design. Never replace it with a real secret here.
const FIXTURE_DEMO_KEY = 'truebuild-fixture-demo'
const API_ORIGIN = 'http://127.0.0.1:3001'

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
            url: `${API_ORIGIN}/api/health`,
            reuseExistingServer: false,
            timeout: 120_000,
            env: {
                NEXT_TELEMETRY_DISABLED: '1',
                TRUEBUILD_ENABLE_MODELS: '0',
                API_SHARED_SECRET: FIXTURE_DEMO_KEY,
                PROVIDER_MODE: 'fixture',
            },
        },
        {
            command: 'npm run dev:web',
            url: 'http://localhost:8081',
            reuseExistingServer: false,
            timeout: 120_000,
            env: {
                CI: '1',
                EXPO_NO_TELEMETRY: '1',
                EXPO_NO_DOTENV: '1',
                EXPO_PUBLIC_API_BASE_URL: API_ORIGIN,
                EXPO_PUBLIC_API_SECRET: FIXTURE_DEMO_KEY,
                EXPO_PUBLIC_PROVIDER_MODE: 'fixture',
            },
        },
    ],
})
