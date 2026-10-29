import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Platform } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { StatusBar } from 'expo-status-bar'
import { Redirect, Stack, useIsFocused, useLocalSearchParams, usePreventRemove } from 'expo-router'
import { MediaRejectedError } from '../../media/media-errors'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { SkeletonCard } from '../../ui/skeleton'
import { Instruction } from '../../ui/text'
import { useTheme } from '../../theme/theme'
import { touchTarget } from '../../theme/tokens'
import { CameraScreen, type AssemblyGuide } from './camera-screen'
import type { WorkflowState } from './controller'
import { DoneScreen } from './done-screen'
import { GuideScreen } from './guide-screen'
import type { LibraryEntry } from './library'
import { LibraryScreen, useHomeTitle } from './library-screen'
import { useWorkflowActions } from './native-routes'
import { CoachRoute } from '../onboarding/coach-root'
import { PagesScreen } from './pages-screen'
import { ReadingScreen } from './reading-screen'
import { OverviewScreen, useQuickProgress } from './review-screen'
import { HeaderButtons, useMoreState } from './screen-header'
import { cameraWordingOf, headerFor } from '../screens/host'
import {
    addTitle,
    checkTitle,
    DONE_TITLE,
    guideTitle,
    headerStyleFor,
    homeHeaderOptions,
    READING_TITLE,
    useCompactTitles,
    type HeaderStyle,
} from './header-options'
import { ScreenBody, TextRegion } from './screen-layout'
import { stopFor, type Stop } from './plain-copy'
import { stepAssemblyGuide } from './step-facts'
import { useWorkflow } from './workflow-provider'
import {
    useCameraSlot,
    useDoneSlot,
    useGuideSlot,
    useHomeSlot,
    useMoreSlot,
    useNextScreenWarmUp,
    usePagesSlot,
    useQuestionsSlot,
    useQuickCheckSlot,
    useReadingSlot,
} from '../screens/slots'
import { readingLanguage } from './reading-language'

export type RouteStatus = 'loading' | 'ready' | 'missing' | 'failed'

export type ManualRoute = {
    readonly status: RouteStatus
    // Where to send the person instead of this screen: Home for a missing build, or the stop the build has really reached.
    readonly redirect: string | null
    readonly retry: () => void
}

/** The screen a manual's URL may show. A build never shows a stop beyond the one it has reached. */
function guardedStop(wanted: Stop, entry: LibraryEntry): Stop {
    if (wanted === 'pages' || wanted === 'overview') {
        return wanted
    }
    const reached = stopFor(entry)
    return reached === 'done' ? wanted : reached
}

function hrefForStop(stop: Stop, manualId: string): string {
    const id = encodeURIComponent(manualId)
    return stop === 'pages'
        ? '/add'
        : stop === 'overview'
          ? `/check/${id}`
          : stop === 'guide'
            ? `/guide/${id}`
            : `/done/${id}`
}

/**
 * Resolves the manual in a route's URL once the library has restored. Only the focused screen asks: a screen buried
 * under another manual's route never reopens its own, and a plain pop back to the manual already selected calls
 * nothing, so its photo, result and draft stay. Coming back to a screen whose manual was replaced by an explicit switch
 * opens that manual once, with its saved step. If that does not stick, the screen offers one Try again.
 */
