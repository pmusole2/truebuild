import { act, fireEvent, render, screen, within } from '@testing-library/react-native'
import { StyleSheet, type StyleProp } from 'react-native'
import { INERT_WORKFLOW_CONTROLLER, WorkflowPreview } from '../../ui/preview/workflow-preview'
import {
    WORKFLOW_PREVIEW_CASES,
    workflowPreviewFixture,
    type WorkflowPreviewCase,
} from '../../ui/preview/workflow-fixtures'
import { lightColors } from '../../theme/tokens'
import { GuideScreen } from './guide-screen'
import { LibraryScreen } from './library-screen'
import { plainWords } from './plain-copy'
import { OverviewScreen } from './review-screen'

// Synthetic fixtures only. Native text size is mocked through the window-dimensions hook: CSS 2x screenshots do not
// change `fontScale`, so these tests (not screenshots) cover the large-text and short-window branches.
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
const openMore = async (): Promise<void> => {
    await fireEvent.press(screen.getByRole('button', { name: 'More' }))
}
const DIAGRAM = 'Expected diagram · page 1'

describe('the verdict is one sentence under the photo, and the evidence is its own block in More', () => {
    it.each(['guide-pass', 'guide-cannot-verify'] as const)(
        '%s: the photo comes first, the default surface holds no source diagram, and More does',
        async (id) => {
            const tree = await guide(id)
            expect(screen.getByTestId('guide-hero')).toBeTruthy()
            expect(tree).not.toContain(DIAGRAM)
            expect(screen.queryByTestId('card-bar', hidden)).toBeNull()
            await openMore()
            expect(JSON.stringify(screen.toJSON())).toContain(DIAGRAM)
        },
    )

    it('keeps the answer as the existing response text on the default surface and its card in More', async () => {
        await guide('guide-answer')
        const answer = workflowPreviewFixture('guide-answer').state.answer!
        expect(screen.getByText(plainWords(answer.answer))).toBeTruthy()
        expect(screen.queryByText('Answer')).toBeNull()
        await openMore()
        expect(within(screen.getByTestId('more-sheet')).getByText('Answer')).toBeTruthy()
    })

    it('starts a refusal with "Not yet." and keeps the comparison before the explanation in More', async () => {
        const tree = await guide('guide-refuse')
        const check = workflowPreviewFixture('guide-refuse').state.check!
        expect(screen.getByText(`Not yet. ${plainWords(check.reason)}`)).toBeTruthy()
        expect(tree).not.toContain('Manual diagram')
        await openMore()
        const more = JSON.stringify(screen.toJSON())
        expect(more.indexOf('Manual diagram')).toBeGreaterThanOrEqual(0)
        expect(more.indexOf('Manual diagram')).toBeLessThan(more.indexOf('"Parts"'))
    })
})

describe('guide bottom bar', () => {
    it('holds exactly one primary of at least 56 points, and the picture keeps its place above it', async () => {
        await guide('guide-photo')
        const bar = within(screen.getByTestId('bottom-bar'))
        const buttons = bar.getAllByRole('button')
        expect(buttons).toHaveLength(1)
        expect(flat(buttons[0]!).minHeight).toBeGreaterThanOrEqual(56)
        expect(flat(buttons[0]!).borderWidth).toBeUndefined()
    })

    it.each([
        ['large text', { fontScale: 2, height: 844 }],
        ['a short window', { fontScale: 1, height: 568 }],
        ['a window just above the old compact threshold', { fontScale: 1, height: 650 }],
    ])('keeps the primary in the bar, outside the scrolling text, with %s', async (_name, dimensions) => {
        Object.assign(mockWindow, dimensions)
        await guide('guide-pass')
        expect(within(screen.getByTestId('guide-panel')).queryByTestId('guide-primary')).toBeNull()
        expect(within(screen.getByTestId('bottom-bar')).getByTestId('guide-primary')).toBeTruthy()
    })

    it('keeps every More control at least 44 points tall', async () => {
        await guide('guide-photo')
        await openMore()
        for (const name of ['Ask about this step', 'Previous step', 'Next step', 'Mark step complete myself']) {
            expect(flat(screen.getByRole('button', { name })).minHeight).toBeGreaterThanOrEqual(44)
        }
        await fireEvent.press(screen.getByRole('button', { name: 'Ask about this step' }))
        expect(flat(screen.getByRole('button', { name: 'Take photo to ask' })).minHeight).toBeGreaterThanOrEqual(44)
    })
})

