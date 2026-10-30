import { layoutCoachBubble, pressCoach } from './coach-test-support'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { AppState, Dimensions, Linking, Platform, StatusBar, Text, type AppStateStatus } from 'react-native'
import type { ReactElement } from 'react'
import { spies } from '../../ui/test-support/reanimated-mock'
import { guideCandidates, homeCandidates } from './coach-inventory'
import { CoachRootOverlay } from './coach-overlay'
import { CoachTarget, measureInWindow, useCoach, useCoachScreen } from './coach-provider'
import type { CoachCandidate, Rect } from './coach-types'
import { CoachHarness, RECTS, fakeMeasure, memoryStorage, readyStore } from './coach-test-support'
import { createOnboardingStore } from './onboarding-store'
import { resetTipsSkipLatchForTests, tipsSkippedByLaunchUrl, tipsSkippedSynchronously } from './coach-skip'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
let mockFontScale = 1
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): { width: number; height: number; scale: number; fontScale: number } => ({
        width: 390,
        height: 844,
        scale: 3,
        fontScale: mockFontScale,
    }),
}))

const HOME: readonly CoachCandidate[] = homeCandidates({ add: true, resume: false, more: true })

type Presses = Record<string, number>

function Home({
    candidates = HOME,
    suppressed = false,
    presses,
}: {
    readonly candidates?: readonly CoachCandidate[]
    readonly suppressed?: boolean
    readonly presses: Presses
}): ReactElement {
    useCoachScreen('home', { suppressed, candidates })
    return (
        <>
            {candidates.map((candidate) => (
                <CoachTarget
                    key={candidate.id}
                    id={candidate.id}
                    label={candidate.id}
                    onPress={(): void => {
                        presses[candidate.id] = (presses[candidate.id] ?? 0) + 1
                    }}
                >
                    <Text>{candidate.id}</Text>
                </CoachTarget>
            ))}
        </>
    )
}

beforeEach(() => {
    mockFontScale = 1
    for (const spy of Object.values(spies)) spy.mockClear()
})

const overlay = (): ReturnType<typeof screen.queryByTestId> => screen.queryByTestId('coach-overlay')

describe('showing a tour', () => {
    it('shows the first tip for an unseen, focused, ready screen after it settles, with its real copy', async () => {
        const { store } = await readyStore()
        const presses: Presses = {}
        await render(
            <CoachHarness store={store}>
                <Home presses={presses} />
            </CoachHarness>,
        )
        expect(await screen.findByTestId('coach-overlay')).toBeTruthy()
        expect(screen.getByText('Tap here to add your paper manual.')).toBeTruthy()
        expect(screen.getByText('Start here')).toBeTruthy()
        expect(screen.getByTestId('coach-next')).toBeTruthy()
        expect(screen.getByTestId('coach-skip')).toBeTruthy()
        // Reading a tip does nothing: no action ran and nothing was marked seen.
        expect(presses).toEqual({})
        expect(store.getSnapshot().seen).toEqual([])
    })

    it('waits for the saved record before showing anything', async () => {
        const store = createOnboardingStore(memoryStorage())
        await render(
            <CoachHarness store={store}>
                <Home presses={{}} />
            </CoachHarness>,
        )
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40))
        })
        expect(overlay()).toBeNull()
        await act(async () => {
            await store.restore()
        })
        expect(await screen.findByTestId('coach-overlay')).toBeTruthy()
    })

    it('never shows a tour a person has already finished, even after a remount', async () => {
        const { store } = await readyStore(['home'])
        await render(
            <CoachHarness store={store}>
                <Home presses={{}} />
            </CoachHarness>,
        )
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40))
        })
        expect(overlay()).toBeNull()
    })

    it('shows nothing while the provider is disabled and writes nothing', async () => {
        const { store, storage } = await readyStore()
        await render(
            <CoachHarness store={store} disabled>
                <Home presses={{}} />
            </CoachHarness>,
        )
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40))
        })
        expect(overlay()).toBeNull()
        expect(storage.writes).toEqual([])
        expect(store.getSnapshot().seen).toEqual([])
    })

    it('is skipped by the development flag without ever marking a screen seen', async () => {
        const previous = process.env.EXPO_PUBLIC_SKIP_TIPS
        process.env.EXPO_PUBLIC_SKIP_TIPS = '1'
        try {
            const { store, storage } = await readyStore()
            await render(
                <CoachHarness store={store}>
                    <Home presses={{}} />
                </CoachHarness>,
            )
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 40))
            })
            expect(overlay()).toBeNull()
            expect(storage.writes).toEqual([])
        } finally {
            if (previous === undefined) delete process.env.EXPO_PUBLIC_SKIP_TIPS
            else process.env.EXPO_PUBLIC_SKIP_TIPS = previous
        }
    })

    it('skips a tip whose target cannot be measured, without marking the screen seen', async () => {
        const { store } = await readyStore()
        const rects: Record<string, Rect | null> = {
            'home-add': { x: 0, y: 0, width: 0, height: 0 },
            'header-more': RECTS['header-more']!,
        }
        await render(
            <CoachHarness store={store} measure={fakeMeasure(rects)}>
                <Home presses={{}} />
            </CoachHarness>,
        )
        // The unusable Add anchor is dropped silently; the header More tip leads, and dots count only real tips.
        expect(await screen.findByText('Tap More for help and settings.')).toBeTruthy()
        expect(screen.queryByText('Tap here to add your paper manual.')).toBeNull()
        expect(screen.getByTestId('coach-got-it')).toBeTruthy()
        expect(store.getSnapshot().seen).toEqual([])
    })
})

