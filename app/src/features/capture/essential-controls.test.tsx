import { fireEvent, render, screen } from '@testing-library/react-native'
import {
    buildFallbackProposalV2,
    documentMaterialV2,
    type ScreenKindV2,
    type ScreenVariantV2,
} from '@truebuild/contracts'
import { EssentialDocumentControls } from './essential-controls'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { entry, runtime } from '../screens/test-support/route-harness'
import { defaultNav } from './screen-nav'
import { parseOrigin } from '../../ui/render-origin'

jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))

it('keeps missing import, Resume and step navigation in shell chrome and deduplicates visible model controls by intent', async () => {
    const seeded = entry()
    const { controller } = await runtime([seeded])
    await controller.restore()
    const state = controller.getSnapshot()
    const choose = jest.fn()
    const step = jest.spyOn(controller, 'step').mockResolvedValue(undefined)
    const openStop = jest.fn()
    const nav = { ...defaultNav(controller), openStop }
    const variant = (kind: ScreenKindV2): ScreenVariantV2 => {
        const proposal = buildFallbackProposalV2(
            documentMaterialV2({
                kind,
                session: seeded.session,
                stepId: 'step-1',
                captureId: null,
                result: null,
                failure: null,
            }),
        )
        return {
            ...proposal,
            body: { type: 'Stack', gap: 'md', align: 'stretch', children: [] },
            bar: {
                primary: {
                    type: 'PrimaryAction',
                    label: 'Show tips',
                    intent: { intent: 'show-tips', target: 'screen' },
                    icon: null,
                },
                secondary: null,
            },
            overlays: [],
        }
    }
    const tree = (kind: ScreenKindV2, document: ScreenVariantV2): React.JSX.Element => (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <EssentialDocumentControls
                    kind={kind}
                    variant={document}
                    state={state}
                    entry={seeded}
                    busy={false}
                    resolve={() => ({ enabled: true, reason: null, run: choose })}
                    controller={controller}
                    nav={nav}
                />
            </FeedbackProvider>
        </ThemeProvider>
    )
    const view = await render(tree('add', variant('add')))
    try {
        for (const kind of ['add', 'pages'] as const) {
            const document = variant(kind)
            await view.rerender(tree(kind, document))
            const button = screen.getByTestId('shell-choose-photos')
            expect(parseOrigin(button.props.nativeID)).toBe('shell')
            await fireEvent.press(button)
            await view.rerender(
                tree(kind, {
                    ...document,
                    bar: {
                        ...document.bar,
                        secondary: {
                            type: 'SecondaryAction',
                            label: 'Import',
                            icon: null,
                            intent: { intent: 'capture', target: 'choose-pages' },
                        },
                    },
                }),
            )
            expect(screen.queryByTestId('shell-choose-photos')).toBeNull()
        }
        expect(choose).toHaveBeenCalledTimes(2)
        const home = variant('home')
        await view.rerender(tree('home', home))
        await fireEvent.press(screen.getByTestId('shell-resume'))
        expect(openStop).toHaveBeenCalledWith(seeded)
        await view.rerender(
            tree('home', {
                ...home,
                bar: { ...home.bar, primary: { ...home.bar.primary, intent: { intent: 'navigate', target: 'guide' } } },
            }),
        )
        expect(screen.queryByTestId('shell-resume')).toBeNull()
        const guide = variant('guide')
        await view.rerender(tree('guide', guide))
        expect(screen.getByTestId('shell-previous-step')).toBeDisabled()
        await fireEvent.press(screen.getByTestId('shell-next-step'))
        expect(step).toHaveBeenCalledWith(1)
        await view.rerender(tree('guide', { ...guide, body: { type: 'Stepper', binding: 'steps', label: null } }))
        expect(screen.queryByTestId('shell-next-step')).toBeNull()
    } finally {
        await view.unmount()
        controller.dispose()
        jest.restoreAllMocks()
    }
})

it('places the guide primary between the existing previous/next controls and keeps their boundary rules', async () => {
    const seeded = entry()
    const { controller } = await runtime([seeded])
    await controller.restore()
    const state = controller.getSnapshot()
    const step = jest.spyOn(controller, 'step').mockResolvedValue(undefined)
    const primary = jest.fn()
    const variant = buildFallbackProposalV2(
        documentMaterialV2({
            kind: 'guide',
            session: seeded.session,
            stepId: 'step-1',
            captureId: null,
            result: null,
            failure: null,
        }),
    )
    const view = await render(
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <FixedBottomBar
                    primary={{ label: 'Take photo', testID: 'guide-primary', onPress: primary }}
                    navigation={
                        <EssentialDocumentControls
                            kind="guide"
                            variant={variant}
                            state={state}
                            entry={seeded}
                            busy={false}
                            resolve={() => ({ enabled: true, reason: null, run: (): void => undefined })}
                            controller={controller}
                            nav={defaultNav(controller)}
                        />
                    }
                />
            </FeedbackProvider>
        </ThemeProvider>,
    )
    try {
        const row = screen.getByTestId('guide-action-row')
        expect(row.props.style).toMatchObject({ flexDirection: 'row' })
        expect(screen.getAllByRole('button')).toHaveLength(3)
        expect(screen.getByTestId('shell-previous-step')).toBeDisabled()
        expect(screen.getByTestId('shell-next-step')).toBeEnabled()
        await fireEvent.press(screen.getByRole('button', { name: 'Take photo' }))
        await fireEvent.press(screen.getByRole('button', { name: 'Next step' }))
        expect(primary).toHaveBeenCalledTimes(1)
        expect(step).toHaveBeenCalledWith(1)
    } finally {
        await view.unmount()
        controller.dispose()
        step.mockRestore()
    }
})

it('offers "It\'s done, next step" only on a can\'t-tell result, never on a refuse or a pass', async () => {
    const base = entry()
    const seeded = { ...base, session: { ...base.session, reviewStatus: 'reviewed' as const } }
    const { controller } = await runtime([seeded])
    await controller.restore()
    const complete = jest.spyOn(controller, 'completeStep').mockResolvedValue(undefined)
    const variant = buildFallbackProposalV2(
        documentMaterialV2({
            kind: 'result',
            session: seeded.session,
            stepId: 'step-1',
            captureId: null,
            result: null,
            failure: null,
        }),
    )
    const snapshot = controller.getSnapshot()
    const tree = (decision: 'pass' | 'refuse' | 'cannot_verify'): React.JSX.Element => (
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <EssentialDocumentControls
                    kind="result"
                    variant={{ ...variant, body: { type: 'Stack', gap: 'md', align: 'stretch', children: [] }, overlays: [] }}
                    state={{ ...snapshot, check: { decision } } as typeof snapshot}
                    entry={seeded}
                    busy={false}
                    resolve={() => ({ enabled: true, reason: null, run: (): void => undefined })}
                    controller={controller}
                    nav={defaultNav(controller)}
                />
            </FeedbackProvider>
        </ThemeProvider>
    )
    const view = await render(tree('cannot_verify'))
    try {
        await fireEvent.press(screen.getByRole('button', { name: "It's done, next step" }))
        expect(complete).toHaveBeenCalledTimes(1)
        for (const decision of ['refuse', 'pass'] as const) {
            await view.rerender(tree(decision))
            expect(screen.queryByTestId('shell-own-done')).toBeNull()
        }
    } finally {
        await view.unmount()
        controller.dispose()
        complete.mockRestore()
    }
})
