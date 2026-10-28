import type { ManualStep, ParsedManual } from '@truebuild/contracts'
import { unresolvedCriticalFacts } from '@truebuild/contracts/model'
import { describe, expect, it, vi } from 'vitest'

import { checkInputFor, stepFixtures, type StepFixture } from '../test-support/step-fixtures'
import { createMetaProvider, type ParseManualInput } from './meta-provider'

// MOCKED: every parse reply is a hand-written synthetic extraction served by a local fetch stub. No Meta request,
// recorded output or key is involved; this proves prompt text and validation flow only, not real model behaviour.
const UNKNOWN = { state: 'unknown' as const, reason: 'The diagram does not state a count.' }

interface ReusedCase {
    fixture: StepFixture
    /** Part introduced with a known quantity in the first step and placed/connected again in the second. */
    reused: string
    /** Part first appearing in the second step; no earlier introduction exists. */
    fresh: string
}

const CASES: ReusedCase[] = [
    { fixture: stepFixtures()[0]!, reused: 'side-panel', fresh: 'divider' },
    { fixture: stepFixtures()[1]!, reused: 'post-bracket', fresh: 'monitor-arm' },
]

async function parseInput(fixture: StepFixture): Promise<ParseManualInput> {
    const { session, sourceImages } = await checkInputFor(fixture)

    return {
        requestId: 'parse-carried',
        binding: { kind: 'manual', manualId: session.manualId, revision: session.revision },
        pages: sourceImages,
    }
}

function extraction(fixture: StepFixture): ParsedManual {
    return structuredClone(fixture.session.rawExtraction!)
}

function change(value: ParsedManual, stepIndex: number, partId: string, patch: Record<string, unknown>): ParsedManual {
    const copy = structuredClone(value)
    const step: ManualStep = copy.steps[stepIndex]!
    step.parts = step.parts.map((part) => (part.partId === partId ? { ...part, ...patch } : part))

    return copy
}

function queued(values: unknown[]): {
    provider: ReturnType<typeof createMetaProvider>
    bodies: Record<string, unknown>[]
    fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>
} {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (bodies.length > values.length) throw new Error('Unexpected additional model request')

        return Response.json({
            status: 'completed',
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: JSON.stringify(values[bodies.length - 1]) }],
                },
            ],
        })
    })

    return { provider: createMetaProvider({ apiKey: '<synthetic>', fetchImpl }), bodies, fetchImpl }
}

const signal = (): AbortSignal => new AbortController().signal

describe('parse prompt: carry a known quantity when a part is placed or connected again', (): void => {
    it('requires carrying the earlier known quantity and says an omitted later count is not unknown', async (): Promise<void> => {
        const { fixture } = CASES[0]!
        const { provider, bodies } = queued([extraction(fixture)])
        await provider.parseManual(await parseInput(fixture), signal())
        const instructions = String(bodies[0]!.instructions)
        expect(instructions).toMatch(/placed or connected again in a later step/u)
        expect(instructions).toMatch(/MUST carry the earlier known quantity/u)
        expect(instructions).toMatch(/with evidence/u)
        expect(instructions).toMatch(/not unknown merely because the later diagram omits the count/u)
    })

    it('keeps supplied-quantity blocking, English grounding, alternatives, step kinds and caps in the same request', async (): Promise<void> => {
        const { fixture } = CASES[0]!
        const { provider, bodies } = queued([extraction(fixture)])
        await provider.parseManual(await parseInput(fixture), signal())
        const body = bodies[0]!
        const instructions = String(body.instructions)
        expect(instructions).toMatch(/Never invent a quantity/u)
        expect(instructions).toMatch(/truly unstated/u)
        expect(instructions).toMatch(/still unresolved/u)
        expect(instructions).toContain('Selected parse language: en')
        expect(instructions).toMatch(/mutually exclusive or optional methods/u)
        expect(instructions).toMatch(/Set kind to assembly for placing or mounting parts/u)
        expect(body.max_output_tokens).toBe(24000)
    })

    it('keeps the added carry wording free of brand or manual specific strings', async (): Promise<void> => {
        const { fixture } = CASES[1]!
        const { provider, bodies } = queued([extraction(fixture)])
        await provider.parseManual(await parseInput(fixture), signal())
        expect(String(bodies[0]!.instructions)).not.toMatch(
            /treadmill|monitor|bracket|bolt|side-panel|divider|demo-page/iu,
        )
    })
})

