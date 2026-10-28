import { createHash } from 'node:crypto'
import { createDemoManual, type ManualStep, type ParsedManual } from '@truebuild/contracts'
import { MAX_PARSE_PAGES } from '@truebuild/contracts/model'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

import { createMetaProvider, parseFirstAttemptTimeoutMs, stepRefs, type ParseManualInput } from './meta-provider'

// Everything here is synthetic and mocked: no recorded provider output, no live request.
const CITED = [{ pageId: 'demo-page-1', region: null }]
const UNKNOWN = { state: 'unknown' as const, reason: 'The manual does not state this.' }

function envelope(value: unknown): Record<string, unknown> {
    return {
        status: 'completed',
        output: [
            {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: JSON.stringify(value) }],
            },
        ],
    }
}

async function fixture(pageCount = 1): Promise<{ input: ParseManualInput; clean: ParsedManual }> {
    const session = createDemoManual()
    const pages: ParseManualInput['pages'] = []
    for (let index = 0; index < pageCount; index += 1) {
        const bytes = await sharp({
            create: { width: 8, height: 4, channels: 3, background: { r: index * 20, g: 9, b: 9 } },
        })
            .png()
            .toBuffer()
        pages.push({
            page: {
                ...session.pages[0]!,
                pageId: index === 0 ? session.pages[0]!.pageId : `demo-page-${index + 1}`,
                assetId: index === 0 ? session.pages[0]!.assetId : `demo-asset-${index + 1}`,
                width: 8,
                height: 4,
                mimeType: 'image/png',
                contentHash: createHash('sha256').update(bytes).digest('hex'),
            },
            bytes,
        })
    }
    return {
        input: {
            requestId: 'parse-versatility',
            binding: { kind: 'manual', manualId: session.manualId, revision: session.revision },
            pages,
        },
        clean: structuredClone(session.rawExtraction!),
    }
}

function queued(
    values: unknown[],
    options: { parseModel?: 'muse-spark-1.3' | 'muse-wonder-1.0' } = {},
): {
    provider: ReturnType<typeof createMetaProvider>
    fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>
    bodies: Record<string, unknown>[]
} {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (bodies.length > values.length) throw new Error('Unexpected additional model request')
        return Response.json(envelope(values[bodies.length - 1]))
    })
    return { provider: createMetaProvider({ apiKey: '<synthetic>', ...options, fetchImpl }), fetchImpl, bodies }
}

function withStep(clean: ParsedManual, change: Partial<ManualStep>): ParsedManual {
    const value = structuredClone(clean)
    value.steps[0] = { ...value.steps[0]!, ...change }
    return value
}

function content(body: Record<string, unknown>): { type: string; text?: string }[] {
    const input = body.input as { content: { type: string; text?: string }[] }[]
    return input[0]!.content
}

function manualContext(body: Record<string, unknown>): Record<string, unknown> {
    const first = content(body)[0]!
    return (JSON.parse(first.text!) as { manualContext: Record<string, unknown> }).manualContext
}

const alternatives = [
    { alternativeId: 'wall', title: 'Wall route', description: 'Route the cable along the wall.', sourceRefs: CITED },
    {
        alternativeId: 'floor',
        title: 'Floor route',
        description: 'Route the cable under the floor.',
        sourceRefs: CITED,
    },
]

