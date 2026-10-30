import { fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { createDemoManual, type AppIntent, type ScreenNode } from '@truebuild/contracts'
import { FeedbackProvider } from '../../ui/feedback'
import { measureRenderOriginTree, type RenderOriginCheckpoint } from '../../ui/test-support/render-origin-coverage'
import { ThemeProvider } from '../../theme/theme'
import { heroResolves, ScreenBlocks, type BlockContext } from './blocks'
import type { ResolvedIntent } from './intents'
import { instruction, randomBody, rng } from './test-support/documents'
import { parseOrigin, RenderOriginProvider } from './render-origin'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const session = createDemoManual()
const checkpoint: RenderOriginCheckpoint = {
    sessionId: 'synthetic-blocks',
    screen: 'blocks',
    checkpointId: 'one',
    platform: 'ios',
    evidence: 'synthetic-fixture',
}
const observation = {
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/jpeg' as const,
    width: 600,
    height: 800,
    uri: 'file:///n.jpg',
}

function context(overrides: Partial<BlockContext> = {}): BlockContext {
    const resolve = (intent: AppIntent): ResolvedIntent => ({
        enabled: intent.intent !== 'retry',
        reason: intent.intent === 'retry' ? 'Nothing to retry.' : null,
        run: jest.fn(),
    })
    return {
        origin: 'generated',
        originOf: () => 'generated',
        session,
        pageUris: {},
        capture: null,
        marks: [],
        sources: [],
        manualFacts: [],
        live: null,
        heroMode: 'inline',
        resolve,
        inspect: false,
        ...overrides,
    }
}

function mount(nodes: readonly ScreenNode[], ctx: BlockContext): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <ScreenBlocks nodes={nodes} context={ctx} />
            </FeedbackProvider>
        </ThemeProvider>
    )
}

const EVERY_VARIANT: ScreenNode[] = [
    { type: 'HeroFigure', source: 'page', refId: session.pages[0]!.pageId, caption: 'The bracket', fit: 'cover' },
    instruction('Slide the panel onto the bracket.'),
    { type: 'PartList', showQuantities: true, items: [{ partId: 'side-panel', label: 'Side panel', quantity: 2 }] },
    { type: 'QuantityChip', partId: 'side-panel', label: 'Panels', quantity: 2 },
    { type: 'Warning', text: 'Two people should lift this.', tone: 'critical', citations: [] },
    { type: 'StepProgress', current: 2, total: 5, label: null },
    {
        type: 'ChoiceList',
        prompt: 'What next?',
        options: [
            { label: 'Take photo', intent: { intent: 'capture', target: 'take-photo' } },
            { label: 'Try again', intent: { intent: 'retry', target: 'screen' } },
        ],
    },
    {
        type: 'ConfirmFact',
        text: 'The groove faces inward.',
        confirm: { intent: 'confirm', target: 'facts' },
        dismiss: { intent: 'open-details', target: 'step' },
        citations: [],
    },
    { type: 'ResultBanner', verdict: 'refuse', text: 'The panel faces outward.', citations: [] },
    { type: 'AnswerCard', text: 'The groove goes inward.', caveat: 'Based on page 2.', citations: [] },
    { type: 'Tip', targetId: 'guide-primary', heading: 'Big button', text: 'Tap here.' },
    { type: 'Skeleton', variant: 'card', lines: 2 },
    { type: 'Group', layout: 'row', children: [instruction('Left', 'normal'), instruction('Right', 'quiet')] as never },
    {
        type: 'DetailsDisclosure',
        label: 'More detail',
        initiallyOpen: false,
        children: [instruction('Hidden detail', 'normal')] as never,
    },
]

