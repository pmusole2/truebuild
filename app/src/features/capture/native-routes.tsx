import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { router, usePathname } from 'expo-router'
import { Camera } from 'expo-camera'
import type { ScreenContextInputsV2 } from '@truebuild/contracts'
import type { CameraIntent, CaptureController, ScreenRoute, WorkflowState } from './controller'
import type { LibraryEntry } from './library'
import { allStepsMarked, stopFor } from './plain-copy'
import type { ScreenNav } from './screen-nav'
import { useWorkflow } from './workflow-provider'
import type { WorkflowController } from './workflow-types'
import { documentInputs } from './document-inputs'
import { DOCUMENT_COLLECTION_DEADLINE_MS, documentKey, type DocumentStore } from '../document-runtime/store'
import { editableQuestions } from './quick-check-model'
import type { QuickProgress } from '../screens/quick-progress'
import { compareOpeningEntries, comparePaneInputs, type CompareNavigation } from '../screens/compare-flow'
import { API_BASE_URL } from '../../config'
import { nativeProofConfig } from '../ai-effort-proof/config'

type PreparedKind = 'guide' | 'quick-check' | 'completion' | 'camera' | 'compare'
export type CameraPreparationState = {
    readonly permission: 'undetermined' | 'granted' | 'denied'
    readonly canAskAgain: boolean | null
    readonly failed: false
}
const cameraAccess = new WeakMap<
    CaptureController,
    { readonly intent: CameraIntent; readonly access: CameraPreparationState }
>()
export function fixtureCameraEnabled(): boolean {
    return (__DEV__ || process.env.EXPO_PUBLIC_RELEASE_FIXTURE === '1') && nativeProofConfig(API_BASE_URL) !== null
}
export function observedCameraAccess(
    permission: { readonly granted: boolean; readonly canAskAgain: boolean } | null,
): CameraPreparationState {
    return {
        permission: permission === null ? 'undetermined' : permission.granted ? 'granted' : 'denied',
        canAskAgain: permission?.canAskAgain ?? null,
        failed: false,
    }
}
export function cameraPreparationState(controller: CaptureController): CameraPreparationState | null {
    if (fixtureCameraEnabled()) return { permission: 'granted', canAskAgain: null, failed: false }
    const current = controller.getSnapshot()
    const prepared = cameraAccess.get(controller)
    return current.route === 'camera' && prepared?.intent === current.cameraIntent ? (prepared?.access ?? null) : null
}
function remainingPreparationMs(deadline: number): number {
    return Math.max(0, Math.min(DOCUMENT_COLLECTION_DEADLINE_MS, Math.ceil(deadline - performance.now())))
}
async function queryCameraAccess(signal: AbortSignal, deadline: number): Promise<CameraPreparationState | null> {
    if (signal.aborted) return null
    if (fixtureCameraEnabled()) return { permission: 'granted', canAskAgain: null, failed: false }
    return new Promise((resolve) => {
        let stopped = false
        const finish = (access: CameraPreparationState | null): void => {
            if (stopped) return
            stopped = true
            clearTimeout(timer)
            signal.removeEventListener('abort', aborted)
            resolve(access)
        }
        const aborted = (): void => finish(null)
        const timer = setTimeout((): void => finish(observedCameraAccess(null)), remainingPreparationMs(deadline))
        signal.addEventListener('abort', aborted, { once: true })
        void Promise.resolve()
            .then(() => Camera.getCameraPermissionsAsync())
            .then(
                (permission): void => finish(observedCameraAccess(permission)),
                (): void => finish(observedCameraAccess(null)),
            )
    })
}
type NavigationPreparation = {
    readonly sourcePath: string
    readonly source: () => string
    // Null for Compare, which belongs to no one manual.
    readonly manualId: string | null
    readonly kind: PreparedKind
    readonly targetPath: string
    readonly deadline: number
    readonly abort: AbortController
}