export function useManualRoute(manualId: string, stop: Stop): ManualRoute {
    const { controller, state, entry } = useWorkflow()
    const focused = useIsFocused()
    const known = state.entries.find((candidate) => candidate.session.manualId === manualId)
    const selected = entry?.session.manualId === manualId
    const [retries, setRetries] = useState(0)
    const [failed, setFailed] = useState<string | null>(null)
    const key = `${manualId}:${retries}`
    const tried = useRef<string | null>(null)
    // True once this screen has seen its manual selected while focused. If the selection then goes (Back to Home clears
    // it before the router has left), the screen is being left, not resumed, so it must not open the manual again.
    const seen = useRef<string | null>(null)
    useEffect(() => {
        if (!focused) {
            tried.current = null
            seen.current = null
            return
        }
        if (selected) {
            tried.current = null
            seen.current = manualId
            return
        }
        if (seen.current === manualId || state.loading || known === undefined || tried.current === key) {
            return
        }
        tried.current = key
        void controller.open(manualId, stop === 'done' ? 'guide' : stop).then(() => {
            if (tried.current === key && controller.getSnapshot().selectedId !== manualId) {
                setFailed(key)
            }
        })
    }, [controller, focused, key, known, manualId, selected, state.loading, stop])
    const retry = useCallback((): void => {
        setFailed(null)
        setRetries((count) => count + 1)
    }, [])
    if (state.loading) {
        return { status: 'loading', redirect: null, retry }
    }
    if (known === undefined) {
        return { status: 'missing', redirect: focused ? '/' : null, retry }
    }
    if (!selected) {
        return { status: failed === key ? 'failed' : 'loading', redirect: null, retry }
    }
    const reached = guardedStop(stop, known)
    return { status: 'ready', redirect: focused && reached !== stop ? hrefForStop(reached, manualId) : null, retry }
}

function Waiting({ route }: { route?: ManualRoute }): ReactElement {
    if (route?.status === 'failed') {
        return (
            <ScreenBody testID="route-failed">
                <TextRegion>
                    <Instruction>We could not open this build.</Instruction>
                </TextRegion>
                <FixedBottomBar
                    primary={{ label: 'Try again', compactLabel: 'Retry', testID: 'retry-route', onPress: route.retry }}
                />
            </ScreenBody>
        )
    }
    return (
        <ScreenBody>
            <SkeletonCard />
        </ScreenBody>
    )
}

/** Colours the native header from the theme. */
export function useHeaderStyle(): HeaderStyle {
    return headerStyleFor(useTheme().colors)
}

export function HomeRoute(): ReactElement {
    const { state } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    const { scrollY, collapsed, onCollapsedChange } = useHomeTitle()
    const { colors } = useTheme()
    const native = Platform.OS === 'ios'
    const common = { state, entry: undefined, controller, nav, more }
    const slot = useHomeSlot({ ...common, native: false })
    const moreSlot = useMoreSlot(common)
    useNextScreenWarmUp('home', state, undefined)
    return (
        <>
            <Stack.Screen options={homeHeaderOptions({ colors, scrollY, more, collapsed })} />
            <CoachRoute screen="home">
                <LibraryScreen
                    state={state}
                    controller={controller}
                    nav={nav}
                    chrome="native"
                    largeTitle={native ? 'heading' : 'content'}
                    more={more}
                    slot={slot}
                    moreSlot={moreSlot}
                    scrollY={scrollY}
                    onCollapsedChange={onCollapsedChange}
                />
            </CoachRoute>
        </>
    )
}

/** Picker for photos already on the phone. Same permission and limits as before; the controller validates the result. */
function useChoosePages(entry: LibraryEntry | undefined): (replaceIndex?: number) => void {
    const { controller: raw } = useWorkflow()
    return (replaceIndex?: number): void => {
        void raw.importPages(async () => {
            const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
            if (!permission.granted) {
                throw new MediaRejectedError('permission')
            }
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsMultipleSelection: replaceIndex === undefined,
                selectionLimit: replaceIndex === undefined ? Math.max(1, 20 - (entry?.session.pages.length ?? 0)) : 1,
                orderedSelection: true,
                exif: false,
                quality: 1,
            })
            return result.canceled ? [] : result.assets
        }, replaceIndex)
    }
}

export function AddRoute(): ReactElement {
    const { state, entry } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    const choosePages = useChoosePages(entry)
    const compact = useCompactTitles()
    const common = {
        state,
        entry,
        controller,
        nav,
        more,
        choosePages: (): void => choosePages(),
        language: entry === undefined ? undefined : readingLanguage(entry.session.manualId),
    }
    const slot = usePagesSlot({ ...common, native: false })
    const moreSlot = useMoreSlot(common)
    useNextScreenWarmUp('pages', state, entry)
    if (!state.loading && entry === undefined) {
        return <Redirect href="/" />
    }
    return (
        <>
            <Stack.Screen
                options={{
                    ...headerFor(slot, addTitle(compact)),
                    headerRight: (): ReactElement => (
                        <HeaderButtons
                            more={more}
                            coach="pages"
                            trailing={slot?.status === 'ready' ? slot.screen.trailing : null}
                        />
                    ),
                }}
            />
            <CoachRoute screen="pages">
                {entry === undefined ? (
                    <Waiting />
                ) : (
                    <PagesScreen
                        key={entry.session.manualId}
                        state={state}
                        controller={controller}
                        entry={entry}
                        choosePages={choosePages}
                        chrome="native"
                        more={more}
                        slot={slot}
                        moreSlot={moreSlot}
                    />
                )}
            </CoachRoute>
        </>
    )
}

