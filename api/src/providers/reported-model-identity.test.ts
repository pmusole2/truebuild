import { createHash } from 'node:crypto'

import { createDemoManual } from '@truebuild/contracts'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { asRequestedMetaResponse, decodeMetaFixtureResponse } from '../test-support/meta-stream'
import { MOCK_PROVIDER_KEY, startMetaMock, type MockScenario } from '../test-support/meta-http-mock'
import { createMetaProvider, MetaProviderError, type CheckStepInput, type MetaProvider } from './meta-provider'

const signal = (): AbortSignal => new AbortController().signal

async function fixtureInput(): Promise<CheckStepInput> {
    const bytes = new Uint8Array(
        await sharp({ create: { width: 20, height: 16, channels: 3, background: 'red' } })
            .png()
            .toBuffer(),
    )
    const session = createDemoManual()
    const page = {
        ...session.pages[0]!,
        width: 20,
        height: 16,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
    }
    session.pages[0] = page
    return {
        requestId: 'identity-1',
        binding: {
            kind: 'capture',
            manualId: session.manualId,
            revision: session.revision,
            stepId: 'step-1',
            captureId: 'capture-1',
        },
        session,
        sourceImages: [{ page, bytes }],
        observation: { bytes, mimeType: 'image/png', width: 20, height: 16 },
    }
}

/** The documented loopback mock answers with the model it was asked for; `rewrite` replaces what the response says. */
async function harness(
    rewrite: Rewrite = (body) => body,
    scenario: MockScenario = 'reversed',
): Promise<{ provider: MetaProvider; dispatches(): number; close(): Promise<void> }> {
    const mock = await startMetaMock({ scenario })
    const fetchImpl: typeof fetch = async (url, init) => {
        const response = await mock.transport(url, init)
        const body = (await decodeMetaFixtureResponse(response)) as Record<string, unknown>
        return asRequestedMetaResponse(Response.json(rewrite(body), { status: response.status }), init)
    }
    return {
        provider: createMetaProvider({ apiKey: MOCK_PROVIDER_KEY, fetchImpl }),
        dispatches: () => mock.requests.length,
        close: mock.close,
    }
}

function withoutModel(body: Record<string, unknown>): Record<string, unknown> {
    const { model: _model, ...rest } = body
    return rest
}

