import { render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { StyleSheet } from 'react-native'
import Svg from 'react-native-svg'
import type { CheckResult } from '@truebuild/contracts'
import { FeedbackProvider } from '../../ui/feedback'
import { spies } from '../../ui/test-support/reanimated-mock'
import { lightColors, motion } from '../../theme/tokens'
import { workflowPreviewFixture } from '../../ui/preview/workflow-fixtures'
import { AnswerPanel, CheckHighlight, CheckPanel, passPulseKey } from './result-panels'

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
    expect(screen.getByText('Answer')).toBeTruthy()
    expect(screen.getByText('Answer to your question from the manual pages. It is not a step check.')).toBeTruthy()
    // It leads like a result, but its bar is the neutral ink of a plain notice, never a pass, refuse or caution colour.
    const bar = StyleSheet.flatten(screen.getByTestId('card-bar', { includeHiddenElements: true }).props.style)
    expect(bar.backgroundColor).toBe(lightColors.ink)
    for (const verdictColour of [lightColors.pass, lightColors.refuse, lightColors.caution]) {
        expect(bar.backgroundColor).not.toBe(verdictColour)
    }
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

describe('passPulseKey', () => {
    // Synthetic region: no recorded or live model output backs it.
    const region = { x: 0.2, y: 0.3, width: 0.4, height: 0.25 }
    const passWith = (observedRegion: typeof region | null): CheckResult => ({
        ...workflowPreviewFixture('guide-pass').state.check!,
        observedRegion,
    })

    it('keys a pass that returned a grounded region to its capture and region', () => {
        const key = passPulseKey(passWith(region), 'capture-1')
        expect(key).toEqual(expect.any(String))
        expect(passPulseKey(passWith(region), 'capture-2')).not.toBe(key)
        expect(passPulseKey(passWith({ ...region, x: 0.25 }), 'capture-1')).not.toBe(key)
        expect(passPulseKey({ ...passWith(region), modelNotes: ['metadata only'] }, 'capture-1')).toBe(key)
    })

    it('never invents a pulse for a pass without a returned region', () => {
        expect(passPulseKey(passWith(null), 'capture-1')).toBeNull()
    })

    it.each(['refuse', 'cannot_verify'] as const)('does not pulse a %s even with a region', (decision) => {
        expect(passPulseKey({ ...passWith(region), decision }, 'capture-1')).toBeNull()
    })
})

it('keeps the grounded highlight on the exact rect it is given', async () => {
    await render(
        <FeedbackProvider reduceMotion>
            <Svg width={300} height={200}>
                <CheckHighlight rect={{ x: 5, y: 6, width: 70, height: 40 }} pulseKey={null} />
            </Svg>
        </FeedbackProvider>,
    )
    expect(screen.getByTestId('grounded-outline-line').props).toMatchObject({ x: 5, y: 6, width: 70, height: 40 })
})
