import { describe, expect, it, jest } from '@jest/globals'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo, Dimensions, Keyboard, StyleSheet, Text } from 'react-native'
import {
    BottomSheet,
    DETENT_RATIO,
    fitDetents,
    InstructionSheet,
    keyboardOverlap,
    MoreSheet,
    SHEET_MAX_HEIGHT_RATIO,
    snapHeight,
} from './sheet'
import { FeedbackProvider } from './feedback'
import { SPRING_GENTLE } from './motion'
import { spies } from './test-support/reanimated-mock'

jest.mock('react-native-reanimated', () => jest.requireActual('./test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

describe('BottomSheet', () => {
    it.each(['0', '1'])(
        'keeps native show diagnostics separate from logical mounting in fixture mode %s',
        async (mode) => {
            const prior = process.env.EXPO_PUBLIC_RELEASE_FIXTURE
            process.env.EXPO_PUBLIC_RELEASE_FIXTURE = mode
            const log = jest.spyOn(console, 'info').mockImplementation((): void => undefined)
            const onClose = jest.fn()
            const view = await render(
                <BottomSheet visible title="Instructions" onClose={onClose}>
                    <Text>First content</Text>
                </BottomSheet>,
            )
            const modal = (): ReturnType<typeof screen.getByTestId> => {
                let node = screen.getByTestId('bottom-sheet')
                while (node.type !== 'Modal' && node.parent !== null) node = node.parent
                expect(node.type).toBe('Modal')
                return node
            }
            let mounted = true
            try {
                if (mode === '0') expect(modal().props.onShow).toBeUndefined()
                await fireEvent(modal(), 'show')
                await view.rerender(
                    <BottomSheet visible title="Instructions" onClose={onClose}>
                        <Text>Next content</Text>
                    </BottomSheet>,
                )
                await fireEvent(modal(), 'show')
                await view.unmount()
                mounted = false
                const records = log.mock.calls.flatMap(([value]) =>
                    typeof value === 'string' && value.startsWith('{"event":"native_sheet_lifecycle"')
                        ? [
                              JSON.parse(value) as {
                                  instance: number
                                  phase: string
                                  receivedAt: number
                                  visible?: boolean
                              },
                          ]
                        : [],
                )
                if (mode === '0') expect(records).toEqual([])
                else {
                    expect(records.map((record) => record.phase)).toEqual([
                        'mount',
                        'visibility',
                        'native-show',
                        'native-show',
                        'unmount',
                    ])
                    expect(new Set(records.map((record) => record.instance)).size).toBe(1)
                    expect(records.every((record) => Number.isFinite(record.receivedAt))).toBe(true)
                    expect(
                        records.filter((record) => record.phase === 'visibility').map((record) => record.visible),
                    ).toEqual([true])
                }
                expect(onClose).not.toHaveBeenCalled()
            } finally {
                if (mounted) await view.unmount()
                log.mockRestore()
                if (prior === undefined) delete process.env.EXPO_PUBLIC_RELEASE_FIXTURE
                else process.env.EXPO_PUBLIC_RELEASE_FIXTURE = prior
            }
        },
    )

    it('shows its title as a header and its content while visible', async () => {
        await render(
            <BottomSheet visible={true} title="Instructions" onClose={(): void => undefined}>
                <Text>Groove faces inward</Text>
            </BottomSheet>,
        )
        expect(screen.getByRole('header', { name: 'Instructions' })).toBeTruthy()
        expect(screen.getByText('Groove faces inward')).toBeTruthy()
    })

    it('closes from its labelled close control', async () => {
        const onClose = jest.fn()
        await render(
            <BottomSheet visible={true} title="Instructions" onClose={onClose}>
                <Text>Body</Text>
            </BottomSheet>,
        )
        await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200))
        })
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('renders no content while hidden', async () => {
        await render(
            <BottomSheet visible={false} title="Instructions" onClose={(): void => undefined}>
                <Text>Hidden body</Text>
            </BottomSheet>,
        )
        expect(screen.queryByText('Hidden body')).toBeNull()
    })
})

describe('BottomSheet motion', () => {
    it('opens and settles with the one gentle spring and leaves with a fast fade, scrim and sheet together', async () => {
        spies.withSpring.mockClear()
        spies.withTiming.mockClear()
        const onClose = jest.fn()
        await render(
            <FeedbackProvider reduceMotion={false}>
                <BottomSheet visible={true} title="Instructions" onClose={onClose}>
                    <Text>Body</Text>
                </BottomSheet>
            </FeedbackProvider>,
        )
        expect(spies.withSpring).toHaveBeenCalled()
        for (const call of spies.withSpring.mock.calls) {
            expect(call[1]).toBe(SPRING_GENTLE)
        }
        await fireEvent.press(screen.getByRole('button', { name: 'Close sheet' }))
        expect(spies.withTiming).toHaveBeenCalledWith(0, expect.objectContaining({ duration: 150 }))
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200))
        })
        expect(onClose).toHaveBeenCalledTimes(1)
    })
})

