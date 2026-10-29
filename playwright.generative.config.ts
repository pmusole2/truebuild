import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const mode = process.env.TRUEBUILD_E2E_GENERATIVE_UI ?? 'full'
if (mode !== 'full' && mode !== 'off') throw new Error('Use full or off for the isolated generative UI flow')

export default defineConfig({
    testDir: './tests/generative-e2e',
    outputDir: `.local/ai-effort/e2e-${mode}`,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 120_000,
    use: { baseURL: 'http://localhost:8091', trace: 'retain-on-failure' },
    projects: [{ name: `chromium-${mode}`, use: { ...devices['Desktop Chrome'] } }],
    webServer: [
        {
            command: 'node --import tsx api/scripts/fixture-server.ts',
            cwd: root,
            url: 'http://127.0.0.1:3101/api/health',
            reuseExistingServer: false,
            timeout: 120_000,
            env: {
                PROVIDER_MODE: 'fixture',
                PORT: '3101',
                GENERATIVE_UI: mode,
                MODEL_API_KEY: '',
                EXPO_NO_DOTENV: '1',
            },
        },
        {
            command: 'npm run web -- --localhost --port 8091',
            cwd: `${root}app`,
            url: 'http://localhost:8091',
            reuseExistingServer: false,
            timeout: 120_000,
            env: {
                CI: '1',
                // Expo advertises an IPv4 bundle URL for localhost; bind that address on Node 24/macOS as well.
                NODE_OPTIONS: '--dns-result-order=ipv4first',
                EXPO_NO_TELEMETRY: '1',
                EXPO_NO_DOTENV: '1',
                EXPO_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3101',
                EXPO_PUBLIC_API_SECRET: 'truebuild-fixture-demo',
                EXPO_PUBLIC_PROVIDER_MODE: 'fixture',
                EXPO_PUBLIC_GENERATIVE_UI: mode,
                EXPO_PUBLIC_AI_EFFORT_PROOF: '1',
                EXPO_PUBLIC_AI_EFFORT_PROOF_RUN: `whole-screen-e2e-${mode}`,
                EXPO_PUBLIC_SKIP_TIPS: '1',
            },
        },
    ],
})
