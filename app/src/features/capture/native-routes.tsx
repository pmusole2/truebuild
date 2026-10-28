import { useEffect, useMemo, useRef } from 'react'
import { router, usePathname } from 'expo-router'
import type { CameraIntent, ScreenRoute, WorkflowState } from './controller'
import type { LibraryEntry } from './library'
import { allStepsMarked, stopFor } from './plain-copy'
import type { ScreenNav } from './screen-nav'
import { useWorkflow } from './workflow-provider'
import type { WorkflowController } from './workflow-types'

/** Everything about the controller that decides which native screen is on top. */
export type RouteFacts = {
    readonly route: ScreenRoute
    readonly selectedId: string | null
    // True while the manual pages are being read; that is the Reading screen.
    readonly reading: boolean
}

export type Surface = 'home' | 'add' | 'reading' | 'check' | 'guide' | 'camera' | 'done'

export function factsOf(state: Pick<WorkflowState, 'route' | 'selectedId' | 'pending'>): RouteFacts {
    return {
        route: state.route,
        selectedId: state.selectedId,
        reading: state.route === 'pages' && state.pending !== null && state.pending.startsWith('Reading'),
    }
}

/** The URL that shows a controller position, or null when that position has no screen (a manual-less route). */
export function destinationFor(facts: RouteFacts): string | null {
    if (facts.route === 'library') {
        return '/'
    }
    if (facts.route === 'camera') {
        return '/camera'
    }
    if (facts.selectedId === null) {
        return null
    }
    const id = encodeURIComponent(facts.selectedId)
    switch (facts.route) {
        case 'pages':
            return facts.reading ? `/reading/${id}` : '/add'
        case 'overview':
            return `/check/${id}`
        case 'guide':
            return `/guide/${id}`
    }
}

export function surfaceOf(pathname: string): Surface {
    if (pathname === '/' || pathname === '') return 'home'
    if (pathname === '/add') return 'add'
    if (pathname === '/camera') return 'camera'
    if (pathname.startsWith('/reading/')) return 'reading'
    if (pathname.startsWith('/check/')) return 'check'
    if (pathname.startsWith('/guide/')) return 'guide'
    if (pathname.startsWith('/done/')) return 'done'
    return 'home'
}

export type NavAction = 'push' | 'replace' | 'dismissTo'
export type NavCommand = { readonly action: 'none' } | { readonly action: NavAction; readonly href: string }
const NONE: NavCommand = { action: 'none' }

/**
 * What the router must do after the controller moved from `previous` to `next`, given the URL now on screen.
 * Only a change drives navigation, and a destination that is already showing never navigates, so a native Back that
 * leaves the controller's route unchanged cannot loop or push a duplicate.
 */
export function reconcile(previous: RouteFacts, next: RouteFacts, pathname: string): NavCommand {
    if (previous.route === next.route && previous.selectedId === next.selectedId && previous.reading === next.reading) {
        return NONE
    }
    const href = destinationFor(next)
    if (href === null || href === pathname) {
        return NONE
    }
    const current = surfaceOf(pathname)
    const target = surfaceOf(href)
    // Reading owns its own failure and retry; Done is the end of the line.
    if (current === 'done' || (current === 'reading' && target === 'add')) {
        return NONE
    }
    if (target === 'camera') {
        return { action: 'push', href }
    }
    if (current === 'camera' || target === 'home') {
        return { action: 'dismissTo', href }
    }
    if (current === 'reading' || (current === 'check' && target === 'guide') || current === target) {
        return { action: 'replace', href }
    }
    return { action: 'push', href }
}

// Hrefs the app itself just asked the router for. The controller publishes the matching state a moment later; the sync
// below sees the URL (or this record) and does not navigate a second time.
const issued = { href: null as string | null }

function apply(command: NavCommand): void {
    if (command.action === 'none') {
        return
    }
    issued.href = command.href
    const target = command.href as never
    if (command.action === 'push') {
        router.push(target)
    } else if (command.action === 'replace') {
        router.replace(target)
    } else {
        router.dismissTo(target)
    }
}

/**
 * Drives the router from controller changes that happen without a tap (a read finishing, a photo being accepted). It
 * mounts once beside the Stack. User taps navigate through `useWorkflowActions`, which records the same href.
 */
export function NativeRouteSync(): null {
    const { state } = useWorkflow()
    const pathname = usePathname()
    const facts = factsOf(state)
    const previous = useRef(facts)
    const latestPath = useRef(pathname)
    latestPath.current = pathname
    useEffect(() => {
        if (issued.href === pathname) {
            issued.href = null
        }
    }, [pathname])
    useEffect(() => {
        const before = previous.current
        previous.current = facts
        const command = reconcile(before, facts, latestPath.current)
        if (command.action !== 'none' && command.href === issued.href) {
            return
        }
        apply(command)
    }, [facts.route, facts.selectedId, facts.reading])
    return null
}