/** One preparation owner per workflow, shared by automatic routing and every mounted document action. */
class NavigationPreparations {
    private current: NavigationPreparation | null = null
    private readonly listeners = new Set<() => void>()
    getSnapshot = (): NavigationPreparation | null => this.current
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return (): void => {
            this.listeners.delete(listener)
        }
    }
    private publish(): void {
        for (const listener of this.listeners) listener()
    }
    begin(source: () => string, manualId: string | null, kind: PreparedKind): NavigationPreparation | null {
        if (this.current !== null) return null
        this.current = {
            sourcePath: source(),
            source,
            manualId,
            kind,
            targetPath:
                kind === 'camera'
                    ? '/camera'
                    : kind === 'compare'
                      ? '/compare'
                      : `/${kind === 'completion' ? 'done' : kind === 'quick-check' ? 'check' : 'guide'}/${encodeURIComponent(manualId ?? '')}`,
            deadline: performance.now() + DOCUMENT_COLLECTION_DEADLINE_MS,
            abort: new AbortController(),
        }
        this.publish()
        return this.current
    }
    active(preparation: NavigationPreparation): boolean {
        return (
            this.current === preparation &&
            !preparation.abort.signal.aborted &&
            preparation.source() === preparation.sourcePath
        )
    }
    cancel = (): void => {
        const previous = this.current
        this.current = null
        previous?.abort.abort()
        if (previous !== null) this.publish()
    }
}
const preparations = new WeakMap<CaptureController, NavigationPreparations>()
function preparationsFor(controller: CaptureController): NavigationPreparations {
    let owner = preparations.get(controller)
    if (owner === undefined) {
        owner = new NavigationPreparations()
        preparations.set(controller, owner)
    }
    return owner
}

export function useNavigationPreparation(): NavigationPreparation | null {
    const { controller } = useWorkflow()
    const owner = preparationsFor(controller)
    return useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot)
}

/** The first cursor of a newly entered Quick check, using the same real questions and ordering as useQuickProgress. */
function firstQuickProgress(entry: LibraryEntry): QuickProgress {
    const questions = editableQuestions(entry.session)
    const current = questions[0]
    return {
        questions,
        current,
        position: current === undefined ? 0 : 1,
        total: questions.length,
        skipped: [],
        skip: (): void => {},
        unskip: (): void => {},
        label:
            current !== undefined && current.step.sourceRefs.length > 0
                ? `Question 1 of ${questions.length}`
                : undefined,
    }
}
function targetInputs(controller: CaptureController, kind: PreparedKind): ScreenContextInputsV2 | null {
    const state = controller.getSnapshot()
    const entry = state.entries.find((candidate) => candidate.session.manualId === state.selectedId)
    if (entry === undefined) return null
    const inputs = documentInputs(
        kind,
        { state, entry },
        kind === 'quick-check' ? firstQuickProgress(entry) : undefined,
    )
    if (kind === 'camera' && inputs.uiState?.camera != null)
        inputs.uiState.camera = {
            ...inputs.uiState.camera,
            ...(cameraPreparationState(controller) ?? observedCameraAccess(null)),
        }
    return inputs
}
/**
 * Whether arriving at `kind` holds the source screen until its complete document is collected. Quick check never holds:
 * its shell mounts at once and the focused screen requests (or reuses the prefetched) document in the background.
 */