async function rejection(work: Promise<unknown>): Promise<MetaProviderError> {
    const error = await work.then(
        () => undefined,
        (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(MetaProviderError)
    return error as MetaProviderError
}

type Rewrite = (body: Record<string, unknown>) => Record<string, unknown>
const reporting =
    (model: unknown): Rewrite =>
    (body) => ({ ...body, model })

const invalidIdentities: [string, Rewrite][] = [
    ['a different known model', reporting('muse-wonder-1.0')],
    ['an unknown model', reporting('muse-spark-9.9')],
    ['an aliased model', reporting('muse-spark-1.3-latest')],
    ['a non-string model', reporting(7)],
    ['a null model', reporting(null)],
    ['a missing model', withoutModel],
]

describe('provider-reported model identity', () => {
    it('credits a call to the model its own response reports', async () => {
        const run = await harness()
        try {
            const result = await run.provider.checkStep(await fixtureInput(), signal())
            expect(result).toMatchObject({ decision: 'refuse', model: 'muse-spark-1.3' })
            expect(result.telemetry).toMatchObject({
                stage: 'verdict',
                model: 'muse-spark-1.3',
                usage: { inputTokens: 100, cachedTokens: 50, outputTokens: 20, reasoningTokens: 5 },
            })
            expect(run.dispatches()).toBe(1)
        } finally {
            await run.close()
        }
    })

    it.each(invalidIdentities)(
        'fails a verdict closed when the response reports %s, without repair or retry',
        async (_name, rewrite) => {
            const run = await harness(rewrite)
            try {
                const error = await rejection(run.provider.checkStep(await fixtureInput(), signal()))
                expect(error.code).toBe('invalid_output')
                // No `malformed` detail: nothing may justify the one same-model repair for a wrong identity.
                expect(error.detail).toBeUndefined()
                expect(run.dispatches()).toBe(1)
                // The call still measured real time and usage, but claims no model.
                expect(error.telemetry).toBeDefined()
                expect(error.telemetry).not.toHaveProperty('model')
                expect(error.telemetry).toMatchObject({
                    stage: 'verdict',
                    usage: { inputTokens: 100, cachedTokens: 50, outputTokens: 20, reasoningTokens: 5 },
                })
                expect(error.telemetry!.providerMs).toBeGreaterThanOrEqual(0)
            } finally {
                await run.close()
            }
        },
    )

    it('never promotes a pass from a mismatched response even when its output is otherwise a valid pass', async () => {
        const run = await harness(reporting('muse-wonder-1.0'), 'correct')
        try {
            await expect(run.provider.checkStep(await fixtureInput(), signal())).rejects.toMatchObject({
                code: 'invalid_output',
            })
        } finally {
            await run.close()
        }
    })

    it.each(invalidIdentities)('fails a question closed when the response reports %s', async (_name, rewrite) => {
        const run = await harness(rewrite)
        try {
            const input = await fixtureInput()
            const error = await rejection(
                run.provider.answerQuestion(
                    { ...input, question: 'Which edge?', target: { kind: 'point', x: 0.5, y: 0.5 } },
                    signal(),
                ),
            )
            expect(error.code).toBe('invalid_output')
            expect(error.detail).toBeUndefined()
            expect(error.telemetry).not.toHaveProperty('model')
            expect(run.dispatches()).toBe(1)
        } finally {
            await run.close()
        }
    })

    it.each(invalidIdentities)('fails a parse closed when the response reports %s', async (_name, rewrite) => {
        const run = await harness(rewrite)
        try {
            const input = await fixtureInput()
            const error = await rejection(
                run.provider.parseManual(
                    {
                        requestId: 'identity-parse',
                        binding: { kind: 'manual', manualId: input.session.manualId, revision: input.session.revision },
                        pages: input.sourceImages,
                    },
                    signal(),
                ),
            )
            expect(error.code).toBe('invalid_output')
            expect(error.detail).toBeUndefined()
            expect(error.telemetry).not.toHaveProperty('model')
            expect(run.dispatches()).toBe(1)
        } finally {
            await run.close()
        }
    })

    it('credits a parse to the reported model only', async () => {
        const run = await harness()
        try {
            const input = await fixtureInput()
            const parsed = await run.provider.parseManual(
                {
                    requestId: 'identity-parse',
                    binding: { kind: 'manual', manualId: input.session.manualId, revision: input.session.revision },
                    pages: input.sourceImages,
                },
                signal(),
            )
            expect(parsed).toMatchObject({
                model: 'muse-spark-1.3',
                telemetry: { stage: 'parse', model: 'muse-spark-1.3' },
            })
        } finally {
            await run.close()
        }
    })

    it.each(invalidIdentities)('never repairs a generated screen whose response reports %s', async (_name, rewrite) => {
        const run = await harness(rewrite)
        try {
            const error = await rejection(
                run.provider.generateScreen!(
                    {
                        requestId: 'screen-identity',
                        stage: 'screens',
                        stable: {},
                        dynamic: { screen: { kind: 'home' } },
                    },
                    signal(),
                ),
            )
            expect(error.code).toBe('invalid_output')
            // The screen service repairs only `malformed`; a wrong identity must never carry that detail.
            expect(error.detail).not.toBe('malformed')
            expect(error.telemetry).not.toHaveProperty('model')
            expect(run.dispatches()).toBe(1)
        } finally {
            await run.close()
        }
    })

    it('reports a verified screen call with the response model', async () => {
        const run = await harness()
        try {
            const generation = await run.provider.generateScreen!(
                { requestId: 'screen-identity', stage: 'screens', stable: {}, dynamic: { screen: { kind: 'home' } } },
                signal(),
            )
            expect(generation.telemetry).toMatchObject({ stage: 'screens', model: 'muse-spark-1.3' })
        } finally {
            await run.close()
        }
    })

    it('does not label an incomplete response with an unverified model as repairable', async () => {
        const run = await harness((body) => ({ ...withoutModel(body), status: 'incomplete', output: [] }))
        try {
            const error = await rejection(run.provider.checkStep(await fixtureInput(), signal()))
            expect(error.code).toBe('invalid_output')
            expect(error.detail).not.toBe('malformed')
            expect(error.telemetry).not.toHaveProperty('model')
        } finally {
            await run.close()
        }
    })
})
