import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { AccessibilityInfo, Text, View } from 'react-native'
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
    ['screen', 'Preparing this screen'],
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

it.each<[BlueprintPhase, string]>([
    ['guide', 'Still writing; this can take up to a minute and a half'],
    ['piece', 'Still shaping this part'],
])('uses honest slow copy for %s only after 20 seconds', async (phase, copy) => {
    await render(frame(<BlueprintLoader phase={phase} />))
    await act(() => jest.advanceTimersByTime(19_999))
    expect(screen.queryByText(copy)).toBeNull()
    await act(() => jest.advanceTimersByTime(1))
    expect(screen.getByText(copy)).toBeTruthy()
    expect(screen.queryByText('Still working; big manuals take up to a minute')).toBeNull()
})

it('starts a fresh slow wait for an actual phase change', async () => {
    const { rerender } = await render(frame(<BlueprintLoader phase="reading" />))
    await act(() => jest.advanceTimersByTime(20_000))
    await rerender(frame(<BlueprintLoader phase="guide" />))
    expect(screen.queryByText('Still working; big manuals take up to a minute')).toBeNull()
    expect(screen.queryByText('Still writing; this can take up to a minute and a half')).toBeNull()
    await act(() => jest.advanceTimersByTime(20_000))
    expect(screen.getByText('Still writing; this can take up to a minute and a half')).toBeTruthy()
})

it('allocates no slow timer for the 8-second check and never exposes manual copy', async () => {
    const schedule = jest.spyOn(global, 'setTimeout')
    await render(frame(<BlueprintLoader phase="check" />))
    expect(schedule).not.toHaveBeenCalledWith(expect.any(Function), 20_000)
    await act(() => jest.advanceTimersByTime(20_000))
    expect(screen.queryByText(/Still /u, { hidden: true })).toBeNull()
})

it('allocates no timer for a passive scene and cancels the timer when paused', async () => {
    const schedule = jest.spyOn(global, 'setTimeout')
    const cancel = jest.spyOn(global, 'clearTimeout')
    const tree = (running: boolean): ReactElement => frame(<BlueprintLoader phase="piece" running={running} />)
    const { rerender } = await render(tree(false))
    expect(schedule).not.toHaveBeenCalledWith(expect.any(Function), 20_000)
    await rerender(tree(true))
    const scheduled = schedule.mock.calls.findIndex((call) => call[1] === 20_000)
    expect(scheduled).toBeGreaterThanOrEqual(0)
    const timer = schedule.mock.results[scheduled]?.value
    await act(() => jest.advanceTimersByTime(19_000))
    schedule.mockClear()
    await rerender(tree(false))
    expect(cancel).toHaveBeenCalledWith(timer)
    expect(schedule).not.toHaveBeenCalledWith(expect.any(Function), 20_000)
    await act(() => jest.advanceTimersByTime(20_000))
    expect(screen.queryByText('Still shaping this part')).toBeNull()
    await rerender(tree(true))
    await act(() => jest.advanceTimersByTime(19_999))
    expect(screen.queryByText('Still shaping this part')).toBeNull()
    await act(() => jest.advanceTimersByTime(1))
    expect(screen.getByText('Still shaping this part')).toBeTruthy()
})

it('keeps the check sweep inside the photo edges', async () => {
    await render(frame(<BlueprintLoader phase="check" imageUri="file:///check.jpg" />))
    const sweep = screen.getByTestId('blueprint-sweep', { hidden: true })
    expect(Number(sweep.props.x1)).toBeGreaterThanOrEqual(36)
    expect(Number(sweep.props.x2)).toBeLessThanOrEqual(133)
    expect(Number(sweep.props.y1)).toBeGreaterThanOrEqual(40)
    expect(Number(sweep.props.y2)).toBeLessThanOrEqual(140)
})

it('lets a screen own the announcement across loader remounts', async () => {
    const { rerender } = await render(frame(<BlueprintLoader phase="piece" announce={false} />))
    await rerender(frame(<BlueprintLoader key="another-part" phase="piece" announce={false} />))
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled()
})

it('pauses a wrapped outgoing loader immediately while the next primary starts', async () => {
    const schedule = jest.spyOn(global, 'setTimeout')
    const cancel = jest.spyOn(global, 'clearTimeout')
    const tree = (waiting: boolean): ReactElement =>
        frame(
            <>
                <LoaderSwap
                    waiting={waiting}
                    loader={
                        <View>
                            <BlueprintLoader phase="piece" label="First part" />
                        </View>
                    }
                >
                    <Text>First part ready</Text>
                </LoaderSwap>
                {waiting ? null : <BlueprintLoader phase="piece" label="Next part" />}
            </>,
            false,
        )
    // Keep the original timeline mid-loop so its exact shared-value identity can be observed through cancellation.
    spies.withRepeat.mockReturnValueOnce(0.4)
    const { rerender } = await render(tree(true))
    const originalTimeline = spies.cancelAnimation.mock.calls
        .map(([value]) => value)
        .find((value) => typeof value === 'object' && value !== null && 'value' in value && value.value === 0.4)
    expect(originalTimeline).toBeDefined()
    const scheduled = schedule.mock.calls.findIndex((call) => call[1] === 20_000)
    expect(scheduled).toBeGreaterThanOrEqual(0)
    const originalTimer = schedule.mock.results[scheduled]?.value
    schedule.mockClear()
    cancel.mockClear()
    spies.cancelAnimation.mockClear()
    spies.withRepeat.mockClear()
    jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear()

    await rerender(tree(false))
    expect(screen.getByText('First part', { hidden: true })).toBeTruthy()
    expect(screen.getByText('Next part')).toBeTruthy()
    expect(spies.cancelAnimation.mock.calls.some(([value]) => value === originalTimeline)).toBe(true)
    expect(originalTimeline).toMatchObject({ value: 1 })
    expect(cancel).toHaveBeenCalledWith(originalTimer)
    // Only the next primary owns a fresh loop, slow timer and announcement during the retained 200ms fade.
    expect(spies.withRepeat).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls.filter((call) => call[1] === 20_000)).toHaveLength(1)
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1)
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Next part')
    await act(() => jest.advanceTimersByTime(199))
    expect(screen.getByText('First part', { hidden: true })).toBeTruthy()
    await act(() => jest.advanceTimersByTime(1))
    expect(screen.queryByText('First part', { hidden: true })).toBeNull()
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
    await act(() => jest.advanceTimersByTime(199))
    expect(screen.getByTestId('swap')).toHaveStyle({ minHeight: 300 })
    await act(() => jest.advanceTimersByTime(1))
    expect(screen.queryByText('Waiting drawing')).toBeNull()
    expect(screen.getByTestId('swap')).not.toHaveStyle({ minHeight: 300 })
    await rerender(tree(true, true))
    spies.withTiming.mockClear()
    await rerender(tree(false, true))
    expect(screen.queryByText('Waiting drawing')).toBeNull()
    expect(screen.getByText('Ready content')).toBeTruthy()
    expect(screen.getByTestId('swap')).not.toHaveStyle({ minHeight: 300 })
    expect(spies.withTiming).not.toHaveBeenCalled()
})