export function ReadingRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const route = useManualRoute(manualId, 'pages')
    const { status } = route
    const { state, entry } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const [confirming, setConfirming] = useState(false)
    const reading = state.pending !== null && state.pending.startsWith('Reading')
    const more = useMoreState()
    const slot = useReadingSlot({
        state,
        entry,
        controller,
        nav,
        more,
        native: status !== 'ready',
        language: entry === undefined ? undefined : readingLanguage(entry.session.manualId),
    })
    // Back while a read is running asks first and never traps: stopping reads the same cancel as the Cancel button.
    usePreventRemove(reading, () => setConfirming(true))
    // The prevention lifts on the render after the cancel, so the step back waits for it.
    const readingNav = useMemo(() => ({ ...nav, back: (): void => void setTimeout(nav.back, 0) }), [nav])
    if (route.redirect !== null) {
        return <Redirect href={route.redirect as never} />
    }
    return (
        <>
            <Stack.Screen options={headerFor(slot, READING_TITLE)} />
            <CoachRoute screen={null}>
                {status === 'ready' && entry !== undefined ? (
                    <ReadingScreen
                        state={state}
                        controller={controller}
                        entry={entry}
                        nav={readingNav}
                        confirming={confirming}
                        onConfirmingChange={setConfirming}
                        slot={slot}
                    />
                ) : (
                    <Waiting route={route} />
                )}
            </CoachRoute>
        </>
    )
}

export function CheckRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const route = useManualRoute(manualId, 'overview')
    const { status } = route
    const { state, entry } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    // The question count lives here, above the screen, so accepting a fact (a new revision) never restarts it.
    const progress = useQuickProgress(entry?.session)
    const compact = useCompactTitles()
    const slot = useQuickCheckSlot({
        state,
        entry,
        controller,
        nav,
        more,
        native: status !== 'ready',
        live: { quick: progress },
    })
    if (route.redirect !== null) {
        return <Redirect href={route.redirect as never} />
    }
    return (
        <>
            <Stack.Screen
                options={{
                    // The question count is the app's own; the document names the screen only when no question is on it.
                    ...headerFor(progress.label === undefined ? slot : undefined, checkTitle(progress.label, compact)),
                    headerRight: (): ReactElement => (
                        <HeaderButtons
                            more={more}
                            coach="quick-check"
                            trailing={slot?.status === 'ready' ? slot.screen.trailing : null}
                        />
                    ),
                }}
            />
            <CoachRoute screen="quick-check">
                {status === 'ready' && entry !== undefined ? (
                    <OverviewScreen
                        state={state}
                        controller={controller}
                        entry={entry}
                        nav={nav}
                        chrome="native"
                        more={more}
                        progress={progress}
                        slot={slot}
                    />
                ) : (
                    <Waiting route={route} />
                )}
            </CoachRoute>
        </>
    )
}