describe('Next, Skip and Got it', () => {
    it('Next advances through the tips without running any action; Got it ends and marks the screen seen', async () => {
        const { store } = await readyStore()
        const presses: Presses = {}
        await render(
            <CoachHarness store={store}>
                <Home presses={presses} />
            </CoachHarness>,
        )
        await screen.findByTestId('coach-overlay')
        await pressCoach('coach-next')
        expect(await screen.findByText('Tap More for help and settings.')).toBeTruthy()
        expect(screen.queryByTestId('coach-next')).toBeNull()
        await pressCoach('coach-got-it')
        await waitFor(() => expect(overlay()).toBeNull())
        expect(store.getSnapshot().seen).toEqual(['home'])
        expect(presses).toEqual({})
    })

    it('Skip ends the whole screen tour from any step, runs no action and does not return', async () => {
        const { store } = await readyStore()
        const presses: Presses = {}
        const view = (
            <CoachHarness store={store}>
                <Home presses={presses} />
            </CoachHarness>
        )
        const { rerender } = await render(view)
        await screen.findByTestId('coach-overlay')
        await pressCoach('coach-skip')
        await waitFor(() => expect(overlay()).toBeNull())
        expect(store.getSnapshot().seen).toEqual(['home'])
        await rerender(view)
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40))
        })
        expect(overlay()).toBeNull()
        expect(presses).toEqual({})
    })

    it('a burst of Next then Skip dismisses once and never runs a queued target action', async () => {
        const { store } = await readyStore()
        const presses: Presses = {}
        const complete = jest.spyOn(store, 'complete')
        const trigger = jest.fn()
        let coach: ReturnType<typeof useCoach> = null
        function Capture(): ReactElement | null {
            coach = useCoach()
            return null
        }
        await render(
            <CoachHarness store={store} haptics={{ trigger }}>
                <Home presses={presses} />
                <Capture />
            </CoachHarness>,
        )
        await screen.findByTestId('coach-overlay')
        // Next claims once; Skip can still dismiss it, and the queued target must do nothing.
        await act(async () => {
            coach?.next()
            coach?.next()
            coach?.skip()
            coach?.activate()
        })
        expect(store.getSnapshot().seen).toEqual(['home'])
        expect(screen.queryByTestId('coach-overlay')).toBeNull()
        expect(presses).toEqual({})
        expect(complete).toHaveBeenCalledTimes(1)
        expect(complete).toHaveBeenCalledWith('home')
        expect(trigger).not.toHaveBeenCalled()
    })
})

