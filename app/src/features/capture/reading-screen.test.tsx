import { act, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { spies } from '../../ui/test-support/reanimated-mock'
import { FeedbackProvider } from '../../ui/feedback'
import { INERT_WORKFLOW_CONTROLLER } from '../../ui/preview/workflow-preview'
import { workflowPreviewFixture } from '../../ui/preview/workflow-fixtures'
import { ReadingScreen } from './reading-screen'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

beforeEach(() => {
    jest.useFakeTimers()
    for (const spy of Object.values(spies)) spy.mockClear()
})
afterEach(() => jest.useRealTimers())

const reading = (reduceMotion: boolean): ReactElement => {
    const { state, entry } = workflowPreviewFixture('pages-reading')
    return (
        <FeedbackProvider reduceMotion={reduceMotion}>
            <ReadingScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} entry={entry} />
        </FeedbackProvider>
    )
}

describe('Reading', () => {
    it('shows one fixed caption, the known page count and nothing about how the manual is read', async () => {
        await render(reading(false))
        expect(screen.getByText('Keep this screen open.')).toBeTruthy()
        expect(screen.getByText(/^Reading your \d+-page manual$/u)).toBeTruthy()
        await act(async () => jest.advanceTimersByTime(3500))
        expect(screen.getByText('Keep this screen open.')).toBeTruthy()
        expect(screen.queryByText(/privacy|stay on this device|page in order|percent|%/iu)).toBeNull()
    })

    it('runs one calm loop in the reading scene and no sliding progress bar or percentage', async () => {
        await render(reading(false))
        expect(screen.getByTestId('reading-indicator', { hidden: true })).toBeTruthy()
        expect(spies.withRepeat).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('progressbar')).toBeNull()
    })

    it('holds the scene still under Reduce Motion and starts no loop', async () => {
        await render(reading(true))
        expect(spies.withRepeat).not.toHaveBeenCalled()
        expect(screen.getByTestId('reading-indicator', { hidden: true })).toBeTruthy()
        expect(screen.getByText('Keep this screen open.')).toBeTruthy()
    })

    it('names only the stream’s own output phase on the scene, and no step or percentage', async () => {
        const { state, entry } = workflowPreviewFixture('pages-reading')
        const laying = { ...state, pending: 'Reading manual pages: laying out steps…' }
        await render(
            <FeedbackProvider reduceMotion={false}>
                <ReadingScreen state={laying} controller={INERT_WORKFLOW_CONTROLLER} entry={entry} />
            </FeedbackProvider>,
        )
        expect(screen.getByText('Laying out steps…')).toBeTruthy()
        expect(screen.queryByText(/step \d|%/iu)).toBeNull()
    })

    it('stops the loop and the scene once reading stops', async () => {
        const { state, entry } = workflowPreviewFixture('pages-reading')
        const tree = (pending: string | null): ReactElement => (
            <FeedbackProvider reduceMotion={false}>
                <ReadingScreen state={{ ...state, pending }} controller={INERT_WORKFLOW_CONTROLLER} entry={entry} />
            </FeedbackProvider>
        )
        const { rerender } = await render(tree(state.pending))
        spies.cancelAnimation.mockClear()
        await rerender(tree(null))
        expect(spies.cancelAnimation).toHaveBeenCalled()
        // The scene hands its place to the page after the short cross-fade.
        await act(async () => jest.advanceTimersByTime(200))
        expect(screen.queryByTestId('reading-indicator', { hidden: true })).toBeNull()
        expect(screen.queryByText('Keep this screen open.')).toBeNull()
    })
})
