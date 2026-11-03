import { manualOpeningTitleV2, type ScreenKindV2 } from '@truebuild/contracts'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import * as ImagePicker from 'expo-image-picker'
import { Redirect, Stack, useIsFocused, useLocalSearchParams, usePreventRemove } from 'expo-router'
import { MediaRejectedError } from '../../media/media-errors'
import { useTheme } from '../../theme/theme'
import { touchTarget } from '../../theme/tokens'
import { DocumentCamera } from '../documents/document-camera'
import { DocumentSurface } from './document-surface'
import type { LibraryEntry } from './library'
import { CoachRoute } from '../onboarding/coach-root'
import { useQuickProgress } from '../screens/quick-progress'
import { headerStyleFor, type HeaderStyle } from './header-options'
import { isProblemNotice, stopFor, type Stop } from './plain-copy'
import { useWorkflow } from './workflow-provider'

export type RouteStatus = 'loading' | 'ready' | 'missing' | 'failed'

export function useHeaderStyle(): HeaderStyle {
    const { colors } = useTheme()
    return headerStyleFor(colors)
}

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

/**
 * Loading, failure and recovery route states are complete fallback documents through the same renderer as every
 * other route — never a native branch beside a document. The native Stack header above stays the one header.
 */
function Waiting({
    route,
    kind,
    manualId,
}: {
    route?: ManualRoute
    kind: ScreenKindV2
    manualId: string
}): ReactElement {
    const { state } = useWorkflow()
    const session = state.entries.find((candidate) => candidate.session.manualId === manualId)?.session
    const manualTitle = session === undefined ? undefined : manualOpeningTitleV2(session)
    return (
        <DocumentSurface
            kind={route?.status === 'failed' ? 'error' : kind}
            routeWait={route?.status === 'failed' ? undefined : { kind, manualTitle }}
            state={route?.status === 'failed' ? 'error' : 'pending'}
            retry={route?.retry}
            primaryTestId={route?.status === 'failed' ? 'retry-route' : undefined}
            operationNotice={route?.status === 'failed' ? 'We could not open this build.' : undefined}
        />
    )
}

export function HomeRoute(): ReactElement {
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <CoachRoute screen="home">
                <DocumentSurface kind="home" />
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
    const choosePages = useChoosePages(entry)
    const importFailed = state.pending === null && state.notice !== null && isProblemNotice(state.notice)
    if (!state.loading && entry === undefined) return <Redirect href="/" />
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <CoachRoute screen="pages">
                <DocumentSurface
                    kind={importFailed ? 'error' : entry?.session.pages.length === 0 ? 'add' : 'pages'}
                    choosePages={(): void => choosePages()}
                    retry={importFailed && !state.storageReadOnly ? (): void => choosePages() : undefined}
                />
            </CoachRoute>
        </>
    )
}

export function ReadingRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const route = useManualRoute(manualId, 'pages')
    const { state } = useWorkflow()
    const [confirming, setConfirming] = useState(false)
    // Native Back and document navigation use the same cancellation; an in-flight result can never reopen this route.
    usePreventRemove(state.pending?.startsWith('Reading') === true, (): void => setConfirming(true))
    if (route.redirect !== null) return <Redirect href={route.redirect as never} />
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <CoachRoute screen={null}>
                {route.status === 'ready' ? (
                    <DocumentSurface
                        kind="reading"
                        state={
                            state.pending === null && state.notice !== null && isProblemNotice(state.notice)
                                ? 'error'
                                : undefined
                        }
                        readingConfirmation={{ open: confirming, onChange: setConfirming }}
                    />
                ) : (
                    <Waiting route={route} kind="reading" manualId={manualId} />
                )}
            </CoachRoute>
        </>
    )
}

export function CheckRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const route = useManualRoute(manualId, 'overview')
    const { entry } = useWorkflow()
    const progress = useQuickProgress(entry?.session)
    if (route.redirect !== null) return <Redirect href={route.redirect as never} />
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <CoachRoute screen="quick-check">
                {route.status === 'ready' ? (
                    <DocumentSurface kind="quick-check" quick={progress} />
                ) : (
                    <Waiting route={route} kind="quick-check" manualId={manualId} />
                )}
            </CoachRoute>
        </>
    )
}

export function GuideRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const route = useManualRoute(manualId, 'guide')
    if (route.redirect !== null) return <Redirect href={route.redirect as never} />
    return (
        <>
            <Stack.Screen options={{ headerShown: false, gestureResponseDistance: { end: touchTarget } }} />
            <CoachRoute screen="guide">
                {route.status === 'ready' ? (
                    <DocumentSurface kind="guide" />
                ) : (
                    <Waiting route={route} kind="guide" manualId={manualId} />
                )}
            </CoachRoute>
        </>
    )
}

export function DoneRoute(): ReactElement {
    const { manualId } = useLocalSearchParams<{ manualId: string }>()
    const route = useManualRoute(manualId, 'done')
    if (route.redirect !== null) return <Redirect href={route.redirect as never} />
    return (
        <>
            <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
            <CoachRoute screen={null}>
                {route.status === 'ready' ? (
                    <DocumentSurface kind="completion" />
                ) : (
                    <Waiting route={route} kind="completion" manualId={manualId} />
                )}
            </CoachRoute>
        </>
    )
}

export function CameraRoute(): ReactElement {
    const { controller, state, entry } = useWorkflow()
    const choosePages = useChoosePages(entry)
    const entered = useRef(state.route === 'camera')
    usePreventRemove(state.route === 'camera', controller.cancel)
    if (!entered.current) return <Redirect href="/" />
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <CoachRoute screen="camera">
                <DocumentCamera
                    choosePages={
                        state.cameraIntent?.kind === 'page'
                            ? (): void => {
                                  const index =
                                      state.cameraIntent?.kind === 'page' ? state.cameraIntent.replaceIndex : undefined
                                  controller.cancel()
                                  choosePages(index)
                              }
                            : undefined
                    }
                />
            </CoachRoute>
        </>
    )
}