describe('the highlighted target', () => {
    it('runs the registered action exactly once however often it is tapped, consuming the tip first', async () => {
        const { store } = await readyStore()
        const presses: Presses = {}
        const seenAtPress: string[][] = []
        let captured: ReturnType<typeof useCoach> = null
        function Spy(): ReactElement {
            const coach = useCoach()
            captured = coach
            return (
                <CoachTarget
                    id="home-add"
                    label="home-add"
                    onPress={(): void => {
                        // Consumed and hidden before the real action runs, and never waiting for storage.
                        seenAtPress.push([...store.getSnapshot().seen])
                        expect(coach?.active).toBeDefined()
                        presses['home-add'] = (presses['home-add'] ?? 0) + 1
                    }}
                >
                    <Text>real control</Text>
                </CoachTarget>
            )
        }
        function Screen(): ReactElement {
            useCoachScreen('home', { suppressed: false, candidates: HOME })
            return <Spy />
        }
        await render(
            <CoachHarness store={store}>
                <Screen />
            </CoachHarness>,
        )
        await screen.findByTestId('coach-target-hole')
        await act(async () => {
            captured?.activate()
            captured?.activate()
            captured?.activate()
        })
        expect(presses['home-add']).toBe(1)
        expect(seenAtPress).toEqual([['home']])
        await waitFor(() => expect(overlay()).toBeNull())
        expect(store.getSnapshot().seen).toEqual(['home'])
    })

    it('a picture surface only moves the tour on and never runs an action or browses', async () => {
        const { store } = await readyStore()
        const candidates = guideCandidates({ hero: true, primaryLabel: 'Take photo', swipe: true, more: false })
        const presses: Presses = {}
        function Screen(): ReactElement {
            useCoachScreen('home', { suppressed: false, candidates })
            return (
                <>
                    {candidates.map((candidate) => (
                        <CoachTarget
                            key={candidate.id}
                            id={candidate.id}
                            label={candidate.id}
                            onPress={
                                candidate.kind === 'surface'
                                    ? undefined
                                    : (): void => {
                                          presses[candidate.id] = 1
                                      }
                            }
                        >
                            <Text>{candidate.id}</Text>
                        </CoachTarget>
                    ))}
                </>
            )
        }
        await render(
            <CoachHarness store={store}>
                <Screen />
            </CoachHarness>,
        )
        expect(await screen.findByText('This picture shows what to build.')).toBeTruthy()
        await pressCoach('coach-target-hole')
        expect(await screen.findByText('Take a photo to check your work.')).toBeTruthy()
        expect(presses).toEqual({})
    })

    it('gives the target proxy the real control name and a hint for screen readers', async () => {
        const { store } = await readyStore()
        await render(
            <CoachHarness store={store}>
                <Home presses={{}} />
            </CoachHarness>,
        )
        const hole = await screen.findByTestId('coach-target-hole')
        expect(hole.props.accessibilityRole).toBe('button')
        expect(hole.props.accessibilityLabel).toBe('home-add')
        expect(hole.props.accessibilityHint).toBe('Double-tap to use it.')
    })
})

describe('suppression and pausing', () => {
    it('shows no tip while the screen is working, then offers the same first tip when it stops', async () => {
        const { store } = await readyStore()
        const presses: Presses = {}
        const tree = (suppressed: boolean): ReactElement => (
            <CoachHarness store={store}>
                <Home presses={presses} suppressed={suppressed} />
            </CoachHarness>
        )
        const { rerender } = await render(tree(true))
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40))
        })
        expect(overlay()).toBeNull()
        await rerender(tree(false))
        expect(await screen.findByText('Tap here to add your paper manual.')).toBeTruthy()
        expect(store.getSnapshot().seen).toEqual([])
    })

    it('hides a visible tip without marking it seen when work starts, and resumes the same step', async () => {
        const { store } = await readyStore()
        const tree = (suppressed: boolean): ReactElement => (
            <CoachHarness store={store}>
                <Home presses={{}} suppressed={suppressed} />
            </CoachHarness>
        )
        const { rerender } = await render(tree(false))
        await screen.findByTestId('coach-overlay')
        await pressCoach('coach-next')
        await screen.findByText('Tap More for help and settings.')
        await rerender(tree(true))
        await waitFor(() => expect(overlay()).toBeNull())
        expect(store.getSnapshot().seen).toEqual([])
        await rerender(tree(false))
        // Resumes at the tip it was on, not the first one.
        expect(await screen.findByText('Tap More for help and settings.')).toBeTruthy()
    })

    it('shows no tip on an unfocused route', async () => {
        const { store } = await readyStore()
        await render(
            <CoachHarness store={store} focused={false}>
                <Home presses={{}} />
            </CoachHarness>,
        )
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40))
        })
        expect(overlay()).toBeNull()
    })

    it('hides the tip when the app goes to the background and keeps it unseen', async () => {
        const { store } = await readyStore()
        let notify: ((state: AppStateStatus) => void) | undefined
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
            notify = listener as (state: AppStateStatus) => void
            return { remove: (): void => undefined }
        })
        await render(
            <CoachHarness store={store}>
                <Home presses={{}} />
            </CoachHarness>,
        )
        await screen.findByTestId('coach-overlay')
        await act(async () => notify?.('background'))
        await waitFor(() => expect(overlay()).toBeNull())
        expect(store.getSnapshot().seen).toEqual([])
        await act(async () => notify?.('active'))
        expect(await screen.findByTestId('coach-overlay')).toBeTruthy()
    })

    it('drops a measurement that finishes after the screen became unfit, so no stale tip shows', async () => {
        const { store } = await readyStore()
        let release: (rect: Rect) => void = () => undefined
        const slow = (): Promise<Rect | null> => new Promise((resolve) => (release = resolve))
        const tree = (suppressed: boolean): ReactElement => (
            <CoachHarness store={store} measure={slow}>
                <Home presses={{}} suppressed={suppressed} />
            </CoachHarness>
        )
        const { rerender } = await render(tree(false))
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30))
        })
        await rerender(tree(true))
        await act(async () => release(RECTS['home-add']!))
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30))
        })
        expect(overlay()).toBeNull()
        expect(store.getSnapshot().seen).toEqual([])
    })
})

