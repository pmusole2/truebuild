import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { checkInputFor, stepFixtures, type StepFixture } from '../test-support/step-fixtures'
import { metaLayoutOutputSchemas, metaOutputSchemas } from './meta-schemas'
import { createMetaProvider, type MetaProviderOptions } from './meta-provider'

// MOCKED: every provider reply below is a hand-written synthetic value served by a local fetch stub. No Meta request,
// recorded model output, key or network is involved, and nothing here measures real accuracy or latency.
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

// Fingerprints of the cf2260d check/ask request, captured from that commit before this change.
const CF2260D = {
    instructionsLength: 6884,
    instructionsSha: '7fc297d2f0e17b4de75c7fde9c30798f5a2f7965fbbe8a1080f0f8ef9e186cf6',
    checkSchemaSha: '494e17b261b81d694815c7ec811385aec4bedbae25c110438191b9b707984f2f',
    questionSchemaSha: 'a2725e6d45b1b183e4449caddde2687c3da82e2efd4f47ddf9538854718475fa',
    keys: ['model', 'store', 'stream', 'max_output_tokens', 'reasoning', 'instructions', 'input', 'text'],
}

const grid = { x1: 100, y1: 200, x2: 400, y2: 600 }
const verdict = {
    decision: 'cannot_verify',
    orientationAssessment: 'uncertain',
    reason: 'Synthetic mocked result',
    sourceRefs: [],
    observedRegion: null,
    missingEvidence: ['Need a clearer view'],
    partsAssessment: 'unobservable',
    connectionAssessment: 'unobservable',
    checks: [],
}
const answer = {
    answer: 'Synthetic mocked answer',
    sourceRefs: [],
    missingEvidence: ['Need a clearer view'],
    observedRegion: null,
}

/** `model` is what the response reports; a real response echoes the model it was asked for. */
function envelope(value: unknown, model = 'muse-spark-1.3'): Response {
    return Response.json({
        status: 'completed',
        model,
        output: [
            {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: JSON.stringify(value) }],
            },
        ],
    })
}

type Body = Record<string, unknown> & {
    instructions: string
    max_output_tokens: number
    reasoning: unknown
    input: unknown
    text: { format: { name: string; schema: unknown; strict: boolean } }
}

function mocked(
    reply: unknown,
    options: Partial<MetaProviderOptions> = {},
): {
    provider: ReturnType<typeof createMetaProvider>
    bodies: Body[]
    fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>
} {
    const bodies: Body[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
        const body = JSON.parse(String(init?.body)) as Body
        bodies.push(body)
        return envelope(reply, String(body.model))
    })
    return { provider: createMetaProvider({ apiKey: '<synthetic>', fetchImpl, ...options }), bodies, fetchImpl }
}

const signal = (): AbortSignal => new AbortController().signal

