import { render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { ColdStartProvider } from '../../ui/cold-start'
import { FeedbackProvider } from '../../ui/feedback'
import { SPRING_GENTLE } from '../../ui/motion'
import { INERT_WORKFLOW_CONTROLLER } from '../../ui/preview/workflow-preview'
import { workflowPreviewFixture } from '../../ui/preview/workflow-fixtures'
import { spies } from '../../ui/test-support/reanimated-mock'
import { GuideScreen } from './guide-screen'
import { LibraryScreen } from './library-screen'
import { DoneScreen } from './done-screen'
import { PagesScreen } from './pages-screen'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

beforeEach(() => {
    for (const spy of Object.values(spies)) spy.mockClear()
})

const durations = (): number[] =>
    spies.withTiming.mock.calls.map(([, config]) => (config as { duration?: number } | undefined)?.duration ?? -1)

describe('Guide result icon', () => {
    const guide = (id: 'guide-pass' | 'guide-refuse', reduce = false, pending: string | null = null): ReactElement => {
        const { state, entry } = workflowPreviewFixture(id)
        return (
            <FeedbackProvider reduceMotion={reduce}>
                <GuideScreen state={{ ...state, pending }} controller={INERT_WORKFLOW_CONTROLLER} entry={entry} />
            </FeedbackProvider>
        )
    }

    it('settles the icon once with the one gentle spring and does not replay on an unrelated re-render', async () => {
        const { rerender } = await render(guide('guide-pass'))
        expect(screen.getByTestId('result-icon', { hidden: true })).toBeTruthy()
        expect(spies.withSpring).toHaveBeenCalledTimes(1)
        expect(spies.withSpring).toHaveBeenCalledWith(1, SPRING_GENTLE)
        await rerender(guide('guide-pass'))
        expect(spies.withSpring).toHaveBeenCalledTimes(1)
    })

    it('does not replay on a revisit that remounts the screen under the same provider with the same result', async () => {
        const { state, entry } = workflowPreviewFixture('guide-pass')
        const revisit = (key: string): ReactElement => (
            <FeedbackProvider reduceMotion={false}>
                <GuideScreen key={key} state={state} controller={INERT_WORKFLOW_CONTROLLER} entry={entry} />
            </FeedbackProvider>
        )
        const { rerender } = await render(revisit('a'))
        expect(spies.withSpring).toHaveBeenCalledTimes(1)
        await rerender(revisit('b'))
        await rerender(revisit('c'))
        expect(spies.withSpring).toHaveBeenCalledTimes(1)
    })

    it('shows the icon at rest with no scale under reduced motion', async () => {
        await render(guide('guide-pass', true))
        expect(screen.getByTestId('result-icon', { hidden: true })).toBeTruthy()
        expect(spies.withSpring).not.toHaveBeenCalled()
    })

    it('gives an answer no verdict icon and no icon motion', async () => {
        const { state, entry } = workflowPreviewFixture('guide-answer')
        await render(
            <FeedbackProvider reduceMotion={false}>
                <GuideScreen state={{ ...state, check: null }} controller={INERT_WORKFLOW_CONTROLLER} entry={entry} />
            </FeedbackProvider>,
        )
        expect(screen.queryByTestId('result-icon', { hidden: true })).toBeNull()
        expect(spies.withSpring).not.toHaveBeenCalled()
    })
})

describe('Guide step change', () => {
    const at = (stepIndex: number, pending: string | null = null, reduce = false): ReactElement => {
        const { state, entry } = workflowPreviewFixture('guide-empty')
        return (
            <FeedbackProvider reduceMotion={reduce}>
                <GuideScreen
                    state={{ ...state, pending }}
                    controller={INERT_WORKFLOW_CONTROLLER}
                    entry={{ ...entry, stepIndex }}
                />
            </FeedbackProvider>
        )
    }

    it('moves the picture and the instruction on one shared timeline at the standard duration', async () => {
        const { rerender } = await render(at(0))
        expect(durations()).toEqual([])
        await rerender(at(1))
        // One timeline drives picture+instruction and one drives the separate progress fill.
        // Independent picture/instruction timelines would add a third call.
        expect(durations().filter((duration) => duration === 250)).toHaveLength(2)
    })

    it('applies a change instantly while a request is pending', async () => {
        const { rerender } = await render(at(0, 'Checking the frozen photo…'))
        await rerender(at(1, 'Checking the frozen photo…'))
        expect(durations()).toEqual([])
    })

    it('uses only a fast fade under reduced motion', async () => {
        const { rerender } = await render(at(0, null, true))
        await rerender(at(1, null, true))
        expect(durations()).toEqual([150])
    })

    it('moves the default progress cue on a step browse without marking any step complete', async () => {
        const view = await render(at(0, null, true))
        expect(screen.getByTestId('progress-fill', { hidden: true })).toHaveStyle({ width: '50%' })
        await view.rerender(at(1, null, true))
        await view.rerender(at(1, null, true))
        expect(screen.getByTestId('progress-fill', { hidden: true })).toHaveStyle({ width: '100%' })
    })

    it('keeps a slim, decorative progress cue and leaves the labelled bar to More', async () => {
        await render(at(0, null, true))
        expect(screen.getByTestId('progress-track', { hidden: true })).toBeTruthy()
        expect(screen.queryByRole('progressbar')).toBeNull()
    })
})

describe('Home cold launch entrance', () => {
    const home = (id: 'home-empty' | 'home-loading', mountKey: string, reduce = false): ReactElement => {
        const { state } = workflowPreviewFixture(id)
        return (
            <FeedbackProvider reduceMotion={reduce}>
                <ColdStartProvider>
                    <LibraryScreen key={mountKey} state={state} controller={INERT_WORKFLOW_CONTROLLER} />
                </ColdStartProvider>
            </FeedbackProvider>
        )
    }

    it('plays one 350 ms timeline for the heading and content once the library is ready', async () => {
        await render(home('home-empty', 'a'))
        expect(durations()).toEqual([350])
    })

    it('plays nothing over the loading skeleton, and nothing again on a remount in the same process', async () => {
        const { rerender } = await render(home('home-loading', 'a'))
        expect(durations()).toEqual([])
        await rerender(home('home-empty', 'a'))
        expect(durations()).toEqual([350])
        await rerender(home('home-empty', 'b'))
        expect(durations()).toEqual([350])
    })

    it('is a single fast fade under reduced motion', async () => {
        await render(home('home-empty', 'a', true))
        expect(durations()).toEqual([150])
    })

    it('plays nothing without the launch provider, as in previews', async () => {
        const { state } = workflowPreviewFixture('home-empty')
        await render(<LibraryScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} />)
        expect(durations()).toEqual([])
    })
})

