/** Explicit tests-only real-mode API composition. No .env loading and no upstream-host override. */
import { z } from 'zod'
import { serve } from '@hono/node-server'
import { createApp } from '../src/app'
import { createRuntimeFromEnvironment } from '../src/server/model-runtime'
import { startMetaMock } from '../src/test-support/meta-http-mock'

if (!process.argv.includes('--test-only') || process.env.MODEL_API_KEY?.trim()) {
    throw new Error('mock_requires_test_only_and_no_real_key')
}
const port = Number(process.env.PORT ?? '3001')
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port')
const scenarioArgs = process.argv.slice(2).filter((arg) => arg.startsWith('--scenario='))
if (
    scenarioArgs.length > 1 ||
    process.argv.slice(2).some((arg) => arg !== '--test-only' && !arg.startsWith('--scenario='))
)
    throw new Error('invalid_mock_arguments')
const scenario = z
    .enum(['correct', 'reversed', 'uncertain'])
    .parse(scenarioArgs[0]?.slice('--scenario='.length) ?? 'uncertain')
const runtime = createRuntimeFromEnvironment(
    {
        PROVIDER_MODE: 'meta',
        MODEL_API_KEY: '<synthetic>',
        API_SHARED_SECRET: 'truebuild-fixture-demo',
        MODEL_CALL_LIMIT: '200',
        MODEL_CHECK_CONTEXT: process.env.MODEL_CHECK_CONTEXT,
        CORS_ORIGINS: process.env.CORS_ORIGINS,
    },
    (url, init) => {
        return mock.transport(url, init)
    },
)
const mock = await startMetaMock({ scenario })
const server = serve({ fetch: createApp({ runtime }).fetch, hostname: '127.0.0.1', port }, () => {
    console.info('TEST MOCK ONLY: Meta-mode transport, no real inference or acceptance')
})
let stopped = false
async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    if ('closeAllConnections' in server) server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await mock.close()
}
process.once('SIGINT', () => {
    void stop()
})
process.once('SIGTERM', () => {
    void stop()
})
