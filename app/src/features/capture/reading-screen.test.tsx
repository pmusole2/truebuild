import { act, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { spies } from '../../ui/test-support/reanimated-mock'
import { FeedbackProvider } from '../../ui/feedback'
import { INERT_WORKFLOW_CONTROLLER } from '../../ui/preview/workflow-preview'
import { workflowPreviewFixture } from '../../ui/preview/workflow-fixtures'
import { CAPTION_MS, READING_CAPTIONS, ReadingScreen } from './reading-screen'

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
    it('says only the two approved captions, every 3.5 seconds, and nothing about how the manual is read', async () => {
        expect(READING_CAPTIONS).toEqual(['Keep this screen open.', 'You can stop and try again later.'])
        expect(CAPTION_MS).toBe(3500)
        await render(reading(false))
        expect(screen.getByText('Keep this screen open.')).toBeTruthy()
        await act(async () => jest.advanceTimersByTime(3499))
        expect(screen.getByText('Keep this screen open.')).toBeTruthy()
        await act(async () => jest.advanceTimersByTime(1))
        expect(screen.getByText('You can stop and try again later.')).toBeTruthy()
        await act(async () => jest.advanceTimersByTime(3500))
        expect(screen.getByText('Keep this screen open.')).toBeTruthy()
        expect(screen.queryByText(/privacy|stay on this phone|page in order|percent|%/iu)).toBeNull()
    })

    it('runs one calm indicator loop and no sliding progress bar or percentage', async () => {
        await render(reading(false))
        expect(screen.getByTestId('reading-indicator', { hidden: true })).toBeTruthy()
        expect(spies.withRepeat).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('progressbar')).toBeNull()
    })

    it('keeps rotating captions under Reduce Motion but starts no loop', async () => {
        await render(reading(true))
        expect(spies.withRepeat).not.toHaveBeenCalled()
        await act(async () => jest.advanceTimersByTime(3500))
        expect(screen.getByText('You can stop and try again later.')).toBeTruthy()
    })

    it('stops the loop and the captions once reading stops', async () => {
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
        expect(screen.queryByTestId('reading-indicator', { hidden: true })).toBeNull()
        expect(screen.queryByText('You can stop and try again later.')).toBeNull()
    })
})
