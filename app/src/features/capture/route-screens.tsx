import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Platform } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { Redirect, Stack, useLocalSearchParams, usePreventRemove } from 'expo-router'
import { useSharedValue } from 'react-native-reanimated'
import { MediaRejectedError } from '../../media/media-errors'
import { SkeletonCard } from '../../ui/skeleton'
import { useTheme } from '../../theme/theme'
import { CameraScreen, type AssemblyGuide } from './camera-screen'
import type { WorkflowState } from './controller'
import { DoneScreen } from './done-screen'
import { GuideScreen } from './guide-screen'
import type { LibraryEntry } from './library'
import { LibraryScreen, PinnedTitle } from './library-screen'
import { useWorkflowActions } from './native-routes'
import { PagesScreen } from './pages-screen'
import { ReadingScreen } from './reading-screen'
import { OverviewScreen } from './review-screen'
import { HeaderButtons, HeaderTitle, useMoreState } from './screen-header'
import { ScreenBody } from './screen-layout'
import { stepAssemblyGuide } from './step-facts'
import { useWorkflow } from './workflow-provider'

type Stop = 'pages' | 'overview' | 'guide' | 'done'

/**
 * Entering a manual's URL directly (a reload on web, a deep link) loads that manual once the library has restored.
 * Navigating inside the app never reopens it: the manual is already selected, so nothing is cleared.
 */
export function useManualRoute(manualId: string, stop: Stop): 'loading' | 'ready' | 'missing' {
    const { controller, state, entry } = useWorkflow()
    const attempted = useRef(false)
    const known = state.entries.some((candidate) => candidate.session.manualId === manualId)
    useEffect(() => {
        if (state.loading || attempted.current) {
            return
        }
        attempted.current = true
        if (known && state.selectedId !== manualId) {
            void controller.open(manualId, stop === 'done' ? 'guide' : stop)
        }
    }, [controller, known, manualId, state.loading, state.selectedId, stop])
    if (state.loading) {
        return 'loading'
    }
    if (!known) {
        return 'missing'
    }
    return entry?.session.manualId === manualId ? 'ready' : 'loading'
}

function Waiting(): ReactElement {
    return (
        <ScreenBody>
            <SkeletonCard />
        </ScreenBody>
    )
}

/** Colours the native header from the theme, so light and dark both read as one surface with the canvas. */
export function useHeaderStyle(): {
    headerStyle: { backgroundColor: string }
    headerTintColor: string
    headerShadowVisible: false
    contentStyle: { backgroundColor: string }
} {
    const { colors } = useTheme()
    return {
        headerStyle: { backgroundColor: colors.canvas },
        headerTintColor: colors.accentInk,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.canvas },
    }
}

export function HomeRoute(): ReactElement {
    const { state } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    const scrollY = useSharedValue(0)
    const { colors } = useTheme()
    // iOS draws the real large title and collapses it natively; Android and web collapse the same title with Reanimated.
    const native = Platform.OS === 'ios'
    return (
        <>
            <Stack.Screen
                options={{
                    title: 'TrueBuild',
                    headerLargeTitleEnabled: native,
                    headerLargeTitleShadowVisible: false,
                    headerLargeStyle: { backgroundColor: colors.canvas },
                    headerTitle: native
                        ? undefined
                        : (): ReactElement => <PinnedTitle scrollY={scrollY} title="TrueBuild" />,
                    headerRight: (): ReactElement => <HeaderButtons more={more} />,
                }}
            />
            <LibraryScreen
                state={state}
                controller={controller}
                nav={nav}
                chrome="native"
                largeTitle={native ? 'native' : 'content'}
                more={more}
                scrollY={scrollY}
            />
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
    const { controller } = useWorkflowActions()
    const more = useMoreState()
    const choosePages = useChoosePages(entry)
    const pages = entry?.session.pages.length ?? 0
    if (!state.loading && entry === undefined) {
        return <Redirect href="/" />
    }
    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: (): ReactElement => (
                        <HeaderTitle
                            title="Add manual"
                            subtitle={pages === 0 ? undefined : `Page ${pages} of up to 20`}
                        />
                    ),
                    headerRight: (): ReactElement => <HeaderButtons more={more} />,
                }}
            />
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
                />
            )}
        </>
    )
}

