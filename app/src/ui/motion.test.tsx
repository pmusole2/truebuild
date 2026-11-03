import { act, render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import Animated from 'react-native-reanimated'
import type { ReactElement } from 'react'
import { ColdStartProvider, useColdEntrance } from './cold-start'
import { FeedbackProvider, useFeedback } from './feedback'
import {
    EASE_OUT,
    SPRING_GENTLE,
    STEP_TRAVEL,
    stepTravel,
    timing,
    useEntranceTimeline,
    useEntranceGroup,
    useIconReveal,
    useLoadEntrance,
    useStepTransition,
} from './motion'
import { motion } from '../theme/tokens'
import { spies } from './test-support/reanimated-mock'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))

beforeEach(() => {
    for (const spy of Object.values(spies)) spy.mockClear()
})

const frame = (reduce: boolean, node: ReactElement): ReactElement => (
    <FeedbackProvider reduceMotion={reduce}>{node}</FeedbackProvider>
)

describe('motion language', () => {
    it('has one spring, bounded by the emphasis budget, critically damped, clamped and Reanimated-reduced', () => {
        // Reanimated multiplies a duration spring's perceptual duration by 1.5: this targets about 350 ms of settling.
        expect(SPRING_GENTLE.duration * 1.5).toBeCloseTo(motion.emphasis)
        expect(SPRING_GENTLE).toMatchObject({ dampingRatio: 1, overshootClamping: true, reduceMotion: 'system' })
        expect(EASE_OUT).toBeDefined()
    })

    it('builds every timing from the ease-out curve and the system reduce-motion rule', () => {
        for (const duration of [motion.fast, motion.standard, motion.emphasis]) {
            expect(timing(duration)).toEqual({ duration, easing: EASE_OUT, reduceMotion: 'system' })
        }
    })
})

function Step({ id, direction, enabled }: { id: string; direction: number; enabled: boolean }): ReactElement {
    const style = useStepTransition(id, direction, enabled)
    return (
        <Animated.View testID="moving" style={style}>
            <Text>{id}</Text>
        </Animated.View>
    )
}

describe('step transition', () => {
    it('moves later steps in from ahead and earlier steps in from behind, and not at all when reduced', () => {
        expect(stepTravel(1, false)).toBe(STEP_TRAVEL)
        expect(stepTravel(-1, false)).toBe(-STEP_TRAVEL)
        expect(stepTravel(1, true)).toBe(0)
        expect(STEP_TRAVEL).toBeLessThanOrEqual(16)
    })

    it('animates once per step change at the standard duration, and never on mount', async () => {
        const { rerender } = await render(frame(false, <Step id="a" direction={1} enabled />))
        expect(spies.withTiming).not.toHaveBeenCalled()
        await rerender(frame(false, <Step id="b" direction={1} enabled />))
        expect(spies.withTiming).toHaveBeenCalledTimes(1)
        expect(spies.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: motion.standard }))
        // Same step again, e.g. a re-render: nothing replays.
        await rerender(frame(false, <Step id="b" direction={1} enabled />))
        expect(spies.withTiming).toHaveBeenCalledTimes(1)
    })

    it('applies a change instantly while work, a sheet or a tip holds the screen, and never replays it later', async () => {
        const { rerender } = await render(frame(false, <Step id="a" direction={1} enabled={false} />))
        await rerender(frame(false, <Step id="b" direction={1} enabled={false} />))
        await rerender(frame(false, <Step id="b" direction={1} enabled />))
        expect(spies.withTiming).not.toHaveBeenCalled()
    })

    it('uses a single fast fade under reduced motion', async () => {
        const { rerender } = await render(frame(true, <Step id="a" direction={1} enabled />))
        await rerender(frame(true, <Step id="b" direction={-1} enabled />))
        expect(spies.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: motion.fast }))
    })

    it('cancels an in-flight change when the preference flips', async () => {
        const { rerender } = await render(frame(false, <Step id="a" direction={1} enabled />))
        await rerender(frame(false, <Step id="b" direction={1} enabled />))
        spies.cancelAnimation.mockClear()
        await rerender(frame(true, <Step id="b" direction={1} enabled />))
        expect(spies.cancelAnimation).toHaveBeenCalled()
    })
})

function Icon({ identity, enabled = true }: { identity: string; enabled?: boolean }): ReactElement {
    const style = useIconReveal(identity, enabled)
    return <Animated.View testID="icon" style={style} />
}

describe('result icon reveal', () => {
    it('settles once per identity with the one gentle spring, and not again on a remount or revisit', async () => {
        const tree = (identity: string, mounted = true): ReactElement =>
            frame(false, mounted ? <Icon identity={identity} /> : <Text>gone</Text>)
        const { rerender } = await render(tree('result-1'))
        expect(spies.withSpring).toHaveBeenCalledTimes(1)
        expect(spies.withSpring).toHaveBeenCalledWith(1, SPRING_GENTLE)
        // More opens and closes, or the person leaves and returns: the same identity is already revealed.
        await rerender(tree('result-1', false))
        await rerender(tree('result-1'))
        expect(spies.withSpring).toHaveBeenCalledTimes(1)
        // A genuinely new result reveals again.
        await rerender(tree('result-2'))
        expect(spies.withSpring).toHaveBeenCalledTimes(2)
    })

    it('shows at rest with no movement under reduced motion', async () => {
        await render(frame(true, <Icon identity="result-1" />))
        expect(spies.withSpring).not.toHaveBeenCalled()
    })

    it('spends the identity when it arrives under a tip or sheet, so it never plays late', async () => {
        const { rerender } = await render(frame(false, <Icon identity="result-1" enabled={false} />))
        await rerender(frame(false, <Icon identity="result-1" enabled />))
        expect(spies.withSpring).not.toHaveBeenCalled()
    })

    it('is independent of the haptic memory, so an earlier haptic never swallows the first reveal', async () => {
        function Announced(): ReactElement {
            const { hapticOnce } = useFeedback()
            hapticOnce('same', 'success')
            return <Icon identity="same" />
        }
        await render(
            <FeedbackProvider reduceMotion={false} haptics={{ trigger: jest.fn() }}>
                <Announced />
            </FeedbackProvider>,
        )
        expect(spies.withSpring).toHaveBeenCalledTimes(1)
    })
})