/** Navigate to a screen the person asked for, unless it is showing or was just requested. */
function go(href: string, action: NavAction, pathname: string): void {
    if (href === pathname || href === issued.href) {
        return
    }
    apply({ action, href })
}

/**
 * The controller as the screens see it, plus native navigation for the taps that need it. Each method calls the same
 * controller operation the old single screen did and then asks the router for the matching screen. Nothing here calls
 * `home`, `navigate` or `open` just to mirror the router, so going Back never clears a photo, a result or a draft.
 */
export function useWorkflowActions(): { controller: WorkflowController; nav: ScreenNav } {
    const { controller } = useWorkflow()
    const pathname = usePathname()
    const path = useRef(pathname)
    path.current = pathname
    return useMemo(() => {
        const here = (): string => path.current
        const hrefs = (route: ScreenRoute, id: string | null): string | null =>
            destinationFor({ route, selectedId: id, reading: false })
        const wrapped: WorkflowController = {
            acceptStepFacts: (binding, stepId, resolution) => controller.acceptStepFacts(binding, stepId, resolution),
            ask: () => controller.ask(),
            camera: (intent: CameraIntent) => controller.camera(intent),
            get canCompose() {
                return controller.canCompose
            },
            cancel: controller.cancel,
            completeStep: () => controller.completeStep(),
            confirm: () => controller.confirm(),
            coverageNotice: () => controller.coverageNotice(),
            createManual: async () => {
                const before = controller.getSnapshot().selectedId
                await controller.createManual()
                const after = controller.getSnapshot()
                if (after.selectedId !== null && after.selectedId !== before) {
                    go('/add', 'push', here())
                }
            },
            editPage: (index, action) => controller.editPage(index, action),
            home: () => {
                controller.home()
                go('/', 'dismissTo', here())
            },
            navigate: (route) => {
                controller.navigate(route)
                const href = hrefs(route, controller.getSnapshot().selectedId)
                if (href !== null) {
                    go(
                        href,
                        route === 'guide' && surfaceOf(here()) === 'check'
                            ? 'replace'
                            : route === 'pages'
                              ? 'dismissTo'
                              : 'push',
                        here(),
                    )
                }
            },
            open: async (manualId, route = 'overview') => {
                const snapshot = controller.getSnapshot()
                // The manual is already loaded: resume it where it is instead of clearing its photo and result.
                const resume = snapshot.selectedId === manualId && snapshot.route !== 'library'
                const pending = resume
                    ? snapshot.route === route
                        ? Promise.resolve()
                        : (controller.navigate(route), Promise.resolve())
                    : controller.open(manualId, route)
                const href = hrefs(route, manualId)
                if (href !== null) {
                    go(href, 'push', here())
                }
                await pending
            },
            parse: async (language) => {
                const pending = controller.parse(language)
                const { pending: now, selectedId } = controller.getSnapshot()
                if (now !== null && now.startsWith('Reading') && selectedId !== null) {
                    go(`/reading/${encodeURIComponent(selectedId)}`, 'push', here())
                }
                await pending
            },
            questionChanged: controller.questionChanged,
            rename: (title) => controller.rename(title),
            restore: () => controller.restore(),
            step: (index) => controller.step(index),
            targetChanged: controller.targetChanged,
        }
        const nav: ScreenNav = {
            openStop: (entry: LibraryEntry): void => {
                const stop = stopFor(entry)
                const id = entry.session.manualId
                if (stop === 'done') {
                    void wrapped.open(id, 'guide').then(() => go(`/done/${encodeURIComponent(id)}`, 'push', here()))
                    return
                }
                void wrapped.open(id, stop)
            },
            startBuilding: async (): Promise<void> => {
                const entry = controller.current
                if (entry === undefined) {
                    return
                }
                if (entry.session.reviewStatus !== 'reviewed') {
                    await controller.confirm()
                }
                if (controller.current?.session.reviewStatus === 'reviewed') {
                    wrapped.navigate('guide')
                }
            },
            finish: async (): Promise<void> => {
                await controller.completeStep()
                const entry = controller.current
                if (entry !== undefined && allStepsMarked(entry)) {
                    go(`/done/${encodeURIComponent(entry.session.manualId)}`, 'replace', here())
                }
            },
            allBuilds: (): void => go('/', 'dismissTo', here()),
            editPages: (): void => wrapped.navigate('pages'),
            leave: (): void => wrapped.home(),
            back: (): void => {
                if (router.canGoBack()) {
                    router.back()
                } else {
                    go('/', 'replace', here())
                }
            },
        }
        return { controller: wrapped, nav }
    }, [controller])
}
