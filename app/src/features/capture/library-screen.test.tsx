import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { StyleSheet } from 'react-native'
import type { SharedValue } from 'react-native-reanimated'
import { FeedbackProvider } from '../../ui/feedback'
import { INERT_WORKFLOW_CONTROLLER } from '../../ui/preview/workflow-preview'
import { workflowPreviewFixture, type WorkflowPreviewCase } from '../../ui/preview/workflow-fixtures'
import { collapseProgress, COLLAPSE_DISTANCE, LibraryScreen, useHomeTitle } from './library-screen'
import type { WorkflowState } from './controller'
import type { WorkflowController } from './workflow-types'

const mockWindow = { width: 390, height: 844, fontScale: 1 }
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): typeof mockWindow & { scale: number } => ({ ...mockWindow, scale: 2 }),
}))
beforeEach(() => {
    Object.assign(mockWindow, { width: 390, height: 844, fontScale: 1 })
})

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

async function setup(
    id: WorkflowPreviewCase,
    patch: Partial<WorkflowState> = {},
): Promise<{ createManual: jest.Mock; open: jest.Mock; restore: jest.Mock }> {
    const { state } = workflowPreviewFixture(id)
    const createManual = jest.fn(async (): Promise<void> => undefined)
    const open = jest.fn(async (): Promise<void> => undefined)
    const restore = jest.fn(async (): Promise<void> => undefined)
    const controller: WorkflowController = { ...INERT_WORKFLOW_CONTROLLER, createManual, open, restore }
    await render(<LibraryScreen state={{ ...state, ...patch }} controller={controller} />)
    return { createManual, open, restore }
}

describe('first run', () => {
    it('says one thing, with Add manual as the only action, and keeps How it works in More', async () => {
        await setup('home-empty')
        expect(screen.getByText('Build furniture with step-by-step help.')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Add manual' })).toBeTruthy()
        expect(screen.queryByText('Use sample manual')).toBeNull()
        // The explanation is not on the surface and has no second button beside the primary; it is in More.
        expect(screen.queryByText('Scan. Photograph the pages of your paper manual.')).toBeNull()
        expect(screen.queryByRole('button', { name: 'How it works' })).toBeNull()
        expect(within(screen.getByTestId('bottom-bar')).getAllByRole('button')).toHaveLength(1)
        await fireEvent.press(screen.getByRole('button', { name: 'More' }))
        const more = within(screen.getByTestId('more-sheet'))
        for (const verb of ['Scan', 'Look', 'Next', 'Ask']) {
            expect(more.getByText(new RegExp(`^${verb}\\. `, 'u'))).toBeTruthy()
        }
    })

    it('does not show the first-run line over a retained but unreadable library, loading, or saved manuals', async () => {
        for (const [id, patch] of [
            ['home-error', {}],
            ['home-loading', {}],
            ['home-populated', {}],
        ] as const) {
            await setup(id, patch)
            expect(screen.queryByText('Build furniture with step-by-step help.')).toBeNull()
            await screen.unmount()
        }
    })

    it('adds a manual from one primary action, only when pressed', async () => {
        const { createManual } = await setup('home-empty')
        expect(createManual).not.toHaveBeenCalled()
        await fireEvent.press(screen.getByRole('button', { name: 'Add manual' }))
        expect(createManual).toHaveBeenCalledTimes(1)
    })
})

describe('Add manual placement', () => {
    it('anchors the action in the fixed bar outside the scroll at a normal height', async () => {
        await setup('home-empty')
        expect(within(screen.getByTestId('bottom-bar')).getByRole('button', { name: 'Add manual' })).toBeTruthy()
        expect(within(screen.getByTestId('library-scroll')).queryByRole('button', { name: 'Add manual' })).toBeNull()
    })

    it.each([
        ['a short phone', { width: 320, height: 568, fontScale: 1 }],
        ['large system text', { width: 390, height: 844, fontScale: 2 }],
    ])('keeps the large title in the scroll and the action in the bar with %s', async (_label, dimensions) => {
        Object.assign(mockWindow, dimensions)
        await setup('home-empty')
        expect(within(screen.getByTestId('library-scroll')).getByText('TrueBuild')).toBeTruthy()
        expect(within(screen.getByTestId('bottom-bar')).getByRole('button', { name: 'Add manual' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'More' })).toBeTruthy()
    })

    it('lets the native iOS list fill the screen under a floating bar, padded by the bar so nothing is hidden', async () => {
        const { state } = workflowPreviewFixture('home-populated')
        await render(
            <LibraryScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} chrome="native" largeTitle="heading" />,
        )
        expect(StyleSheet.flatten(screen.getByTestId('bottom-bar').props.style)).toMatchObject({
            position: 'absolute',
            bottom: 0,
        })
        const before = StyleSheet.flatten(screen.getByTestId('library-scroll').props.contentContainerStyle)
        await fireEvent(screen.getByTestId('bottom-bar'), 'layout', { nativeEvent: { layout: { height: 140 } } })
        const after = StyleSheet.flatten(screen.getByTestId('library-scroll').props.contentContainerStyle)
        expect(after.paddingBottom).toBe(before.paddingBottom + 140)
    })

    it('keeps the bar below the list where the title is drawn in the content', async () => {
        await setup('home-populated')
        expect(StyleSheet.flatten(screen.getByTestId('bottom-bar').props.style).position).toBeUndefined()
    })

    it('draws the uncapped "Your builds" heading in the list and no brand title there on iOS', async () => {
        const { state } = workflowPreviewFixture('home-empty')
        await render(
            <LibraryScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} chrome="native" largeTitle="heading" />,
        )
        const heading = within(screen.getByTestId('library-scroll')).getByRole('header', { name: 'Your builds' })
        expect(heading.props.numberOfLines).toBeUndefined()
        expect(heading.props.maxFontSizeMultiplier).toBe(0)
        expect(screen.queryByText('TrueBuild')).toBeNull()
        expect(screen.queryByTestId('collapsing-title')).toBeNull()
        expect(screen.queryByTestId('inline-header')).toBeNull()
    })
})

