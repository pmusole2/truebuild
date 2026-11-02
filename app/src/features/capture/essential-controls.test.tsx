import { fireEvent, render, screen } from '@testing-library/react-native'
import {
    buildFallbackProposalV2,
    documentMaterialV2,
    type ScreenKindV2,
    type ScreenVariantV2,
} from '@truebuild/contracts'
import { EssentialDocumentControls } from './essential-controls'
import { ThemeProvider } from '../../theme/theme'
import { FeedbackProvider } from '../../ui/feedback'
import { entry, runtime } from '../screens/test-support/route-harness'
import { defaultNav } from './screen-nav'
import { parseOrigin } from '../../ui/render-origin'

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