describe('parse prompt for versatile manuals', () => {
    it('preserves language-neutral diagram grounding while filtering printed text blocks', async () => {
        const { input, clean } = await fixture()
        const { provider, bodies } = queued([clean])
        await provider.parseManual(input, new AbortController().signal)
        expect(String(bodies[0]!.instructions)).toContain('Language-neutral diagrams remain valid grounding')
        expect(String(bodies[0]!.instructions)).toContain('This language filter applies to printed text only')
    })

    it('asks for one parent step with cited alternatives and a recorded selection', async () => {
        const { input, clean } = await fixture()
        const { provider, bodies } = queued([clean])
        await provider.parseManual(input, new AbortController().signal)
        const instructions = String(bodies[0]!.instructions)
        expect(instructions).toMatch(/mutually exclusive or optional methods/u)
        expect(instructions).toMatch(/ONE parent step/u)
        expect(instructions).toContain('alternatives')
        expect(instructions).toContain('selectedAlternativeId')
        expect(instructions).toMatch(/explicit default/u)
        expect(instructions).toMatch(/first alternative as printed/u)
        expect(instructions).toMatch(/only the selected path/u)
        expect(instructions).toMatch(/never in the required parts or the part registry/u)
    })

    it('forbids invented quantities and names the cited user-supplied and not-specified basis', async () => {
        const { input, clean } = await fixture()
        const { provider, bodies } = queued([clean])
        await provider.parseManual(input, new AbortController().signal)
        const instructions = String(bodies[0]!.instructions)
        expect(instructions).toMatch(/Never invent a quantity/u)
        expect(instructions).toContain('quantityBasis')
        expect(instructions).toContain('user_supplied')
        expect(instructions).toContain('not_specified')
        expect(instructions).toMatch(/quantity unknown/u)
    })

    it('distinguishes assembly steps from adjust, connect, tighten and route steps', async () => {
        const { input, clean } = await fixture()
        const { provider, bodies } = queued([clean])
        await provider.parseManual(input, new AbortController().signal)
        const instructions = String(bodies[0]!.instructions)
        for (const kind of ['assembly', 'adjust', 'connect', 'tighten', 'route']) expect(instructions).toContain(kind)
        expect(instructions).toContain('requirements')
        expect(instructions).toMatch(
            /Assembly steps always need orientation, connection and at least one visible check/u,
        )
        expect(instructions).toMatch(/never invent a camera-observable check/iu)
    })

    it('still sends every ordered page image with the parse operation last', async () => {
        const { input, clean } = await fixture(3)
        const { provider, bodies } = queued([clean])
        await provider.parseManual(input, new AbortController().signal)
        const kinds = content(bodies[0]!).map((block) => block.type)
        expect(kinds).toEqual(['input_text', 'input_image', 'input_image', 'input_image', 'input_text'])
    })
})

