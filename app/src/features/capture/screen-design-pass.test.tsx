import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { StyleSheet, Text, type StyleProp } from 'react-native'
import { ShutterButton } from '../../ui/camera-chrome'
import { INERT_WORKFLOW_CONTROLLER, WorkflowPreview } from '../../ui/preview/workflow-preview'
import {
    WORKFLOW_PREVIEW_CASES,
    workflowPreviewFixture,
    type WorkflowPreviewCase,
} from '../../ui/preview/workflow-fixtures'
import { lightColors } from '../../theme/tokens'
import { CameraStage } from './camera-stage'
import { GuideScreen } from './guide-screen'
import { LibraryScreen } from './library-screen'
import { OverviewScreen } from './review-screen'

// Synthetic fixtures only. Native text size is mocked through the window-dimensions hook: CSS 2x screenshots do not
// change `fontScale`, so these tests (not screenshots) cover the compact large-text and short-window branches.
const mockWindow = { width: 390, height: 844, fontScale: 1 }
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): typeof mockWindow & { scale: number } => ({ ...mockWindow, scale: 2 }),
}))
beforeEach(() => Object.assign(mockWindow, { width: 390, height: 844, fontScale: 1 }))
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

const flat = (node: { props: { style?: StyleProp<object> } }): Record<string, unknown> =>
    StyleSheet.flatten(node.props.style) as Record<string, unknown>
const hidden = { includeHiddenElements: true } as const

async function guide(id: WorkflowPreviewCase): Promise<string> {
    const { state, entry } = workflowPreviewFixture(id)
    const { toJSON } = await render(<GuideScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />)
    return JSON.stringify(toJSON())
}
const PHOTO = 'Frozen photo for this step'
const DIAGRAM = 'Expected diagram · page 1'

describe('the verdict is the hero and the evidence is its own block', () => {
    it.each(['guide-pass', 'guide-cannot-verify'] as const)(
        '%s: the verdict card holds no source diagram and the photo comes before the diagram',
        async (id) => {
            const tree = await guide(id)
            const card = screen.getByTestId('card-bar', hidden).parent!
            expect(within(card).queryByText(DIAGRAM)).toBeNull()
            expect(flat(card).borderColor).toBe(lightColors.borderStrong)
            expect(tree.indexOf(PHOTO)).toBeGreaterThan(tree.indexOf('Synthetic'))
            expect(tree.indexOf(DIAGRAM)).toBeGreaterThan(tree.indexOf(PHOTO))
            expect(tree.indexOf('"Parts"')).toBeGreaterThan(tree.indexOf(DIAGRAM))
            expect(screen.getByText(DIAGRAM)).toBeTruthy()
        },
    )

    it('keeps the answer card free of the source diagram, and the photo before it', async () => {
        const tree = await guide('guide-answer')
        const card = screen.getByText('Answer').parent!.parent!
        expect(within(card).queryByText(DIAGRAM)).toBeNull()
        expect(tree.indexOf(DIAGRAM)).toBeGreaterThan(tree.indexOf(PHOTO))
        expect(screen.getByText(/^Synthetic answer:/u)).toBeTruthy()
    })

    it('keeps a refusal as the first card, before the comparison, with the reason in full', async () => {
        const tree = await guide('guide-refuse')
        expect(tree.indexOf('Refuse')).toBeLessThan(tree.indexOf('Manual diagram'))
        expect(flat(screen.getByTestId('card-bar', hidden).parent!).borderColor).toBe(lightColors.borderStrong)
        expect(screen.getByText(/^Synthetic refusal:/u)).toBeTruthy()
    })

    it('shows the diagram once, never both in the card and below the photo', async () => {
        await guide('guide-pass')
        expect(screen.getAllByText(DIAGRAM)).toHaveLength(1)
    })
})

