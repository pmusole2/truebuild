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
import { ManualCard, ThumbnailCard } from './cards'
import { PageHeader, SectionHeader } from './headers'
import { PartChip } from './part-chip'
import { ProgressRing } from './progress'

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
        '%s: the result tone is raised and elevated with the shared scheme outline',
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
            expect(flat.borderWidth).toBe(scheme === 'light' ? StyleSheet.hairlineWidth : undefined)
            expect(flat.backgroundColor).toBe(palette[scheme].surfaceRaised)
            expect(flat.shadowOpacity ?? flat.boxShadow).toBeTruthy()
        },
    )

    it('outlines a plain light card with a hairline and lifts a plain dark card onto the raised fill', async () => {
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
        expect(light.borderWidth).toBe(StyleSheet.hairlineWidth)
        expect(light.borderColor).toBe(lightColors.border)
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
        await render(<IconButton label="Back" icon="chevronLeft" variant="quiet" onPress={(): void => undefined} />)
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

    it('has no accent bar and keeps its alert role for errors', async () => {
        await render(<Notice tone="error" text="Check unavailable." />)
        expect(screen.queryByTestId('notice-bar', hidden)).toBeNull()
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

    it('marks only the current step selected, and keeps the state word in its label', async () => {
        await render(
            <StepList
                steps={[
                    { id: 'a', title: 'Stand the panel', state: 'done' },
                    { id: 'b', title: 'Seat the divider', state: 'current' },
                    { id: 'c', title: 'Tighten', state: 'upcoming' },
                ]}
            />,
        )
        const current = screen.getByLabelText('Step 2, Current: Seat the divider')
        expect(current.props.accessibilityState.selected).toBe(true)
        expect(screen.getByLabelText('Step 1, Done: Stand the panel').props.accessibilityState.selected).toBe(false)
        expect(screen.getByLabelText('Step 3, Not started: Tighten').props.accessibilityState.selected).toBe(false)
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

describe('shared card chrome', () => {
    it.each(['light', 'dark'] as const)(
        '%s: thumbnail and manual cards wear the same fill and outline as a plain card',
        async (scheme) => {
            await render(
                inScheme(
                    scheme,
                    <>
                        <Card testID="plain">
                            <></>
                        </Card>
                        <ThumbnailCard testID="thumb" title="Side panel photo" onPress={(): void => undefined} />
                        <ManualCard title="Side divider" summary="6 pages" onPress={(): void => undefined} />
                    </>,
                ),
            )
            const plain = style(screen.getByTestId('plain'))
            for (const card of [
                style(screen.getByTestId('thumb')),
                style(screen.getByRole('button', { name: 'Side divider, 6 pages' })),
            ]) {
                expect(card.backgroundColor).toBe(plain.backgroundColor)
                expect(card.borderWidth).toBe(plain.borderWidth)
                expect(card.borderColor).toBe(plain.borderColor)
                expect(card.borderRadius).toBe(16)
                expect(card.padding).toBe(16)
            }
        },
    )

    it('a selected thumbnail takes the focus ring instead of the plain outline', async () => {
        await render(<ThumbnailCard title="Side panel photo" selected={true} onPress={(): void => undefined} />)
        expect(style(screen.getByRole('button', { name: 'Side panel photo' }))).toMatchObject({
            borderColor: lightColors.focus,
        })
    })
})

describe('page and section headers', () => {
    it('a page title is a header at 22 points and its subtitle is one muted line', async () => {
        await render(<PageHeader title="Your manuals" subtitle="Two saved" />)
        const title = screen.getByRole('header', { name: 'Your manuals' })
        expect(style(title)).toMatchObject({ fontSize: 22, fontWeight: '600' })
        expect(screen.getByText('Two saved')).toHaveProp('numberOfLines', 1)
        expect(style(screen.getByText('Two saved')).color).toBe(lightColors.inkMuted)
    })

    it('the display variant sets the title at 28 points', async () => {
        await render(<PageHeader title="Build a part" display={true} />)
        expect(style(screen.getByRole('header', { name: 'Build a part' }))).toMatchObject({ fontSize: 28 })
    })

    it('a section header is a muted 13 point heading with 32 above and 12 below, and keeps its trailing control', async () => {
        await render(
            <SectionHeader
                title="Parts on this step"
                trailing={<ThumbnailCard title="Add" onPress={(): void => undefined} />}
            />,
        )
        const heading = screen.getByRole('header', { name: 'Parts on this step' })
        expect(style(heading)).toMatchObject({ fontSize: 13, fontWeight: '600', color: lightColors.inkMuted })
        const row = heading.parent!
        expect(style(row)).toMatchObject({ marginTop: 32, marginBottom: 12 })
        expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
    })
})

describe('part chip', () => {
    it('shows the sentence-case name and a count pill, while the accessible name keeps the part name', async () => {
        const onPress = jest.fn()
        await render(<PartChip name="SIDE PANEL" count={2} quantityTestID="qty" onPress={onPress} />)
        expect(screen.getByText('Side panel')).toBeTruthy()
        expect(screen.queryByText('SIDE PANEL')).toBeNull()
        expect(screen.getByTestId('qty')).toHaveTextContent('×2')
        const chip = screen.getByRole('button', { name: 'SIDE PANEL, 2' })
        expect(style(chip).minHeight).toBeGreaterThanOrEqual(44)
        await fireEvent.press(chip)
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it.each(['USB cable', 'PVC', 'IKEA bracket', 'eBay', 'iPhone case'])(
        'keeps acronym casing from %s in the displayed name',
        async (name) => {
            await render(<PartChip name={name} count={1} onPress={(): void => undefined} />)
            expect(screen.getByText(name)).toBeTruthy()
            expect(screen.getByRole('button', { name: `${name}, 1` }).props.accessibilityValue).toEqual({ text: '×1' })
        },
    )

    it('draws its 2D image first, then its colour, then the part glyph', async () => {
        const image = await render(
            <PartChip
                name="Divider"
                count={1}
                imageUri="file:///photo.jpg"
                color="#C84A31"
                onPress={(): void => undefined}
            />,
        )
        const shownImage = JSON.stringify(image.toJSON())
        expect(shownImage).toContain('file:///photo.jpg')
        expect(shownImage).not.toContain('#C84A31')
        await image.unmount()

        const coloured = await render(
            <PartChip name="Divider" count={1} color="#C84A31" onPress={(): void => undefined} />,
        )
        const shownColour = JSON.stringify(coloured.toJSON())
        expect(shownColour).toContain('#C84A31')
        expect(shownColour).not.toContain('file:///')
        await coloured.unmount()

        const plain = await render(<PartChip name="Divider" count={1} onPress={(): void => undefined} />)
        const shownGlyph = JSON.stringify(plain.toJSON())
        expect(shownGlyph).not.toContain('file:///')
        expect(shownGlyph).not.toContain('#C84A31')
        expect(shownGlyph).toContain('RNSVG')
    })

    it('omits the count pill when the count is unknown, and never invents a number', async () => {
        await render(<PartChip name="Divider" count={null} quantityTestID="qty" onPress={(): void => undefined} />)
        expect(screen.queryByTestId('qty')).toBeNull()
        expect(screen.getByRole('button', { name: 'Divider' })).toBeTruthy()
    })

    it('can render statically without an action', async () => {
        await render(<PartChip name="Divider" count={1} />)
        expect(screen.queryByRole('button', { name: 'Divider, 1' })).toBeNull()
        expect(screen.getByLabelText('Divider, 1')).toBeTruthy()
    })
})

describe('progress ring', () => {
    it('reports the whole-step value and label to assistive tech', async () => {
        await render(<ProgressRing label="Steps done" value={2} total={5} />)
        expect(screen.getByRole('progressbar', { name: 'Steps done' }).props.accessibilityValue).toEqual({
            min: 0,
            max: 5,
            now: 2,
            text: '2 of 5',
        })
    })

    it('stays between 36 and 44 points whatever size it is asked for', async () => {
        const { unmount } = await render(<ProgressRing label="Small" value={1} total={2} size={20} />)
        expect(style(screen.getByRole('progressbar', { name: 'Small' }))).toMatchObject({ width: 36, height: 36 })
        await unmount()
        await render(<ProgressRing label="Large" value={1} total={2} size={90} />)
        expect(style(screen.getByRole('progressbar', { name: 'Large' }))).toMatchObject({ width: 44, height: 44 })
    })
})