function Cold({ ready, held = false }: { ready: boolean; held?: boolean }): ReactElement {
    const play = useColdEntrance(ready, held)
    return <Text testID="cold">{play ? 'plays' : 'still'}</Text>
}

describe('cold launch lease', () => {
    it('plays once, after content is ready, and never again on a warm remount or pop', async () => {
        const tree = (node: ReactElement): ReactElement => <ColdStartProvider>{node}</ColdStartProvider>
        const { rerender } = await render(tree(<Cold ready={false} />))
        expect(screen.getByTestId('cold').children).toEqual(['still'])
        await rerender(tree(<Cold ready />))
        expect(screen.getByTestId('cold').children).toEqual(['plays'])
        // A second Home mount under the same provider (pop, resume) gets nothing.
        await rerender(tree(<Cold key="again" ready />))
        expect(screen.getByTestId('cold').children).toEqual(['still'])
    })

    it('is spent when ready is reached while covered, so a later focus never plays it', async () => {
        const tree = (held: boolean): ReactElement => (
            <ColdStartProvider>
                <Cold ready held={held} />
            </ColdStartProvider>
        )
        const { rerender } = await render(tree(true))
        await rerender(tree(false))
        expect(screen.getByTestId('cold').children).toEqual(['still'])
    })

    it('plays nothing without a provider, as in previews and tests', async () => {
        await render(<Cold ready />)
        expect(screen.getByTestId('cold').children).toEqual(['still'])
    })
})

function Enter({ enabled = true }: { enabled?: boolean }): ReactElement {
    const style = useLoadEntrance(enabled)
    return <Animated.View testID="enter" style={style} />
}

describe('load entrance', () => {
    it('plays once on mount at the standard duration, or a fast fade when reduced', async () => {
        const { rerender, unmount } = await render(frame(false, <Enter />))
        expect(spies.withTiming).toHaveBeenCalledTimes(1)
        expect(spies.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: motion.standard }))
        await rerender(frame(false, <Enter />))
        expect(spies.withTiming).toHaveBeenCalledTimes(1)
        await act(async () => unmount())
        spies.withTiming.mockClear()
        await render(frame(true, <Enter />))
        expect(spies.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: motion.fast }))
    })
})

describe('live motion interruption', () => {
    it('keeps backward travel on its original side through a same-step rerender', async () => {
        const view = await render(frame(false, <Step id="b" direction={1} enabled />))
        spies.withTiming.mockImplementationOnce(() => 0.5)
        await view.rerender(frame(false, <Step id="a" direction={-1} enabled />))
        await view.rerender(frame(false, <Step id="a" direction={1} enabled />))
        expect(screen.getByTestId('moving')).toHaveStyle({ transform: [{ translateX: -8 }] })
    })

    it.each(['held', 'reduce'] as const)(
        'snaps a running load entrance when %s changes and never replays it',
        async (cause) => {
            spies.withTiming.mockImplementationOnce(() => 0.4)
            const view = await render(frame(false, <Enter />))
            spies.cancelAnimation.mockClear()
            await view.rerender(frame(cause === 'reduce', <Enter enabled={cause !== 'held'} />))
            expect(spies.cancelAnimation).toHaveBeenCalled()
            await view.rerender(frame(cause === 'reduce', <Enter enabled={cause !== 'held'} />))
            expect(screen.getByTestId('enter')).toHaveStyle({ opacity: 1 })
            await view.rerender(frame(false, <Enter />))
            expect(spies.withTiming).toHaveBeenCalledTimes(1)
        },
    )

    it('snaps a cold timeline when attention moves away and never restarts on return', async () => {
        function Timeline({ enabled }: { enabled: boolean }): ReactElement {
            const timeline = useEntranceTimeline(true, enabled)
            const style = useEntranceGroup(timeline, 0, 1, true)
            return <Animated.View testID="timeline" style={style} />
        }
        spies.withTiming.mockImplementationOnce(() => 0.4)
        const view = await render(frame(false, <Timeline enabled />))
        spies.cancelAnimation.mockClear()
        await view.rerender(frame(false, <Timeline enabled={false} />))
        expect(spies.cancelAnimation).toHaveBeenCalled()
        await view.rerender(frame(false, <Timeline enabled={false} />))
        expect(screen.getByTestId('timeline')).toHaveStyle({ opacity: 1 })
        await view.rerender(frame(false, <Timeline enabled />))
        expect(spies.withTiming).toHaveBeenCalledTimes(1)
    })
})

it('spends a granted cold entrance if it is already covered before its first effect', async () => {
    function Timeline({ enabled }: { enabled: boolean }): ReactElement {
        useEntranceTimeline(true, enabled)
        return <Text>Home</Text>
    }
    const view = await render(frame(false, <Timeline enabled={false} />))
    await view.rerender(frame(false, <Timeline enabled />))
    expect(spies.withTiming).not.toHaveBeenCalled()
})
