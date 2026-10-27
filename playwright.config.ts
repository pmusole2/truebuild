import { defineConfig, devices } from '@playwright/test'

// Synthetic, public demo key for fixture tests only. It is not a credential: fixture mode calls no model and the same
// value is visible in the app bundle by design. Never replace it with a real secret here.
const FIXTURE_DEMO_KEY = 'truebuild-fixture-demo'
function testPort(value: string | undefined, fallback: number): number {
    const port = value === undefined ? fallback : Number(value)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error('Invalid test port')
    }
    return port
}
const API_PORT = testPort(process.env.TRUEBUILD_E2E_API_PORT, 31_071)
const WEB_PORT = testPort(process.env.TRUEBUILD_E2E_WEB_PORT, 18_071)
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`
process.env.TRUEBUILD_E2E_API_ORIGIN = API_ORIGIN

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 45_000,
    use: {
        baseURL: WEB_ORIGIN,
        trace: 'retain-on-failure',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: [
        {
            command: 'node --import tsx api/src/index.ts',
            url: `${API_ORIGIN}/api/health`,
            reuseExistingServer: false,
            timeout: 120_000,
            env: {
                API_SHARED_SECRET: FIXTURE_DEMO_KEY,
                PROVIDER_MODE: 'fixture',
                PORT: String(API_PORT),
                CORS_ORIGINS: WEB_ORIGIN,
            },
        },
        {
            command: `npm exec --workspace @truebuild/app -- expo start --web --localhost --port ${WEB_PORT}`,
            url: WEB_ORIGIN,
            reuseExistingServer: false,
            timeout: 120_000,
            env: {
                CI: '1',
                EXPO_NO_TELEMETRY: '1',
                EXPO_NO_DOTENV: '1',
                EXPO_OFFLINE: '1',
                EXPO_PUBLIC_API_BASE_URL: API_ORIGIN,
                EXPO_PUBLIC_API_SECRET: FIXTURE_DEMO_KEY,
                EXPO_PUBLIC_PROVIDER_MODE: 'fixture',
            },
        },
    ],
})