describe('show tips again', () => {
    it('clears the record and re-offers the tour on the same visit', async () => {
        const { store } = await readyStore()
        let coach: ReturnType<typeof useCoach> = null
        function Capture(): ReactElement | null {
            coach = useCoach()
            return null
        }
        await render(
            <CoachHarness store={store}>
                <Home presses={{}} />
                <Capture />
            </CoachHarness>,
        )
        await screen.findByTestId('coach-overlay')
        await pressCoach('coach-skip')
        await waitFor(() => expect(overlay()).toBeNull())
        expect(store.getSnapshot().seen).toEqual(['home'])
        await act(async () => coach?.showTipsAgain())
        expect(store.getSnapshot().seen).toEqual([])
        expect(await screen.findByText('Tap here to add your paper manual.')).toBeTruthy()
    })
})

describe('accessibility and large text', () => {
    it('isolates the overlay as one modal subtree holding the heading, sentence, target proxy, Next and Skip', async () => {
        const { store } = await readyStore()
        await render(
            <CoachHarness store={store}>
                <Home presses={{}} />
            </CoachHarness>,
        )
        const root = await screen.findByTestId('coach-overlay')
        expect(root.props.accessibilityViewIsModal).toBe(true)
        for (const id of ['coach-heading', 'coach-target-hole', 'coach-next', 'coach-skip']) {
            expect(screen.getByTestId(id)).toBeTruthy()
        }
        expect(screen.getByTestId('coach-skip').props.accessibilityLabel).toBe('Skip tips')
        // Decorative parts never read: the dots carry progress only through the announcement.
        expect(screen.getByTestId('coach-dots', { hidden: true }).props.accessibilityElementsHidden).toBe(true)
    })

    it('hides the covered screen from Android screen readers while a root tip is visible', async () => {
        const { store } = await readyStore()
        jest.replaceProperty(Platform, 'OS', 'android')
        try {
            await render(
                <CoachHarness store={store}>
                    <Home presses={{}} />
                </CoachHarness>,
            )
            await screen.findByTestId('coach-overlay')
            expect(screen.getByText('home-add', { hidden: true })).toBeTruthy()
            expect(screen.queryByText('home-add')).toBeNull()
        } finally {
            jest.restoreAllMocks()
        }
    })

    it('prioritizes the uncapped sentence and pinned actions at the largest text size', async () => {
        mockFontScale = 3
        const { store } = await readyStore()
        await render(
            <CoachHarness store={store}>
                <Home presses={{}} candidates={homeCandidates({ add: false, resume: false, more: true })} />
            </CoachHarness>,
        )
        await screen.findByTestId('coach-overlay')
        expect(screen.queryByText('Tip')).toBeNull()
        expect(screen.getByText('Tap More for help and settings.')).toBeTruthy()
        const last = screen.getByTestId('coach-got-it')
        expect(last.props.accessibilityLabel).toBe('Got it')
        expect(screen.getByText('Done')).toBeTruthy()
        // The sentence stays whole and scrolls inside the bubble; Skip and the last action are outside the scroll.
        expect(screen.getByTestId('coach-bubble-scroll')).toBeTruthy()
    })
})

