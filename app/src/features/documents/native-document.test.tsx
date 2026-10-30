import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { useEffect, type ReactElement } from 'react'
import { Dimensions, PanResponder, Platform, StyleSheet, View } from 'react-native'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    documentMaterialV2,
    screenDocumentV2Schema,
    manualSessionSchema,
    variantsOfV2,
    type ScreenDocumentV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
} from '@truebuild/contracts'
import { partSourceRefs } from '../screens/part-source'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider, type HapticPort } from '../../ui/feedback'
import { DocumentRenderer } from './document-renderer'
import { sha256Hex } from './sha256'
import type { FrameBindings } from './types'
import { entry, runtime, source } from '../screens/test-support/route-harness'
import { defaultNav } from '../capture/screen-nav'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

function wrap(child: ReactElement, haptics?: HapticPort): ReactElement {
    return (
        <ThemeProvider>
            <FeedbackProvider reduceMotion haptics={haptics}>
                {child}
            </FeedbackProvider>
        </ThemeProvider>
    )
}
function compose(
    inputs: ScreenContextInputsV2,
    extras: ScreenNodeV2[] = [],
    source: 'generated' | 'fallback' = 'generated',
): ScreenDocumentV2 {
    const material = documentMaterialV2(inputs)
    const proposal = buildFallbackProposalV2(material)
    return screenDocumentV2Schema.parse(
        assembleDocumentV2(
            material,
            {
                ...proposal,
                body:
                    extras.length === 0
                        ? proposal.body
                        : { type: 'Stack', gap: 'md', align: 'stretch', children: [...extras, proposal.body] },
            },
            { source, evidence: 'synthetic-fixture', fallbackReason: source === 'generated' ? null : 'disabled' },
            { sha256Hex, now: () => new Date('2026-10-29T00:00:00Z') },
        ),
    )
}
async function setup(
    capture = false,
    noParts = false,
): Promise<
    Awaited<ReturnType<typeof runtime>> & {
        bindings: FrameBindings
        inputs: ScreenContextInputsV2
        run: ReturnType<typeof jest.fn>
    }
> {
    const seeded = entry()
    if (noParts) {
        seeded.session.parts = []
        seeded.session.rawExtraction = null
        seeded.session.reviewedSteps.forEach((step) => {
            step.parts = []
            step.kind = 'adjust'
            step.requirements = { orientation: false, connection: false, visibleChecks: false }
            step.orientation = { state: 'unknown', reason: 'Not required.' }
            step.connection = { state: 'unknown', reason: 'Not required.' }
            step.visibleChecks = []
            step.correction = null
        })
        manualSessionSchema.parse(seeded.session)
    }
    const ports = await runtime([seeded])
    await ports.controller.restore()
    await ports.controller.open(seeded.session.manualId, 'guide')
    if (capture) {
        ports.controller.camera({ kind: noParts ? 'question' : 'check' })
        await ports.controller.shutter(async () => source)
    }
    const state = ports.controller.getSnapshot()
    const selected = ports.controller.current!
    const more = { open: false, mode: 'details' as const, show: (): void => undefined, hide: (): void => undefined }
    const nav = defaultNav(ports.controller)
    const run = jest.fn()
    const bindings: FrameBindings = {
        resolve: () => ({ enabled: true, reason: null, run }),
        session: selected.session,
        live: { state, entry: selected, controller: ports.controller, nav, more },
        pageUris: state.pageUris,
        capture: state.capture,
        marks: [],
        heroMode: 'inline',
        inspect: false,
    }
    const inputs: ScreenContextInputsV2 = {
        kind: capture ? 'result' : 'guide',
        session: selected.session,
        stepId: selected.session.reviewedSteps[0]!.stepId,
        captureId: state.capture?.binding.captureId ?? null,
        result: state.check === null ? null : { kind: 'check', value: state.check },
        failure: null,
    }
    return { ...ports, bindings, inputs, run }
}