describe('BottomSheet bounds', () => {
    it('opens at the tall detent, never grows past 92 percent of the window and scrolls long content inside it', async () => {
        await render(
            <BottomSheet visible={true} title="Long result" onClose={(): void => undefined}>
                <Text>{'Step text. '.repeat(200)}</Text>
            </BottomSheet>,
        )
        const sheet = screen.getByTestId('bottom-sheet')
        expect(StyleSheet.flatten(sheet.props.style).height).toBeCloseTo(Dimensions.get('window').height * 0.78, 0)
        expect(SHEET_MAX_HEIGHT_RATIO).toBe(0.92)
        expect(screen.getByTestId('bottom-sheet-scroll')).toBeTruthy()
    })

    it('cancels its entrance animation when the sheet unmounts', async () => {
        spies.cancelAnimation.mockClear()
        const rendered = await render(
            <BottomSheet visible={true} title="Instructions" onClose={(): void => undefined}>
                <Text>Body</Text>
            </BottomSheet>,
        )
        await act(() => rendered.unmount())
        expect(spies.cancelAnimation).toHaveBeenCalled()
    })
})

describe('InstructionSheet', () => {
    it('announces each instruction with its step number', async () => {
        await render(
            <InstructionSheet
                visible={true}
                title="Step 1"
                steps={['Stand the side panel upright.', 'Keep the panel free before seating the divider.']}
                onClose={(): void => undefined}
            />,
        )
        expect(screen.getByLabelText('Step 1: Stand the side panel upright.')).toBeTruthy()
        expect(screen.getByLabelText('Step 2: Keep the panel free before seating the divider.')).toBeTruthy()
    })
})

describe('MoreSheet and detents', () => {
    const heightOf = (): number => StyleSheet.flatten(screen.getByTestId('more-sheet').props.style).height as number
    const window = (): number => Dimensions.get('window').height

    it('is the one More pattern: a grabber, a labelled close control, and its own test ids', async () => {
        await render(
            <MoreSheet visible={true} onClose={(): void => undefined}>
                <Text>Details</Text>
            </MoreSheet>,
        )
        expect(screen.getByRole('header', { name: 'More' })).toBeTruthy()
        expect(screen.getByTestId('sheet-handle')).toBeTruthy()
        expect(screen.getByTestId('more-sheet-scroll')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Close sheet' })).toBeTruthy()
    })

    it.each([
        ['peek', 'peek' as const, DETENT_RATIO.peek],
        ['tall', 'tall' as const, DETENT_RATIO.tall],
        ['full', 'full' as const, DETENT_RATIO.full],
    ])('opens at the %s detent when asked', async (_name, initial, ratio) => {
        await render(
            <MoreSheet
                visible={true}
                onClose={(): void => undefined}
                detents={['peek', 'tall', 'full']}
                initialDetent={initial}
            >
                <Text>Details</Text>
            </MoreSheet>,
        )
        expect(heightOf()).toBeCloseTo(window() * ratio, 0)
    })

    it('defaults to the tall detent of two, and to the larger when only tall and full are offered', async () => {
        await render(
            <MoreSheet visible={true} onClose={(): void => undefined}>
                <Text>Details</Text>
            </MoreSheet>,
        )
        expect(heightOf()).toBeCloseTo(window() * DETENT_RATIO.tall, 0)
    })

    it('moves between detents from the assistive increment and decrement actions, and closes below the smallest', async () => {
        const onClose = jest.fn()
        await render(
            <MoreSheet visible={true} onClose={onClose} detents={['peek', 'tall', 'full']}>
                <Text>Details</Text>
            </MoreSheet>,
        )
        const handle = screen.getByTestId('sheet-handle')
        await fireEvent(handle, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } })
        expect(heightOf()).toBeCloseTo(window() * DETENT_RATIO.full, 0)
        await fireEvent(handle, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } })
        await fireEvent(handle, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } })
        expect(heightOf()).toBeCloseTo(window() * DETENT_RATIO.peek, 0)
        // Reduced motion in the stand-in: the close is immediate here only after the entrance timer.
        await fireEvent(handle, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } })
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200))
        })
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('does not fail where the platform cannot move screen reader focus', async () => {
        const original = AccessibilityInfo.sendAccessibilityEvent
        Object.assign(AccessibilityInfo, { sendAccessibilityEvent: undefined })
        try {
            await render(
                <MoreSheet visible={true} onClose={(): void => undefined}>
                    <Text>Details</Text>
                </MoreSheet>,
            )
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10))
            })
            expect(screen.getByText('Details')).toBeTruthy()
        } finally {
            Object.assign(AccessibilityInfo, { sendAccessibilityEvent: original })
        }
    })
})