describe('reduced motion', () => {
    it('animates nothing under Reduce Motion and uses the one gentle spring otherwise', async () => {
        const { store } = await readyStore()
        const { unmount } = await render(
            <CoachHarness store={store} reduceMotion>
                <Home presses={{}} />
            </CoachHarness>,
        )
        await screen.findByTestId('coach-overlay')
        expect(spies.withSpring).not.toHaveBeenCalled()
        expect(spies.withTiming).not.toHaveBeenCalled()
        await unmount()
        const again = await readyStore()
        await render(
            <CoachHarness store={again.store} reduceMotion={false}>
                <Home presses={{}} />
            </CoachHarness>,
        )
        await screen.findByTestId('coach-overlay')
        expect(spies.withSpring).toHaveBeenCalledTimes(1)
        expect(spies.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 150 }))
    })
})

describe('live targets and placement', () => {
    it('refreshes copy and geometry for a changed candidate with the same target id', async () => {
        const { store } = await readyStore()
        const measure = fakeMeasure()
        const tree = (sentence: string): ReactElement => (
            <CoachHarness store={store} measure={measure}>
                <Home candidates={[{ ...HOME[0]!, sentence }]} presses={{}} />
            </CoachHarness>
        )
        const view = await render(tree('Tap here to add your paper manual.'))
        await screen.findByText('Tap here to add your paper manual.')
        await view.rerender(tree('Take a photo of the next page.'))
        await waitFor(() => expect(screen.queryByText('Tap here to add your paper manual.')).toBeNull())
        expect(await screen.findByText('Take a photo of the next page.')).toBeTruthy()
    })

    it('defers a tip with no clear bubble space without blocking the screen or marking it seen', async () => {
        const { store, storage } = await readyStore()
        const measure = fakeMeasure({ 'home-add': { x: 16, y: 60, width: 358, height: 700 } })
        await render(
            <CoachHarness store={store} measure={measure}>
                <Home candidates={[HOME[0]!]} presses={{}} />
            </CoachHarness>,
        )
        await screen.findByTestId('coach-overlay')
        await fireEvent(screen.getByTestId('coach-bubble'), 'layout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 300 } },
        })
        await waitFor(() => expect(screen.queryByTestId('coach-overlay')).toBeNull())
        expect(store.getSnapshot().seen).toEqual([])
        expect(storage.writes).toEqual([])
    })
})

it('keeps one coach host while the spotlight eases to the next real target', async () => {
    const { store } = await readyStore()
    const measure = fakeMeasure()
    await render(
        <CoachHarness store={store} measure={measure} reduceMotion={false}>
            <Home presses={{}} />
        </CoachHarness>,
    )
    const original = await screen.findByTestId('coach-overlay')
    spies.withTiming.mockClear()
    await pressCoach('coach-next')
    await screen.findByText('Tap More for help and settings.')
    expect(screen.getByTestId('coach-overlay')).toBe(original)
    expect(spies.withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 250 }))
})

it('keeps one selection haptic on the highlighted action even under reduced motion', async () => {
    const { store } = await readyStore()
    const trigger = jest.fn()
    const presses: Presses = {}
    await render(
        <CoachHarness store={store} reduceMotion haptics={{ trigger }}>
            <Home presses={presses} />
        </CoachHarness>,
    )
    await screen.findByTestId('coach-overlay')
    await pressCoach('coach-target-hole')
    expect(presses['home-add']).toBe(1)
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith('selection')
})

it('does not add a guessed Android status-bar offset to a native measurement', async () => {
    const os = Platform.OS
    const statusHeight = StatusBar.currentHeight
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true })
    Object.defineProperty(StatusBar, 'currentHeight', { value: 24, configurable: true })
    try {
        const rect = await measureInWindow({
            label: 'target',
            ref: {
                current: {
                    measureInWindow: (done: (x: number, y: number, w: number, h: number) => void): void =>
                        done(16, 700, 360, 56),
                } as never,
            },
        })
        expect(rect).toEqual({ x: 16, y: 700, width: 360, height: 56 })
    } finally {
        Object.defineProperty(StatusBar, 'currentHeight', { value: statusHeight, configurable: true })
        Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
    }
})

