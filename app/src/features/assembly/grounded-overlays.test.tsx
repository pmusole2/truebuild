import { render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { AccessibilityInfo } from 'react-native'
import Svg from 'react-native-svg'
import { FeedbackProvider } from '../../ui/feedback'
import { spies } from '../../ui/test-support/reanimated-mock'
import { motion } from '../../theme/tokens'
import { GroundedRegionOutline, OUTLINE_HALO_WIDTH, OUTLINE_LINE_WIDTH } from './grounded-overlays'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))

// Synthetic geometry only: no recorded or live model output backs these rects.
const RECT = { x: 20, y: 30, width: 100, height: 80 }

function outline(props: { pulseKey?: string | null; rect?: typeof RECT }, reduceMotion: boolean | null): ReactElement {
    return (
        <FeedbackProvider reduceMotion={reduceMotion}>
            <Svg width={300} height={200}>
                <GroundedRegionOutline rect={props.rect ?? RECT} pulseKey={props.pulseKey} />
            </Svg>
        </FeedbackProvider>
    )
}

beforeEach(() => {
    for (const spy of Object.values(spies)) spy.mockClear()
})

describe('static outline', () => {
    it('draws a contrast halo under a thicker accent line on exactly the given rect', async () => {
        await render(outline({}, true))
        const halo = screen.getByTestId('grounded-outline-halo')
        const line = screen.getByTestId('grounded-outline-line')
        for (const node of [halo, line]) {
            expect(node.props).toMatchObject({ x: 20, y: 30, width: 100, height: 80 })
        }
        expect(OUTLINE_HALO_WIDTH).toBeGreaterThan(OUTLINE_LINE_WIDTH)
        expect(OUTLINE_LINE_WIDTH).toBeGreaterThan(3)
        expect(halo.props.strokeWidth).toBe(OUTLINE_HALO_WIDTH)
        expect(line.props.strokeWidth).toBe(OUTLINE_LINE_WIDTH)
        expect(halo.props.stroke).not.toBe(line.props.stroke)
    })

    it('starts no animation and draws no pulse ring without a pulse key', async () => {
        await render(outline({}, false))
        expect(spies.withTiming).not.toHaveBeenCalled()
        expect(screen.queryByTestId('grounded-outline-pulse')).toBeNull()
    })
})

describe('pass pulse', () => {
    it('pulses once up and back down when a new key arrives and motion is allowed', async () => {
        await render(outline({ pulseKey: 'pass:capture-1' }, false))
        expect(spies.withTiming.mock.calls.map(([target]) => target)).toEqual([1, 0])
        expect(spies.withTiming.mock.calls[0]?.[1]).toMatchObject({ duration: motion.quick })
        expect(spies.withSequence).toHaveBeenCalledTimes(1)
        expect(screen.getByTestId('grounded-outline-pulse')).toBeTruthy()
    })

    it('does not pulse again for metadata-only renders or a moved rect with the same key', async () => {
        const { rerender } = await render(outline({ pulseKey: 'pass:capture-1' }, false))
        await rerender(outline({ pulseKey: 'pass:capture-1' }, false))
        await rerender(outline({ pulseKey: 'pass:capture-1', rect: { ...RECT, x: 40 } }, false))
        expect(spies.withSequence).toHaveBeenCalledTimes(1)
    })

    it('pulses again for a different key', async () => {
        const { rerender } = await render(outline({ pulseKey: 'pass:capture-1' }, false))
        await rerender(outline({ pulseKey: 'pass:capture-2' }, false))
        expect(spies.withSequence).toHaveBeenCalledTimes(2)
    })

    it('binds the pulse ring to the animated progress and leaves the static outline untouched', async () => {
        spies.withSequence.mockImplementationOnce(() => 1)
        const { rerender } = await render(outline({ pulseKey: 'pass:capture-1' }, false))
        // The jest stand-in evaluates animated props during render, so a rerender reads the progress the effect set.
        await rerender(outline({ pulseKey: 'pass:capture-1' }, false))
        const ring = screen.getByTestId('grounded-outline-pulse')
        expect(ring.props.strokeOpacity).toBeGreaterThan(0)
        expect(ring.props.strokeWidth).toBeGreaterThan(OUTLINE_LINE_WIDTH)
        expect(ring.props).toMatchObject({ x: 20, y: 30, width: 100, height: 80 })
        expect(screen.getByTestId('grounded-outline-line').props.strokeWidth).toBe(OUTLINE_LINE_WIDTH)
    })

    it('cancels the running pulse on unmount', async () => {
        const { unmount } = await render(outline({ pulseKey: 'pass:capture-1' }, false))
        spies.cancelAnimation.mockClear()
        await unmount()
        expect(spies.cancelAnimation).toHaveBeenCalled()
    })
})

describe('reduced and unknown motion', () => {
    it('stays static, with the outline still visible, when Reduce Motion is on', async () => {
        await render(outline({ pulseKey: 'pass:capture-1' }, true))
        expect(spies.withTiming).not.toHaveBeenCalled()
        expect(spies.withSequence).not.toHaveBeenCalled()
        expect(screen.getByTestId('grounded-outline-line')).toBeTruthy()
        expect(screen.queryByTestId('grounded-outline-pulse')).toBeNull()
    })

    // React Native's jest setup already mocks the query, so a one-shot answer is used instead of spy/restore, which
    // would reset the shared mock for later tests.
    const systemAnswer = (answer: Promise<boolean>): void => {
        jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockReturnValueOnce(answer)
    }

    it('stays static while the system preference is still unknown', async () => {
        systemAnswer(new Promise(() => {}))
        await render(outline({ pulseKey: 'pass:capture-1' }, null))
        expect(spies.withTiming).not.toHaveBeenCalled()
        expect(screen.queryByTestId('grounded-outline-pulse')).toBeNull()
    })

    it('stays static when the system preference lookup fails', async () => {
        systemAnswer(Promise.reject(new Error('unsupported')))
        await render(outline({ pulseKey: 'pass:capture-1' }, null))
        expect(spies.withTiming).not.toHaveBeenCalled()
    })

    it('cancels a running pulse when Reduce Motion turns on and does not replay it when it turns off again', async () => {
        const { rerender } = await render(outline({ pulseKey: 'pass:capture-1' }, false))
        spies.cancelAnimation.mockClear()
        await rerender(outline({ pulseKey: 'pass:capture-1' }, true))
        expect(spies.cancelAnimation).toHaveBeenCalled()
        expect(screen.queryByTestId('grounded-outline-pulse')).toBeNull()
        await rerender(outline({ pulseKey: 'pass:capture-1' }, false))
        expect(spies.withSequence).toHaveBeenCalledTimes(1)
    })

    it('pulses once when the system answer arrives as motion allowed after the first render', async () => {
        systemAnswer(Promise.resolve(false))
        await render(outline({ pulseKey: 'pass:capture-1' }, null))
        await screen.findByTestId('grounded-outline-pulse')
        expect(spies.withSequence).toHaveBeenCalledTimes(1)
    })
})