describe('every catalog variant renders natively', () => {
    it('draws each block and says nothing for a tip (coach copy is not body content)', async () => {
        await render(mount(EVERY_VARIANT, context()))
        expect(screen.getByText('The bracket')).toBeTruthy()
        expect(screen.getByText('Slide the panel onto the bracket.')).toBeTruthy()
        expect(screen.getByText('Side panel')).toBeTruthy()
        expect(screen.getByText('× 2')).toBeTruthy()
        expect(screen.getByText('2 × Panels')).toBeTruthy()
        expect(screen.getByText('Two people should lift this.')).toBeTruthy()
        expect(screen.getByRole('progressbar', { name: 'Step 2 of 5' })).toBeTruthy()
        expect(screen.getByText('What next?')).toBeTruthy()
        expect(screen.getByText('The groove faces inward.')).toBeTruthy()
        expect(screen.getByText('Not yet')).toBeTruthy()
        expect(screen.getByText('The panel faces outward.')).toBeTruthy()
        expect(screen.getByText('The groove goes inward.')).toBeTruthy()
        expect(screen.getByText('Based on page 2.')).toBeTruthy()
        expect(screen.queryByText('Big button')).toBeNull()
        expect(screen.queryByText('Tap here.')).toBeNull()
        expect(screen.getByText('Left')).toBeTruthy()
        expect(screen.getByText('Right')).toBeTruthy()
        expect(screen.queryByText('Hidden detail')).toBeNull()
    })

    it('opens a collapsed disclosure on tap', async () => {
        await render(mount(EVERY_VARIANT, context()))
        await fireEvent.press(screen.getByRole('button', { name: 'More detail' }))
        expect(screen.getByText('Hidden detail')).toBeTruthy()
    })

    it('never collapses safety: a disclosure that holds a warning is open and cannot be closed', async () => {
        const safety: ScreenNode[] = [
            {
                type: 'DetailsDisclosure',
                label: 'Safety',
                initiallyOpen: false,
                children: [{ type: 'Warning', text: 'Never stand it up alone.', tone: 'critical', citations: [] }],
            },
        ]
        await render(mount(safety, context()))
        expect(screen.getByText('Never stand it up alone.')).toBeTruthy()
        const toggle = screen.getByRole('button', { name: 'Safety' })
        await fireEvent.press(toggle)
        expect(screen.getByText('Never stand it up alone.')).toBeTruthy()
    })

    it('runs only an enabled action and leaves a disabled one inert with its reason as the hint', async () => {
        const ctx = context()
        await render(mount(EVERY_VARIANT, ctx))
        const enabled = screen.getByRole('button', { name: 'Take photo' })
        const disabled = screen.getByRole('button', { name: 'Try again' })
        expect(disabled.props.accessibilityState).toMatchObject({ disabled: true })
        expect(disabled.props.accessibilityHint).toBe('Nothing to retry.')
        await fireEvent.press(disabled)
        await fireEvent.press(enabled)
        expect(screen.getByRole('button', { name: 'Take photo' })).toBeTruthy()
    })
})

describe('a photo block belongs to one capture', () => {
    const photo: ScreenNode = {
        type: 'PhotoWithRegions',
        captureId: 'capture-1',
        observed: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
        regions: [{ partId: 'side-panel', role: 'next', box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } }],
    }
    const capture = (captureId: string): BlockContext['capture'] => ({
        binding: {
            kind: 'capture',
            manualId: session.manualId,
            revision: session.revision,
            stepId: 'step-1',
            captureId,
        },
        observation,
        capturedAt: 0,
        reusable: true,
    })

    it('draws the frozen photo for its own capture', async () => {
        await render(mount([photo], context({ capture: capture('capture-1') })))
        expect(screen.getByTestId('frozen-photo-frame', { hidden: true })).toBeTruthy()
    })

    it('draws nothing for another capture or no capture, so a stale photo can never sit under a verdict', async () => {
        await render(mount([photo], context({ capture: capture('capture-2') })))
        expect(screen.queryByTestId('frozen-photo-frame', { hidden: true })).toBeNull()
        await render(mount([photo], context({ capture: null })))
        expect(screen.queryByTestId('frozen-photo-frame', { hidden: true })).toBeNull()
    })
})