function prepares(documents: DocumentStore | null | undefined, kind: PreparedKind): documents is DocumentStore {
    return (
        documents !== null &&
        documents !== undefined &&
        kind !== 'quick-check' &&
        (documents.mode === 'full' || (documents.mode === 'steps' && kind === 'guide'))
    )
}
async function awaitTarget(
    controller: CaptureController,
    documents: DocumentStore,
    owner: NavigationPreparations,
    preparation: NavigationPreparation,
    kind: PreparedKind,
): Promise<boolean> {
    if (!owner.active(preparation)) return false
    const inputs = targetInputs(controller, kind)
    if (inputs === null || inputs.session?.manualId !== preparation.manualId) {
        owner.cancel()
        return false
    }
    const key = documentKey(inputs)
    // Confirmation can publish current facts before the provider's observation effect runs. Bind that exact snapshot.
    if (inputs.session !== null) documents.observeSession(inputs.session)
    const stop = controller.subscribe((): void => {
        const next = targetInputs(controller, kind)
        if (
            owner.active(preparation) &&
            (next === null ||
                documentKey(next) !== key ||
                (kind === 'camera' && controller.getSnapshot().route !== 'camera'))
        )
            owner.cancel()
    })
    try {
        // Null is a genuine failure/disabled/deadline outcome: navigation may then show its truthful fallback.
        const timeoutMs = remainingPreparationMs(preparation.deadline)
        if (timeoutMs > 0) await documents.waitForGenerated(inputs, { signal: preparation.abort.signal, timeoutMs })
        return owner.active(preparation)
    } finally {
        stop()
    }
}

/**
 * Everything Compare draws on arrival: its own screen, then each pane it opens with, from the screen's own selection
 * and inputs.
 */
function compareTargets(controller: CaptureController): ScreenContextInputsV2[] {
    const state = controller.getSnapshot()
    const entry = state.entries.find((candidate) => candidate.session.manualId === state.selectedId)
    return [
        documentInputs('compare', { state, entry }),
        ...compareOpeningEntries(state.entries).map((opening) => comparePaneInputs(opening.session)),
    ]
}
/**
 * Holds the source screen until Compare and both opening panes are all complete, so the route never draws one pending.
 * They are awaited together under the one deadline; any change to what Compare would show cancels the wait.
 */