describe('guide dock', () => {
    it('groups the secondary actions in two short rows below the primary action, keeping every label', async () => {
        await guide('guide-photo')
        const steps = within(screen.getByTestId('dock-step-row'))
        expect(steps.getByRole('button', { name: 'Previous step' })).toBeTruthy()
        expect(steps.getByRole('button', { name: 'Next step' })).toBeTruthy()
        const support = within(screen.getByTestId('dock-support-row'))
        expect(support.getByRole('button', { name: 'Take photo to ask' })).toBeTruthy()
        expect(support.getByRole('button', { name: 'Mark step complete myself' })).toBeTruthy()
        // One filled action: the primary. Everything beneath it is outlined or quiet.
        const primary = flat(screen.getByRole('button', { name: 'Take new photo and check' }))
        expect(primary.backgroundColor).toBe(lightColors.accent)
        for (const name of ['Take photo to ask', 'Mark step complete myself']) {
            expect(flat(screen.getByRole('button', { name })).backgroundColor).toBe('transparent')
        }
        for (const name of ['Previous step', 'Next step']) {
            expect(flat(screen.getByRole('button', { name })).backgroundColor).toBe(lightColors.surfaceRaised)
        }
        expect(within(screen.getByTestId('guide-actions')).getAllByTestId(/^dock-.*-row$/u)).toHaveLength(2)
    })

    it('never shrinks or drops a control: each stays at least 44 points tall', async () => {
        await guide('guide-photo')
        for (const name of [
            'Take new photo and check',
            'Take photo to ask',
            'Previous step',
            'Next step',
            'Mark step complete myself',
        ]) {
            expect(flat(screen.getByRole('button', { name })).minHeight).toBe(44)
        }
    })

    it.each([
        ['text just below the large threshold', { fontScale: 1.49, height: 844 }, false],
        ['text at the large threshold', { fontScale: 1.5, height: 844 }, true],
        ['text at double size', { fontScale: 2, height: 844 }, true],
        ['a window just above the short threshold', { fontScale: 1, height: 650 }, false],
        ['a window just below the short threshold', { fontScale: 1, height: 649 }, true],
    ])('with %s the actions %s the one guide scroll', async (_label, dimensions, inline) => {
        Object.assign(mockWindow, dimensions)
        await guide('guide-photo')
        const scroll = within(screen.getByTestId('guide-panel'))
        expect(scroll.queryByRole('button', { name: 'Take new photo and check' }) !== null).toBe(inline)
        // Reachable either way, and the composer is in the same scroll when the dock is inline.
        expect(screen.getByRole('button', { name: 'Take new photo and check' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Mark step complete myself' })).toBeTruthy()
    })

    it('keeps the secondary dock rows bounded by the window and scrollable, never clipped', async () => {
        Object.assign(mockWindow, { fontScale: 1.2, height: 700 })
        await guide('guide-photo')
        expect(flat(screen.getByTestId('guide-actions')).maxHeight).toBe(700 * 0.4)
    })
})

describe('demo controls', () => {
    it('separates the three groups with rules and keeps every original group and label', async () => {
        await guide('guide-photo')
        expect(screen.getAllByTestId('demo-divider', hidden)).toHaveLength(2)
        for (const label of ['USER CONFIRMATION', "Judge's choice", 'Earlier progress']) {
            expect(screen.getByText(label)).toBeTruthy()
        }
    })
})

describe('home', () => {
    it('centres the first-run content instead of leaving a blank lower half', async () => {
        const { state } = workflowPreviewFixture('home-empty')
        await render(<LibraryScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} />)
        const content = StyleSheet.flatten(screen.getByTestId('library-scroll').props.contentContainerStyle)
        expect(content).toMatchObject({ flexGrow: 1, justifyContent: 'center' })
    })

    it('does not centre a populated library', async () => {
        const { state } = workflowPreviewFixture('home-populated')
        await render(<LibraryScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} />)
        const content = StyleSheet.flatten(screen.getByTestId('library-scroll').props.contentContainerStyle)
        expect(content.justifyContent).toBeUndefined()
    })

    it('gives a sole manual the hero card, and keeps several flat', async () => {
        const one = workflowPreviewFixture('home-populated')
        const { rerender } = await render(<LibraryScreen state={one.state} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(flat(screen.getByTestId('manual-card')).borderColor).toBe(lightColors.borderStrong)
        const second = { ...one.state.entries[0]!, session: { ...one.state.entries[0]!.session, manualId: 'second' } }
        await rerender(
            <LibraryScreen
                state={{ ...one.state, entries: [one.state.entries[0]!, second] }}
                controller={INERT_WORKFLOW_CONTROLLER}
            />,
        )
        for (const card of screen.getAllByTestId('manual-card')) {
            expect(flat(card).borderColor).toBe(lightColors.border)
        }
    })

    it('predicts the saved-manual card while the library restores', async () => {
        const { state } = workflowPreviewFixture('home-loading')
        await render(<LibraryScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(screen.getByLabelText('Restoring local library…')).toBeTruthy()
        // A card silhouette has a title block, three lines and an action bar.
        expect(screen.getAllByTestId('skeleton-block', hidden).length).toBeGreaterThanOrEqual(5)
    })

    it('keeps the add action reachable in the one scroll at large text', async () => {
        Object.assign(mockWindow, { fontScale: 1.5 })
        const { state } = workflowPreviewFixture('home-empty')
        await render(<LibraryScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(within(screen.getByTestId('library-scroll')).getByRole('button', { name: 'Add manual' })).toBeTruthy()
    })
})

describe('review', () => {
    it('separates the confirmation gate from the facts with a rule, and only while it is unconfirmed', async () => {
        const ready = workflowPreviewFixture('review-ready')
        const { unmount } = await render(
            <OverviewScreen state={ready.state} entry={ready.entry} controller={INERT_WORKFLOW_CONTROLLER} />,
        )
        expect(screen.getByTestId('confirm-divider', hidden)).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Confirm reviewed facts' })).toBeTruthy()
        await unmount()
        const done = workflowPreviewFixture('review-reviewed')
        await render(<OverviewScreen state={done.state} entry={done.entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(screen.queryByTestId('confirm-divider', hidden)).toBeNull()
    })

    it('gives each step card the hero border and keeps its gate and detail controls', async () => {
        const { state, entry } = workflowPreviewFixture('review-ready')
        await render(<OverviewScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        const card = screen.getAllByTestId('step-card')[0]!
        expect(flat(card).borderColor).toBe(lightColors.borderStrong)
        expect(screen.getByRole('button', { name: 'Step 1 details' })).toBeTruthy()
    })

    it('lists each part name first with the raw id as secondary text, keeping the full earlier name for assistive tech', async () => {
        const { state, entry } = workflowPreviewFixture('review-ready')
        await render(<OverviewScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        for (const part of entry.session.parts) {
            const name = part.name.state === 'known' ? part.name.value : `Unknown: ${part.name.reason}`
            // OLD visible text `Part <id>: <name>` is gone; its words live on as the row's accessibility label.
            expect(screen.queryByText(`Part ${part.partId}: ${name}`)).toBeNull()
            const row = screen.getByLabelText(`Part ${part.partId}: ${name}`)
            expect(within(row).getByText(name)).toBeTruthy()
            expect(within(row).getByText(`Part ID: ${part.partId}`)).toBeTruthy()
        }
    })

    it('opens a tapped page thumbnail full width and closes it, leaving the confirmation gate untouched', async () => {
        const { state, entry } = workflowPreviewFixture('review-ready')
        const page = entry.session.pages[0]!
        entry.session.pages = [page, { ...page, pageId: 'second-page' }]
        state.pageUris = { ...state.pageUris, 'second-page': state.pageUris[page.pageId]! }
        await render(<OverviewScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        const gateState = (): unknown[] => [
            screen.getByRole('checkbox', { name: /I checked all facts/ }).props.accessibilityState,
            screen.getByRole('button', { name: 'Confirm reviewed facts' }).props.accessibilityState,
        ]
        const before = gateState()
        // Every page stays reachable, each from a target at least 44 points on each side.
        const strip = screen.getAllByTestId('page-strip-item')
        expect(strip).toHaveLength(2)
        for (const item of strip) {
            expect(flat(item).minHeight).toBeGreaterThanOrEqual(64)
            expect(flat(item).width).toBeGreaterThanOrEqual(44)
        }
        expect(screen.queryByTestId('bottom-sheet')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Manual page 2' }))
        const sheet = within(screen.getByTestId('bottom-sheet'))
        expect(sheet.getByText('Manual page 2')).toBeTruthy()
        expect(sheet.getByLabelText('Manual page 2', { includeHiddenElements: true })).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
        expect(screen.queryByTestId('bottom-sheet')).toBeNull()
        // Opening and closing a page leaves the confirmation checkbox and its button exactly as they were.
        expect(gateState()).toEqual(before)
    })

    it('keeps page thumbnails at least 64 points tall', async () => {
        const { state, entry } = workflowPreviewFixture('review-ready')
        await render(<OverviewScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(flat(screen.getAllByTestId('page-strip-item')[0]!).minHeight).toBeGreaterThanOrEqual(64)
    })
})

describe('camera stage panel', () => {
    const stage = (summary?: boolean): React.ReactElement => (
        <CameraStage
            intent={{ kind: 'check' }}
            guide={{
                progress: 'Step 1 of 2',
                title: 'Side panel',
                summary: summary === true ? <Text>One line summary.</Text> : undefined,
                instructions: <Text>Every original fact.</Text>,
            }}
            presentation={{
                status: 'preview',
                media: <Text>Synthetic viewfinder</Text>,
                shutter: <ShutterButton label="Capture photo" disabled={false} onPress={(): void => undefined} />,
            }}
            onCancel={(): void => undefined}
            onRequestPermission={(): void => undefined}
            onOpenSettings={(): void => undefined}
            onRetry={(): void => undefined}
        />
    )

    it('shows a short summary over the viewfinder and keeps every fact one press away in the sheet', async () => {
        await render(stage(true))
        const panel = within(screen.getByTestId('assembly-panel'))
        expect(panel.getByText('One line summary.')).toBeTruthy()
        expect(panel.queryByText('Every original fact.')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'All step facts' }))
        expect(screen.getByText('Every original fact.')).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
        expect(screen.queryByText('Every original fact.')).toBeNull()
    })

    it('falls back to the full instructions in the panel when no summary is supplied', async () => {
        await render(stage(false))
        expect(within(screen.getByTestId('assembly-panel')).getByText('Every original fact.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'All step facts' })).toBeNull()
    })

    it('keeps the shutter and the bounded panel at a short window and at large text', async () => {
        Object.assign(mockWindow, { height: 568, fontScale: 1.5 })
        await render(stage(true))
        expect(screen.getByRole('button', { name: 'Capture photo' })).toBeTruthy()
        expect(screen.queryByTestId('assembly-panel')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Step instructions' }))
        expect(screen.getByText('Every original fact.')).toBeTruthy()
    })

    it('bounds the panel to a third of the window so the viewfinder keeps most of it', async () => {
        await render(stage(true))
        expect(flat(screen.getByTestId('assembly-panel')).maxHeight).toBeCloseTo(844 * 0.32, 6)
    })
})

// Every workflow screen, in both schemes, at normal text, at the large-text threshold, and in a short window. Each
// real screen must render with its content and at least one way forward; nothing here is a screenshot claim.
const SCENARIOS = [
    ['normal text', { fontScale: 1, height: 844 }],
    ['large text (fontScale 1.5)', { fontScale: 1.5, height: 844 }],
    ['double text (fontScale 2)', { fontScale: 2, height: 844 }],
    ['a short window', { fontScale: 1, height: 568 }],
] as const

describe.each(['light', 'dark'] as const)('every workflow screen in the %s scheme', (scheme) => {
    describe.each(SCENARIOS)('with %s', (_name, dimensions) => {
        it.each(WORKFLOW_PREVIEW_CASES.map((preview) => preview.id))('renders %s', async (id) => {
            Object.assign(mockWindow, dimensions)
            await render(<WorkflowPreview initialCase={id} initialScheme={scheme} showControls={false} />)
            expect(screen.getByTestId('workflow-preview')).toBeTruthy()
            // Screens keep at least one way forward; the loading, checking and build-unavailable states are the only ones without a button.
            const quiet = ['home-loading', 'home-unavailable', 'camera-loading', 'guide-pending'].includes(id)
            expect(screen.queryAllByRole('button').length > 0 || quiet).toBe(true)
        })
    })
})
