import { createDemoManual, type ManualSession, type ScreenDocument } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import type { VerifiedCallTelemetry } from '../../providers/meta-provider'
import { shownScreenSchema } from '../../providers/shown-screen'
import { aiPolicyFromEnvironment } from '../ai-policy'
import { buildContext, type ScreenInputs } from './context'
import { issueShown, resolveShown, type IssuedShown } from './shown'
import { createScreenService, type BackgroundWork } from './service'

// The provider here is an in-process stub that returns whatever composition a test wants graded. No network, key or
// recorded model output is involved; the service validates and grounds it exactly as it does a real answer.
const REGION = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
const SAFETY = 'Keep fingers clear of the groove edge.'

function session(change?: (value: ManualSession) => void): ManualSession {
    const value = createDemoManual()
    const step = value.reviewedSteps[0]!
    const known = <T>(
        item: T,
        region: typeof REGION | null = null,
    ): { state: 'known'; value: T; sourceRefs: unknown[] } => ({
        state: 'known',
        value: item,
        sourceRefs: [{ pageId: 'demo-page-1', region }],
    })
    step.safetyNotes = [{ noteId: 'n1', note: known(SAFETY) }] as never
    step.orientation = known(
        { partId: 'side-panel', description: 'Groove faces inward toward the divider.' },
        REGION,
    ) as never
    step.parts = [
        { partId: 'side-panel', quantity: known(1) },
        { partId: 'divider', quantity: known(2) },
    ] as never
    change?.(value)
    return value
}

const guideInputs = (manual: ManualSession, stepId = 'step-1'): ScreenInputs => ({
    kind: 'guide',
    session: manual,
    stepId,
    captureId: null,
    result: null,
    failure: null,
})

const telemetry: VerifiedCallTelemetry = {
    stage: 'step-pages',
    model: 'muse-wonder-1.0',
    effort: 'max',
    timeToProviderMs: 1,
    providerMs: 2,
    parseValidateMs: 1,
    totalMs: 4,
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 },
}

const work: BackgroundWork = {
    run: (_options, fn) => fn(),
    repair: (fn) => fn(),
    tryAcquire: () => () => {},
    acquire: async () => () => {},
}

interface Dynamic {
    screen: { sources: { index: number; pageId: string; region: unknown }[] }
}

function serviceFor(compose: (dynamic: Dynamic) => unknown): {
    service: ReturnType<typeof createScreenService>
    calls: () => number
} {
    let calls = 0
    const service = createScreenService({
        provider: {
            generateScreen: async (input) => {
                calls += 1
                return { value: compose(input.dynamic as unknown as Dynamic), telemetry }
            },
        },
        policy: aiPolicyFromEnvironment(
            {},
            {
                checkTimeoutMs: 8_000,
                parseModel: 'muse-spark-1.3',
                verdictModel: 'muse-spark-1.3',
                secondOpinionModel: 'muse-wonder-1.0',
            },
        ),
        runtimeMode: 'meta',
        work,
    })
    return { service, calls: () => calls }
}

const header = { type: 'ScreenHeader', title: 'Step 1', subtitle: null, trailing: null }
const bar = {
    primary: {
        type: 'PrimaryAction',
        label: 'Take photo',
        icon: 'camera',
        intent: { intent: 'capture', target: 'take-photo' },
    },
    secondary: null,
}
const regionIndex = (dynamic: Dynamic): number => dynamic.screen.sources.find((source) => source.region !== null)!.index

/** A composition that chooses a subset of the step, an emphasized figure region and a source look. */
const chosen = (dynamic: Dynamic): unknown => ({
    header,
    body: [
        {
            type: 'HeroFigure',
            source: 'page',
            refId: 'demo-page-1',
            caption: null,
            fit: 'cover',
            sourceRefIndex: regionIndex(dynamic),
        },
        { type: 'Instruction', text: 'Stand the side panel upright', emphasis: 'strong', citations: [] },
        { type: 'PartList', items: [{ partId: 'divider', label: 'Divider shelf', quantity: 2 }], showQuantities: true },
        { type: 'Warning', text: SAFETY, tone: 'caution', citations: [] },
        {
            type: 'SourceDetails',
            label: 'Manual pages',
            sources: [regionIndex(dynamic)],
            fit: 'contain',
            initiallyOpen: false,
        },
        { type: 'CameraGuidance', cue: 'Hold steady', pill: null, tipTarget: 'guide-hero-frame' },
    ],
    bar,
})