async function awaitCompare(
    controller: CaptureController,
    documents: DocumentStore,
    owner: NavigationPreparations,
    preparation: NavigationPreparation,
): Promise<boolean> {
    if (!owner.active(preparation)) return false
    const targets = compareTargets(controller)
    const bound = targets.map(documentKey).join('|')
    for (const inputs of targets) if (inputs.session !== null) documents.observeSession(inputs.session)
    const stop = controller.subscribe((): void => {
        if (owner.active(preparation) && compareTargets(controller).map(documentKey).join('|') !== bound) owner.cancel()
    })
    try {
        // Null is a genuine failure/disabled/deadline outcome: Compare may then show its truthful fallback.
        const timeoutMs = remainingPreparationMs(preparation.deadline)
        if (timeoutMs > 0)
            await Promise.all(
                targets.map((inputs) =>
                    documents.waitForGenerated(inputs, { signal: preparation.abort.signal, timeoutMs }),
                ),
            )
        return owner.active(preparation)
    } finally {
        stop()
    }
}

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
    const { state, controller, documents } = useWorkflow()
    const owner = preparationsFor(controller)
    const pathname = usePathname()
    const facts = factsOf(state)
    const previous = useRef(facts)
    const latestPath = useRef(pathname)
    latestPath.current = pathname
    useLayoutEffect(() => {
        const pending = owner.getSnapshot()
        if (pending !== null && pending.sourcePath !== pathname) {
            owner.cancel()
            if (
                pending.kind === 'camera' &&
                pending.targetPath !== pathname &&
                controller.getSnapshot().route === 'camera' &&
                controller.getSnapshot().selectedId === pending.manualId
            )
                controller.cancel()
        }
        if (issued.href === pathname) {
            issued.href = null
        }
    }, [controller, owner, pathname])
    useEffect(() => (): void => owner.cancel(), [owner])
    useLayoutEffect(() => {
        const before = previous.current
        previous.current = facts
        const pending = owner.getSnapshot()
        // Compare depends on no one manual, so any controller move makes it stale; it must never hold routing back.
        const moved =
            before.route !== facts.route || before.selectedId !== facts.selectedId || before.reading !== facts.reading
        if (
            pending !== null &&
            ((facts.selectedId !== pending.manualId && facts.selectedId !== before.selectedId) ||
                (pending.kind === 'compare' && moved))
        )
            owner.cancel()
        const command = reconcile(before, facts, latestPath.current)
        if (command.action !== 'none' && command.href === issued.href) {
            return
        }
        if (owner.getSnapshot() !== null || command.action === 'none') return
        const kind = facts.route === 'overview' ? 'quick-check' : facts.route === 'guide' ? 'guide' : null
        // A captured Spark verdict/answer must appear immediately, independently of deeper composition/SAM.
        if (
            kind === null ||
            surfaceOf(latestPath.current) === 'camera' ||
            state.check !== null ||
            state.answer !== null ||
            !prepares(documents, kind)
        ) {
            apply(command)
            return
        }
        const preparation =
            facts.selectedId === null ? null : owner.begin((): string => latestPath.current, facts.selectedId, kind)
        if (preparation !== null) {
            void awaitTarget(controller, documents, owner, preparation, kind).then((active): void => {
                if (active && owner.active(preparation)) apply(command)
            })
        }
    }, [controller, documents, owner, facts.route, facts.selectedId, facts.reading])
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
export function useWorkflowActions(): {
    controller: WorkflowController
    nav: ScreenNav
    compare: Pick<CompareNavigation, 'open'>
} {
    const { controller, documents } = useWorkflow()
    const owner = preparationsFor(controller)
    const pathname = usePathname()
    const path = useRef(pathname)
    path.current = pathname
    return useMemo(() => {
        const here = (): string => path.current
        const available = (): boolean => owner.getSnapshot() === null
        const hrefs = (route: ScreenRoute, id: string | null): string | null =>
            destinationFor({ route, selectedId: id, reading: false })
        const open = async (
            manualId: string,
            route: 'pages' | 'overview' | 'guide' = 'overview',
            completion = false,
        ): Promise<void> => {
            if (owner.getSnapshot() !== null) return
            const snapshot = controller.getSnapshot()
            const kind = completion
                ? 'completion'
                : route === 'overview'
                  ? 'quick-check'
                  : route === 'guide'
                    ? 'guide'
                    : null
            const resume = snapshot.selectedId === manualId && snapshot.route !== 'library'
            const immediateResult = resume && route === 'guide' && (snapshot.check !== null || snapshot.answer !== null)
            const preparation =
                kind !== null && !immediateResult && (completion || prepares(documents, kind))
                    ? owner.begin(here, manualId, kind)
                    : null
            if (resume) {
                if (snapshot.route !== route) controller.navigate(route)
            } else await controller.open(manualId, route)
            if (
                controller.getSnapshot().selectedId !== manualId ||
                (preparation !== null && !owner.active(preparation))
            ) {
                if (preparation !== null && owner.active(preparation)) owner.cancel()
                return
            }
            if (preparation !== null && kind !== null && prepares(documents, kind)) {
                if (!(await awaitTarget(controller, documents, owner, preparation, kind))) return
            }
            if (preparation !== null && !owner.active(preparation)) return
            const href = completion ? `/done/${encodeURIComponent(manualId)}` : hrefs(route, manualId)
            if (href !== null) go(href, 'push', here())
            if (preparation !== null && href === preparation.sourcePath) owner.cancel()
        }
        const navigate = async (
            route: 'pages' | 'overview' | 'guide',
            options?: Parameters<CaptureController['navigate']>[1],
        ): Promise<void> => {
            if (owner.getSnapshot() !== null) return
            const id = controller.getSnapshot().selectedId
            const kind = route === 'guide' ? 'guide' : route === 'overview' ? 'quick-check' : null
            const preparation =
                id !== null && kind !== null && prepares(documents, kind) ? owner.begin(here, id, kind) : null
            controller.navigate(route, options)
            if (preparation !== null && kind !== null && documents !== null && documents !== undefined) {
                if (!(await awaitTarget(controller, documents, owner, preparation, kind))) return
            }
            if (preparation !== null && !owner.active(preparation)) return
            const href = hrefs(route, controller.getSnapshot().selectedId)
            if (href !== null)
                go(
                    href,
                    route === 'guide' && surfaceOf(here()) === 'check'
                        ? 'replace'
                        : route === 'pages'
                          ? 'dismissTo'
                          : 'push',
                    here(),
                )
            if (preparation !== null && href === preparation.sourcePath) owner.cancel()
        }
        const camera = async (intent: CameraIntent): Promise<void> => {
            if (owner.getSnapshot() !== null) return
            const state = controller.getSnapshot()
            if (
                !prepares(documents, 'camera') ||
                state.selectedId === null ||
                state.pending !== null ||
                state.storageReadOnly ||
                (intent.kind !== 'page' && controller.current?.session.reviewStatus !== 'reviewed')
            ) {
                controller.camera(intent)
                return
            }
            const preparation = owner.begin(here, state.selectedId, 'camera')
            if (preparation === null) return
            // Query the existing OS consent only after the explicit camera intent; never request permission here.
            const access = await queryCameraAccess(preparation.abort.signal, preparation.deadline)
            if (!owner.active(preparation)) return
            if (access === null) {
                owner.cancel()
                return
            }
            if (controller.getSnapshot().selectedId !== preparation.manualId) {
                owner.cancel()
                return
            }
            cameraAccess.set(controller, { intent, access })
            controller.camera(intent)
            if (controller.getSnapshot().cameraIntent !== intent) {
                owner.cancel()
                return
            }
            if (await awaitTarget(controller, documents, owner, preparation, 'camera')) {
                if (owner.active(preparation)) go('/camera', 'push', here())
            }
        }
        const idle = (): void => {}
        const openCompare = (dismiss?: () => void): (() => void) => {
            if (owner.getSnapshot() !== null) return idle
            const launch = (): void => {
                dismiss?.()
                if (here() !== '/compare') router.push('/compare' as never)
            }
            // Off and steps compose nothing for Compare, so there is nothing to wait for.
            if (!prepares(documents, 'compare')) {
                launch()
                return idle
            }
            const preparation = owner.begin(here, null, 'compare')
            if (preparation === null) return idle
            void (async (): Promise<void> => {
                let opened = false
                try {
                    if (await awaitCompare(controller, documents, owner, preparation)) {
                        launch()
                        opened = true
                    }
                } finally {
                    // A route change releases the reservation of an opened Compare; any other exit releases it here.
                    if ((!opened || preparation.sourcePath === '/compare') && owner.getSnapshot() === preparation)
                        owner.cancel()
                }
            })()
            return (): void => {
                if (owner.getSnapshot() === preparation) owner.cancel()
            }
        }
        const wrapped: WorkflowController = {
            acceptStepFacts: (binding, stepId, resolution) =>
                available() ? controller.acceptStepFacts(binding, stepId, resolution) : Promise.resolve(false),
            ask: () => (available() ? controller.ask() : Promise.resolve()),
            camera: (intent: CameraIntent): void => {
                void camera(intent)
            },
            get canCompose() {
                return controller.canCompose
            },
            cancel: (): void => {
                owner.cancel()
                controller.cancel()
            },
            completeStep: async (): Promise<void> => {
                if (!available()) return
                const before = controller.current
                if (
                    before === undefined ||
                    before.stepIndex >= before.session.reviewedSteps.length - 1 ||
                    !prepares(documents, 'guide')
                ) {
                    await controller.completeStep()
                    return
                }
                // Reserve before invalidate/save publishes: the same guide URL cannot reserve this transition later.
                const preparation = owner.begin(here, before.session.manualId, 'guide')
                if (preparation === null) return
                try {
                    await controller.completeStep()
                    const after = controller.current
                    if (
                        !owner.active(preparation) ||
                        after?.session.manualId !== before.session.manualId ||
                        after.session.revision !== before.session.revision ||
                        after.stepIndex !== before.stepIndex + 1
                    )
                        return
                    await awaitTarget(controller, documents, owner, preparation, 'guide')
                } finally {
                    if (owner.active(preparation)) owner.cancel()
                }
            },
            confirm: () => (available() ? controller.confirm() : Promise.resolve()),
            coverageNotice: () => controller.coverageNotice(),
            createManual: async () => {
                if (!available()) return
                const before = controller.getSnapshot().selectedId
                await controller.createManual()
                const after = controller.getSnapshot()
                if (after.selectedId !== null && after.selectedId !== before) {
                    go('/add', 'push', here())
                }
            },
            editPage: (index, action) => (available() ? controller.editPage(index, action) : Promise.resolve()),
            home: () => {
                owner.cancel()
                controller.home()
                go('/', 'dismissTo', here())
            },
            navigate: (route, options): void => {
                void navigate(route, options)
            },
            open,
            parse: async (language) => {
                if (!available()) return
                const pending = controller.parse(language)
                const { pending: now, selectedId } = controller.getSnapshot()
                if (now !== null && now.startsWith('Reading') && selectedId !== null) {
                    go(`/reading/${encodeURIComponent(selectedId)}`, 'push', here())
                }
                await pending
            },
            questionChanged: (question): void => {
                if (available()) controller.questionChanged(question)
            },
            rename: (title) => (available() ? controller.rename(title) : Promise.resolve()),
            restore: () => (available() ? controller.restore() : Promise.resolve()),
            step: (index) => (available() ? controller.step(index) : Promise.resolve()),
            targetChanged: (target): void => {
                if (available()) controller.targetChanged(target)
            },
        }
        const nav: ScreenNav = {
            openStop: (entry: LibraryEntry): void => {
                const stop = stopFor(entry)
                const id = entry.session.manualId
                if (stop === 'done') {
                    void open(id, 'guide', true)
                    return
                }
                void wrapped.open(id, stop)
            },
            startBuilding: async (): Promise<void> => {
                if (owner.getSnapshot() !== null) return
                const entry = controller.current
                if (entry === undefined) {
                    return
                }
                const preparation = prepares(documents, 'guide')
                    ? owner.begin(here, entry.session.manualId, 'guide')
                    : null
                if (entry.session.reviewStatus !== 'reviewed') {
                    await controller.confirm()
                }
                if (controller.current?.session.reviewStatus === 'reviewed') {
                    if (
                        preparation !== null &&
                        documents !== null &&
                        documents !== undefined &&
                        !(await awaitTarget(controller, documents, owner, preparation, 'guide'))
                    )
                        return
                    if (preparation !== null && !owner.active(preparation)) return
                    controller.navigate('guide')
                    go(
                        `/guide/${encodeURIComponent(entry.session.manualId)}`,
                        surfaceOf(here()) === 'check' ? 'replace' : 'push',
                        here(),
                    )
                } else if (preparation !== null) owner.cancel()
            },
            finish: async (): Promise<void> => {
                if (owner.getSnapshot() !== null) return
                const before = controller.current
                const preparation =
                    before !== undefined && prepares(documents, 'completion')
                        ? owner.begin(here, before.session.manualId, 'completion')
                        : null
                await controller.completeStep()
                const entry = controller.current
                if (entry !== undefined && allStepsMarked(entry)) {
                    if (
                        preparation !== null &&
                        documents !== null &&
                        documents !== undefined &&
                        !(await awaitTarget(controller, documents, owner, preparation, 'completion'))
                    )
                        return
                    if (preparation !== null && !owner.active(preparation)) return
                    go(`/done/${encodeURIComponent(entry.session.manualId)}`, 'replace', here())
                } else if (preparation !== null) owner.cancel()
            },
            allBuilds: (): void => {
                owner.cancel()
                go('/', 'dismissTo', here())
            },
            editPages: (options): void => wrapped.navigate('pages', options),
            leave: (): void => wrapped.home(),
            back: (): void => {
                const pending = owner.getSnapshot()
                owner.cancel()
                if (pending?.kind === 'camera' && controller.getSnapshot().route === 'camera') controller.cancel()
                if (router.canGoBack()) {
                    router.back()
                } else {
                    go('/', 'replace', here())
                }
            },
        }
        return { controller: wrapped, nav, compare: { open: openCompare } }
    }, [controller, documents, owner])
}
