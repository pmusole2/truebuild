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
const args = process.argv.slice(2)
const flags = [
    '--scenario=',
    '--second-opinion=',
    '--second-opinion-delay-ms=',
    '--follow-ups=',
    '--question-delay-ms=',
]
if (
    args.some((arg) => arg !== '--test-only' && !flags.some((flag) => arg.startsWith(flag))) ||
    flags.some((flag) => args.filter((arg) => arg.startsWith(flag)).length > 1)
)
    throw new Error('invalid_mock_arguments')
const flag = (name: string): string | undefined => args.find((arg) => arg.startsWith(name))?.slice(name.length)
const scenario = z.enum(['correct', 'reversed', 'uncertain']).parse(flag('--scenario=') ?? 'uncertain')
const secondOpinion = z.enum(['correct', 'reversed', 'uncertain', 'failed']).optional().parse(flag('--second-opinion='))
const delayMs = z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .parse(flag('--second-opinion-delay-ms=') ?? '0')
if (delayMs && !secondOpinion) throw new Error('invalid_mock_arguments')
// The accepted regression stack keeps the still-highlight verdict. `--follow-ups=on` offers the Wonder overlay and SAM
// stages instead (the verdict then carries no geometry), exactly as an unconfigured-flag production runtime does.
const followUps = z.enum(['on', 'off']).parse(flag('--follow-ups=') ?? 'off') === 'on'
// A slow question: the simulated provider holds the answer this long. Longer than QUESTION_SYNC_WAIT_MS (8 s by default,
// or the value passed through the environment) the route answers 202 and the app collects the answer with its ticket.
const questionDelayMs = z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .parse(flag('--question-delay-ms=') ?? '0')
const runtime = createRuntimeFromEnvironment(
    {
        PROVIDER_MODE: 'meta',
        GENERATIVE_UI: process.env.GENERATIVE_UI,
        MODEL_API_KEY: '<synthetic>',
        MODEL_SECOND_OPINION: secondOpinion ? 'muse-wonder-1.0' : undefined,
        API_SHARED_SECRET: 'truebuild-fixture-demo',
        MODEL_CALL_LIMIT_PER_DAY: '200',
        // One isolated test process serves multiple independent synthetic clients/scenarios.
        PARSE_LIMIT_PER_HOUR: '1000',
        MODEL_LAYOUT_WONDER: followUps ? undefined : '0',
        MODEL_SEGMENTS: followUps ? undefined : '0',
        MODEL_CHECK_CONTEXT: process.env.MODEL_CHECK_CONTEXT,
        CORS_ORIGINS: process.env.CORS_ORIGINS,
        QUESTION_SYNC_WAIT_MS: process.env.QUESTION_SYNC_WAIT_MS,
    },
    (url, init) => {
        return mock.transport(url, init)
    },
)
const mock = await startMetaMock({
    scenario,
    secondOpinion: secondOpinion ? { scenario: secondOpinion, delayMs } : undefined,
    question: questionDelayMs ? { delayMs: questionDelayMs } : undefined,
})
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
