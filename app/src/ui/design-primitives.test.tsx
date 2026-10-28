import { describe, expect, it, jest } from '@jest/globals'
import { fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet, type StyleProp } from 'react-native'
import { ThemeProvider } from '../theme/theme'
import { darkColors, lightColors, type ColorScheme, type Colors } from '../theme/tokens'
import { AskSheet } from './ask-sheet'
import { AppButton, IconButton } from './button'
import { ViewfinderCorners } from './camera-chrome'
import { SegmentedControl, TextField } from './fields'
import { ProgressBar, StepList } from './progress'
import { ResultSheet } from './result-sheet'
import { BottomSheet } from './sheet'
import { ErrorState, LoadingState } from './states'
import { Notice, StatusTag } from './status'
import { ActionDock, Card } from './surface'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const palette: Readonly<Record<ColorScheme, Colors>> = { light: lightColors, dark: darkColors }
const style = (node: { props: { style?: StyleProp<object> } }): Record<string, unknown> =>
    StyleSheet.flatten(node.props.style) as Record<string, unknown>
const hidden = { includeHiddenElements: true } as const
const inScheme = (scheme: ColorScheme, element: React.ReactElement): React.ReactElement => (
    <ThemeProvider scheme={scheme}>{element}</ThemeProvider>
)

describe('hero result card', () => {
    it.each(['light', 'dark'] as const)(
        '%s: the result tone is raised and elevated, with no outline',
        async (scheme) => {
            await render(
                inScheme(
                    scheme,
                    <Card tone="result" testID="card">
                        <></>
                    </Card>,
                ),
            )
            // The only View with the card chrome is the card itself.
            const card = screen.getByTestId('card')
            const flat = style(card)
            expect(flat.borderWidth).toBeUndefined()
            expect(flat.backgroundColor).toBe(palette[scheme].surfaceRaised)
            expect(flat.shadowOpacity ?? flat.boxShadow).toBeTruthy()
        },
    )

    it('keeps a plain card flat and light, and lifts a plain card off the canvas in the dark scheme', async () => {
        const plain = (scheme: ColorScheme): React.ReactElement =>
            inScheme(
                scheme,
                <Card testID="card">
                    <></>
                </Card>,
            )
        const { unmount } = await render(plain('light'))
        const light = style(screen.getByTestId('card'))
        expect(light.backgroundColor).toBe(lightColors.surface)
        expect(light.borderWidth).toBeUndefined()
        expect(light.shadowOpacity).toBeUndefined()
        await unmount()
        await render(plain('dark'))
        expect(style(screen.getByTestId('card')).backgroundColor).toBe(darkColors.surfaceRaised)
    })

    it('keeps the reason and missing evidence in full, with no accent bar', async () => {
        await render(<ResultSheet verdict="refuse" reason="The panel is reversed." missing={['inward groove']} />)
        expect(screen.queryByTestId('card-bar', hidden)).toBeNull()
        expect(screen.getByText('The panel is reversed.')).toBeTruthy()
        expect(screen.getByText('Missing: inward groove')).toBeTruthy()
    })
})

describe('action dock', () => {
    it.each(['light', 'dark'] as const)(
        '%s: separates itself from the scroll by its own fill, with no rule',
        async (scheme) => {
            await render(
                inScheme(
                    scheme,
                    <ActionDock testID="dock">
                        <></>
                    </ActionDock>,
                ),
            )
            const flat = style(screen.getByTestId('dock'))
            expect(flat.borderTopWidth).toBeUndefined()
            expect(flat.backgroundColor).toBe(scheme === 'light' ? lightColors.surface : darkColors.surface)
            expect(flat.paddingHorizontal).toBe(16)
            expect(flat.paddingTop).toBe(12)
        },
    )
})