async function issue(manual = session()): Promise<{
    document: ScreenDocument
    resolve: ReturnType<typeof createScreenService>['resolveStepScreen']
    manual: ManualSession
    service: ReturnType<typeof createScreenService>
    calls: () => number
}> {
    const { service, calls } = serviceFor(chosen)
    const document = await service.generate(guideInputs(manual))
    return { document, resolve: service.resolveStepScreen.bind(service), manual, service, calls }
}

const identity = (document: ScreenDocument): { screenId: string; contextKey: string } => ({
    screenId: document.screenId,
    contextKey: document.bound.contextKey,
})

describe('the page a check is told the person was shown', (): void => {
    it('names the model-chosen blocks in order with the figure region, parts and sources it actually showed', async (): Promise<void> => {
        const { document, resolve, manual } = await issue()
        expect(document.metadata.source).toBe('generated')
        const resolved = resolve(manual, 'step-1', identity(document))
        if (resolved === null || resolved === 'mismatch') throw new Error('unresolved')
        const { shown } = resolved
        expect(shown?.blocks.map((block) => [block.path, block.type, block.origin])).toEqual([
            ['body.0', 'HeroFigure', 'generated'],
            ['body.1', 'Instruction', 'generated'],
            ['body.2', 'PartList', 'generated'],
            ['body.3', 'Warning', 'generated'],
            ['body.4', 'SourceDetails', 'generated'],
            ['body.5', 'CameraGuidance', 'generated'],
        ])
        // The emphasized region is the manual's own, copied by the server; the unchosen part is not named at all.
        expect(shown?.blocks[0]?.figure).toEqual({ source: 'page', refId: 'demo-page-1', fit: 'cover', region: REGION })
        expect(shown?.blocks[2]?.parts).toEqual([{ partId: 'divider', label: 'Divider shelf', quantity: 2 }])
        expect(shown?.blocks[4]?.sources).toEqual([{ pageId: 'demo-page-1', region: REGION }])
        expect(shown?.blocks[5]).toMatchObject({ label: 'Hold steady' })
        expect(shown?.header).toEqual({ title: 'Step 1', subtitle: null })
        expect(shown?.bar?.primary).toEqual({ label: 'Take photo', intent: 'capture', target: 'take-photo' })
        // The mandatory safety fact was not placed by any block, so the app showed it in the remainder section.
        expect(shown?.remainderFactIds).toEqual(['safety:n1'])
        // Only facts that were on the page: not the orientation, connection, check or correction texts.
        expect(resolved.facts.map((fact) => fact.id)).toEqual(['title', 'safety:n1'])
        expect(shownScreenSchema.safeParse(shown).success).toBe(true)
    })

    it('marks server-forced and server-replaced components as fallback, never generated', async (): Promise<void> => {
        const { service } = serviceFor((dynamic) => ({
            header,
            body: [
                { type: 'Instruction', text: 'Stand the side panel upright', emphasis: 'strong', citations: [] },
                // The model's wording is not listed copy, so the server substitutes it and owns that component.
                {
                    type: 'SourceDetails',
                    label: 'Peek at it',
                    sources: [regionIndex(dynamic)],
                    fit: 'contain',
                    initiallyOpen: false,
                },
            ],
            bar,
        }))
        const manual = session()
        const document = await service.generate(guideInputs(manual))
        const resolved = service.resolveStepScreen(manual, 'step-1', identity(document))
        if (resolved === null || resolved === 'mismatch') throw new Error('unresolved')
        expect(resolved.shown?.blocks.map((block) => [block.type, block.origin])).toEqual([
            ['Instruction', 'generated'],
            ['SourceDetails', 'fallback'],
        ])
        expect(resolved.shown?.blocks[1]?.label).toBe('Manual pages')
    })

    it('describes a deterministic fallback page honestly, with every mandatory fact on it', async (): Promise<void> => {
        const manual = session()
        const service = createScreenService({
            provider: null,
            policy: aiPolicyFromEnvironment(
                {},
                {
                    checkTimeoutMs: 8_000,
                    parseModel: 'muse-spark-1.3',
                    verdictModel: 'muse-spark-1.3',
                    secondOpinionModel: 'muse-wonder-1.0',
                },
            ),
            runtimeMode: 'fixture',
            work,
        })
        const document = await service.generate(guideInputs(manual))
        expect(document.metadata.source).not.toBe('generated')
        const resolved = service.resolveStepScreen(manual, 'step-1', identity(document))
        if (resolved === null || resolved === 'mismatch') throw new Error('unresolved')
        expect(resolved.shown?.blocks.every((block) => block.origin === 'fallback')).toBe(true)
        expect(resolved.facts.map((fact) => fact.id)).toContain('safety:n1')
    })

    it('keeps the numeric operators of the manual exactly in the facts it reports', async (): Promise<void> => {
        const note = 'Keep the load < 5 kg and > 2 kg.'
        const manual = session((value) => {
            value.reviewedSteps[0]!.safetyNotes = [
                {
                    noteId: 'n1',
                    note: { state: 'known', value: note, sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
                },
            ]
        })
        const { service } = serviceFor(() => ({
            header,
            body: [{ type: 'Instruction', text: 'Stand the side panel upright', emphasis: 'strong', citations: [] }],
            bar,
        }))
        const document = await service.generate(guideInputs(manual))
        const resolved = service.resolveStepScreen(manual, 'step-1', identity(document))
        if (resolved === null || resolved === 'mismatch') throw new Error('unresolved')
        expect(resolved.facts.find((fact) => fact.id === 'safety:n1')?.text).toBe(note)
        expect(resolved.shown?.remainderFactIds).toEqual(['safety:n1'])
    })

    it('accepts only the exact kind, manual, revision, step and context it issued', async (): Promise<void> => {
        const { document, resolve, manual } = await issue()
        const key = identity(document)
        // Another step recomputes another context key.
        expect(resolve(manual, 'step-2', key)).toBe('mismatch')
        // A later revision of the manual is a different context, so the older page is not paired with it.
        const later = structuredClone(manual)
        later.revision += 1
        expect(resolve(later, 'step-1', key)).toBe('mismatch')
        // A page this server did not issue contributes nothing and is not an error.
        expect(resolve(manual, 'step-1', { screenId: 'b'.repeat(64), contextKey: key.contextKey })).toBeNull()
    })

    it('never pairs the identity of a non-guide page with a guide request', async (): Promise<void> => {
        const manual = session()
        const { service } = serviceFor(chosen)
        const result = await service.generate({
            kind: 'questions',
            session: manual,
            stepId: 'step-1',
            captureId: null,
            result: null,
            failure: null,
            uiState: null,
        })
        const guideKey = buildContext(guideInputs(manual)).bound.contextKey
        expect(service.resolveStepScreen(manual, 'step-1', { screenId: result.screenId, contextKey: guideKey })).toBe(
            'mismatch',
        )
    })

    it('reports the same page whether it was composed now or served from the cache', async (): Promise<void> => {
        const first = await issue()
        const again = await first.service.generate(guideInputs(first.manual))
        expect(first.calls()).toBe(1)
        const a = first.resolve(first.manual, 'step-1', identity(first.document))
        const b = first.resolve(first.manual, 'step-1', identity(again))
        expect(b).toMatchObject({ shown: expect.objectContaining({ blocks: expect.any(Array) }) })
        if (a === null || a === 'mismatch' || b === null || b === 'mismatch') throw new Error('unresolved')
        expect(b.shown?.blocks.map((block) => block.type)).toEqual(a.shown?.blocks.map((block) => block.type))
        expect(b.facts).toEqual(a.facts)
    })
})

describe('re-verifying an issued page against the manual of the request', (): void => {
    const manual = session()
    const context = buildContext(guideInputs(manual))
    const issued = (blocks: IssuedShown['blocks'], extra: Partial<IssuedShown> = {}): IssuedShown => ({
        header: { title: 'Step 1', subtitle: null },
        bar: { primary: { label: 'Take photo', intent: 'capture', target: 'take-photo' }, secondary: null },
        blocks,
        facts: [],
        ...extra,
    })
    const block = (partial: Record<string, unknown>): IssuedShown['blocks'][number] =>
        ({ path: 'body.0', type: 'Instruction', origin: 'generated', ...partial }) as never

    it('drops geometry, figures, parts, facts, wording and actions the manual does not support', (): void => {
        const resolved = resolveShown(
            issued(
                [
                    block({
                        type: 'HeroFigure',
                        figure: {
                            source: 'page',
                            refId: 'demo-page-1',
                            fit: 'cover',
                            region: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 },
                        },
                    }),
                    block({
                        path: 'body.1',
                        type: 'HeroFigure',
                        figure: { source: 'page', refId: 'foreign-page', fit: 'cover', region: REGION },
                    }),
                    block({
                        path: 'body.2',
                        type: 'HeroFigure',
                        figure: { source: 'capture', refId: 'capture-9', fit: 'cover', region: null },
                    }),
                    block({
                        path: 'body.3',
                        type: 'PartList',
                        parts: [
                            { partId: 'unknown-part', label: 'Divider shelf', quantity: 1 },
                            { partId: 'side-panel', label: 'Renamed panel', quantity: 1 },
                            { partId: 'divider', label: 'Divider shelf', quantity: 9 },
                        ],
                    }),
                    block({ path: 'body.4', type: 'ManualDirections', factIds: ['orientation', 'invented-fact'] }),
                    block({ path: 'body.5', text: 'Insert 99 bolts into the frame now.' }),
                    block({ path: 'body.6', text: 'Stand the side' }),
                    block({
                        path: 'body.7',
                        type: 'ActionLink',
                        label: 'Click here',
                        sources: [{ pageId: 'demo-page-1', region: { x: 0.9, y: 0.9, width: 0.1, height: 0.1 } }],
                    }),
                ],
                {
                    header: { title: 'Anything at all', subtitle: null },
                    bar: { primary: { label: 'Take photo', intent: 'retry', target: 'screen' }, secondary: null },
                },
            ),
            context,
        )
        const blocks = resolved.shown!.blocks
        // An off-manual region is dropped but the figure the page really named stays; a foreign figure is removed.
        expect(blocks[0]?.figure).toEqual({ source: 'page', refId: 'demo-page-1', fit: 'cover', region: null })
        expect(blocks[1]).not.toHaveProperty('figure')
        expect(blocks[2]).not.toHaveProperty('figure')
        // Part names and quantities come from the manual; a wrong name is dropped and a wrong quantity becomes unknown.
        expect(blocks[3]?.parts).toEqual([{ partId: 'divider', label: 'Divider shelf', quantity: null }])
        expect(blocks[4]?.factIds).toEqual(['orientation'])
        expect(blocks[5]).not.toHaveProperty('text')
        expect(blocks[6]?.text).toBe('Stand the side')
        expect(blocks[7]).not.toHaveProperty('label')
        expect(blocks[7]).not.toHaveProperty('sources')
        // A header or action the server would not have accepted is not reported.
        expect(resolved.shown).not.toHaveProperty('header')
        expect(resolved.shown).not.toHaveProperty('bar')
        // A verbatim piece of the title does not prove the whole title was shown, so only the named fact is reported.
        expect(resolved.facts.map((fact) => fact.id)).toEqual(['orientation'])
        expect(JSON.stringify(resolved)).not.toContain('invented-fact')
    })

    it('reads fact text from the manual, never from the issued page', (): void => {
        const resolved = resolveShown(
            issued([block({ type: 'ManualDirections', factIds: ['orientation'], text: undefined })], {
                facts: [{ factId: 'orientation', placement: 'body' }],
            }),
            context,
        )
        expect(resolved.facts).toEqual([
            { id: 'orientation', kind: 'orientation', text: 'Groove faces inward toward the divider.' },
        ])
    })

    it('omits the composition rather than failing when it cannot be expressed in the bounded shape', (): void => {
        const blocks = Array.from({ length: 40 }, (_unused, index) =>
            block({ path: `body.${index % 14}`, type: 'Skeleton' }),
        )
        const resolved = resolveShown(issued(blocks), context)
        expect(resolved.shown).toBeUndefined()
        expect(resolved.facts).toEqual([])
    })

    it('projects every catalog node without losing its place in the page', async (): Promise<void> => {
        const { document } = await issue()
        const projected = issueShown(document)
        expect(projected.blocks).toHaveLength(document.body.length)
        expect(projected.facts.map((fact) => fact.factId)).toEqual(['safety:n1'])
    })
})
