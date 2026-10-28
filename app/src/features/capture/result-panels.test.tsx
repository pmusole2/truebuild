import { render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { FeedbackProvider } from '../../ui/feedback'
import { spies } from '../../ui/test-support/reanimated-mock'
import { motion } from '../../theme/tokens'
import { workflowPreviewFixture } from '../../ui/preview/workflow-fixtures'
import { AnswerPanel, CheckPanel } from './result-panels'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
beforeEach(() => {
    spies.withTiming.mockClear()
    spies.cancelAnimation.mockClear()
})

it.each([
    ['guide-pass', 'success'],
    ['guide-refuse', 'warning'],
    ['guide-cannot-verify', 'warning'],
] as const)('gives one %s notification and stays quiet on metadata-only rerenders', async (fixtureId, kind) => {
    const { state, entry } = workflowPreviewFixture(fixtureId)
    const trigger = jest.fn()
    const view = (notes: string[]): ReactElement => (
        <FeedbackProvider reduceMotion haptics={{ trigger }}>
            <CheckPanel
                check={{ ...state.check!, modelNotes: notes }}
                session={entry.session}
                pageUris={state.pageUris}
            />
        </FeedbackProvider>
    )
    const { rerender } = await render(view([]))
    expect(trigger).toHaveBeenCalledWith(kind)
    await rerender(view(['Provider metadata, same outcome.']))
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(screen.getByText(state.check!.reason)).toBeTruthy()
})

it('announces a new answer with neutral selection feedback and no verdict', async () => {
    const { state, entry } = workflowPreviewFixture('guide-answer')
    const trigger = jest.fn()
    await render(
        <FeedbackProvider reduceMotion haptics={{ trigger }}>
            <AnswerPanel answer={state.answer!} session={entry.session} pageUris={state.pageUris} />
        </FeedbackProvider>,
    )
    expect(trigger).toHaveBeenCalledWith('selection')
    for (const label of ['Pass', 'Refuse', 'Cannot verify']) expect(screen.queryByText(label)).toBeNull()
})

it('notifies again when a later capture displays the same result text after the prior result was cleared', async () => {
    const { state, entry } = workflowPreviewFixture('guide-pass')
    const trigger = jest.fn()
    const view = (visible: boolean): ReactElement => (
        <FeedbackProvider reduceMotion haptics={{ trigger }}>
            {visible ? <CheckPanel check={state.check!} session={entry.session} pageUris={state.pageUris} /> : null}
        </FeedbackProvider>
    )
    const { rerender } = await render(view(true))
    expect(trigger).toHaveBeenCalledTimes(1)
    await rerender(view(false))
    expect(trigger).toHaveBeenCalledTimes(1)
    await rerender(view(true))
    expect(trigger).toHaveBeenCalledTimes(2)
})

it.each([false, true])(
    'uses a brief result entrance only when Reduce Motion is off (reduced=%s)',
    async (reduceMotion) => {
        const { state, entry } = workflowPreviewFixture('guide-refuse')
        await render(
            <FeedbackProvider reduceMotion={reduceMotion}>
                <CheckPanel check={state.check!} session={entry.session} pageUris={state.pageUris} />
            </FeedbackProvider>,
        )
        if (reduceMotion) expect(spies.withTiming).not.toHaveBeenCalled()
        else expect(spies.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: motion.quick }))
    },
)

it('cancels result motion when the preference changes without replaying notification feedback', async () => {
    const { state, entry } = workflowPreviewFixture('guide-refuse')
    const trigger = jest.fn()
    const view = (reduceMotion: boolean): ReactElement => (
        <FeedbackProvider reduceMotion={reduceMotion} haptics={{ trigger }}>
            <CheckPanel check={state.check!} session={entry.session} pageUris={state.pageUris} />
        </FeedbackProvider>
    )
    const { rerender } = await render(view(false))
    spies.cancelAnimation.mockClear()
    await rerender(view(true))
    expect(spies.cancelAnimation).toHaveBeenCalled()
    expect(trigger).toHaveBeenCalledTimes(1)
})