export function GuideRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const route = useManualRoute(manualId, 'guide')
    const { status } = route
    const { state, entry } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    const needsQuestions = entry !== undefined && entry.session.reviewStatus !== 'reviewed'
    const common = { state, entry, controller, nav, more }
    const slot = useGuideSlot({
        ...common,
        native: status !== 'ready',
        blocked: needsQuestions,
        coverage: entry !== undefined && controller.coverageNotice() !== null,
    })
    const moreSlot = useMoreSlot(common)
    const questionsSlot = useQuestionsSlot({ ...common, native: status !== 'ready', blocked: needsQuestions })
    useNextScreenWarmUp('guide', state, needsQuestions ? undefined : entry)
    if (route.redirect !== null) {
        return <Redirect href={route.redirect as never} />
    }
    return (
        <>
            <Stack.Screen
                options={{
                    ...headerFor(slot, guideTitle(entry)),
                    // iOS 26 tests the current touch position after its initial movement. One touch target
                    // admits edge Back while excluding a hero swipe once its 24pt threshold is reached.
                    gestureResponseDistance: { end: touchTarget },
                    headerRight: (): ReactElement => (
                        <HeaderButtons
                            more={more}
                            coach="guide"
                            trailing={slot?.status === 'ready' ? slot.screen.trailing : null}
                        />
                    ),
                }}
            />
            <CoachRoute screen="guide">
                {status === 'ready' && entry !== undefined ? (
                    <GuideScreen
                        state={state}
                        controller={controller}
                        entry={entry}
                        nav={nav}
                        chrome="native"
                        more={more}
                        slot={slot}
                        moreSlot={moreSlot}
                        questionsSlot={questionsSlot}
                    />
                ) : (
                    <Waiting route={route} />
                )}
            </CoachRoute>
        </>
    )
}

export function DoneRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const route = useManualRoute(manualId, 'done')
    const { status } = route
    const { state, entry } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    const slot = useDoneSlot({ state, entry, controller, nav, more, native: status !== 'ready' })
    const moreSlot = useMoreSlot({ state, entry, controller, nav, more })
    // A Done URL shows Done only for a build whose every step is marked; otherwise it goes to the stop the build is at.
    if (route.redirect !== null) {
        return <Redirect href={route.redirect as never} />
    }
    return (
        <>
            <Stack.Screen
                options={{
                    ...headerFor(slot, DONE_TITLE),
                    headerBackVisible: false,
                    gestureEnabled: false,
                    headerRight: (): ReactElement => (
                        <HeaderButtons more={more} trailing={slot?.status === 'ready' ? slot.screen.trailing : null} />
                    ),
                }}
            />
            <CoachRoute screen={null}>
                {status === 'ready' && entry !== undefined ? (
                    <DoneScreen
                        state={state}
                        controller={controller}
                        entry={entry}
                        nav={nav}
                        chrome="native"
                        more={more}
                        slot={slot}
                        moreSlot={moreSlot}
                    />
                ) : (
                    <Waiting route={route} />
                )}
            </CoachRoute>
        </>
    )
}

/** The guide shown over the assembly camera. Manual scanning has no step guide. */
function assemblyGuide(entry: LibraryEntry | undefined, state: WorkflowState): AssemblyGuide | undefined {
    if (entry === undefined || state.cameraIntent === null || state.cameraIntent.kind === 'page') {
        return undefined
    }
    return stepAssemblyGuide(entry.session, entry.stepIndex, state.pageUris)
}

export function CameraRoute(): ReactElement {
    const { controller, state, entry } = useWorkflow()
    const { nav } = useWorkflowActions()
    const more = useMoreState()
    const entered = useRef(state.route === 'camera')
    // The step's guide is already composed for the Guide; the camera reads its camera wording and nothing else.
    const wording = cameraWordingOf(
        useCameraSlot({
            state,
            entry,
            controller,
            nav,
            more,
            blocked:
                entry !== undefined &&
                (entry.session.reviewStatus !== 'reviewed' || controller.coverageNotice() !== null),
        }),
    )
    // Back, the hardware button and the close control all mean "cancel the photo" and use the existing cancel. The
    // screen closes once the controller leaves the camera route, so a save in progress is never abandoned.
    usePreventRemove(state.route === 'camera', () => controller.cancel())
    if (!entered.current) {
        return <Redirect href="/" />
    }
    return (
        <>
            <StatusBar style="light" />
            <CoachRoute screen="camera">
                <CameraScreen
                    busy={state.pending !== null}
                    intent={state.cameraIntent}
                    guide={assemblyGuide(entry, state)}
                    wording={wording}
                    onCancel={controller.cancel}
                    onCapture={(take): void => {
                        void controller.shutter(take)
                    }}
                />
            </CoachRoute>
        </>
    )
}