describe('parse validation of alternatives, quantity basis and step kinds', () => {
    it('accepts one parent step with two cited alternatives and a recorded selection without a repair', async () => {
        const { input, clean } = await fixture()
        const value = withStep(clean, { alternatives, selectedAlternativeId: 'wall' })
        const { provider, fetchImpl } = queued([value])
        const result = await provider.parseManual(input, new AbortController().signal)
        expect(result.steps).toHaveLength(clean.steps.length)
        expect(result.steps[0]).toMatchObject({ selectedAlternativeId: 'wall', alternatives })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['selection is not an alternative', { alternatives, selectedAlternativeId: 'ceiling' }],
        ['selection is missing', { alternatives, selectedAlternativeId: null }],
        [
            'alternative cites an unsupplied page',
            {
                alternatives: [
                    { ...alternatives[0]!, sourceRefs: [{ pageId: 'ghost', region: null }] },
                    alternatives[1]!,
                ],
                selectedAlternativeId: 'wall',
            },
        ],
        [
            'alternative ids repeat',
            { alternatives: [alternatives[0]!, alternatives[0]!], selectedAlternativeId: 'wall' },
        ],
    ] as const)('rejects an extraction where the %s', async (_label, change) => {
        const { input, clean } = await fixture()
        const { provider, fetchImpl } = queued([withStep(clean, change as Partial<ManualStep>)])
        await expect(provider.parseManual(input, new AbortController().signal)).rejects.toMatchObject({
            code: 'invalid_output',
        })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it.each(['user_supplied', 'not_specified'] as const)(
        'keeps a %s quantity unknown without spending a repair',
        async (kind) => {
            const { input, clean } = await fixture()
            const step = clean.steps[0]!
            const value = withStep(clean, {
                parts: step.parts.map((part) => ({
                    ...part,
                    quantity: UNKNOWN,
                    quantityBasis: { kind, sourceRefs: CITED },
                })),
            })
            const { provider, fetchImpl } = queued([value])
            const result = await provider.parseManual(input, new AbortController().signal)
            expect(result.steps[0]!.parts[0]).toMatchObject({ quantity: UNKNOWN, quantityBasis: { kind } })
            expect(fetchImpl).toHaveBeenCalledTimes(1)
        },
    )

    it('keeps an ungrounded unknown quantity as an unresolved fact and spends the single repair', async () => {
        const { input, clean } = await fixture()
        const step = clean.steps[0]!
        const ungrounded = withStep(clean, {
            parts: step.parts.map((part) => ({ ...part, quantity: UNKNOWN, quantityBasis: null })),
        })
        const { provider, fetchImpl, bodies } = queued([ungrounded, ungrounded])
        const result = await provider.parseManual(input, new AbortController().signal)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(String(bodies[1]!.instructions)).toContain('quantity of')
        expect(result.steps[0]!.parts[0]!.quantity).toEqual(UNKNOWN)
    })

    it('accepts a tighten step without orientation, connection or visible checks and no repair', async () => {
        const { input, clean } = await fixture()
        const value = withStep(clean, {
            kind: 'tighten',
            requirements: null,
            parts: [],
            orientation: UNKNOWN,
            connection: UNKNOWN,
            visibleChecks: [],
        })
        const { provider, fetchImpl } = queued([value])
        const result = await provider.parseManual(input, new AbortController().signal)
        expect(result.steps[0]).toMatchObject({ kind: 'tighten', visibleChecks: [] })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('does not waive the same missing evidence for an assembly step', async () => {
        const { input, clean } = await fixture()
        const value = withStep(clean, {
            kind: 'assembly',
            orientation: UNKNOWN,
            connection: UNKNOWN,
            visibleChecks: [],
        })
        const { provider, fetchImpl, bodies } = queued([value, value])
        await provider.parseManual(input, new AbortController().signal)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(String(bodies[1]!.instructions)).toContain('visible checks are missing')
    })

    it('counts quantity-basis and alternative citations as step source references', () => {
        const step = createDemoManual().reviewedSteps[0]!
        const basis = { pageId: 'basis-page', region: null }
        const alternative = { pageId: 'alternative-page', region: null }
        const refs = stepRefs({
            ...step,
            parts: [
                { ...step.parts[0]!, quantity: UNKNOWN, quantityBasis: { kind: 'user_supplied', sourceRefs: [basis] } },
            ],
            alternatives: [
                { ...alternatives[0]!, sourceRefs: [alternative] },
                { ...alternatives[1]!, sourceRefs: CITED },
            ],
            selectedAlternativeId: 'wall',
        })
        expect(refs).toContainEqual(basis)
        expect(refs).toContainEqual(alternative)
    })
})

describe('parse prompt and validation for carried-over quantities', () => {
    // All values are synthetic: a mocked provider reply, never a recorded or live extraction.
    function carriedManual(clean: ParsedManual, steps = 2): ParsedManual {
        const value = structuredClone(clean)
        const anchor = value.steps[1]!
        // Step 2 reuses the part introduced in step 1 and copies its known quantity.
        anchor.parts = anchor.parts.map((part) =>
            part.partId === 'side-panel'
                ? {
                      ...part,
                      quantityBasis: {
                          kind: 'carried_over',
                          stepId: 'step-1',
                          partId: 'side-panel',
                          sourceRefs: CITED,
                      },
                  }
                : part,
        )
        for (let order = 3; order <= steps; order += 1) {
            const previous = value.steps[order - 2]!
            value.steps.push({
                ...structuredClone(previous),
                stepId: `step-${order}`,
                order,
                title: `Continue assembly ${order}`,
                visibleChecks: previous.visibleChecks.map((check) => ({
                    ...check,
                    checkId: `${check.checkId}-${order}`,
                })),
                correction: null,
                parts: previous.parts.map((part) =>
                    part.partId === 'side-panel'
                        ? {
                              ...part,
                              quantityBasis: {
                                  kind: 'carried_over',
                                  stepId: previous.stepId,
                                  partId: 'side-panel',
                                  sourceRefs: CITED,
                              },
                          }
                        : part,
                ),
            })
        }
        return value
    }

    function setPart(value: ParsedManual, stepIndex: number, change: Record<string, unknown>): ParsedManual {
        const copy = structuredClone(value)
        const step = copy.steps[stepIndex]!
        step.parts = step.parts.map((part) => (part.partId === 'side-panel' ? { ...part, ...change } : part))
        return copy
    }

    it('adds a carried_over instruction for earlier known same-part quantities without changing earlier guidance', async () => {
        const { input, clean } = await fixture()
        const { provider, bodies } = queued([clean])
        await provider.parseManual(input, new AbortController().signal)
        const instructions = String(bodies[0]!.instructions)
        expect(instructions).toContain('carried_over')
        expect(instructions).toMatch(/earlier step/u)
        expect(instructions).toMatch(/same part/u)
        expect(instructions).toMatch(/copy the earlier known quantity/u)
        expect(instructions).toMatch(/never fabricate/iu)
        expect(instructions).toMatch(/unresolved/u)
        // The existing quantity, alternatives, step kind and language lines remain present.
        expect(instructions).toMatch(/Never invent a quantity/u)
        expect(instructions).toContain('user_supplied')
        expect(instructions).toMatch(/mutually exclusive or optional methods/u)
        expect(instructions).toMatch(/Set kind to assembly for placing or mounting parts/u)
        expect(instructions).toMatch(/Language-neutral diagrams remain valid grounding/u)
    })

    it('tells the model a capacity or range is not an installed count and an unstated supplied quantity stays unknown', async () => {
        const { input, clean } = await fixture()
        const { provider, bodies } = queued([clean])
        await provider.parseManual(input, new AbortController().signal)
        const instructions = String(bodies[0]!.instructions)
        expect(instructions).toMatch(/capacity or range/iu)
        expect(instructions).toMatch(/not a required installed count/u)
        expect(instructions).toMatch(/not_specified/u)
        expect(instructions).toMatch(/truly unstated/u)
        expect(instructions).toMatch(/still unresolved/u)
    })

    it('keeps the production prompt free of brand or manual specific strings', async () => {
        const { input, clean } = await fixture()
        const { provider, bodies } = queued([clean])
        await provider.parseManual(input, new AbortController().signal)
        expect(String(bodies[0]!.instructions)).not.toMatch(/ikea|cable|kallax|billy|demo-page|side-panel|divider/iu)
    })

    it('accepts an earlier known same-part quantity carried into a later step with no repair', async () => {
        const { input, clean } = await fixture()
        const { provider, fetchImpl } = queued([carriedManual(clean)])
        const result = await provider.parseManual(input, new AbortController().signal)
        expect(result.steps[1]!.parts[0]).toMatchObject({
            quantity: { state: 'known', value: 1 },
            quantityBasis: { kind: 'carried_over', stepId: 'step-1', partId: 'side-panel' },
        })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('accepts a chain of carried quantities that ends at a known anchor with no repair', async () => {
        const { input, clean } = await fixture()
        const { provider, fetchImpl } = queued([carriedManual(clean, 3)])
        const result = await provider.parseManual(input, new AbortController().signal)
        expect(result.steps).toHaveLength(3)
        expect(result.steps[2]!.parts[0]!.quantityBasis).toMatchObject({ kind: 'carried_over', stepId: 'step-2' })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it.each([
        [
            'an unknown step',
            { quantityBasis: { kind: 'carried_over', stepId: 'step-9', partId: 'side-panel', sourceRefs: CITED } },
        ],
        [
            'a self reference',
            { quantityBasis: { kind: 'carried_over', stepId: 'step-2', partId: 'side-panel', sourceRefs: CITED } },
        ],
        [
            'a different part',
            { quantityBasis: { kind: 'carried_over', stepId: 'step-1', partId: 'divider', sourceRefs: CITED } },
        ],
        ['a mismatched count', { quantity: { state: 'known', value: 2, sourceRefs: CITED } }],
        [
            'an uncited basis',
            { quantityBasis: { kind: 'carried_over', stepId: 'step-1', partId: 'side-panel', sourceRefs: [] } },
        ],
        [
            'an unsupplied page',
            {
                quantityBasis: {
                    kind: 'carried_over',
                    stepId: 'step-1',
                    partId: 'side-panel',
                    sourceRefs: [{ pageId: 'ghost', region: null }],
                },
            },
        ],
        ['an unknown count', { quantity: UNKNOWN }],
        [
            'a missing step reference',
            { quantityBasis: { kind: 'carried_over', stepId: null, partId: 'side-panel', sourceRefs: CITED } },
        ],
    ])('rejects a carried quantity with %s without spending a repair', async (_label, change) => {
        const { input, clean } = await fixture()
        const { provider, fetchImpl } = queued([setPart(carriedManual(clean), 1, change)])
        await expect(provider.parseManual(input, new AbortController().signal)).rejects.toMatchObject({
            code: 'invalid_output',
        })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('rejects a forward reference and a reference to a later step', async () => {
        const { input, clean } = await fixture()
        const forward = setPart(carriedManual(clean), 0, {
            quantityBasis: { kind: 'carried_over', stepId: 'step-2', partId: 'side-panel', sourceRefs: CITED },
        })
        const { provider, fetchImpl } = queued([forward])
        await expect(provider.parseManual(input, new AbortController().signal)).rejects.toMatchObject({
            code: 'invalid_output',
        })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('rejects a carried basis on a legacy quantity kind that names a step', async () => {
        const { input, clean } = await fixture()
        const value = setPart(clean, 1, {
            quantity: UNKNOWN,
            quantityBasis: { kind: 'user_supplied', stepId: 'step-1', partId: 'side-panel', sourceRefs: CITED },
        })
        const { provider, fetchImpl } = queued([value])
        await expect(provider.parseManual(input, new AbortController().signal)).rejects.toMatchObject({
            code: 'invalid_output',
        })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('rejects a carried chain whose anchor quantity is unknown instead of repairing around it', async () => {
        const { input, clean } = await fixture()
        const anchorUnknown = setPart(carriedManual(clean), 0, { quantity: UNKNOWN, quantityBasis: null })
        const { provider, fetchImpl } = queued([anchorUnknown])
        await expect(provider.parseManual(input, new AbortController().signal)).rejects.toMatchObject({
            code: 'invalid_output',
        })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('still spends exactly one bounded repair for a truly unstated supplied quantity after a known earlier use', async () => {
        const { input, clean } = await fixture()
        // Step 2 states no count and no basis: an earlier known same-part value is not an automatic waiver.
        const unstated = setPart(clean, 1, { quantity: UNKNOWN, quantityBasis: null })
        const { provider, fetchImpl, bodies } = queued([unstated, unstated])
        const result = await provider.parseManual(input, new AbortController().signal)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(String(bodies[1]!.instructions)).toContain('quantity of side-panel')
        expect(result.steps[1]!.parts[0]!.quantity).toEqual(UNKNOWN)
    })

    it('keeps a capacity-only cited not_specified quantity unknown with no invented count or repair', async () => {
        const { input, clean } = await fixture()
        const capacity = setPart(clean, 1, {
            quantity: { state: 'unknown', reason: 'The manual gives a capacity range, not an installed count.' },
            quantityBasis: { kind: 'not_specified', sourceRefs: CITED },
        })
        const { provider, fetchImpl } = queued([capacity])
        const result = await provider.parseManual(input, new AbortController().signal)
        expect(result.steps[1]!.parts[0]).toMatchObject({
            quantity: { state: 'unknown' },
            quantityBasis: { kind: 'not_specified' },
        })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('rejects a capacity-only quantity that invents a count under a not_specified basis', async () => {
        const { input, clean } = await fixture()
        const invented = setPart(clean, 1, { quantityBasis: { kind: 'not_specified', sourceRefs: CITED } })
        const { provider, fetchImpl } = queued([invented])
        await expect(provider.parseManual(input, new AbortController().signal)).rejects.toMatchObject({
            code: 'invalid_output',
        })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('keeps step-level citation custody for a carried quantity basis', () => {
        const value = carriedManual(createDemoManual().rawExtraction!)
        const basis = { pageId: 'basis-page', region: null }
        const step = setPart(value, 1, {
            quantityBasis: { kind: 'carried_over', stepId: 'step-1', partId: 'side-panel', sourceRefs: [basis] },
        }).steps[1]!
        expect(stepRefs(step)).toContainEqual(basis)
    })
})

describe('parse language', () => {
    it('keeps English facts from a mocked multilingual page without mixing the other block', async () => {
        const { input, clean } = await fixture()
        const blocks = { en: 'Support bracket', fr: 'Support de fixation' }
        // The response is mocked, not OCR evidence: this checks the English policy and the returned fact plumbing.
        clean.parts[0]!.name = { state: 'known', value: blocks.en, sourceRefs: CITED }
        const { provider, bodies } = queued([clean])
        const result = await provider.parseManual(input, new AbortController().signal)
        expect(result.parts[0]!.name).toMatchObject({ value: blocks.en })
        expect(JSON.stringify(result.parts[0]!.name)).not.toContain(blocks.fr)
        expect(manualContext(bodies[0]!).language).toBe('en')
        expect(String(bodies[0]!.instructions)).toContain('ignore facts in other languages')
        expect(String(bodies[0]!.instructions)).toContain('never mix or translate')
    })

    it('defaults the request language to English in context and instructions', async () => {
        const { input, clean } = await fixture()
        const { provider, bodies } = queued([clean])
        await provider.parseManual(input, new AbortController().signal)
        expect(manualContext(bodies[0]!).language).toBe('en')
        expect(String(bodies[0]!.instructions)).toMatch(/Selected parse language: en/u)
    })

    it('propagates a selected language and tells the model to ignore, never mix or translate others', async () => {
        const { input, clean } = await fixture(2)
        const { provider, bodies } = queued([clean])
        // The mock returns English text: it demonstrates request plumbing, not real multilingual OCR.
        const result = await provider.parseManual({ ...input, language: 'fr-CA' }, new AbortController().signal)
        expect(result.parts[0]!.name).toMatchObject({ state: 'known' })
        expect(manualContext(bodies[0]!).language).toBe('fr-CA')
        const instructions = String(bodies[0]!.instructions)
        expect(instructions).toMatch(/Selected parse language: fr-CA/u)
        expect(instructions).toMatch(/only blocks written in that language/u)
        expect(instructions).toMatch(/ignore facts in other languages/u)
        expect(instructions).toMatch(/never mix or translate/u)
        expect(instructions).toMatch(/keep the fact unknown/u)
        expect(content(bodies[0]!).filter((block) => block.type === 'input_image')).toHaveLength(2)
    })

    it.each(['EN', 'english', 'e', 'fr_CA', 'fr-', 'x'.repeat(17), '', ' '])(
        'rejects invalid language %j before any request',
        async (language) => {
            const { input, clean } = await fixture()
            const { provider, fetchImpl } = queued([clean])
            await expect(
                provider.parseManual({ ...input, language }, new AbortController().signal),
            ).rejects.toMatchObject({
                code: 'invalid_input',
            })
            expect(fetchImpl).not.toHaveBeenCalled()
        },
    )
})

describe('page-scaled first parse attempt and page limit', () => {
    it.each([
        [7, 59_500],
        [8, 90_000],
    ])(
        'retains a slow unresolved first parse at %i pages instead of overrunning overall time in repair',
        async (pages, firstMs) => {
            const { input, clean } = await fixture(pages)
            clean.steps[0]!.orientation = UNKNOWN
            let monotonic = 100
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
            const fetchImpl = vi.fn<typeof fetch>(async (): Promise<Response> => {
                monotonic += fetchImpl.mock.calls.length === 1 ? firstMs : 40_001
                return Response.json(envelope(clean))
            })
            try {
                const provider = createMetaProvider({ apiKey: '<synthetic>', fetchImpl })
                const result = await provider.parseManual(input, new AbortController().signal)
                expect(result.steps[0]!.orientation).toEqual(UNKNOWN)
                expect(fetchImpl).toHaveBeenCalledTimes(1)
            } finally {
                clock.mockRestore()
            }
        },
    )

    async function timed(pageCount: number, elapsedMs: number): Promise<{ calls: number; outcome: unknown }> {
        const { input, clean } = await fixture(pageCount)
        let monotonic = 100
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
        const fetchImpl = vi.fn<typeof fetch>(async (): Promise<Response> => {
            monotonic += elapsedMs
            return Response.json(envelope(clean))
        })
        try {
            const provider = createMetaProvider({ apiKey: '<synthetic>', fetchImpl })
            const outcome = await provider.parseManual(input, new AbortController().signal).then(
                () => 'accepted' as const,
                (error: unknown) => (error as { code?: string }).code,
            )
            return { calls: fetchImpl.mock.calls.length, outcome }
        } finally {
            clock.mockRestore()
        }
    }

    it('accepts an 80 second first response for a seven-page manual that the retired 60 second budget would time out', async () => {
        expect(await timed(7, 80_000)).toEqual({ calls: 1, outcome: 'accepted' })
    })

    it.each([
        [1, 55_000],
        [4, 55_000],
        [5, 65_000],
        [7, 85_000],
        [8, 95_000],
    ])('allows %i pages up to %i ms and times out one millisecond beyond', async (pages, budget) => {
        expect(await timed(pages, budget - 1_000)).toEqual({ calls: 1, outcome: 'accepted' })
        expect(await timed(pages, budget + 1)).toEqual({ calls: 1, outcome: 'timeout' })
    })

    it.each([
        [1, 55_000],
        [4, 55_000],
        [5, 65_000],
        [6, 75_000],
        [7, 85_000],
        [8, 95_000],
        [9, 95_000],
        [20, 95_000],
    ])('computes %i pages as a %i ms first attempt and never exceeds 95 seconds', (pages, expected) => {
        expect(parseFirstAttemptTimeoutMs(pages)).toBe(expected)
    })

    it('accepts exactly the shared page maximum', async () => {
        const { input, clean } = await fixture(MAX_PARSE_PAGES)
        const { provider, fetchImpl } = queued([clean])
        await provider.parseManual(input, new AbortController().signal)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('keeps the shared page maximum at eight', () => {
        expect(MAX_PARSE_PAGES).toBe(8)
    })

    it.each([9, 10])(
        'rejects %i pages before normalization or any request without leaking a message',
        async (pageCount) => {
            const { input, clean } = await fixture(pageCount)
            const { provider, fetchImpl } = queued([clean])
            const error = await provider
                .parseManual(input, new AbortController().signal)
                .catch((caught: unknown) => caught)
            expect(error).toMatchObject({ code: 'invalid_input', message: 'invalid_input' })
            expect(fetchImpl).not.toHaveBeenCalled()
        },
    )
})
