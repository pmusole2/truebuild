import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { AccessibilityInfo, Text } from 'react-native'
import { BlueprintLoader, LoaderSwap, type BlueprintPhase } from './blueprint-loader'
import { FeedbackProvider } from './feedback'
import { spies } from './test-support/reanimated-mock'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))

const frame = (node: ReactElement, reduced = true): ReactElement => (
    <FeedbackProvider reduceMotion={reduced}>{node}</FeedbackProvider>
)

beforeEach(() => {
    jest.useFakeTimers()
    for (const spy of Object.values(spies)) spy.mockClear()
    jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
        .mockImplementation(() => undefined)
        .mockClear()
})

afterEach(async () => {
    await cleanup()
    jest.useRealTimers()
    jest.restoreAllMocks()
})

it.each<[BlueprintPhase, string]>([
    ['reading', 'Reading your manual'],
    ['guide', 'Building your guide'],
    ['piece', 'Shaping the part'],
    ['check', 'Checking your build'],
])('renders the %s scene with an accessible phase label', async (phase, label) => {
    await render(frame(<BlueprintLoader phase={phase} />))
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByTestId(`blueprint-scene-${phase}`, { hidden: true })).toHaveProp(
        'importantForAccessibility',
        'no-hide-descendants',
    )
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(label)
})

it('shows the final static drawing when motion is reduced, including after a live preference change', async () => {
    const { rerender } = await render(frame(<BlueprintLoader phase="guide" />, false))
    expect(spies.withRepeat).toHaveBeenCalledTimes(1)
    for (const spy of Object.values(spies)) spy.mockClear()
    await rerender(frame(<BlueprintLoader phase="guide" />, true))
    expect(spies.withRepeat).not.toHaveBeenCalled()
    expect(spies.withTiming).not.toHaveBeenCalled()
    // SVG normalizes a zero dash offset to null at the native boundary.
    expect(screen.getByTestId('blueprint-trace-card', { hidden: true }).props.strokeDashoffset ?? 0).toBe(0)
    expect(spies.cancelAnimation).toHaveBeenCalled()
})

it('uses known counts or the caller’s observed phase and announces only once for the mounted wait', async () => {
    const { rerender } = await render(frame(<BlueprintLoader phase="reading" pageCount={8} />))
    expect(screen.getByText('Reading your 8-page manual')).toBeTruthy()
    await rerender(frame(<BlueprintLoader phase="reading" pageCount={8} label="Laying out steps" />))
    expect(screen.getByText('Laying out steps')).toBeTruthy()
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1)
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Reading your 8-page manual')
})

it('waits until the scene is visible to announce and cancels its loop when unmounted', async () => {
    const tree = (running: boolean): ReactElement => frame(<BlueprintLoader phase="guide" running={running} />, false)
    const view = await render(tree(false))
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled()
    expect(spies.withRepeat).not.toHaveBeenCalled()
    await view.rerender(tree(true))
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1)
    spies.cancelAnimation.mockClear()
    await view.unmount()
    expect(spies.cancelAnimation).toHaveBeenCalled()
})

it('adds the calm second line at 20 seconds without resetting when real phase copy changes', async () => {
    const { rerender, unmount } = await render(frame(<BlueprintLoader phase="reading" />))
    const slow = 'Still working; big manuals take up to a minute'
    await act(() => jest.advanceTimersByTime(19_999))
    expect(screen.queryByText(slow)).toBeNull()
    await rerender(frame(<BlueprintLoader phase="reading" label="Laying out steps" />))
    await act(() => jest.advanceTimersByTime(1))
    expect(screen.getByText(slow)).toBeTruthy()
    await unmount()
})

it('cross-fades the same content slot for 200ms and reveals immediately with reduced motion', async () => {
    const tree = (waiting: boolean, reduced: boolean): ReactElement =>
        frame(
            <LoaderSwap testID="swap" waiting={waiting} loader={<Text>Waiting drawing</Text>}>
                <Text>Ready content</Text>
            </LoaderSwap>,
            reduced,
        )
    const { rerender } = await render(tree(true, false))
    expect(screen.getByText('Waiting drawing')).toBeTruthy()
    expect(screen.queryByText('Ready content')).toBeNull()
    expect(screen.getByText('Ready content', { hidden: true })).toBeTruthy()
    const loaderFrame = screen.getByText('Waiting drawing').parent
    if (loaderFrame === null) throw new Error('Missing loader frame')
    await fireEvent(loaderFrame, 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 300 } },
    })
    await rerender(tree(false, false))
    expect(spies.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 200 }))
    expect(screen.getByText('Ready content')).toBeTruthy()
    expect(screen.getByTestId('swap')).toHaveStyle({ minHeight: 300 })
    await act(() => jest.advanceTimersByTime(200))
    expect(screen.queryByText('Waiting drawing')).toBeNull()
    await rerender(tree(true, true))
    spies.withTiming.mockClear()
    await rerender(tree(false, true))
    expect(screen.queryByText('Waiting drawing')).toBeNull()
    expect(screen.getByText('Ready content')).toBeTruthy()
    expect(spies.withTiming).not.toHaveBeenCalled()
})
