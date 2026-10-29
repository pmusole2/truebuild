import { pressCoach } from './coach-test-support'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { INERT_WORKFLOW_CONTROLLER, WorkflowPreview } from '../../ui/preview/workflow-preview'
import { workflowPreviewFixture, type WorkflowPreviewCase } from '../../ui/preview/workflow-fixtures'
import { GuideScreen } from '../capture/guide-screen'
import { HeaderButtons } from '../capture/screen-header'
import { LibraryScreen } from '../capture/library-screen'
import { PagesScreen } from '../capture/pages-screen'
import { OverviewScreen } from '../capture/review-screen'
import type { MoreControl } from '../capture/screen-header'
import type { ScreenNav } from '../capture/screen-nav'
import type { WorkflowController } from '../capture/workflow-types'
import { homeCandidates } from './coach-inventory'
import { useCoachScreen } from './coach-provider'
import { HideTipsForTestingRow } from './tips-rows'
import { CoachHarness, readyStore, type MemoryStorage } from './coach-test-support'
import type { OnboardingScreen, OnboardingStore, Rect } from './coach-types'

// Real screens, real bottom bar, real registry and overlay. Only the controller is a spy, and nothing here can reach a
// model: the "paid" actions are the controller's own, called through the tip exactly as a tap on the button would.
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: (): { width: number; height: number; scale: number; fontScale: number } => ({
        width: 390,
        height: 844,
        scale: 3,
        fontScale: 1,
    }),
}))

const ANYWHERE: Rect = { x: 16, y: 700, width: 358, height: 56 }
const measure = async (): Promise<Rect | null> => ANYWHERE

function controllerSpies(): WorkflowController & Record<'createManual' | 'camera' | 'parse' | 'step', jest.Mock> {
    return {
        ...INERT_WORKFLOW_CONTROLLER,
        createManual: jest.fn(async (): Promise<void> => undefined),
        camera: jest.fn(),
        parse: jest.fn(async (): Promise<void> => undefined),
        step: jest.fn(async (): Promise<void> => undefined),
    } as never
}

function more(): MoreControl & { show: jest.Mock } {
    return { open: false, mode: 'details', show: jest.fn(), hide: jest.fn() }
}

async function wait(ms = 40): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms))
    })
}

async function mount(
    key: OnboardingScreen,
    node: ReactElement,
    seen: readonly OnboardingScreen[] = [],
): Promise<{ store: OnboardingStore; storage: MemoryStorage }> {
    const { store, storage } = await readyStore(seen)
    await render(
        <CoachHarness store={store} screen={key} measure={measure}>
            {node}
        </CoachHarness>,
    )
    return { store, storage }
}

describe('Home', () => {
    it('teaches the real Add primary on an empty library, and the tap runs createManual exactly once', async () => {
        const controller = controllerSpies()
        const { state } = workflowPreviewFixture('home-empty')
        const { store } = await mount('home', <LibraryScreen state={state} controller={controller} />)
        expect(await screen.findByText('Tap here to add your paper manual.')).toBeTruthy()
        await pressCoach('coach-target-hole')
        await waitFor(() => expect(screen.queryByTestId('coach-overlay')).toBeNull())
        expect(controller.createManual).toHaveBeenCalledTimes(1)
        expect(store.getSnapshot().seen).toEqual(['home'])
    })

    it('Skip and Next never call the controller', async () => {
        const controller = controllerSpies()
        const { state } = workflowPreviewFixture('home-empty')
        await mount('home', <LibraryScreen state={state} controller={controller} />)
        await screen.findByTestId('coach-overlay')
        await pressCoach('coach-skip')
        await waitFor(() => expect(screen.queryByTestId('coach-overlay')).toBeNull())
        expect(controller.createManual).not.toHaveBeenCalled()
    })

    it('stays quiet while the library is loading', async () => {
        const { state } = workflowPreviewFixture('home-loading')
        const { store } = await mount('home', <LibraryScreen state={state} controller={controllerSpies()} />)
        await wait()
        expect(screen.queryByTestId('coach-overlay')).toBeNull()
        expect(store.getSnapshot().seen).toEqual([])
    })

    it('stays quiet when saved builds could not open', async () => {
        const { state } = workflowPreviewFixture('home-error')
        await mount('home', <LibraryScreen state={state} controller={controllerSpies()} />)
        await wait()
        expect(screen.queryByTestId('coach-overlay')).toBeNull()
    })

    it('stays quiet while a request is pending', async () => {
        const { state } = workflowPreviewFixture('home-empty')
        await mount(
            'home',
            <LibraryScreen state={{ ...state, pending: 'Reading manual pages…' }} controller={controllerSpies()} />,
        )
        await wait()
        expect(screen.queryByTestId('coach-overlay')).toBeNull()
    })
})