describe('iOS heading collapse', () => {
    async function scrollTo(y: number): Promise<void> {
        await fireEvent.scroll(screen.getByTestId('library-scroll'), { nativeEvent: { contentOffset: { x: 0, y } } })
    }
    async function renderHeading(): Promise<jest.Mock> {
        const onCollapsedChange = jest.fn()
        const { state } = workflowPreviewFixture('home-populated')
        await render(
            <LibraryScreen
                state={state}
                controller={INERT_WORKFLOW_CONTROLLER}
                chrome="native"
                largeTitle="heading"
                onCollapsedChange={onCollapsedChange}
            />,
        )
        return onCollapsedChange
    }

    it('reports collapsed once, only when the heading has scrolled away, and open again on the way back', async () => {
        const onCollapsedChange = await renderHeading()
        await scrollTo(COLLAPSE_DISTANCE - 1)
        expect(onCollapsedChange).not.toHaveBeenCalled()
        await scrollTo(COLLAPSE_DISTANCE)
        await scrollTo(COLLAPSE_DISTANCE + 80)
        expect(onCollapsedChange.mock.calls).toEqual([[true]])
        await scrollTo(0)
        expect(onCollapsedChange.mock.calls).toEqual([[true], [false]])
    })

    it('waits for the measured heading height, so a tall heading at the largest text size is not collapsed at 56', async () => {
        const onCollapsedChange = await renderHeading()
        await fireEvent(screen.getByTestId('home-heading'), 'layout', { nativeEvent: { layout: { height: 256 } } })
        await scrollTo(COLLAPSE_DISTANCE + 100)
        expect(onCollapsedChange).not.toHaveBeenCalled()
        await scrollTo(256)
        expect(onCollapsedChange.mock.calls).toEqual([[true]])
    })

    it('reconciles the header when the heading reflows without another scroll', async () => {
        const onCollapsedChange = await renderHeading()
        await scrollTo(100)
        expect(onCollapsedChange.mock.calls).toEqual([[true]])
        await fireEvent(screen.getByTestId('home-heading'), 'layout', { nativeEvent: { layout: { height: 256 } } })
        expect(onCollapsedChange.mock.calls).toEqual([[true], [false]])
        await fireEvent(screen.getByTestId('home-heading'), 'layout', { nativeEvent: { layout: { height: 40 } } })
        expect(onCollapsedChange.mock.calls).toEqual([[true], [false], [true]])
        await fireEvent(screen.getByTestId('home-heading'), 'layout', { nativeEvent: { layout: { height: 40 } } })
        expect(onCollapsedChange).toHaveBeenCalledTimes(3)
    })

    it('fades and scales the heading over that height, and only fades under reduced motion', async () => {
        const { state } = workflowPreviewFixture('home-populated')
        const scrollY = { value: 0 }
        const view = (reduceMotion: boolean): ReactElement => (
            <FeedbackProvider reduceMotion={reduceMotion}>
                <LibraryScreen
                    state={state}
                    controller={INERT_WORKFLOW_CONTROLLER}
                    chrome="native"
                    largeTitle="heading"
                    scrollY={scrollY as unknown as SharedValue<number>}
                />
            </FeedbackProvider>
        )
        const { rerender } = await render(view(false))
        await fireEvent(screen.getByTestId('home-heading'), 'layout', { nativeEvent: { layout: { height: 200 } } })
        scrollY.value = 100
        await rerender(view(false))
        expect(StyleSheet.flatten(screen.getByTestId('home-heading').props.style)).toMatchObject({
            opacity: 0.5,
            transform: [{ scale: 0.9 }],
        })
        await rerender(view(true))
        const reduced = StyleSheet.flatten(screen.getByTestId('home-heading').props.style)
        expect(reduced.opacity).toBe(0.5)
        expect(reduced.transform).toEqual([{ scale: 1 }])
    })
})