describe.each(CASES)(
    'MOCKED carried_over regression on the $fixture.name manual',
    ({ fixture, reused, fresh }): void => {
        const refsPage = (index: number): { pageId: string; region: null }[] => [
            { pageId: fixture.session.pages[index]!.pageId, region: null },
        ]

        it('resolves a reused part to a carried_over quantity after the repair, with no unresolved facts', async (): Promise<void> => {
            const clean = extraction(fixture)
            // First reply: the later diagram omits the count, so the model leaves the reused quantity unknown.
            const omitted = change(clean, 1, reused, { quantity: UNKNOWN, quantityBasis: null })
            const carried = change(clean, 1, reused, {
                quantityBasis: {
                    kind: 'carried_over',
                    stepId: clean.steps[0]!.stepId,
                    partId: reused,
                    sourceRefs: refsPage(fixture.session.pages.length - 1),
                },
            })
            const { provider, bodies, fetchImpl } = queued([omitted, carried])
            const result = await provider.parseManual(await parseInput(fixture), signal())
            expect(fetchImpl).toHaveBeenCalledTimes(2)
            expect(String(bodies[1]!.instructions)).toContain(`quantity of ${reused}`)
            expect(result.steps[1]!.parts.find((part) => part.partId === reused)).toMatchObject({
                quantity: { state: 'known' },
                quantityBasis: { kind: 'carried_over', stepId: clean.steps[0]!.stepId, partId: reused },
            })
            expect(unresolvedCriticalFacts({ parts: result.parts, reviewedSteps: result.steps })).toEqual([])
        })

        it('accepts the carried reply on the first attempt with exactly one dispatch', async (): Promise<void> => {
            const clean = extraction(fixture)
            const carried = change(clean, 1, reused, {
                quantityBasis: {
                    kind: 'carried_over',
                    stepId: clean.steps[0]!.stepId,
                    partId: reused,
                    sourceRefs: refsPage(0),
                },
            })
            const { provider, fetchImpl } = queued([carried])
            await provider.parseManual(await parseInput(fixture), signal())
            expect(fetchImpl).toHaveBeenCalledTimes(1)
        })

        it('keeps a truly unstated supplied part unknown and blocking after the single repair', async (): Promise<void> => {
            const unstated = change(extraction(fixture), 1, fresh, { quantity: UNKNOWN, quantityBasis: null })
            const { provider, fetchImpl } = queued([unstated, unstated])
            const result = await provider.parseManual(await parseInput(fixture), signal())
            expect(fetchImpl).toHaveBeenCalledTimes(2)
            expect(result.steps[1]!.parts.find((part) => part.partId === fresh)!.quantity).toEqual(UNKNOWN)
            expect(unresolvedCriticalFacts({ parts: result.parts, reviewedSteps: result.steps })).toEqual([
                expect.stringContaining(`quantity of ${fresh}`),
            ])
        })

        it('does not accept a carry for a part with no earlier introduction', async (): Promise<void> => {
            const forged = change(extraction(fixture), 1, fresh, {
                quantityBasis: {
                    kind: 'carried_over',
                    stepId: extraction(fixture).steps[0]!.stepId,
                    partId: fresh,
                    sourceRefs: refsPage(0),
                },
            })
            const { provider } = queued([forged])
            await expect(provider.parseManual(await parseInput(fixture), signal())).rejects.toMatchObject({
                code: 'invalid_output',
            })
        })
    },
)