describe('render origin markers', () => {
    it('marks every block root with the origin the server gave that component, and nothing else', async () => {
        const nodes = [instruction('One'), instruction('Two'), instruction('Three')]
        const origins: Record<string, 'generated' | 'fallback'> = {
            'body.0': 'generated',
            'body.1': 'fallback',
            'body.2': 'generated',
        }
        const view = await render(mount(nodes, context({ originOf: (path) => origins[path] ?? 'fallback' })))
        const measured = measureRenderOriginTree(view.toJSON(), checkpoint)
        // Each Text is its own composed root; the unmarked renderer container above them is the shell.
        expect(measured.counts).toEqual({ generated: 2, fallback: 1, shell: 0, total: 3 })
    })

    it('adds no wrapper of its own: a body of N blocks is N marked roots plus what the blocks contain', async () => {
        const view = await render(mount([instruction('One'), instruction('Two')], context()))
        const measured = measureRenderOriginTree(view.toJSON(), checkpoint)
        expect(measured.counts.shell).toBe(0)
        expect(measured.counts.total).toBe(2)
    })

    it('keeps a fallback document fallback end to end', async () => {
        const view = await render(
            mount(EVERY_VARIANT.slice(1, 12), context({ origin: 'fallback', originOf: () => 'fallback' })),
        )
        const measured = measureRenderOriginTree(view.toJSON(), checkpoint)
        expect(measured.counts.generated).toBe(0)
        expect(measured.counts.fallback).toBeGreaterThan(5)
    })

    it('adds nothing for the judge layer while it is off', async () => {
        const view = await render(mount([instruction('One')], context({ inspect: false })))
        expect(screen.queryByRole('button')).toBeNull()
        expect(measureRenderOriginTree(view.toJSON(), checkpoint).counts).toEqual({
            generated: 1,
            fallback: 0,
            shell: 0,
            total: 1,
        })
    })

    it('lets the judge layer name a block and its origin by tapping it', async () => {
        await render(mount([instruction('One')], context({ inspect: true })))
        expect(screen.queryByText(/generated by the model/u)).toBeNull()
        await fireEvent.press(screen.getByLabelText('Instruction. Show how this part was built'))
        expect(await screen.findByText('Instruction · generated by the model')).toBeTruthy()
    })

    it('names each tapped block from its own recorded origin, never from the document as a whole', async () => {
        // A generated document in which the server wrote one block, replaced a child, and left one to the app.
        const origins: Record<string, 'generated' | 'fallback' | 'shell'> = {
            'body.0': 'generated',
            'body.1': 'fallback',
            'body.2': 'generated',
            'body.2.children.0': 'generated',
            'body.2.children.1': 'fallback',
            'body.3': 'shell',
        }
        const nodes: ScreenNode[] = [
            instruction('Model wrote this.'),
            instruction('The server wrote this.'),
            { type: 'Group', layout: 'stack', children: [instruction('Kept'), instruction('Replaced')] as never },
            { type: 'Skeleton', variant: 'lines', lines: 1 },
        ]
        // `origin` is the whole-document source: generated. It must not decide any tag.
        await render(mount(nodes, context({ inspect: true, origin: 'generated', originOf: (path) => origins[path]! })))
        const tapped = async (type: string, index: number): Promise<void> => {
            await fireEvent.press(screen.getAllByLabelText(`${type}. Show how this part was built`)[index]!)
        }
        await tapped('Instruction', 0)
        expect(screen.getByText('Instruction · generated by the model')).toBeTruthy()
        await tapped('Instruction', 1)
        expect(screen.getByText('Instruction · built by the app from the manual')).toBeTruthy()
        // One tag at a time, and the fallback block is never called generated because its document was.
        expect(screen.queryByText('Instruction · generated by the model')).toBeNull()
        // The generated group says exactly which of its own blocks the server replaced.
        await tapped('Group', 0)
        expect(
            screen.getByText(
                'Group · generated by the model · inside: Instruction generated by the model; Instruction built by the app from the manual',
            ),
        ).toBeTruthy()
        await tapped('Skeleton', 0)
        expect(screen.getByText('Skeleton · the app’s own screen')).toBeTruthy()
        expect(screen.queryByText(/Skeleton · generated/u)).toBeNull()
    })
})