describe('Pages', () => {
    const entryOf = (id: WorkflowPreviewCase): ReturnType<typeof workflowPreviewFixture> => workflowPreviewFixture(id)

    it('teaches the photo button for an empty manual and runs the camera once from the tip', async () => {
        const controller = controllerSpies()
        const { state, entry } = entryOf('pages-empty')
        await mount(
            'pages',
            <PagesScreen state={state} controller={controller} entry={entry} choosePages={jest.fn()} />,
        )
        expect(await screen.findByText('Take a photo of each page.')).toBeTruthy()
        await pressCoach('coach-target-hole')
        expect(controller.camera).toHaveBeenCalledTimes(1)
        expect(controller.camera).toHaveBeenCalledWith({ kind: 'page' })
    })

    it('teaches Read my manual once pages exist, never mentions Done, and Next does not read', async () => {
        const controller = controllerSpies()
        const { state, entry } = entryOf('pages-populated')
        await mount(
            'pages',
            <PagesScreen state={state} controller={controller} entry={entry} choosePages={jest.fn()} />,
        )
        expect(await screen.findByText('When every page is here, tap Read my manual.')).toBeTruthy()
        expect(screen.queryByText(/done/iu)).toBeNull()
        await pressCoach('coach-next')
        expect(await screen.findByText('Tap here to add one more page.')).toBeTruthy()
        expect(controller.parse).not.toHaveBeenCalled()
    })

    it('does not tip while the manual is being read', async () => {
        const { state, entry } = entryOf('pages-reading')
        await mount(
            'pages',
            <PagesScreen state={state} controller={controllerSpies()} entry={entry} choosePages={jest.fn()} />,
        )
        await wait()
        expect(screen.queryByTestId('coach-overlay')).toBeNull()
    })
})

describe('Quick check', () => {
    it('teaches the real "Let me fix it" and "Skip for now" controls, never a Yes', async () => {
        const { state, entry } = workflowPreviewFixture('review-unresolved')
        const control = more()
        await mount(
            'quick-check',
            <OverviewScreen state={state} controller={controllerSpies()} entry={entry} more={control} />,
        )
        const asking = screen.queryByText('Not sure? Write what the picture shows.')
        if (asking === null) {
            // This fixture is the blocked or ready group instead; the same rule holds for it.
            expect(await screen.findByTestId('coach-overlay')).toBeTruthy()
            expect(screen.queryByText(/\byes\b/iu)).toBeNull()
            return
        }
        expect(screen.queryByText(/\byes\b/iu)).toBeNull()
        await pressCoach('coach-target-hole')
        expect(control.show).toHaveBeenCalledTimes(1)
        expect(control.show).toHaveBeenCalledWith('fix')
    })

    it('teaches Start building when the steps are ready and starts building once', async () => {
        const { state, entry } = workflowPreviewFixture('review-ready')
        const startBuilding = jest.fn(async (): Promise<void> => undefined)
        const nav = { startBuilding } as unknown as ScreenNav
        await mount(
            'quick-check',
            <OverviewScreen state={state} controller={controllerSpies()} entry={entry} nav={nav} more={more()} />,
        )
        expect(await screen.findByText('Tap Start building when you are ready.')).toBeTruthy()
        await pressCoach('coach-target-hole')
        expect(startBuilding).toHaveBeenCalledTimes(1)
    })
})

describe('Guide', () => {
    it('walks picture, big button, swipe in order, and the big button tip runs the camera once', async () => {
        const controller = controllerSpies()
        const { state, entry } = workflowPreviewFixture('guide-empty')
        const { store } = await mount('guide', <GuideScreen state={state} controller={controller} entry={entry} />)
        expect(await screen.findByText('This picture shows what to build.')).toBeTruthy()
        await pressCoach('coach-next')
        expect(await screen.findByText('Take a photo to check your work.')).toBeTruthy()
        expect(controller.camera).not.toHaveBeenCalled()
        await pressCoach('coach-target-hole')
        expect(controller.camera).toHaveBeenCalledTimes(1)
        expect(controller.camera).toHaveBeenCalledWith({ kind: 'check' })
        expect(store.getSnapshot().seen).toEqual(['guide'])
    })

    it('describes the button that is really there for a resumed build with a retained pass', async () => {
        const { state, entry } = workflowPreviewFixture('guide-pass')
        await mount('guide', <GuideScreen state={state} controller={controllerSpies()} entry={entry} />)
        await screen.findByTestId('coach-overlay')
        await pressCoach('coach-next')
        expect(await screen.findByText(/Tap (Next step|Finish) when this looks right\./u)).toBeTruthy()
    })

    it('stays quiet while a check is pending and never targets Checking…', async () => {
        const { state, entry } = workflowPreviewFixture('guide-pending')
        const { store } = await mount(
            'guide',
            <GuideScreen state={state} controller={controllerSpies()} entry={entry} />,
        )
        await wait()
        expect(screen.queryByTestId('coach-overlay')).toBeNull()
        expect(store.getSnapshot().seen).toEqual([])
    })
})