export function ReadingRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const status = useManualRoute(manualId, 'pages')
    const { state, entry } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const [confirming, setConfirming] = useState(false)
    const reading = state.pending !== null && state.pending.startsWith('Reading')
    // Back while a read is running asks first and never traps: stopping reads the same cancel as the Cancel button.
    usePreventRemove(reading, () => setConfirming(true))
    // The prevention lifts on the render after the cancel, so the step back waits for it.
    const readingNav = useMemo(() => ({ ...nav, back: (): void => void setTimeout(nav.back, 0) }), [nav])
    if (status === 'missing') {
        return <Redirect href="/" />
    }
    return (
        <>
            <Stack.Screen
                options={{ headerTitle: (): ReactElement => <HeaderTitle title={entry?.session.title ?? 'Reading'} /> }}
            />
            {status === 'ready' && entry !== undefined ? (
                <ReadingScreen
                    state={state}
                    controller={controller}
                    entry={entry}
                    nav={readingNav}
                    confirming={confirming}
                    onConfirmingChange={setConfirming}
                />
            ) : (
                <Waiting />
            )}
        </>
    )
}

export function CheckRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const status = useManualRoute(manualId, 'overview')
    const { state, entry } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    if (status === 'missing') {
        return <Redirect href="/" />
    }
    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: (): ReactElement => <HeaderTitle title="Quick check" />,
                    headerRight: (): ReactElement => <HeaderButtons more={more} />,
                }}
            />
            {status === 'ready' && entry !== undefined ? (
                <OverviewScreen
                    key={`${entry.session.manualId}-${entry.session.revision}`}
                    state={state}
                    controller={controller}
                    entry={entry}
                    nav={nav}
                    chrome="native"
                    more={more}
                />
            ) : (
                <Waiting />
            )}
        </>
    )
}

export function GuideRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const status = useManualRoute(manualId, 'guide')
    const { state, entry } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    if (status === 'missing') {
        return <Redirect href="/" />
    }
    const title = entry?.session.title ?? 'Guide'
    const subtitle =
        entry === undefined ? undefined : `Step ${entry.stepIndex + 1} of ${entry.session.reviewedSteps.length}`
    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: (): ReactElement => <HeaderTitle title={title} subtitle={subtitle} />,
                    headerRight: (): ReactElement => <HeaderButtons more={more} />,
                }}
            />
            {status === 'ready' && entry !== undefined ? (
                <GuideScreen
                    state={state}
                    controller={controller}
                    entry={entry}
                    nav={nav}
                    chrome="native"
                    more={more}
                />
            ) : (
                <Waiting />
            )}
        </>
    )
}

export function DoneRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const status = useManualRoute(manualId, 'done')
    const { state, entry } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    if (status === 'missing') {
        return <Redirect href="/" />
    }
    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: (): ReactElement => <HeaderTitle title="Done" />,
                    headerBackVisible: false,
                    gestureEnabled: false,
                    headerRight: (): ReactElement => <HeaderButtons more={more} />,
                }}
            />
            {status === 'ready' && entry !== undefined ? (
                <DoneScreen state={state} controller={controller} entry={entry} nav={nav} chrome="native" more={more} />
            ) : (
                <Waiting />
            )}
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
    const entered = useRef(state.route === 'camera')
    // Back, the hardware button and the close control all mean "cancel the photo" and use the existing cancel. The
    // screen closes once the controller leaves the camera route, so a save in progress is never abandoned.
    usePreventRemove(state.route === 'camera', () => controller.cancel())
    if (!entered.current) {
        return <Redirect href="/" />
    }
    return (
        <CameraScreen
            busy={state.pending !== null}
            intent={state.cameraIntent}
            guide={assemblyGuide(entry, state)}
            onCancel={controller.cancel}
            onCapture={(take): void => {
                void controller.shutter(take)
            }}
        />
    )
}