describe('collapsing title', () => {
    it('restores identity scale on Android when reduced motion is enabled mid-scroll', async () => {
        const { state } = workflowPreviewFixture('home-populated')
        const scrollY = { value: COLLAPSE_DISTANCE / 2 }
        const view = (reduceMotion: boolean): ReactElement => (
            <FeedbackProvider reduceMotion={reduceMotion}>
                <LibraryScreen
                    state={state}
                    controller={INERT_WORKFLOW_CONTROLLER}
                    chrome="native"
                    largeTitle="content"
                    scrollY={scrollY as unknown as SharedValue<number>}
                />
            </FeedbackProvider>
        )
        const { rerender } = await render(view(false))
        expect(StyleSheet.flatten(screen.getByTestId('collapsing-title').props.style)).toMatchObject({
            opacity: 0.5,
            transform: [{ scale: 0.9 }],
        })
        await rerender(view(true))
        expect(StyleSheet.flatten(screen.getByTestId('collapsing-title').props.style)).toMatchObject({
            opacity: 0.5,
            transform: [{ scale: 1 }],
        })
    })

    it('is fully open at rest, fully collapsed after the collapse distance, and proportional between', () => {
        expect(collapseProgress(0)).toBe(0)
        expect(collapseProgress(COLLAPSE_DISTANCE / 2)).toBe(0.5)
        expect(collapseProgress(COLLAPSE_DISTANCE)).toBe(1)
        expect(collapseProgress(COLLAPSE_DISTANCE * 3)).toBe(1)
        expect(collapseProgress(-40)).toBe(0)
        expect(collapseProgress(128, 256)).toBe(0.5)
    })
})

describe('home title state', () => {
    it('starts open, follows the heading, and resets with the key so a new fixture does not inherit a collapsed bar', async () => {
        const { result, rerender } = await renderHook(({ key }: { key: string }) => useHomeTitle(key), {
            initialProps: { key: 'home-populated:light' },
        })
        expect(result.current.collapsed).toBe(false)
        await act(async () => {
            result.current.scrollY.value = 90
            result.current.onCollapsedChange(true)
        })
        expect(result.current.collapsed).toBe(true)
        await rerender({ key: 'home-empty:light' })
        expect(result.current.collapsed).toBe(false)
        expect(result.current.scrollY.value).toBe(0)
    })
})