describe('snapHeight', () => {
    const heights = [300, 600, 800]
    it.each([
        [310, 300],
        [520, 600],
        [790, 800],
        [2000, 800],
    ])('settles %s on the nearest detent %s', (projected, expected) => {
        expect(snapHeight(projected, heights, 180)).toBe(expected)
    })
    it('closes when thrown below the close line', () => {
        expect(snapHeight(120, heights, 180)).toBe(0)
        expect(snapHeight(-50, heights, 180)).toBe(0)
    })
})

describe('keyboard-fitted sheet', () => {
    type Handler = (event: { endCoordinates?: { height: number } }) => void
    let handlers: Record<string, Handler[]>
    beforeEach(() => {
        handlers = {}
        jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, handler: Handler) => {
            ;(handlers[name] ??= []).push(handler)
            return { remove: (): void => undefined }
        }) as unknown as typeof Keyboard.addListener)
    })
    afterEach(() => jest.restoreAllMocks())

    const window = (): number => Dimensions.get('window').height
    const heightOf = (): number => StyleSheet.flatten(screen.getByTestId('more-sheet').props.style).height as number
    const keyboard = async (height: number): Promise<void> => {
        await act(async () => handlers.keyboardDidShow?.forEach((handler) => handler({ endCoordinates: { height } })))
    }
    const hideKeyboard = async (): Promise<void> => {
        await act(async () => handlers.keyboardDidHide?.forEach((handler) => handler({})))
    }
    const sheet = (): React.ReactElement => (
        <FeedbackProvider reduceMotion={true}>
            <MoreSheet
                visible={true}
                title="Ask about this step"
                onClose={(): void => undefined}
                detents={['tall', 'full']}
            >
                <Text>Composer</Text>
            </MoreSheet>
        </FeedbackProvider>
    )

    it('fits its detents to the space above the keyboard and keeps the handle, title and Close on screen', async () => {
        const view = await render(sheet())
        const open = heightOf()
        expect(open).toBeCloseTo(window() * DETENT_RATIO.full, 0)
        await keyboard(window() * 0.5)
        await view.rerender(sheet())
        // Never taller than what is left above the keyboard, so nothing is pushed off the top.
        expect(heightOf()).toBeLessThanOrEqual(window() - window() * 0.5)
        expect(heightOf()).toBeLessThan(open)
        expect(StyleSheet.flatten(screen.getByTestId('sheet-scrim').props.style).paddingBottom).toBe(window() * 0.5)
        expect(screen.getByTestId('sheet-handle')).toBeTruthy()
        expect(screen.getByRole('header', { name: 'Ask about this step' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Close sheet' })).toBeTruthy()
        expect(screen.getByTestId('more-sheet-scroll')).toBeTruthy()
    })

    it('returns to the chosen resting detent when the keyboard hides', async () => {
        const view = await render(sheet())
        await fireEvent(screen.getByTestId('sheet-handle'), 'accessibilityAction', {
            nativeEvent: { actionName: 'increment' },
        })
        await view.rerender(sheet())
        const chosen = heightOf()
        expect(chosen).toBeCloseTo(window() * DETENT_RATIO.full, 0)
        await keyboard(window() * 0.5)
        await view.rerender(sheet())
        expect(heightOf()).toBeLessThan(chosen)
        await hideKeyboard()
        await view.rerender(sheet())
        expect(heightOf()).toBeCloseTo(chosen, 0)
    })

    it('does not count the keyboard twice when the platform already shrank the window', async () => {
        const view = await render(sheet())
        const scrim = screen.getByTestId('sheet-scrim')
        await fireEvent(scrim, 'layout', { nativeEvent: { layout: { height: window() } } })
        // Android resize: the container is now shorter by the keyboard, and the keyboard event arrives as well.
        await fireEvent(scrim, 'layout', { nativeEvent: { layout: { height: window() - 500 } } })
        await keyboard(500)
        await view.rerender(sheet())
        expect(StyleSheet.flatten(screen.getByTestId('sheet-scrim').props.style).paddingBottom).toBe(0)
        expect(heightOf()).toBeLessThanOrEqual(window() - 500)
        expect(heightOf()).toBeGreaterThan(window() - 500 - 80)
    })

    it('keeps a usable viewport when the window changes with the keyboard still open', async () => {
        const original = Dimensions.get('window')
        const view = await render(sheet())
        await keyboard(300)
        try {
            await act(async () => Dimensions.set({ window: { ...original, height: 600 } }))
            await fireEvent(screen.getByTestId('sheet-scrim'), 'layout', {
                nativeEvent: { layout: { height: 300 } },
            })
            await view.rerender(sheet())
            expect(StyleSheet.flatten(screen.getByTestId('sheet-scrim').props.style).paddingBottom).toBe(0)
            expect(heightOf()).toBeGreaterThan(250)
            expect(heightOf()).toBeLessThanOrEqual(300)
            await hideKeyboard()
            await fireEvent(screen.getByTestId('sheet-scrim'), 'layout', {
                nativeEvent: { layout: { height: 600 } },
            })
            await view.rerender(sheet())
            expect(heightOf()).toBeCloseTo(600 * DETENT_RATIO.full, 0)
        } finally {
            await act(async () => Dimensions.set({ window: original }))
        }
    })

    it('finishes an in-flight keyboard-fit spring when reduced motion is enabled', async () => {
        const element = (reduceMotion: boolean): React.ReactElement => (
            <FeedbackProvider reduceMotion={reduceMotion}>
                <MoreSheet visible={true} title="Ask" onClose={(): void => undefined} detents={['tall', 'full']}>
                    <Text>Composer</Text>
                </MoreSheet>
            </FeedbackProvider>
        )
        const view = await render(element(false))
        // Model a native spring still above its endpoint; the normal stand-in jumps directly to that endpoint.
        spies.withSpring.mockImplementationOnce((target: number): number => target + 80)
        await keyboard(window() * 0.5)
        await view.rerender(element(false))
        const fitted = Math.round(window() * 0.5 - 8)
        expect(heightOf()).toBe(fitted + 80)
        await view.rerender(element(true))
        await view.rerender(element(true))
        expect(heightOf()).toBe(fitted)
    })

    it.each([
        [false, true],
        [true, false],
    ])('with reduced motion %s the fit springs: %s', async (reduced, springs) => {
        const element = (): React.ReactElement => (
            <FeedbackProvider reduceMotion={reduced}>
                <MoreSheet visible={true} title="Ask" onClose={(): void => undefined} detents={['tall', 'full']}>
                    <Text>Composer</Text>
                </MoreSheet>
            </FeedbackProvider>
        )
        const view = await render(element())
        spies.withSpring.mockClear()
        await keyboard(window() * 0.5)
        await view.rerender(element())
        const fitted = window() * 0.5 - 8
        expect(spies.withSpring.mock.calls.some(([target]) => target === Math.round(fitted))).toBe(springs)
        // Either way the sheet ends at the fitted height; reduced motion sets it directly.
        await view.rerender(element())
        expect(heightOf()).toBeLessThanOrEqual(window() * 0.5)
    })
})

describe('short visible title at accessibility text sizes', () => {
    it('shows the concise title and keeps the complete name for assistive tech', async () => {
        // Jest reports a font scale of 2, which is already an accessibility size.
        await render(
            <MoreSheet visible={true} title="Ask about this step" compactTitle="Ask" onClose={(): void => undefined}>
                <Text>Composer</Text>
            </MoreSheet>,
        )
        expect(screen.getByText('Ask')).toBeTruthy()
        expect(screen.queryByText('Ask about this step')).toBeNull()
        expect(screen.getByRole('header', { name: 'Ask about this step' })).toBeTruthy()
    })
})

describe('fitting helpers', () => {
    it('counts only the part of the keyboard the platform has not already removed from the container', () => {
        expect(keyboardOverlap(300, 800, 800)).toBe(300)
        expect(keyboardOverlap(300, 800, 500)).toBe(0)
        expect(keyboardOverlap(300, 800, 650)).toBe(150)
        expect(keyboardOverlap(0, 800, 800)).toBe(0)
    })

    it('never lets a detent pass the space above the keyboard', () => {
        expect(fitDetents([0.45, 0.78, 0.92], 800, 800, 8)).toEqual([360, 624, 736])
        expect(fitDetents([0.45, 0.78, 0.92], 800, 500, 8)).toEqual([360, 492, 492])
    })
})