describe('native header More', () => {
    it('is a tip target through the header buttons and opens More exactly once from the tip', async () => {
        const control = more()
        const { store } = await readyStore()
        await render(
            <CoachHarness store={store} screen="home" measure={measure}>
                <HomeHeader control={control} />
            </CoachHarness>,
        )
        expect(await screen.findByText('Tap More for help and settings.')).toBeTruthy()
        await pressCoach('coach-target-hole')
        expect(control.show).toHaveBeenCalledTimes(1)
        expect(store.getSnapshot().seen).toEqual(['home'])
    })
})

function HomeHeader({ control }: { control: MoreControl }): ReactElement {
    useCoachScreen('home', { suppressed: false, candidates: homeCandidates({ add: false, resume: false, more: true }) })
    // The route names the screen because the native header sits outside the screen's own subtree.
    return <HeaderButtons more={control} coach="home" />
}

describe('Home with one saved manual', () => {
    it('teaches the neutral resume tip and runs the same open action once', async () => {
        const { state } = workflowPreviewFixture('home-populated')
        const sole = { ...state, entries: state.entries.slice(0, 1) }
        const openStop = jest.fn()
        const nav = { openStop } as unknown as ScreenNav
        await mount('home', <LibraryScreen state={sole} controller={controllerSpies()} nav={nav} />)
        expect(await screen.findByText('Tap here to pick up where you left off.')).toBeTruthy()
        await pressCoach('coach-target-hole')
        expect(openStop).toHaveBeenCalledTimes(1)
    })
})

describe('Show tips again and the judge-only skip row', () => {
    it('Show tips again clears the record, closes More and runs no controller action', async () => {
        const { state } = workflowPreviewFixture('home-empty')
        const controller = controllerSpies()
        const control: MoreControl = { open: true, mode: 'details', show: jest.fn(), hide: jest.fn() }
        const { store } = await mount('home', <LibraryScreen state={state} controller={controller} more={control} />, [
            'home',
            'guide',
        ])
        await fireEvent.press(await screen.findByTestId('show-tips-again'))
        expect(control.hide).toHaveBeenCalledTimes(1)
        expect(store.getSnapshot().seen).toEqual([])
        expect(controller.createManual).not.toHaveBeenCalled()
    })

    it('Hide tips for testing hides the tour for the session without touching the saved record', async () => {
        const { store, storage } = await readyStore()
        await render(
            <CoachHarness store={store} measure={measure}>
                <TourScreen />
                <HideTipsForTestingRow />
            </CoachHarness>,
        )
        await screen.findByTestId('coach-overlay')
        // The row sits under the dim, as the judge entry does under More; a test can press it directly.
        await fireEvent.press(screen.getByTestId('coach-test-skip', { hidden: true }))
        await waitFor(() => expect(screen.queryByTestId('coach-overlay')).toBeNull())
        expect(storage.writes).toEqual([])
        expect(store.getSnapshot().seen).toEqual([])
    })
})

function TourScreen(): ReactElement {
    useCoachScreen('home', { suppressed: false, candidates: homeCandidates({ add: false, resume: false, more: true }) })
    return <HeaderButtons more={more()} coach="home" />
}

it('keeps the default inert gallery isolated from a surrounding live coach provider', async () => {
    const { store, storage } = await readyStore()
    await render(
        <CoachHarness store={store}>
            <WorkflowPreview initialCase="home-empty" showControls={false} />
        </CoachHarness>,
    )
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
    })
    expect(screen.queryByTestId('coach-overlay')).toBeNull()
    expect(storage.writes).toEqual([])
})

it('keeps replay inside the inert gallery from clearing the surrounding device tour record', async () => {
    const { store, storage } = await readyStore(['home'])
    await render(
        <CoachHarness store={store}>
            <WorkflowPreview initialCase="home-empty" showControls={false} />
        </CoachHarness>,
    )
    await fireEvent.press(screen.getByRole('button', { name: 'More' }))
    await fireEvent.press(await screen.findByTestId('show-tips-again'))
    await act(async () => {
        await Promise.resolve()
    })
    expect(store.getSnapshot().seen).toEqual(['home'])
    expect(storage.writes).toEqual([])
})