describe('unavailable states', () => {
    it.each([
        ['home-loading', {}, 'Opening your manuals'],
        ['home-empty', { pending: 'Reading your pages…' }, 'Reading your manual. This can take a minute.'],
    ] as const)('%s disables Add manual, says why and never calls a controller', async (id, patch, hint) => {
        const { createManual, open, restore } = await setup(id, patch)
        expect(screen.getByRole('button', { name: 'Add manual' }).props.accessibilityState.disabled).toBe(true)
        expect(within(screen.getByTestId('bottom-bar')).getByText(hint)).toBeTruthy()
        await fireEvent.press(screen.getByRole('button', { name: 'Add manual' }))
        expect(createManual).not.toHaveBeenCalled()
        expect(open).not.toHaveBeenCalled()
        expect(restore).not.toHaveBeenCalled()
    })

    it('labels the restoring state in place', async () => {
        await setup('home-loading')
        expect(screen.getByLabelText('Opening your manuals')).toBeTruthy()
        expect(screen.queryByText('Build furniture with step-by-step help.')).toBeNull()
    })

    it('explains an unreadable library plainly, with one explicit Try again that is not pressed for the person', async () => {
        const { restore, createManual } = await setup('home-error')
        expect(screen.getByText('We could not open your saved photos. They are still on this device.')).toBeTruthy()
        expect(restore).not.toHaveBeenCalled()
        expect(screen.queryByRole('button', { name: 'Add manual' })).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Try again' }))
        expect(restore).toHaveBeenCalledTimes(1)
        expect(createManual).not.toHaveBeenCalled()
    })

    it('pins the sole recovery action when saved builds are retained but read-only', async () => {
        const { restore, createManual } = await setup('home-populated', {
            storageReadOnly: true,
            notice: 'Could not save on this device. Your earlier work is safe.',
        })
        expect(screen.getByText('We could not save on this device. Your earlier work is safe.')).toBeTruthy()
        expect(screen.queryByText(/could not open/u)).toBeNull()
        expect(screen.queryByText('Pick up where you left off.')).toBeNull()
        const retry = screen.getByRole('button', { name: 'Try again' })
        expect(within(screen.getByTestId('bottom-bar')).getByRole('button', { name: 'Try again' })).toBe(retry)
        await fireEvent.press(retry)
        expect(restore).toHaveBeenCalledTimes(1)
        expect(createManual).not.toHaveBeenCalled()
    })

    it('keeps recovery paused while another request is pending', async () => {
        const { restore } = await setup('home-populated', {
            storageReadOnly: true,
            pending: 'Asking about frozen photo…',
            notice: 'Local library images could not be read. Synthetic error for visual review.',
        })
        const retry = screen.getByRole('button', { name: 'Try again' })
        expect(retry.props.accessibilityState.disabled).toBe(true)
        expect(screen.getByText('We could not open your saved photos. They are still on this device.')).toBeTruthy()
        expect(screen.getByText('Asking…')).toBeTruthy()
        await fireEvent.press(retry)
        expect(restore).not.toHaveBeenCalled()
    })
})