describe('buttons', () => {
    it('a quiet text button has no outline and keeps its 44 point target', async () => {
        await render(<AppButton label="Mark step complete myself" variant="quiet" onPress={(): void => undefined} />)
        const flat = style(screen.getByRole('button', { name: 'Mark step complete myself' }))
        expect(flat.borderWidth).toBeUndefined()
        expect(flat.backgroundColor).toBe('transparent')
        expect(flat.minHeight).toBe(44)
    })

    it('an icon-only quiet button stays borderless so headers stay calm', async () => {
        await render(<IconButton label="Back" icon="chevronLeft" onPress={(): void => undefined} />)
        expect(style(screen.getByRole('button', { name: 'Back' })).borderWidth).toBeUndefined()
    })

    it('a disabled button recedes further than a pressed one yet keeps its label', async () => {
        await render(<AppButton label="Previous step" disabled onPress={(): void => undefined} />)
        const button = screen.getByRole('button', { name: 'Previous step' })
        expect(style(button).opacity).toBe(0.38)
        expect(screen.getByText('Previous step')).toBeTruthy()
    })
})

describe('status and notices', () => {
    it('gives a status tag room to breathe without making it a touch target', async () => {
        await render(<StatusTag label="Facts readable" />)
        const tag = screen.getByText('Facts readable').parent!
        expect(style(tag)).toMatchObject({ minHeight: 28, paddingHorizontal: 12 })
    })

    it('marks a notice with a tone bar and keeps its alert role for errors', async () => {
        await render(<Notice tone="error" text="Check unavailable." />)
        expect(style(screen.getByTestId('notice-bar', hidden))).toMatchObject({
            width: 3,
            backgroundColor: lightColors.refuse,
        })
        expect(screen.getByRole('alert')).toBeTruthy()
    })
})

describe('progress', () => {
    it('shows a visible track at zero, so not started never looks broken', async () => {
        await render(<ProgressBar label="Guide progress" value={0} total={2} />)
        expect(style(screen.getByRole('progressbar', { name: 'Guide progress' })).borderColor).toBe(
            lightColors.borderStrong,
        )
    })

    it('keeps the ordinary track once progress starts', async () => {
        await render(<ProgressBar label="Guide progress" value={1} total={2} />)
        expect(style(screen.getByRole('progressbar', { name: 'Guide progress' })).borderColor).toBe(lightColors.border)
    })

    it('marks only the current step with a bar, and keeps the state word in its label', async () => {
        await render(
            <StepList
                steps={[
                    { id: 'a', title: 'Stand the panel', state: 'done' },
                    { id: 'b', title: 'Seat the divider', state: 'current' },
                    { id: 'c', title: 'Tighten', state: 'upcoming' },
                ]}
            />,
        )
        expect(screen.getAllByTestId('step-current-bar', hidden)).toHaveLength(1)
        expect(screen.getByLabelText('Step 2, Current: Seat the divider')).toBeTruthy()
    })
})

describe('states', () => {
    it('presents an error as a result card with an accent retry', async () => {
        const retry = jest.fn()
        await render(
            <ErrorState
                title="Camera unavailable"
                body="Close other apps."
                retry={{ label: 'Retry camera', onPress: retry }}
            />,
        )
        expect(screen.queryByTestId('card-bar', hidden)).toBeNull()
        expect(screen.getByRole('alert')).toBeTruthy()
        const button = screen.getByRole('button', { name: 'Retry camera' })
        expect(style(button).backgroundColor).toBe(lightColors.accent)
        await fireEvent.press(button)
        expect(retry).toHaveBeenCalledTimes(1)
    })

    it('a card-shaped loading state predicts a card, while the default stays three plain lines', async () => {
        const lines = await render(<LoadingState label="Reading pages…" />)
        const plain = screen.queryAllByTestId('skeleton-block', hidden).length
        await lines.unmount()
        await render(<LoadingState label="Reading pages…" shape="card" />)
        expect(screen.getAllByTestId('skeleton-block', hidden).length).toBeGreaterThan(plain)
        expect(screen.getByLabelText('Reading pages…')).toBeTruthy()
    })
})