describe('demo controls', () => {
    it('separates the three groups with rules inside More and keeps every original group and label', async () => {
        await guide('guide-photo')
        expect(screen.queryByText('USER CONFIRMATION')).toBeNull()
        await openMore()
        // The controls wait behind the discreet judge entry; nothing technical shows before it is opened.
        expect(screen.queryByText('USER CONFIRMATION')).toBeNull()
        expect(screen.queryByTestId('demo-divider', hidden)).toBeNull()
        await fireEvent.press(screen.getByTestId('judge-entry'))
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

    it('shows saved manuals as filled cards with no outline, one continuation for a sole manual', async () => {
        const one = workflowPreviewFixture('home-populated')
        const { rerender } = await render(<LibraryScreen state={one.state} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(flat(screen.getByTestId('manual-card')).borderWidth).toBeUndefined()
        expect(flat(screen.getByTestId('manual-card')).backgroundColor).toBe(lightColors.surfaceRaised)
        expect(screen.getByText('Pick up where you left off.')).toBeTruthy()
        const second = { ...one.state.entries[0]!, session: { ...one.state.entries[0]!.session, manualId: 'second' } }
        await rerender(
            <LibraryScreen
                state={{ ...one.state, entries: [one.state.entries[0]!, second] }}
                controller={INERT_WORKFLOW_CONTROLLER}
            />,
        )
        expect(screen.getAllByTestId('manual-card')).toHaveLength(2)
        expect(screen.queryByText('Pick up where you left off.')).toBeNull()
    })

    it('predicts the saved-manual card while the library restores, with the primary disabled in place', async () => {
        const { state } = workflowPreviewFixture('home-loading')
        await render(<LibraryScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(screen.getByLabelText('Getting your builds ready.')).toBeTruthy()
        expect(screen.getAllByTestId('skeleton-block', hidden).length).toBeGreaterThanOrEqual(5)
        expect(screen.getByRole('button', { name: 'Add manual' }).props.accessibilityState.disabled).toBe(true)
    })

    it('keeps the add action in the fixed bar at large text, outside the scroll', async () => {
        Object.assign(mockWindow, { fontScale: 2 })
        const { state } = workflowPreviewFixture('home-empty')
        await render(<LibraryScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(within(screen.getByTestId('bottom-bar')).getByRole('button', { name: 'Add manual' })).toBeTruthy()
        expect(within(screen.getByTestId('library-scroll')).queryByRole('button', { name: 'Add manual' })).toBeNull()
    })
})

describe('quick check', () => {
    it('asks one question with a single Let me fix it primary and a quiet Skip, never a form or a checkbox', async () => {
        const { state, entry } = workflowPreviewFixture('review-unresolved')
        await render(<OverviewScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(screen.getByRole('button', { name: 'Let me fix it' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Skip for now' })).toBeTruthy()
        // No field, part picker, reason wall or Save until Let me fix it is tapped.
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
        expect(screen.queryByRole('radio')).toBeNull()
        expect(screen.queryByLabelText(/^What /u)).toBeNull()
        expect(screen.queryByRole('checkbox')).toBeNull()
        expect(screen.queryByText('Confirm reviewed facts')).toBeNull()
        expect(within(screen.getByTestId('bottom-bar')).getAllByRole('button')).toHaveLength(2)
    })

    it('ends with an explicit Start building when nothing is left to ask', async () => {
        const { state, entry } = workflowPreviewFixture('review-ready')
        await render(<OverviewScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(screen.getByText('Thanks. Your steps are ready.')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Start building' })).toBeTruthy()
    })

    it('lists each part by name only in More, with no part id anywhere', async () => {
        const { state, entry } = workflowPreviewFixture('review-ready')
        await render(<OverviewScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        await openMore()
        const more = within(screen.getByTestId('more-sheet'))
        for (const part of entry.session.parts) {
            if (part.name.state === 'known') {
                expect(more.getAllByText(part.name.value).length).toBeGreaterThan(0)
            }
            expect(screen.queryByText(new RegExp(`Part ID`, 'u'))).toBeNull()
            expect(JSON.stringify(screen.toJSON())).not.toContain(`Part ${part.partId}`)
        }
    })

    it('opens a tapped page thumbnail full width and closes it, leaving Start building untouched', async () => {
        const { state, entry } = workflowPreviewFixture('review-ready')
        const page = entry.session.pages[0]!
        entry.session.pages = [page, { ...page, pageId: 'second-page', assetId: 'second-asset' }]
        state.pageUris = { ...state.pageUris, 'second-page': state.pageUris[page.pageId]! }
        await render(<OverviewScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />)
        const start = (): unknown =>
            screen.getByRole('button', { name: 'Start building', ...hidden }).props.accessibilityState
        const before = start()
        await openMore()
        // Every page stays reachable, each from a target at least 44 points on each side.
        const strip = screen.getAllByTestId('page-strip-item')
        expect(strip).toHaveLength(2)
        for (const item of strip) {
            expect(flat(item).minHeight).toBeGreaterThanOrEqual(44)
            expect(flat(item).width).toBeGreaterThanOrEqual(44)
        }
        await fireEvent.press(screen.getByRole('button', { name: 'Manual page 2' }))
        const sheet = within(screen.getByTestId('more-sheet'))
        expect(sheet.getByText('Page 2')).toBeTruthy()
        expect(sheet.getByLabelText('Manual page 2', hidden)).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200))
        })
        expect(screen.queryByTestId('more-sheet')).toBeNull()
        expect(start()).toEqual(before)
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
