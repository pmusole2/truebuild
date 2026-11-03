import { waitCopyV2, type AppIntent, type ScreenKind } from '@truebuild/contracts'
import { reviewedSession, type WorkflowState } from '../capture/controller'
import type { LibraryEntry } from '../capture/library'
import { allStepsMarked, plainPending, stopFor } from '../capture/plain-copy'
import type { ScreenNav } from '../capture/screen-nav'
import type { MoreMode } from '../capture/screen-header'
import type { WorkflowController } from '../capture/workflow-types'

/** What a route can do that is not a controller call. Absent means that action does not exist on this screen. */
export type IntentExtras = {
    readonly choosePages?: () => void
    readonly showMore?: (mode: MoreMode) => void
    readonly showTips?: () => void
    /** Ask the screen store for this screen's document again. */
    readonly refresh?: () => void
    readonly language?: string
    readonly contextualMore?: boolean
}

/** The current app facts an intent is checked against at the moment it is pressed, never at composition time. */
export type IntentHost = {
    readonly kind: ScreenKind
    readonly state: WorkflowState
    readonly entry: LibraryEntry | undefined
    readonly controller: WorkflowController
    readonly nav: ScreenNav
    readonly extras: IntentExtras
}

export type ResolvedIntent = {
    readonly enabled: boolean
    /** Plain words for why it is not available now; null when it is. */
    readonly reason: string | null
    readonly run: () => void
}

/** Canonical words for an intent pair when a block names an action but not its label (a gallery's add action). */
export function intentLabel(intent: AppIntent): string {
    switch (intent.intent) {
        case 'capture':
            return intent.target === 'add-page'
                ? 'Add a page'
                : intent.target === 'choose-pages'
                  ? 'Choose from photos'
                  : intent.target === 'retake'
                    ? 'Take another photo'
                    : 'Take photo'
        case 'check':
            return 'Check this step'
        case 'ask':
            return 'Ask about this step'
        case 'confirm':
            return intent.target === 'step' ? 'Next step' : 'Continue'
        case 'retry':
            return 'Try again'
        case 'open-details':
            return 'More about this'
        case 'show-tips':
            return 'Show tips'
        case 'navigate':
            return intent.target === 'more' ? 'More' : 'Continue'
    }
}

const NOOP = (): void => undefined
const unavailable = (reason: string): ResolvedIntent => ({ enabled: false, reason, run: NOOP })
const available = (run: () => void): ResolvedIntent => ({ enabled: true, reason: null, run })

const STEP_KINDS: ReadonlySet<ScreenKind> = new Set(['guide', 'result', 'questions', 'answer', 'recovery', 'error'])
const PAGE_KINDS: ReadonlySet<ScreenKind> = new Set(['add', 'pages', 'reading'])

function busyReason(state: WorkflowState, kind: ScreenKind): string | null {
    if (state.loading) return waitCopyV2('home').action
    if (state.storageReadOnly) return 'Saving is paused until your builds open again.'
    if (state.pending !== null) return plainPending(state.pending, kind)
    return null
}

/**
 * The closed map from a document's intent to what this app may do right now. A document never names a route or a
 * handler: it names one of eight intents with a finite target, and this function decides whether the matching
 * controller capability exists on the current screen and whether its preconditions hold. An intent that does not map
 * is shown disabled with a reason; it can never navigate anywhere new.
 */