describe.each(stepFixtures())('MOCKED check/ask request shape on the $name manual', (fixture: StepFixture): void => {
    const askInput = async (): Promise<Parameters<ReturnType<typeof createMetaProvider>['answerQuestion']>[0]> => ({
        ...(await checkInputFor(fixture)),
        question: 'Where does this part go?',
        target: { kind: 'part', partId: fixture.partId },
    })

    describe('flag off (default)', (): void => {
        it('sends the byte-identical cf2260d check request, same cap and one dispatch', async (): Promise<void> => {
            const { provider, bodies, fetchImpl } = mocked(verdict)
            await provider.checkStep(await checkInputFor(fixture), signal())
            expect(fetchImpl).toHaveBeenCalledTimes(1)
            const body = bodies[0]!
            expect(Object.keys(body)).toEqual(CF2260D.keys)
            expect(sha(body.instructions)).toBe(CF2260D.instructionsSha)
            expect(sha(JSON.stringify(body.text.format.schema))).toBe(CF2260D.checkSchemaSha)
            expect(body.text.format).toMatchObject({ name: 'truebuild_check', strict: true })
            expect(body.text.format.schema).toEqual(metaOutputSchemas.check)
            expect(body.max_output_tokens).toBe(1500)
            expect(body.reasoning).toEqual({ effort: 'low' })
        })

        it('preserves cf2260d ask instructions and schema with quality output headroom and one dispatch', async (): Promise<void> => {
            const { provider, bodies, fetchImpl } = mocked(answer)
            await provider.answerQuestion(await askInput(), signal())
            expect(fetchImpl).toHaveBeenCalledTimes(1)
            const body = bodies[0]!
            expect(Object.keys(body)).toEqual(CF2260D.keys)
            expect(sha(body.instructions)).toBe(CF2260D.instructionsSha)
            expect(sha(JSON.stringify(body.text.format.schema))).toBe(CF2260D.questionSchemaSha)
            expect(body.max_output_tokens).toBe(32000)
        })

        it('returns no layout or region even if a stray reply carried them', async (): Promise<void> => {
            const stray = {
                ...verdict,
                layout: { components: [{ type: 'part_grid', partIds: [fixture.partId] }] },
                nextPartRegion: { partId: fixture.partId, region: grid },
            }
            const { provider } = mocked(stray)
            const result = await provider.checkStep(await checkInputFor(fixture), signal())
            expect(result).not.toHaveProperty('layout')
            expect(result).not.toHaveProperty('nextPartRegion')
            expect(result).not.toHaveProperty('targetRegion')
        })
    })

    describe('MODEL_LAYOUT=1', (): void => {
        it('extends the same single check request: layout schema, appended prompt, unchanged cap and input', async (): Promise<void> => {
            const off = mocked(verdict)
            await off.provider.checkStep(await checkInputFor(fixture), signal())
            const on = mocked(verdict, { layout: true })
            await on.provider.checkStep(await checkInputFor(fixture), signal())
            expect(on.fetchImpl).toHaveBeenCalledTimes(1)
            const before = off.bodies[0]!
            const after = on.bodies[0]!
            expect(after.text.format.schema).toEqual(metaLayoutOutputSchemas.check)
            expect(after.text.format).toMatchObject({ name: 'truebuild_check', strict: true })
            expect(after.instructions.startsWith(before.instructions)).toBe(true)
            expect(after.instructions).toContain('nextPartRegion')
            expect(after.instructions).toContain('targetRegion')
            expect(after.instructions).toContain('layout')
            // The stable cached prefix (manual context, pages, step, observation) is untouched.
            expect(after.input).toEqual(before.input)
            expect(after.max_output_tokens).toBe(1500)
            expect(after.reasoning).toEqual({ effort: 'low' })
            expect(Object.keys(after)).toEqual(CF2260D.keys)
        })

        it('extends the same single ask request without extra dispatch', async (): Promise<void> => {
            const { provider, bodies, fetchImpl } = mocked(answer, { layout: true })
            await provider.answerQuestion(await askInput(), signal())
            expect(fetchImpl).toHaveBeenCalledTimes(1)
            expect(bodies[0]!.text.format.schema).toEqual(metaLayoutOutputSchemas.question)
            expect(bodies[0]!.max_output_tokens).toBe(32000)
            expect(bodies[0]!.instructions).toContain('nextPartRegion')
        })

        it('keeps the prompt closed-set and free of text, safety, style, markup, URL and code authoring', async (): Promise<void> => {
            const { provider, bodies } = mocked(verdict, { layout: true })
            await provider.checkStep(await checkInputFor(fixture), signal())
            const added = bodies[0]!.instructions.slice(CF2260D.instructionsLength)
            expect(added).toMatch(/Never write text/u)
            expect(added).toMatch(/warnings|safety/iu)
            for (const type of [
                'part_grid',
                'orientation',
                'connection',
                'visible_checks',
                'source_diagram',
                'recovery',
            ]) {
                expect(added).toContain(type)
            }
            expect(added).not.toMatch(/manufacturer_warning|spec_note/u)
        })

        it('returns a valid layout and converts grid regions to normalized public regions', async (): Promise<void> => {
            const reply = {
                ...verdict,
                layout: { components: [{ type: 'part_grid', partIds: [fixture.partId] }] },
                nextPartRegion: { partId: fixture.partId, region: grid },
                targetRegion: { partId: fixture.partId, region: { x1: 500, y1: 500, x2: 900, y2: 900 } },
            }
            const { provider } = mocked(reply, { layout: true })
            const result = await provider.checkStep(await checkInputFor(fixture), signal())
            expect(result).toMatchObject({
                decision: 'cannot_verify',
                model: 'muse-spark-1.3',
                layout: reply.layout,
                nextPartRegion: { partId: fixture.partId, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
                targetRegion: { partId: fixture.partId, region: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 } },
            })
        })

        it.each([
            ['unknown component', { components: [{ type: 'banner' }] }],
            ['extra keys', { components: [{ type: 'part_grid', partIds: ['a'] }], style: 'x' }],
            ['free text', 'show a warning'],
            ['oversized', { components: Array.from({ length: 9 }, () => ({ type: 'part_grid', partIds: ['a'] })) }],
        ])('drops a %s layout and still returns the verdict', async (_label, layout): Promise<void> => {
            const { provider, fetchImpl } = mocked({ ...verdict, layout }, { layout: true })
            const result = await provider.checkStep(await checkInputFor(fixture), signal())
            expect(result).toMatchObject({ decision: 'cannot_verify', reason: verdict.reason })
            expect(result).not.toHaveProperty('layout')
            expect(fetchImpl).toHaveBeenCalledTimes(1)
        })

        it('states the compact budget in the added prompt and keeps it small', async (): Promise<void> => {
            const { provider, bodies } = mocked(verdict, { layout: true })
            await provider.checkStep(await checkInputFor(fixture), signal())
            const added = bodies[0]!.instructions.slice(CF2260D.instructionsLength)
            expect(added).toMatch(/at most 3 components/u)
            expect(added).toMatch(/at most 3 ids or indexes/iu)
            expect(added).toMatch(/at most 48 characters/u)
            expect(added).toMatch(/600 UTF-8 bytes/u)
            expect(added).toMatch(/192 UTF-8 bytes/u)
            expect(added).toMatch(/same partId/u)
            expect(added).not.toMatch(/at most 8/u)
            expect(Buffer.byteLength(added, 'utf8')).toBeLessThan(2_400)
        })

        it.each([-1, 1001])(
            'drops a returned region with a coordinate %s instead of clamping it',
            async (raw): Promise<void> => {
                const reply = {
                    ...verdict,
                    nextPartRegion: { partId: fixture.partId, region: { ...grid, x1: raw } },
                    targetRegion: { partId: fixture.partId, region: { ...grid, y2: raw } },
                }
                const { provider } = mocked(reply, { layout: true })
                const result = await provider.checkStep(await checkInputFor(fixture), signal())
                expect(result).toMatchObject({ decision: 'cannot_verify', reason: verdict.reason })
                expect(result).not.toHaveProperty('nextPartRegion')
                expect(result).not.toHaveProperty('targetRegion')
            },
        )

        it('drops an over-budget layout while keeping the verdict and valid regions (service then falls back)', async (): Promise<void> => {
            const id = (tag: number): string => `${tag}${'é'.repeat(47)}`
            const layout = {
                components: [
                    { type: 'part_grid', partIds: [id(1), id(2), id(3)] },
                    { type: 'visible_checks', checkIds: [id(4), id(5), id(6)] },
                ],
            }
            expect(Buffer.byteLength(JSON.stringify(layout), 'utf8')).toBeGreaterThan(600)
            const { provider } = mocked(
                { ...verdict, layout, nextPartRegion: { partId: fixture.partId, region: grid } },
                { layout: true },
            )
            const result = await provider.checkStep(await checkInputFor(fixture), signal())
            expect(result).not.toHaveProperty('layout')
            expect(result).toMatchObject({ nextPartRegion: { partId: fixture.partId } })
        })

        it('treats null layout and regions as absence', async (): Promise<void> => {
            const { provider } = mocked(
                { ...verdict, layout: null, nextPartRegion: null, targetRegion: null },
                { layout: true },
            )
            const result = await provider.checkStep(await checkInputFor(fixture), signal())
            expect(result).not.toHaveProperty('layout')
            expect(result).not.toHaveProperty('nextPartRegion')
            expect(result).not.toHaveProperty('targetRegion')
        })
    })

    describe('second opinion request (separate Wonder flag)', (): void => {
        const second = { secondOpinionModel: 'muse-wonder-1.0' } as const

        it.each([
            ['no flags', {}],
            ['MODEL_LAYOUT only', { layout: true }],
            ['MODEL_LAYOUT_WONDER without MODEL_LAYOUT', { layoutWonder: true }],
        ])('is the cf2260d Wonder request with %s', async (_label, flags): Promise<void> => {
            const { provider, bodies } = mocked(verdict, { ...second, ...flags })
            await provider.secondOpinion?.(await checkInputFor(fixture), signal())
            const body = bodies[0]!
            expect(sha(body.instructions)).toBe(CF2260D.instructionsSha)
            expect(sha(JSON.stringify(body.text.format.schema))).toBe(CF2260D.checkSchemaSha)
            expect(body.max_output_tokens).toBe(32000)
            expect(body.reasoning).toEqual({ effort: 'max' })
        })

        it('adds layout and regions only when both MODEL_LAYOUT and MODEL_LAYOUT_WONDER are on', async (): Promise<void> => {
            const { provider, bodies, fetchImpl } = mocked(verdict, { ...second, layout: true, layoutWonder: true })
            await provider.secondOpinion?.(await checkInputFor(fixture), signal())
            expect(fetchImpl).toHaveBeenCalledTimes(1)
            expect(bodies[0]!.text.format.schema).toEqual(metaLayoutOutputSchemas.check)
            expect(bodies[0]!.instructions).toContain('nextPartRegion')
            expect(bodies[0]!.max_output_tokens).toBe(32000)
        })
    })
})