describe('selection and fields share the single accent', () => {
    it('shows the chosen part chip in the accent fill, with its radio state unchanged', async () => {
        await render(
            <AskSheet
                question=""
                questionLabel="Question"
                onQuestionChange={(): void => undefined}
                parts={[
                    { id: 'a', label: 'Side panel' },
                    { id: 'b', label: 'Divider' },
                ]}
                selectedPartId="a"
                onSelectPart={(): void => undefined}
                targetSummary="Selected part: Side panel"
                hasTarget={true}
                onSubmit={(): void => undefined}
            />,
        )
        const chosen = screen.getByRole('radio', { name: 'Side panel' })
        expect(chosen.props.accessibilityState).toMatchObject({ checked: true })
        expect(style(chosen).backgroundColor).toBe(lightColors.accent)
        expect(style(screen.getByRole('radio', { name: 'Divider' })).backgroundColor).toBe(lightColors.surfaceRaised)
    })

    it('shows the selected segment in the accent fill', async () => {
        await render(
            <SegmentedControl
                label="Appearance"
                value="dark"
                options={[
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                ]}
                onChange={(): void => undefined}
            />,
        )
        expect(style(screen.getByRole('radio', { name: 'Dark' })).backgroundColor).toBe(lightColors.accent)
        expect(style(screen.getByRole('radio', { name: 'Light' })).backgroundColor).toBe(lightColors.surfaceRaised)
    })

    it.each(['light', 'dark'] as const)(
        '%s: text on a selected segment or chip uses the accent fill ink, not the strong fill ink',
        async (scheme) => {
            await render(
                inScheme(
                    scheme,
                    <>
                        <SegmentedControl
                            label="Appearance"
                            value="dark"
                            options={[
                                { value: 'light', label: 'Light' },
                                { value: 'dark', label: 'Dark' },
                            ]}
                            onChange={(): void => undefined}
                        />
                        <AskSheet
                            question=""
                            questionLabel="Question"
                            onQuestionChange={(): void => undefined}
                            parts={[{ id: 'a', label: 'Side panel' }]}
                            selectedPartId="a"
                            onSelectPart={(): void => undefined}
                            targetSummary="Selected part: Side panel"
                            hasTarget={true}
                            onSubmit={(): void => undefined}
                        />
                    </>,
                ),
            )
            const colors = palette[scheme]
            for (const label of ['Dark', 'Side panel']) {
                expect(style(screen.getByText(label)).color).toBe(colors.accentFillInk)
            }
            expect(style(screen.getByText('Light')).color).toBe(colors.ink)
        },
    )

    it('adds an icon to a field error so it never relies on red text alone', async () => {
        await render(
            <TextField
                label="Language"
                value="x"
                onChangeText={(): void => undefined}
                error="Use a code such as en."
            />,
        )
        expect(screen.getByTestId('field-error-icon', hidden)).toBeTruthy()
        expect(screen.getByText('Use a code such as en.')).toBeTruthy()
    })
})

describe('sheet and camera chrome', () => {
    it.each([
        ['light', 0.35],
        ['dark', 0.5],
    ] as const)('%s: a %s scrim, a drag handle and a heading-sized title', async (scheme, alpha) => {
        await render(
            inScheme(
                scheme,
                <BottomSheet visible={true} title="Step 1 instructions" onClose={(): void => undefined}>
                    <></>
                </BottomSheet>,
            ),
        )
        expect(style(screen.getByTestId('sheet-scrim', hidden)).backgroundColor).toBe(`rgba(0, 0, 0, ${alpha})`)
        expect(screen.getByTestId('sheet-handle', hidden)).toBeTruthy()
        expect(screen.getByRole('header', { name: 'Step 1 instructions' })).toBeTruthy()
    })

    it('doubles each viewfinder corner with a halo so it reads on a bright scene', async () => {
        await render(<ViewfinderCorners />)
        expect(screen.getAllByTestId('viewfinder-halo', hidden)).toHaveLength(4)
    })
})
