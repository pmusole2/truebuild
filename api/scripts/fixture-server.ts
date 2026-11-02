/** Isolated fixture stack only. It has no live-provider construction or environment credential access. */
import { serve } from '@hono/node-server'
import { SCREEN_KINDS_V2, type ScreenKindV2 } from '@truebuild/contracts'
import { createNativeFixtureApp, type NativeFixtureOptions } from '../src/test-support/native-fixture-app'

if (process.env.PROVIDER_MODE !== 'fixture' || process.env.PORT !== '3101') {
    throw new Error('The native fixture API requires PROVIDER_MODE=fixture and PORT=3101')
}
if (process.argv.slice(2).length > 0) throw new Error('The fixture API accepts no command-line arguments')
const mode = process.env.GENERATIVE_UI ?? 'full'
if (mode !== 'full' && mode !== 'steps' && mode !== 'off') throw new Error('Invalid fixture UI mode')
const listed = (process.env.TRUEBUILD_FIXTURE_DOCUMENT_FAILURES ?? '').split(',').filter(Boolean)
if (listed.some((kind) => !(SCREEN_KINDS_V2 as readonly string[]).includes(kind))) {
    throw new Error('Unknown fixture failure kind')
}
const invalidDocumentKinds = listed as ScreenKindV2[]
const scenarios = [
    'full',
    'all-pass',
    'no-overlay',
    'no-mask',
    'parse-unavailable',
    'check-unavailable',
    'overlay-unavailable',
] as const
const scenario = process.env.TRUEBUILD_FIXTURE_SCENARIO ?? 'full'
if (!(scenarios as readonly string[]).includes(scenario)) throw new Error('Unknown fixture scenario')

// Fixture work has no observed provider model, effort, tokens or latency. Keep only safe outcome classification.
const info = console.info.bind(console)
console.info = (message: unknown): void => {
    if (typeof message === 'string' && message.startsWith('{')) {
        let value: unknown
        try {
            value = JSON.parse(message)
        } catch {
            info('Fixture log omitted: malformed structured message')
            return
        }
        if (typeof value === 'object' && value !== null) {
            const safe = Object.fromEntries(
                ['event', 'route', 'outcome', 'http', 'code', 'path', 'op', 'kind'].flatMap((key) =>
                    key in value ? [[key, (value as Record<string, unknown>)[key]]] : [],
                ),
            )
            info(JSON.stringify({ ...safe, evidence: 'synthetic-fixture', inference: false }))
            return
        }
    }
    info(message)
}

const app = createNativeFixtureApp({
    generativeUi: mode,
    invalidDocumentKinds,
    overlayDelayMs: 12_000,
    scenario: scenario as NativeFixtureOptions['scenario'],
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3101 }, (): void => {
    info('Fixture API:127.0.0.1:3101; synthetic inputs and documents; no inference; provider metrics unknown')
})
const stop = (): void => {
    if ('closeAllConnections' in server) server.closeAllConnections()
    server.close()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