describe('the actual v2 catalog renderer', () => {
    it.each(['ready', 'unavailable'] as const)(
        'ends a missing manual picture honestly after asset loading is %s',
        async (pageImageStatus) => {
            const { inputs, bindings } = await setup()
            await render(
                wrap(
                    <DocumentRenderer
                        document={compose(inputs)}
                        bindings={{ ...bindings, pageUris: {}, pageImageStatus }}
                    />,
                ),
            )
            expect(screen.getByText('This manual picture is unavailable.')).toBeTruthy()
            expect(screen.queryByTestId('guide-hero-frame')).toBeNull()
            await fireEvent.press(screen.getAllByRole('button', { name: 'See it in the manual' })[0]!)
            expect(screen.getAllByText('This manual picture is unavailable.')).toHaveLength(2)
        },
    )

    it('shows freshly parsed facts and parts even when stale reviewed data remains', async () => {
        const { inputs, bindings } = await setup()
        const session = manualSessionSchema.parse({
            ...inputs.session!,
            reviewStatus: 'unreviewed',
            rawExtraction: {
                parts: inputs.session!.parts,
                steps: inputs.session!.reviewedSteps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                })),
                unknowns: [],
            },
            parts: inputs.session!.parts.map((part) => ({
                ...part,
                name: {
                    state: 'known',
                    value: 'Stale reviewed part',
                    sourceRefs: inputs.session!.pages.map((page) => ({ pageId: page.pageId, region: null })),
                },
            })),
            reviewedSteps: [{ ...inputs.session!.reviewedSteps[0]!, title: 'Stale reviewed instruction' }],
        })
        const document = compose(
            {
                kind: 'quick-check',
                session,
                stepId: null,
                captureId: null,
                result: null,
                failure: null,
                uiState: { review: { currentQuestion: null, blockers: 0, canConfirm: true } },
            },
            [{ type: 'Stepper', binding: 'steps', label: null }],
        )
        await render(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, session }} />))
        expect(screen.getByText('Side panel')).toBeTruthy()
        expect(screen.getByText('Divider shelf')).toBeTruthy()
        // The parts cite a page with no figure region: no whole-page picture is drawn for either tile.
        expect(screen.queryByTestId('part-hero-side-panel')).toBeNull()
        expect(screen.queryByTestId('part-hero-divider')).toBeNull()
        // The same page is already cited by the step overview: one shared opener replaces repeated tile links.
        const sideTile = screen.getByTestId('part-tile-side-panel')
        expect(within(sideTile).queryByTestId('diagram-0')).toBeNull()
        expect(within(sideTile).queryByRole('button', { name: 'See it in the manual: Side panel' })).toBeNull()
        const openers = screen.getAllByRole('button', { name: /^See it in the manual(?:$|:)/u })
        expect(openers).toHaveLength(1)
        await fireEvent.press(openers[0]!)
        expect(screen.getByTestId('diagram-0')).toBeTruthy()
        expect(screen.getByText('Picture from your manual · Page 1')).toBeTruthy()
        expect(screen.getByRole('button', { name: inputs.session!.reviewedSteps[1]!.title })).toBeDisabled()
        expect(screen.queryByText('Stale reviewed instruction')).toBeNull()
        expect(screen.queryByText('Stale reviewed part')).toBeNull()
        expect(screen.queryByText(/^×/u)).toBeNull()
    })

    it('keeps a part-only page reachable when no other visible source opener cites it', async () => {
        const { inputs, bindings } = await setup()
        const original = inputs.session!
        const partPage = {
            ...original.pages[0]!,
            pageId: 'part-only-page',
            assetId: 'part-only-asset',
            contentHash: '2'.repeat(64),
        }
        const session = manualSessionSchema.parse({
            ...original,
            pages: [...original.pages, partPage],
            parts: original.parts.map((part) =>
                part.partId === 'side-panel'
                    ? {
                          ...part,
                          name: {
                              state: 'known',
                              value: 'Side panel',
                              sourceRefs: [{ pageId: partPage.pageId, region: null }],
                          },
                      }
                    : part,
            ),
        })
        await render(
            wrap(<DocumentRenderer document={compose({ ...inputs, session })} bindings={{ ...bindings, session }} />),
        )
        const tile = within(screen.getByTestId('part-tile-side-panel'))
        expect(tile.queryByTestId('part-hero-side-panel')).toBeNull()
        await fireEvent.press(tile.getByRole('button', { name: 'See it in the manual: Side panel' }))
        expect(tile.getByTestId('diagram-0')).toBeTruthy()
        expect(tile.getByText('Picture from your manual · Page 2')).toBeTruthy()
        expect(tile.getByRole('button', { name: 'Hide the manual page: Side panel' })).toBeTruthy()
    })

    it('draws a part picture from its own cited figure region while a regionless part stays picture-free', async () => {
        const { inputs, bindings } = await setup()
        const pageId = inputs.session!.pages[0]!.pageId
        const sideName = inputs.session!.parts.find((part) => part.partId === 'side-panel')?.name
        const session = manualSessionSchema.parse({
            ...inputs.session!,
            parts: inputs.session!.parts.map((part) =>
                part.partId === 'side-panel'
                    ? {
                          ...part,
                          name: {
                              state: 'known' as const,
                              value: sideName?.state === 'known' ? sideName.value : 'Side panel',
                              sourceRefs: [{ pageId, region: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 } }],
                          },
                      }
                    : part,
            ),
        })
        const document = compose(
            {
                kind: 'quick-check',
                session,
                stepId: null,
                captureId: null,
                result: null,
                failure: null,
                uiState: { review: { currentQuestion: null, blockers: 0, canConfirm: true } },
            },
            [{ type: 'Stepper', binding: 'steps', label: null }],
        )
        await render(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, session }} />))
        expect(screen.getByTestId('part-hero-side-panel')).toBeTruthy()
        expect(screen.queryByTestId('part-hero-divider')).toBeNull()
    })

    it('shows neither a picture nor a manual link when a part has no resolved citation', async () => {
        const { inputs, bindings } = await setup()
        const session = manualSessionSchema.parse({
            ...inputs.session!,
            reviewStatus: 'unreviewed',
            rawExtraction: {
                parts: inputs.session!.parts.map((part) => ({
                    ...part,
                    name: { state: 'unknown' as const, reason: 'Unreadable.' },
                })),
                steps: inputs.session!.reviewedSteps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                })),
                unknowns: [],
            },
        })
        const document = compose(
            {
                kind: 'quick-check',
                session: inputs.session!,
                stepId: null,
                captureId: null,
                result: null,
                failure: null,
                uiState: { review: { currentQuestion: null, blockers: 0, canConfirm: true } },
            },
            [{ type: 'Stepper', binding: 'steps', label: null }],
        )
        await render(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, session }} />))
        expect(screen.queryByTestId('part-hero-side-panel')).toBeNull()
        const sideTile = screen.getByTestId('part-tile-side-panel')
        expect(within(sideTile).queryByRole('button', { name: /manual/u })).toBeNull()
        expect(within(sideTile).queryByTestId('diagram-0')).toBeNull()
    })

    it('never uses a reviewed-step index to select an unreviewed part quantity citation', async () => {
        const { inputs } = await setup()
        const session = manualSessionSchema.parse({
            ...inputs.session!,
            reviewStatus: 'unreviewed',
            rawExtraction: {
                parts: inputs.session!.parts.map((part) => ({
                    ...part,
                    name: { state: 'unknown', reason: 'Unreadable.' },
                })),
                steps: inputs.session!.reviewedSteps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                })),
                unknowns: [],
            },
        })
        expect(partSourceRefs(session, 'side-panel', 0)).toEqual([])
    })

    it('preserves semantic text roles, selected layout tokens and own-path origins without v1 adaptation', async () => {
        const { inputs, bindings } = await setup()
        const document = compose(inputs, [
            {
                type: 'Text',
                content: { kind: 'literal', text: 'More' },
                role: 'heading',
                emphasis: 'normal',
                tone: 'caution',
                align: 'end',
            },
        ])
        await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
        expect(screen.getByRole('header', { name: 'More' })).toBeTruthy()
        expect(screen.getByRole('header', { name: 'More' }).parent?.props.nativeID).toBe(
            'truebuild-render-origin:generated',
        )
        expect(screen.getByRole('header', { name: 'More' }).props.style).toEqual(
            expect.arrayContaining([expect.objectContaining({ textAlign: 'right' })]),
        )
        expect(screen.getByTestId('guide-primary').props.nativeID).toBe('truebuild-render-origin:generated')
    })

    it('uses the entire busy variant including its header and one fixed primary', async () => {
        const { inputs, bindings } = await setup()
        const document = compose(inputs)
        await render(wrap(<DocumentRenderer document={document} bindings={bindings} variant="busy" />))
        expect(screen.getAllByTestId('bottom-bar')).toHaveLength(1)
        expect(screen.getByTestId('guide-primary').props.nativeID).toBe(
            document.metadata.origins['states.busy.bar.primary'] === 'generated'
                ? 'truebuild-render-origin:generated'
                : 'truebuild-render-origin:fallback',
        )
        expect(screen.getByText('Working…')).toBeTruthy()
    })

    it('keeps the uncapped header copy in a wrapping, non-scrolling persistent native view', async () => {
        const { inputs, bindings } = await setup()
        await render(wrap(<DocumentRenderer document={compose(inputs)} bindings={bindings} />))
        const header = screen.getByTestId('document-header-copy')
        expect(header.type).toBe('View')
        expect(StyleSheet.flatten(header.props.style)).not.toEqual(
            expect.objectContaining({ maxHeight: expect.anything() }),
        )
        expect(header.queryAll((node) => node.type === 'RCTScrollView')).toHaveLength(0)
        expect(header.queryAll((node) => node.props.maxFontSizeMultiplier === 0).length).toBeGreaterThan(0)
    })

    it.each(['kind', 'manual', 'step', 'result capture', 'answer capture'] as const)(
        'starts a fresh native body scroller when the workflow page changes its %s',
        async (change) => {
            const { inputs, bindings } = await setup(true)
            const held = change.endsWith('capture')
            const initial: ScreenContextInputsV2 = {
                ...inputs,
                kind: change === 'answer capture' ? 'answer' : held ? 'result' : 'guide',
                captureId: held ? inputs.captureId : null,
                result:
                    change === 'answer capture'
                        ? {
                              kind: 'question',
                              question: 'Which way does the groove face?',
                              value: {
                                  answer: 'The groove faces inward.',
                                  sourceRefs: bindings.live!.state.check!.sourceRefs,
                                  missingEvidence: [],
                              },
                          }
                        : held
                          ? inputs.result
                          : null,
            }
            const next: ScreenContextInputsV2 =
                change === 'kind'
                    ? inputs
                    : change === 'manual'
                      ? { ...initial, session: { ...initial.session!, manualId: 'next-manual' } }
                      : change === 'step'
                        ? { ...initial, stepId: initial.session!.reviewedSteps[1]!.stepId }
                        : { ...initial, captureId: 'next-capture' }
            const extras: ScreenNodeV2[] =
                change === 'step' ? [{ type: 'Icon', name: 'info', size: 'sm', tone: 'neutral' }] : []
            const view = await render(
                wrap(<DocumentRenderer document={compose(initial, extras)} bindings={bindings} />),
            )
            const body = screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]!
            const header = screen.getByTestId('document-header-copy')
            const bar = screen.getByTestId('bottom-bar')
            await fireEvent.scroll(body, { nativeEvent: { contentOffset: { x: 0, y: 500 } } })
            await view.rerender(wrap(<DocumentRenderer document={compose(next, extras)} bindings={bindings} />))
            expect(screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]).not.toBe(
                body,
            )
            expect(screen.getByTestId('document-header-copy')).toBe(header)
            expect(screen.getByTestId('bottom-bar')).toBe(bar)
            if (change === 'kind') {
                expect(screen.getByTestId('frozen-photo-image')).toBeTruthy()
                expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
            }
        },
    )

    it('keeps the native scroller and an open local disclosure across a new composition of the same page', async () => {
        const { inputs, bindings } = await setup()
        const section: ScreenNodeV2 = {
            type: 'Section',
            title: { kind: 'bound', key: 'manual-title' },
            collapsible: true,
            initiallyOpen: false,
            children: [
                {
                    type: 'Text',
                    content: { kind: 'literal', text: 'More' },
                    role: 'caption',
                    emphasis: 'normal',
                    tone: 'neutral',
                    align: 'start',
                },
            ],
        }
        const fallback = compose(inputs, [section], 'fallback')
        const generated = compose(inputs, [section])
        expect(fallback.screenId).not.toBe(generated.screenId)
        const view = await render(wrap(<DocumentRenderer document={fallback} bindings={bindings} />))
        const body = screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]!
        const disclosure = screen.getByRole('button', { name: inputs.session!.title })
        await fireEvent.press(disclosure)
        expect(disclosure.props.accessibilityState.expanded).toBe(true)
        await view.rerender(wrap(<DocumentRenderer document={generated} bindings={bindings} />))
        expect(screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]).toBe(body)
        expect(screen.getByRole('button', { name: inputs.session!.title }).props.accessibilityState.expanded).toBe(true)
    })

    it('gives an inspected authored body scroller its allocated viewport even with its source disclosure open', async () => {
        const { inputs, bindings } = await setup()
        const document = compose(inputs)
        await render(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, inspect: true }} />))
        const body = screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]!
        const inspector = body.parent!
        expect(inspector.props.onTouchEnd).toEqual(expect.any(Function))
        expect(StyleSheet.flatten(inspector.props.style)).toEqual(expect.objectContaining({ flex: 1, minWidth: 0 }))
        await fireEvent(inspector, 'touchEnd', { stopPropagation: jest.fn() })
        expect(screen.getByText('Scroll · generated')).toBeTruthy()
        expect(screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]).toBe(body)
        expect(StyleSheet.flatten(inspector.props.style)).toEqual(expect.objectContaining({ flex: 1 }))
    })

    it('leaves both Android system edges to Back while claiming a real centre step swipe', async () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'android')
        const create = jest.spyOn(PanResponder, 'create')
        try {
            const { inputs, bindings } = await setup()
            await render(wrap(<DocumentRenderer document={compose(inputs)} bindings={bindings} />))
            const config = create.mock.calls.find(([candidate]) => candidate.onPanResponderRelease !== undefined)![0]
            const width = Dimensions.get('window').width
            const claims = (start: number, dx: number): boolean =>
                config.onMoveShouldSetPanResponder?.({} as never, { dx, dy: 0, moveX: start + dx } as never) ?? false
            expect(claims(10, 70)).toBe(false)
            expect(claims(width - 10, -70)).toBe(false)
            expect(claims(width / 2, -70)).toBe(true)
        } finally {
            create.mockRestore()
            platform.restore()
        }
    })

    it('does not claim a step swipe or change progress for unreviewed facts even if an injected resolver enables capture', async () => {
        const create = jest.spyOn(PanResponder, 'create')
        const { inputs, bindings } = await setup()
        const session = manualSessionSchema.parse({
            ...inputs.session!,
            reviewStatus: 'unreviewed',
            rawExtraction: {
                parts: inputs.session!.parts,
                steps: inputs.session!.reviewedSteps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                })),
                unknowns: [],
            },
        })
        const step = jest.spyOn(bindings.live!.controller, 'step').mockResolvedValue(undefined)
        try {
            await render(
                wrap(
                    <DocumentRenderer document={compose({ ...inputs, session })} bindings={{ ...bindings, session }} />,
                ),
            )
            const config = create.mock.calls.find(([candidate]) => candidate.onPanResponderRelease !== undefined)![0]
            const gesture = { dx: -100, dy: 0, moveX: Dimensions.get('window').width / 2 - 100 } as never
            const claims = config.onMoveShouldSetPanResponder?.({} as never, gesture)
            config.onPanResponderRelease?.({} as never, gesture)
            expect(claims).toBe(false)
            expect(step).not.toHaveBeenCalled()
        } finally {
            create.mockRestore()
            step.mockRestore()
        }
    })

    it('shows a known page count without fabricating per-page reading progress', async () => {
        const { inputs, bindings } = await setup()
        const document = compose({
            ...inputs,
            kind: 'reading',
            stepId: null,
            uiState: { busy: { activity: 'reading' } },
        })
        await render(
            wrap(
                <DocumentRenderer
                    document={document}
                    bindings={{
                        ...bindings,
                        live: { ...bindings.live!, state: { ...bindings.live!.state, pending: 'Reading your pages…' } },
                    }}
                    variant="busy"
                />,
            ),
        )
        const progress = screen.getByRole('progressbar', { name: 'Reading your manual' })
        expect(progress.props.accessibilityValue).toEqual({ text: 'In progress' })
        expect(screen.getByText('1 manual page')).toBeTruthy()
        expect(screen.queryByText('Page 1 of 1')).toBeNull()
    })

    it.each([
        { manualId: 'another-manual' },
        { revision: 999 },
        { stepId: 'another-step' },
        { captureId: 'another-capture' },
    ])(
        'shows the verdict only after its exact held-photo binding loads; mismatch %j never resolves it',
        async (mismatch) => {
            const { inputs, bindings } = await setup(true)
            const document = compose(inputs)
            const view = await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
            expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
            const waitingImage = screen.getByTestId('frozen-photo-image')
            await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
                nativeEvent: { layout: { width: 300, height: 200 } },
            })
            await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
            expect(screen.getByTestId('frozen-photo-image')).toBe(waitingImage)
            expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
            await view.rerender(
                wrap(
                    <DocumentRenderer
                        document={document}
                        bindings={{
                            ...bindings,
                            capture: {
                                ...bindings.capture!,
                                binding: { ...bindings.capture!.binding, ...mismatch },
                            },
                        }}
                    />,
                ),
            )
            expect(screen.queryByTestId('frozen-photo-image')).toBeNull()
            expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
            await view.rerender(wrap(<DocumentRenderer document={document} bindings={bindings} />))
            expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
            await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
                nativeEvent: { layout: { width: 300, height: 200 } },
            })
            await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
            expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
            await view.rerender(
                wrap(
                    <DocumentRenderer
                        document={document}
                        bindings={{ ...bindings, capture: { ...bindings.capture!, reusable: false } }}
                    />,
                ),
            )
            expect(screen.getByTestId('frozen-photo-image')).toBeTruthy()
            await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
            expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
        },
    )

    it('waits for the new native image when a deeper composition moves the same held photo', async () => {
        const { inputs, bindings } = await setup(true)
        const document = compose(inputs)
        const view = await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
        const body = screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]!
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
        const material = documentMaterialV2(inputs)
        const proposal = buildFallbackProposalV2(material)
        for (const { variant } of variantsOfV2(proposal)) {
            if (variant.body.type === 'Scroll' && variant.body.children[0]?.type === 'Stack') {
                variant.body.children[0].children = [
                    {
                        type: 'Card',
                        surface: 'raised',
                        padding: 'md',
                        tone: 'neutral',
                        children: variant.body.children[0].children,
                    },
                ]
            }
        }
        const next = screenDocumentV2Schema.parse(
            assembleDocumentV2(
                material,
                proposal,
                { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
                { sha256Hex, now: () => new Date('2026-10-29T00:00:00Z') },
            ),
        )
        expect(next.screenId).not.toBe(document.screenId)
        await view.rerender(wrap(<DocumentRenderer document={next} bindings={bindings} />))
        expect(screen.getByTestId('document-screen').queryAll((node) => node.type === 'RCTScrollView')[0]).toBe(body)
        expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
    })

    it('waits for the new native photo when inspection adds or removes its wrapper', async () => {
        const { inputs, bindings } = await setup(true)
        const document = compose(inputs)
        const view = await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
        const load = async (): Promise<void> => {
            await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
                nativeEvent: { layout: { width: 300, height: 200 } },
            })
            await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        }
        await load()
        expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
        for (const inspect of [true, false]) {
            const previous = screen.getByTestId('frozen-photo-image')
            await view.rerender(wrap(<DocumentRenderer document={document} bindings={{ ...bindings, inspect }} />))
            expect(screen.getByTestId('frozen-photo-image')).not.toBe(previous)
            expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
            await load()
            expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
        }
    })

    it('binds the sole camera primary to the shutter instead of reopening the camera', async () => {
        const { inputs, bindings, run } = await setup()
        const cameraInputs: ScreenContextInputsV2 = {
            ...inputs,
            kind: 'camera',
            uiState: { camera: { mode: 'build-photo', permission: 'granted' } },
        }
        const document = compose(cameraInputs)
        const capture = jest.fn()
        const mounted = jest.fn()
        const unmounted = jest.fn()
        function CameraPreview(): ReactElement {
            useEffect(() => {
                mounted()
                return unmounted
            }, [])
            return <View testID="raw-camera-preview" />
        }
        const cameraBindings = {
            ...bindings,
            camera: { permission: 'granted' as const, ready: true, capture, preview: <CameraPreview /> },
        }
        const view = await render(wrap(<DocumentRenderer document={document} bindings={cameraBindings} />))
        const preview = screen.getByTestId('raw-camera-preview')
        expect(screen.getAllByTestId('camera-shutter')).toHaveLength(1)
        await fireEvent.press(screen.getByTestId('camera-shutter'))
        expect(capture).toHaveBeenCalledTimes(1)
        expect(run).not.toHaveBeenCalled()
        await view.rerender(wrap(<DocumentRenderer document={document} bindings={cameraBindings} variant="busy" />))
        expect(screen.getByTestId('raw-camera-preview')).toBeTruthy()
        expect(mounted).toHaveBeenCalledTimes(1)
        expect(unmounted).not.toHaveBeenCalled()
        await fireEvent.press(screen.getByRole('button', { name: 'Working…' }))
        expect(capture).toHaveBeenCalledTimes(1)
        await view.rerender(wrap(<DocumentRenderer document={document} bindings={cameraBindings} variant="pending" />))
        expect(screen.getByTestId('camera-shutter')).toBeEnabled()
        expect(mounted).toHaveBeenCalledTimes(1)
        expect(unmounted).not.toHaveBeenCalled()
        const next = compose(cameraInputs, [], 'fallback')
        expect(next.screenId).not.toBe(document.screenId)
        await view.rerender(wrap(<DocumentRenderer document={next} bindings={cameraBindings} />))
        expect(screen.getByTestId('raw-camera-preview')).toBe(preview)
        expect(mounted).toHaveBeenCalledTimes(1)
        expect(unmounted).not.toHaveBeenCalled()
    })

    it('keeps the held result’s exact missing evidence and citations visible and reveals its feedback only once', async () => {
        const { inputs, bindings } = await setup(true)
        const check = {
            ...bindings.live!.state.check!,
            decision: 'cannot_verify' as const,
            missingEvidence: ['The far joint is hidden.'],
        }
        const liveBindings = { ...bindings, live: { ...bindings.live!, state: { ...bindings.live!.state, check } } }
        const document = compose({ ...inputs, result: { kind: 'check', value: check } })
        const trigger = jest.fn()
        const haptics = { trigger }
        const view = await render(wrap(<DocumentRenderer document={document} bindings={liveBindings} />, haptics))
        expect(screen.queryByText(check.missingEvidence[0]!)).toBeNull()
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getByText(check.reason)).toBeTruthy()
        expect(screen.getByText(check.missingEvidence[0]!)).toBeTruthy()
        expect(screen.getAllByRole('button', { name: 'See it in the manual' }).length).toBeGreaterThan(0)
        expect(trigger).toHaveBeenCalledWith('warning')
        await view.rerender(wrap(<DocumentRenderer document={document} bindings={{ ...liveBindings }} />, haptics))
        expect(trigger).toHaveBeenCalledTimes(1)
    })

    it('lets a question about a step without named parts choose a real photo point and blocks edits while busy', async () => {
        const { inputs, bindings, controller } = await setup(true, true)
        const target = jest.spyOn(controller, 'targetChanged')
        const document = compose({
            ...inputs,
            kind: 'questions',
            result: null,
            uiState: {
                capture: {
                    captureId: bindings.capture!.binding.captureId,
                    reusable: true,
                    target: null,
                    questionDraftPresent: false,
                },
            },
        })
        const view = await render(wrap(<DocumentRenderer document={document} bindings={bindings} />))
        expect(bindings.capture?.reusable).toBe(true)
        expect(document.bound.captureId).toBe(bindings.capture?.binding.captureId)
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 168.75 } },
        })
        await fireEvent.press(screen.getByTestId('frozen-photo-frame'), {
            nativeEvent: { locationX: 150, locationY: 84.375 },
        })
        expect(target).toHaveBeenLastCalledWith({ kind: 'point', x: 0.5, y: 0.5 })
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'accessibilityTap')
        expect(target).toHaveBeenCalledTimes(2)
        await view.rerender(
            wrap(
                <DocumentRenderer
                    document={document}
                    bindings={{
                        ...bindings,
                        live: { ...bindings.live!, state: { ...bindings.live!.state, pending: 'Still thinking…' } },
                    }}
                />,
            ),
        )
        await fireEvent.press(screen.getByTestId('frozen-photo-frame'), {
            nativeEvent: { locationX: 150, locationY: 84.375 },
        })
        expect(target).toHaveBeenCalledTimes(2)
    })

    it.each(['equal', 'disjoint', 'result-extra', 'manual-extra'] as const)(
        'shares a result sentence with a manual fact only when their citation sets are equal: %s',
        async (sourceCase) => {
            const { inputs, bindings } = await setup(true)
            const initial = documentMaterialV2(inputs).facts.find((item) => item.kind === 'orientation')!
            const extra = { pageId: initial.sourceRefs[0]!.pageId, region: { x: 0, y: 0, width: 0.5, height: 0.5 } }
            const orientation = inputs.session!.reviewedSteps[0]!.orientation
            if (sourceCase === 'manual-extra' && orientation.state === 'known') orientation.sourceRefs.push(extra)
            const fact = documentMaterialV2(inputs).facts.find((item) => item.kind === 'orientation')!
            const check = {
                ...bindings.live!.state.check!,
                reason: fact.text,
                sourceRefs:
                    sourceCase === 'disjoint'
                        ? [extra]
                        : sourceCase === 'result-extra'
                          ? [...fact.sourceRefs, extra]
                          : sourceCase === 'manual-extra'
                            ? [fact.sourceRefs[0]!]
                            : [...fact.sourceRefs],
            }
            const document = compose({ ...inputs, result: { kind: 'check', value: check } })
            const view = await render(
                wrap(
                    <DocumentRenderer
                        document={document}
                        bindings={{
                            ...bindings,
                            live: { ...bindings.live!, state: { ...bindings.live!.state, check } },
                        }}
                    />,
                ),
            )
            await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
                nativeEvent: { layout: { width: 300, height: 200 } },
            })
            await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
            expect(screen.getAllByText(fact.text)).toHaveLength(sourceCase === 'equal' ? 1 : 2)
            await view.rerender(
                wrap(
                    <DocumentRenderer
                        document={document}
                        bindings={{
                            ...bindings,
                            live: { ...bindings.live!, state: { ...bindings.live!.state, check: null } },
                        }}
                    />,
                ),
            )
            expect(screen.getAllByText(fact.text)).toHaveLength(1)
        },
    )

    it('deduplicates repeated facts and their own citation controls by fact id', async () => {
        const { inputs, bindings } = await setup()
        const material = documentMaterialV2(inputs)
        const fact = material.facts.find((item) => item.sourceRefs.length > 0 && item.kind === 'orientation')!
        const citation = material.sources.findIndex((item) => item.pageId === fact.sourceRefs[0]!.pageId)
        const duplicate: ScreenNodeV2[] = [
            {
                type: 'Text',
                content: { kind: 'fact', factId: fact.factId },
                role: 'body',
                emphasis: 'normal',
                tone: 'neutral',
                align: 'start',
            },
            { type: 'Citation', sources: [citation], label: null, display: 'chip' },
        ]
        await render(
            wrap(<DocumentRenderer document={compose(inputs, [...duplicate, ...duplicate])} bindings={bindings} />),
        )
        expect(screen.getAllByText(fact.text)).toHaveLength(1)
    })

    it('keeps a safety warning even when the held verdict repeats its exact cited sentence', async () => {
        const { inputs, bindings } = await setup(true)
        const fact = documentMaterialV2(inputs).facts.find((item) => item.kind === 'orientation')!
        inputs.session!.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'keep-warning',
                note: { state: 'known', value: fact.text, sourceRefs: [...fact.sourceRefs] },
            },
        ]
        const check = { ...bindings.live!.state.check!, reason: fact.text, sourceRefs: [...fact.sourceRefs] }
        const document = compose({ ...inputs, result: { kind: 'check', value: check } })
        await render(
            wrap(
                <DocumentRenderer
                    document={document}
                    bindings={{ ...bindings, live: { ...bindings.live!, state: { ...bindings.live!.state, check } } }}
                />,
            ),
        )
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getAllByText(fact.text)).toHaveLength(2)
        expect(screen.getByText('Safety')).toBeTruthy()
    })

    it('keeps the fact citation when an earlier repeated statement had no citation control', async () => {
        const { inputs, bindings } = await setup()
        const material = documentMaterialV2(inputs)
        const fact = material.facts.find((item) => item.kind === 'orientation')!
        const bare: ScreenNodeV2 = {
            type: 'Text',
            content: { kind: 'fact', factId: fact.factId },
            role: 'body',
            emphasis: 'normal',
            tone: 'neutral',
            align: 'start',
        }
        await render(wrap(<DocumentRenderer document={compose(inputs, [bare])} bindings={bindings} />))
        expect(screen.getAllByText(fact.text)).toHaveLength(1)
        // One citation affordance per exact source on the screen: every demo fact cites the same
        // page region, so one button offers it however many facts cite it (source access preserved).
        expect(screen.getAllByRole('button', { name: 'See it in the manual' })).toHaveLength(1)
        expect(material.facts.length).toBeGreaterThan(1)
    })

    it('renders a bounded varied set of valid recursive compositions without losing the required frame', async () => {
        const { inputs, bindings } = await setup()
        for (let seed = 0; seed < 24; seed++) {
            const leaf: ScreenNodeV2 = {
                type: 'Text',
                content: { kind: 'literal', text: 'More' },
                role: seed % 2 === 0 ? 'body' : 'caption',
                emphasis: 'normal',
                tone: 'neutral',
                align: 'start',
            }
            const tree: ScreenNodeV2 = {
                type: 'Card',
                padding: seed % 2 === 0 ? 'none' : 'lg',
                surface: 'raised',
                tone: 'neutral',
                children: [
                    {
                        type: 'Grid',
                        columns: ((seed % 4) + 1) as 1 | 2 | 3 | 4,
                        gap: 'sm',
                        children: [
                            {
                                type: 'Row',
                                gap: 'none',
                                align: 'center',
                                justify: 'between',
                                wrap: true,
                                children: [leaf],
                            },
                        ],
                    },
                ],
            }
            const view = await render(wrap(<DocumentRenderer document={compose(inputs, [tree])} bindings={bindings} />))
            expect(screen.getAllByTestId('bottom-bar')).toHaveLength(1)
            expect(screen.getByTestId('guide-primary')).toBeTruthy()
            await view.unmount()
        }
    })
})
