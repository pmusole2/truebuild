import { defineConfig, devices } from '@playwright/test'

/** Separate ports keep capture checks independent of the lead's running API/demo servers. No provider is contacted. */
export default defineConfig({
    testDir: './src/features/capture/browser',
    outputDir: '/tmp/truebuild-track2-playwright-results',
    workers: 1,
    retries: 0,
    timeout: 30_000,
    use: { baseURL: 'http://localhost:8181', trace: 'retain-on-failure', viewport: { width: 390, height: 844 } },
    projects: [
        { name: 'capture-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    ],
    webServer: {
        command: 'EXPO_NO_DOTENV=1 EXPO_OFFLINE=1 npx expo start --web --localhost --port 8181',
        cwd: __dirname,
        url: 'http://localhost:8181',
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
            CI: '1',
            EXPO_NO_TELEMETRY: '1',
            EXPO_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3131',
            EXPO_PUBLIC_API_SECRET: '',
            EXPO_PUBLIC_PROVIDER_MODE: 'meta',
        },
    },
})