describe('saved manuals', () => {
    it('resumes a sole manual from one primary, and reports progress in plain steps, not as verified', async () => {
        const fixture = workflowPreviewFixture('home-populated')
        const total = fixture.entry.session.reviewedSteps.length
        const entry = {
            ...fixture.entry,
            stepIndex: 1,
            completedStepIds: fixture.entry.session.reviewedSteps.slice(0, 1).map((s) => s.stepId),
        }
        const { open } = await setup('home-populated', { entries: [entry] })
        const title = fixture.entry.session.title
        expect(screen.getByText(`Step 2 of ${total}`)).toBeTruthy()
        expect(screen.getByRole('progressbar', { name: `Steps done: 1 of ${total}` })).toBeTruthy()
        expect(screen.queryByText(/verified|facts confirmed|marked complete by you/i)).toBeNull()
        // The card only says where the build stands; the primary is the one way in, and Add manual stays quiet beside it.
        expect(screen.getByText(title)).toBeTruthy()
        expect(screen.queryByRole('button', { name: `Open ${title}` })).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Keep building' }))
        expect(open).toHaveBeenCalledTimes(1)
        expect(open).toHaveBeenLastCalledWith(entry.session.manualId, 'guide')
        expect(screen.getByRole('button', { name: 'Add manual' })).toBeTruthy()
    })

    it.each([
        [
            'no photos yet',
            { pages: [], rawExtraction: null, reviewStatus: 'unreviewed' as const },
            'Add photos',
            'pages',
        ],
        ['pages not yet read', { rawExtraction: null, reviewStatus: 'unreviewed' as const }, 'Add photos', 'pages'],
        ['questions left', { reviewStatus: 'unreviewed' as const }, 'Answer a few questions', 'overview'],
    ])('names the next stop plainly for a manual with %s', async (_name, patch, label, route) => {
        const fixture = workflowPreviewFixture('home-populated')
        const entry = {
            ...fixture.entry,
            session: { ...fixture.entry.session, ...patch },
        }
        const { open } = await setup('home-populated', { entries: [entry] })
        await fireEvent.press(screen.getByRole('button', { name: label }))
        expect(open).toHaveBeenCalledWith(entry.session.manualId, route)
    })

    it('shows the first page as a small unstretched thumbnail when it is loaded, else the image icon, and never as a target', async () => {
        const fixture = workflowPreviewFixture('home-populated')
        const page = fixture.entry.session.pages[0]!
        await setup('home-populated')
        const thumb = (): Record<string, unknown> =>
            StyleSheet.flatten(screen.getByTestId('manual-thumb', { includeHiddenElements: true }).props.style)
        expect(thumb().aspectRatio).toBeCloseTo(page.width / page.height, 6)
        expect(screen.getByLabelText('First page of your manual', { includeHiddenElements: true })).toBeTruthy()
        expect(screen.queryByRole('button', { name: /First page/u })).toBeNull()
        await screen.unmount()
        // Home clears the loaded pages: nothing is read for the thumbnail, so the icon stands in.
        await setup('home-populated', { pageUris: {} })
        expect(thumb().aspectRatio).toBeUndefined()
        expect(screen.queryByLabelText('First page of your manual', { includeHiddenElements: true })).toBeNull()
        expect(screen.getByRole('button', { name: 'Keep building' })).toBeTruthy()
    })

    it('puts the same thumbnail in each row of several manuals without changing the row’s one action', async () => {
        const fixture = workflowPreviewFixture('home-populated')
        const second = { ...fixture.entry, session: { ...fixture.entry.session, manualId: 'second', title: 'Second' } }
        const { open } = await setup('home-populated', { entries: [fixture.entry, second] })
        expect(screen.getAllByTestId('manual-thumb', { includeHiddenElements: true })).toHaveLength(2)
        await fireEvent.press(screen.getByRole('button', { name: 'Open Second' }))
        expect(open).toHaveBeenCalledTimes(1)
    })

    it('keeps several manuals as rows with Add manual as the one primary', async () => {
        const fixture = workflowPreviewFixture('home-populated')
        const second = { ...fixture.entry, session: { ...fixture.entry.session, manualId: 'second', title: 'Second' } }
        const { open } = await setup('home-populated', { entries: [fixture.entry, second] })
        expect(screen.getAllByTestId('manual-card')).toHaveLength(2)
        expect(screen.queryByRole('button', { name: 'Keep building' })).toBeNull()
        expect(within(screen.getByTestId('bottom-bar')).getAllByRole('button')).toHaveLength(1)
        await fireEvent.press(screen.getByRole('button', { name: 'Open Second' }))
        expect(open).toHaveBeenCalledWith('second', 'guide')
    })

    it('puts settings and the discreet judge entry in More, one tap away', async () => {
        await setup('home-populated')
        expect(screen.queryByText('What leaves this device')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'More' }))
        const more = within(screen.getByTestId('more-sheet'))
        expect(more.getByText('What leaves this device')).toBeTruthy()
        expect(more.getByTestId('judge-entry')).toBeTruthy()
    })
})