describe('load entrance', () => {
    it('settles Add manual content once and Done content once at the standard duration', async () => {
        const pages = workflowPreviewFixture('pages-populated')
        await render(
            <FeedbackProvider reduceMotion={false}>
                <PagesScreen
                    state={pages.state}
                    controller={INERT_WORKFLOW_CONTROLLER}
                    entry={pages.entry}
                    choosePages={jest.fn()}
                />
            </FeedbackProvider>,
        )
        expect(durations()).toEqual([250])
        spies.withTiming.mockClear()
        const done = workflowPreviewFixture('done-finished')
        await render(
            <FeedbackProvider reduceMotion={false}>
                <DoneScreen state={done.state} controller={INERT_WORKFLOW_CONTROLLER} entry={done.entry} />
            </FeedbackProvider>,
        )
        expect(durations()).toEqual([250])
    })
})

it('reveals only the newly added page after saving and never replays existing page arrivals', async () => {
    const { state, entry } = workflowPreviewFixture('pages-populated')
    const first = entry.session.pages[0]!
    const extra = { ...first, pageId: 'arrival-page' }
    const tree = (added: boolean, pending: string | null): ReactElement => (
        <FeedbackProvider reduceMotion={false}>
            <PagesScreen
                state={{
                    ...state,
                    pending,
                    pageUris: { ...state.pageUris, [extra.pageId]: state.pageUris[first.pageId]! },
                }}
                entry={{
                    ...entry,
                    session: { ...entry.session, pages: added ? [...entry.session.pages, extra] : entry.session.pages },
                }}
                controller={INERT_WORKFLOW_CONTROLLER}
                choosePages={jest.fn()}
            />
        </FeedbackProvider>
    )
    const view = await render(tree(false, null))
    spies.withTiming.mockClear()
    await view.rerender(tree(true, 'Saving manual pages…'))
    expect(spies.withTiming).not.toHaveBeenCalled()
    await view.rerender(tree(true, null))
    expect(durations()).toEqual([250])
    await view.rerender(tree(true, null))
    expect(durations()).toEqual([250])
})
