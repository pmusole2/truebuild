import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const mode = process.env.TRUEBUILD_E2E_GENERATIVE_UI ?? 'full'
if (mode !== 'full' && mode !== 'steps' && mode !== 'off') {
    throw new Error('TRUEBUILD_E2E_GENERATIVE_UI must be full, steps or off')
}

// Public shared key for the isolated test API and bundle only. It is not a provider credential and is never a Meta key.
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
// The documented Meta HTTP mock answers with one scenario per API process: correct, reversed or uncertain.
const SCENARIO = process.env.TRUEBUILD_E2E_SCENARIO ?? 'reversed'
if (!['correct', 'reversed', 'uncertain'].includes(SCENARIO)) {
    throw new Error('TRUEBUILD_E2E_SCENARIO must be correct, reversed or uncertain')
}
const SECOND_OPINION = process.env.TRUEBUILD_E2E_SECOND_OPINION
if (SECOND_OPINION !== undefined && !['correct', 'reversed', 'uncertain', 'failed'].includes(SECOND_OPINION)) {
    throw new Error('TRUEBUILD_E2E_SECOND_OPINION must be correct, reversed, uncertain or failed')
}
if (SECOND_OPINION !== undefined && SCENARIO !== 'uncertain') {
    throw new Error('Second-opinion E2E requires TRUEBUILD_E2E_SCENARIO=uncertain')
}
const rawSecondDelay = process.env.TRUEBUILD_E2E_SECOND_OPINION_DELAY_MS
if (
    rawSecondDelay !== undefined &&
    (!/^(0|[1-9]\d{0,4})$/.test(rawSecondDelay) || Number(rawSecondDelay) > 55_000 || SECOND_OPINION === undefined)
) {
    throw new Error(
        'TRUEBUILD_E2E_SECOND_OPINION_DELAY_MS requires a second opinion and must be an integer from 0 to 55000',
    )
}
const secondOpinionFlags =
    SECOND_OPINION === undefined
        ? ''
        : ` --second-opinion=${SECOND_OPINION}${rawSecondDelay === undefined ? '' : ` --second-opinion-delay-ms=${Number(rawSecondDelay)}`}`
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`
process.env.TRUEBUILD_E2E_API_ORIGIN = API_ORIGIN

export default defineConfig({
    testDir: './tests/e2e',
    outputDir: 'test-results',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 45_000,
    // The default run keeps all nine real-mode regressions. Opt-in follow-up runs reuse setup for one focused case.
    ...(SECOND_OPINION === undefined ? {} : { grep: /second opinion:/ }),
    use: {
        baseURL: WEB_ORIGIN,
        trace: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                // Fake camera and auto-accepted prompts only; camera permission is granted per test for the web origin.
                launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
            },
        },
    ],
    webServer: [
        {
            // Test-only Meta-mode API with the documented HTTP mock. An empty key is required and no .env file is loaded.
            command: `node --import tsx api/scripts/mock-server.ts --test-only --scenario=${SCENARIO}${secondOpinionFlags}`,
            cwd: root,
            url: `${API_ORIGIN}/api/health`,
            reuseExistingServer: false,
            timeout: 120_000,
            env: {
                MODEL_API_KEY: '',
                PORT: String(API_PORT),
                CORS_ORIGINS: WEB_ORIGIN,
                GENERATIVE_UI: mode,
                EXPO_NO_DOTENV: '1',
            },
        },
        {
            command: `npm run web -- --localhost --port ${WEB_PORT}`,
            cwd: `${root}app`,
            url: WEB_ORIGIN,
            reuseExistingServer: false,
            timeout: 120_000,
            env: {
                CI: '1',
                EXPO_NO_TELEMETRY: '1',
                EXPO_NO_DOTENV: '1',
                NODE_OPTIONS: '--dns-result-order=ipv4first',
                EXPO_PUBLIC_API_BASE_URL: API_ORIGIN,
                EXPO_PUBLIC_API_SECRET: FIXTURE_DEMO_KEY,
                EXPO_PUBLIC_PROVIDER_MODE: 'meta',
                EXPO_PUBLIC_GENERATIVE_UI: mode,
                // Tips are for people; the regression suite drives the real controls directly. This flag only hides them
                // in a development bundle and never marks a screen seen.
                EXPO_PUBLIC_SKIP_TIPS: '1',
            },
        },
    ],
})