describe('randomly composed valid catalogs', () => {
    it('carries the real slow-question phase into its visible composer', async () => {
        const live = {
            state: {
                pending: 'Still thinking about your question…',
                question: 'Which way?',
                target: { kind: 'part', partId: 'side-panel' },
                capture: { binding: { captureId: 'capture-1' } },
            },
            entry: { session, stepIndex: 0 },
            controller: { questionChanged: jest.fn(), targetChanged: jest.fn(), ask: jest.fn() },
            ask: { choices: [], editable: true, blocked: false, targetSummary: 'Selected part' },
        } as unknown as BlockContext['live']
        await render(
            mount(
                [
                    {
                        type: 'QuestionComposer',
                        captureRef: 'current',
                        prompt: 'Question about your photo',
                        partScope: 'none',
                        submitLabel: 'Send question',
                    },
                ],
                context({ live }),
            ),
        )
        expect(screen.getByText('Still thinking…')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Send question' })).toBeDisabled()
    })

    it.each(Array.from({ length: 40 }, (_, index) => index + 1))(
        'renders seed %i fully, all of it composed',
        async (seed) => {
            const nodes = randomBody(rng(seed), 'capture-1')
            const ctx = context({
                capture: {
                    binding: {
                        kind: 'capture',
                        manualId: session.manualId,
                        revision: session.revision,
                        stepId: 'step-1',
                        captureId: 'capture-1',
                    },
                    observation,
                    capturedAt: 0,
                    reusable: true,
                },
            })
            const view = await render(mount(nodes, ctx))
            const measured = measureRenderOriginTree(view.toJSON(), checkpoint)
            expect(measured.counts.fallback).toBe(0)
            // Nothing but composed hosts: a photo block's frame and svg are inside its marked root.
            expect(measured.counts.shell).toBe(0)
        },
    )
})

describe("a part hero draws the manual's own figure or nothing", () => {
    const pageId = session.pages[0]!.pageId
    const partHero = (refId: string): Extract<ScreenNode, { type: 'HeroFigure' }> => ({
        type: 'HeroFigure',
        source: 'part',
        refId,
        caption: null,
        fit: 'cover',
    })
    const live = (stepIndex: number): BlockContext['live'] =>
        ({ entry: { session, stepIndex, completedStepIds: [], capture: null } }) as unknown as BlockContext['live']

    it("resolves a part the manual cites on one of its pages, from the part's own source", async () => {
        const ctx = context({ pageUris: { [pageId]: 'data:image/png;base64,AAAA' } })
        expect(heroResolves(partHero('side-panel'), ctx)).toBe(true)
        await render(mount([partHero('side-panel')], ctx))
        expect(screen.getByTestId('generated-hero')).toBeTruthy()
    })

    it('fails closed for a part the manual does not cite, an unknown part, or a cited page it does not hold', async () => {
        const uncited = {
            ...session,
            parts: session.parts.map((part) =>
                part.partId === 'divider'
                    ? { ...part, name: { state: 'unknown' as const, reason: 'The manual does not name it.' } }
                    : {
                          ...part,
                          name: { ...part.name, sourceRefs: [{ pageId: 'page-from-another-manual', region: null }] },
                      },
            ),
        }
        const ctx = context({ session: uncited, live: live(0) })
        for (const refId of ['divider', 'side-panel', 'not-a-part']) {
            expect(heroResolves(partHero(refId), ctx)).toBe(false)
        }
        await render(mount([partHero('divider'), partHero('side-panel'), partHero('not-a-part')], ctx))
        expect(screen.queryByTestId('generated-hero')).toBeNull()
    })

    it("uses the step's own count citation when the part's name is unread", () => {
        const unread = {
            ...session,
            parts: session.parts.map((part) =>
                part.partId === 'side-panel'
                    ? { ...part, name: { state: 'unknown' as const, reason: 'Not read.' } }
                    : part,
            ),
        }
        expect(heroResolves(partHero('side-panel'), context({ session: unread }))).toBe(false)
        expect(heroResolves(partHero('side-panel'), context({ session: unread, live: live(0) }))).toBe(true)
    })
})

describe('a manual fact can open the pages it is cited from', () => {
    const pageId = session.pages[0]!.pageId
    const directions: ScreenNode = {
        type: 'ManualDirections',
        factIds: ['orientation', 'elsewhere'],
        emphasis: 'normal',
    }
    const fact = (factId: string, text: string, citedPage: string): BlockContext['manualFacts'][number] => ({
        factId,
        kind: 'orientation',
        basis: 'unclassified-step',
        text,
        sourceRefs: [{ pageId: citedPage, region: null }],
        placement: 'body',
    })
    const ctx = (): BlockContext =>
        context({
            pageUris: { [pageId]: 'data:image/png;base64,AAAA' },
            manualFacts: [
                fact('orientation', 'The groove faces the rail.', pageId),
                fact('elsewhere', 'Keep your fingers clear.', 'page-from-another-manual'),
            ],
        })

    it.each(['Instruction', 'Warning'] as const)(
        'keeps the cited source when a %s replaces repeated directions',
        async (type) => {
            const text = 'The groove faces the rail.'
            const node: ScreenNode =
                type === 'Instruction' ? instruction(text) : { type: 'Warning', text, tone: 'caution', citations: [] }
            await render(mount([node, directions], ctx()))
            expect(screen.getAllByText(text)).toHaveLength(1)
            await fireEvent.press(screen.getByRole('button', { name: 'Show this in the manual' }))
            expect(screen.getByTestId('diagram-0')).toBeTruthy()
        },
    )

    it('calls a synthetic generated block a simulated composition', async () => {
        await render(mount([instruction('Line up the rail.')], context({ inspect: true, synthetic: true })))
        await fireEvent.press(screen.getByLabelText('Instruction. Show how this part was built'))
        expect(screen.getByText('Instruction · simulated composition (generated source)')).toBeTruthy()
        expect(screen.queryByText(/generated by the model/u)).toBeNull()
    })

    it('keeps the complete words, shows the cited page only on request, and offers nothing for a page it lacks', async () => {
        await render(mount([directions], ctx()))
        expect(screen.getByText('The groove faces the rail.')).toBeTruthy()
        expect(screen.getByText('Keep your fingers clear.')).toBeTruthy()
        // One fact cites a page this manual holds; the other cites none it has, so it gets no dead control.
        expect(screen.getAllByRole('button', { name: 'Show this in the manual' })).toHaveLength(1)
        expect(screen.queryByTestId('diagram-0')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Show this in the manual' }))
        expect(screen.getByTestId('diagram-0')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Hide this in the manual' }))
        expect(screen.queryByTestId('diagram-0')).toBeNull()
    })

    it('attributes the citation control to the document node that places it', async () => {
        const view = await render(mount([directions], ctx()))
        expect(parseOrigin(screen.getByTestId('fact-source').props.nativeID)).toBe('generated')
        const measured = measureRenderOriginTree(view.toJSON(), checkpoint)
        expect(measured.counts.shell).toBe(0)
        expect(measured.counts.generated).toBeGreaterThan(0)
    })

    it.each(['Instruction', 'Warning'] as const)(
        'keeps a %s citation at its own fallback origin inside a generated container',
        async (type) => {
            const text = 'The groove faces the rail.'
            const node: ScreenNode =
                type === 'Instruction' ? instruction(text) : { type: 'Warning', text, tone: 'caution', citations: [] }
            await render(
                <RenderOriginProvider origin="generated">
                    {mount([node], { ...ctx(), originOf: () => 'fallback' })}
                </RenderOriginProvider>,
            )
            expect(parseOrigin(screen.getByTestId('fact-source').props.nativeID)).toBe('fallback')
        },
    )
})