it.each([
    ['keep-building', { x: 42, y: 2023, width: 996, height: 147 }],
    ['header-more', { x: 923, y: 170, width: 115, height: 116 }],
] as const)(
    'measures %s relative to the actual common coach frame instead of another native window',
    async (label, expected) => {
        const reference = {} as never
        const nativeWindow = jest.fn((done: (x: number, y: number, width: number, height: number) => void): void =>
            done(expected.x, expected.y + 128.5, expected.width, expected.height),
        )
        const relative = jest.fn(
            (_root: unknown, done: (x: number, y: number, width: number, height: number) => void): void =>
                done(expected.x, expected.y, expected.width, expected.height),
        )
        const measured = await measureInWindow(
            { label, ref: { current: { measureInWindow: nativeWindow, measureLayout: relative } as never } },
            reference,
        )
        expect(measured).toEqual(expected)
        expect(relative).toHaveBeenCalledWith(reference, expect.any(Function), expect.any(Function))
        expect(nativeWindow).not.toHaveBeenCalled()
    },
)

it('offers a bottom action in Android full-screen coordinates beyond the app content window', async () => {
    const os = Platform.OS
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true })
    const dims = jest
        .spyOn(Dimensions, 'get')
        .mockImplementation(() => ({ width: 390, height: 900, scale: 3, fontScale: 1 }))
    try {
        const { store } = await readyStore()
        await render(
            <CoachHarness
                store={store}
                measure={fakeMeasure({ 'home-add': { x: 16, y: 850, width: 358, height: 44 } })}
            >
                <Home candidates={HOME.slice(0, 1)} presses={{}} />
            </CoachHarness>,
        )
        expect(await screen.findByTestId('coach-overlay')).toBeTruthy()
    } finally {
        dims.mockRestore()
        Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
    }
})

it('Skip still dismisses while Next waits for its next target measurement', async () => {
    const { store } = await readyStore()
    let hold = false
    const measure = fakeMeasure()
    await render(
        <CoachHarness
            store={store}
            measure={(handle) =>
                hold && handle.label === 'header-more' ? new Promise(() => undefined) : measure(handle)
            }
        >
            <Home presses={{}} />
        </CoachHarness>,
    )
    await screen.findByTestId('coach-overlay')
    hold = true
    await pressCoach('coach-next')
    await pressCoach('coach-skip')
    expect(store.getSnapshot().seen).toEqual(['home'])
    expect(screen.queryByTestId('coach-overlay')).toBeNull()
})

it.each([false, true])('shows highlighted-target press feedback, reduced=%s', async (reduced) => {
    const { store } = await readyStore()
    const measure = fakeMeasure()
    const tree = (): ReactElement => (
        <CoachHarness store={store} measure={measure} reduceMotion={reduced}>
            <Home presses={{}} />
        </CoachHarness>
    )
    const view = await render(tree())
    await screen.findByTestId('coach-overlay')
    await layoutCoachBubble()
    await fireEvent(screen.getByTestId('coach-target-hole'), 'pressIn')
    await view.rerender(tree())
    expect(screen.getByTestId('coach-ring', { hidden: true })).toHaveStyle({
        opacity: 0.8,
        transform: [{ scale: reduced ? 1 : 0.97 }],
    })
})

it('uses a full-screen transparent Android coach window and wires native Back to Skip', async () => {
    const os = Platform.OS
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true })
    const skip = jest.fn()
    try {
        const { store } = await readyStore()
        await render(
            <CoachHarness store={store}>
                <CoachRootOverlay
                    active={{
                        token: 1,
                        screen: 'home',
                        host: 'root',
                        candidate: HOME[0]!,
                        rect: { x: 16, y: 700, width: 358, height: 56 },
                        label: 'Add manual',
                        actionable: true,
                        position: 1,
                        total: 1,
                    }}
                    controls={{ skip, next: jest.fn(), activate: jest.fn(), defer: jest.fn() }}
                />
            </CoachHarness>,
        )
        const modal = screen.getByTestId('coach-root-modal')
        expect(modal.props).toMatchObject({
            transparent: true,
            animationType: 'none',
            statusBarTranslucent: true,
            navigationBarTranslucent: true,
        })
        await fireEvent(modal, 'requestClose')
        expect(skip).toHaveBeenCalledTimes(1)
    } finally {
        Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
    }
})

it('latches the native development launch-URL skip without a saved record', async () => {
    resetTipsSkipLatchForTests()
    const url = jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('exp://127.0.0.1:8091?truebuildSkipTips=1')
    try {
        expect(await tipsSkippedByLaunchUrl()).toBe(true)
        url.mockResolvedValue(null)
        expect(await tipsSkippedByLaunchUrl()).toBe(true)
        expect(tipsSkippedSynchronously()).toBe(true)
    } finally {
        url.mockRestore()
        resetTipsSkipLatchForTests()
    }
})