export function resolveIntent(intent: AppIntent, host: IntentHost): ResolvedIntent {
    const { state, entry, controller, nav, extras, kind } = host
    const busy = busyReason(state, kind)
    const session = entry?.session
    const reviewed = session?.reviewStatus === 'reviewed'
    const contextualStep =
        kind === 'more' &&
        extras.contextualMore === true &&
        reviewed &&
        entry !== undefined &&
        session?.reviewedSteps[entry.stepIndex] !== undefined
    const hasCoverageGap = (): boolean => controller.coverageNotice() !== null
    const checkPhoto = (): ResolvedIntent => {
        if (entry === undefined || !reviewed) return unavailable('Confirm the manual facts first.')
        if (busy !== null) return unavailable(busy)
        if (hasCoverageGap()) return unavailable('More manual pages are needed before a photo can be checked.')
        return available(() => controller.camera({ kind: 'check' }))
    }
    switch (intent.intent) {
        case 'navigate':
            switch (intent.target) {
                case 'home':
                    return available(kind === 'completion' ? nav.leave : nav.allBuilds)
                case 'add':
                    if (kind !== 'home') return unavailable('Go to Home to add a manual.')
                    return busy !== null ? unavailable(busy) : available(() => void controller.createManual())
                case 'pages':
                    if (entry === undefined) return unavailable('Open a manual first.')
                    return state.pending !== null
                        ? unavailable(busyReason(state, kind) ?? '')
                        : available(nav.editPages)
                case 'reading':
                    return unavailable('Reading starts from your pages.')
                case 'quick-check':
                    if (entry === undefined || (session?.reviewedSteps.length ?? 0) === 0) {
                        return unavailable('Read the manual first.')
                    }
                    return state.pending !== null
                        ? unavailable(busyReason(state, kind) ?? '')
                        : available(() => controller.navigate('overview'))
                case 'guide':
                    if (kind === 'home') {
                        const latest = [...state.entries].sort((a, b) =>
                            b.session.updatedAt.localeCompare(a.session.updatedAt),
                        )[0]
                        return latest === undefined || busy !== null
                            ? unavailable(busy ?? 'Add a manual first.')
                            : available(() => nav.openStop(latest))
                    }
                    if (entry === undefined || !reviewed) return unavailable('Confirm the manual facts first.')
                    return state.pending !== null
                        ? unavailable(busyReason(state, kind) ?? '')
                        : available(() => controller.navigate('guide'))
                case 'done':
                    return entry !== undefined && allStepsMarked(entry) && stopFor(entry) === 'done'
                        ? available(() => nav.openStop(entry))
                        : unavailable('Finish every step first.')
                case 'more':
                    return extras.showMore === undefined
                        ? unavailable('More is not on this screen.')
                        : available(() => extras.showMore?.('details'))
            }
            break
        case 'capture':
            switch (intent.target) {
                case 'take-photo':
                case 'retake':
                    if (PAGE_KINDS.has(kind) || (intent.target === 'take-photo' && kind === 'home')) {
                        if (entry === undefined) return unavailable('Add a manual first.')
                        return busy !== null ? unavailable(busy) : available(() => controller.camera({ kind: 'page' }))
                    }
                    if (kind === 'questions' || kind === 'answer') {
                        if (entry === undefined || !reviewed) return unavailable('Confirm the manual facts first.')
                        return busy !== null
                            ? unavailable(busy)
                            : available(() => controller.camera({ kind: 'question' }))
                    }
                    return STEP_KINDS.has(kind) || contextualStep
                        ? checkPhoto()
                        : unavailable('No photo is needed here.')
                case 'choose-pages':
                    if (extras.choosePages === undefined || !PAGE_KINDS.has(kind)) {
                        return unavailable('Choosing photos is not available here.')
                    }
                    return busy !== null ? unavailable(busy) : available(extras.choosePages)
                case 'add-page':
                    if (!PAGE_KINDS.has(kind) || entry === undefined)
                        return unavailable('Pages are added from Add manual.')
                    return busy !== null ? unavailable(busy) : available(() => controller.camera({ kind: 'page' }))
            }
            break
        case 'check':
            return STEP_KINDS.has(kind) ? checkPhoto() : unavailable('A check needs a step.')
        case 'ask':
            if ((!STEP_KINDS.has(kind) && kind !== 'more') || entry === undefined || !reviewed)
                return unavailable('Open a step first.')
            if (kind === 'more') {
                if (extras.contextualMore !== true) return unavailable('Open a step first.')
                const step = session?.reviewedSteps[entry.stepIndex]
                const capture = state.capture
                if (busy !== null) return unavailable(busy)
                if (
                    step === undefined ||
                    capture?.reusable !== true ||
                    capture.binding.manualId !== session?.manualId ||
                    capture.binding.revision !== session.revision ||
                    capture.binding.stepId !== step.stepId
                )
                    return unavailable('Take a photo of this step first.')
            }
            return extras.showMore === undefined
                ? unavailable('Asking is not on this screen.')
                : available(() => extras.showMore?.('ask'))
        case 'confirm':
            switch (intent.target) {
                case 'reading':
                    if (entry === undefined || (session?.pages.length ?? 0) === 0)
                        return unavailable('Add a page first.')
                    return busy !== null
                        ? unavailable(busy)
                        : available(() => void controller.parse(extras.language ?? 'en'))
                case 'facts':
                case 'manual':
                    if (entry === undefined || session === undefined) return unavailable('Open a manual first.')
                    if (busy !== null) return unavailable(busy)
                    return reviewed || reviewedSession(session) !== null
                        ? available(() => void nav.startBuilding())
                        : unavailable('Some facts still need a clearer photo.')
                case 'step':
                    if (kind === 'more' && !contextualStep) return unavailable('Open a step first.')
                    // Only a held pass for the current photo can mark a step done, whatever a screen asked for.
                    if (state.check?.decision !== 'pass' || state.capture === null || entry === undefined) {
                        return unavailable('Take a photo that looks right first.')
                    }
                    if (busy !== null) return unavailable(busy)
                    return available(() => {
                        const last = entry.stepIndex >= entry.session.reviewedSteps.length - 1
                        if (last) {
                            void nav.finish()
                        } else {
                            void controller.completeStep()
                        }
                    })
            }
            break
        case 'retry':
            switch (intent.target) {
                case 'reading':
                    return resolveIntent({ intent: 'confirm', target: 'reading' }, host)
                case 'check':
                    return STEP_KINDS.has(kind) ? checkPhoto() : unavailable('A check needs a step.')
                case 'question':
                    if (state.capture === null || state.target === null || state.question.trim() === '') {
                        return unavailable('Take a photo and choose what to ask first.')
                    }
                    return busy !== null ? unavailable(busy) : available(() => void controller.ask())
                case 'screen':
                    return extras.refresh === undefined ? unavailable('Nothing to reload.') : available(extras.refresh)
                case 'last-action':
                    if (kind === 'reading' || kind === 'pages') {
                        return resolveIntent({ intent: 'retry', target: 'reading' }, host)
                    }
                    if (kind === 'guide' || kind === 'result' || kind === 'recovery') {
                        return resolveIntent({ intent: 'retry', target: 'check' }, host)
                    }
                    return resolveIntent({ intent: 'retry', target: 'screen' }, host)
            }
            break
        case 'open-details':
            return extras.showMore === undefined
                ? unavailable('Details are not on this screen.')
                : available(() => extras.showMore?.('details'))
        case 'show-tips':
            return extras.showTips !== undefined
                ? available(extras.showTips)
                : extras.showMore === undefined
                  ? unavailable('Tips are not on this screen.')
                  : available(() => extras.showMore?.('details'))
    }
    return unavailable('Not available here.')
}
