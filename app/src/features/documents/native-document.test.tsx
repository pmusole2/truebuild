import { fireEvent, render, screen } from '@testing-library/react-native'
import { useEffect, type ReactElement } from 'react'
import { Dimensions, PanResponder, Platform, StyleSheet, View } from 'react-native'
import {
    assembleDocumentV2,
    composeProposalV2,
    documentMaterialV2,
    screenDocumentV2Schema,
    manualSessionSchema,
    variantsOfV2,
    type ScreenDocumentV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
} from '@truebuild/contracts'
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
function compose(inputs: ScreenContextInputsV2, extras: ScreenNodeV2[] = []): ScreenDocumentV2 {
    const material = documentMaterialV2(inputs)
    const proposal = composeProposalV2(material)
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
            { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
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
        const view = await render(wrap(<DocumentRenderer document={compose(inputs)} bindings={bindings} />))
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
        const material = documentMaterialV2(inputs)
        const proposal = composeProposalV2(material)
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
        await view.rerender(wrap(<DocumentRenderer document={next} bindings={bindings} />))
        expect(screen.queryByText(bindings.live!.state.check!.reason)).toBeNull()
        await fireEvent(screen.getByTestId('frozen-photo-frame'), 'layout', {
            nativeEvent: { layout: { width: 300, height: 200 } },
        })
        await fireEvent(screen.getByTestId('frozen-photo-image'), 'load')
        expect(screen.getByText(bindings.live!.state.check!.reason)).toBeTruthy()
    })

    it('binds the sole camera primary to the shutter instead of reopening the camera', async () => {
        const { inputs, bindings, run } = await setup()
        const document = compose({
            ...inputs,
            kind: 'camera',
            uiState: { camera: { mode: 'build-photo', permission: 'granted' } },
        })
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
