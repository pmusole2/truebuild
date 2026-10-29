import {
    CAMERA_TIP_TARGETS,
    type CheckResult,
    type ManualStep,
    type QuestionResult,
    type ScreenKind,
    type ScreenUiState,
} from '@truebuild/contracts'
import type { ModelScreensMetadata } from '@truebuild/contracts/model'
import type { WorkflowState } from '../capture/controller'
import type { LibraryEntry } from '../capture/library'
import type { MoreControl } from '../capture/screen-header'
import type { ScreenNav } from '../capture/screen-nav'
import type { WorkflowController } from '../capture/workflow-types'
import { stopFor } from '../capture/plain-copy'
import { useShowTipsAgain } from '../onboarding/coach-provider'
import type { ScreenFacts } from './documents'
import type { IntentExtras } from './intents'
import type { LiveScreen } from './live'
import { publishableResult, sessionForScreens, type ScreenSpec } from './screen-spec'
import { captureUiState, homeUiState, moreUiState, pagesUiState, reviewUiState } from './ui-state'
import { useScreenSlot, useWarmUp, type ScreenSlot } from './use-screen-slot'

/** Maps the controller's notice for a failed call to the closed failure class a screens request may carry. */
export function failureFromNotice(notice: string | null): NonNullable<ModelScreensMetadata['failure']> | null {
    if (notice === null) return null
    const named = /^Unavailable \((\w+)\)/u.exec(notice)?.[1]
    if (named === 'unconfigured' || named === 'unauthorized' || named === 'invalid_input' || named === 'timeout') {
        return named
    }
    if (named === 'invalid_output' || named === 'provider_error') return named
    if (/timed out|exceeded 8 seconds/u.test(notice)) return 'timeout'
    if (/^Cannot verify:|^Question unavailable|^Manual reading unavailable|^Cannot use this camera/u.test(notice)) {
        return 'provider_error'
    }
    return null
}

const NO_FACTS: ScreenFacts = {}
const spec = (
    kind: ScreenKind,
    entry: LibraryEntry | undefined,
    rest: Partial<Pick<ScreenSpec, 'stepId' | 'captureId' | 'result' | 'failure' | 'completedStepIds'>> & {
        readonly uiState?: ScreenUiState
        /** Quick check composes what was read, so it keeps the raw extraction the other screens leave out. */
        readonly keepRaw?: boolean
    } = {},
    withSession = true,
): ScreenSpec => ({
    kind,
    session:
        withSession && entry !== undefined
            ? rest.keepRaw === true
                ? { ...sessionForScreens(entry.session), rawExtraction: entry.session.rawExtraction }
                : sessionForScreens(entry.session)
            : null,
    stepId: rest.stepId ?? null,
    captureId: rest.captureId ?? null,
    result: rest.result ?? null,
    failure: rest.failure ?? null,
    ...(rest.completedStepIds === undefined ? {} : { completedStepIds: rest.completedStepIds }),
    ...(rest.uiState === undefined ? {} : { uiState: rest.uiState }),
})

/** The screens a manual's own pages, reading and completion are composed from; one definition serves the screen and its warm-up. */
export const pagesSpec = (entry: LibraryEntry): ScreenSpec =>
    spec(entry.session.pages.length > 0 ? 'pages' : 'add', entry, { uiState: pagesUiState(entry) })
export const readingSpec = (entry: LibraryEntry): ScreenSpec => spec('reading', entry)
export const completionSpec = (entry: LibraryEntry, completedStepIds: readonly string[]): ScreenSpec =>
    spec('completion', entry, { completedStepIds })
/** A step's plain guide page: the Guide before a photo is held, the camera's wording, and what a precompute fills. */
export const guidePageSpec = (entry: LibraryEntry, stepId: string): ScreenSpec =>
    spec('guide', entry, { stepId, uiState: { capture: null } })

type Common = {
    readonly state: WorkflowState
    readonly entry: LibraryEntry | undefined
    readonly controller: WorkflowController
    readonly nav: ScreenNav
    readonly more: MoreControl
    readonly choosePages?: () => void
    readonly language?: string
    /** What a composed block reads from the screen it sits on (the current question, tapped pages, the held photo). */
    readonly live?: Partial<Pick<LiveScreen, 'quick' | 'pages' | 'heroCapture' | 'ask' | 'closeSheet'>>
}

function useExtras(args: Common): IntentExtras {
    const showAgain = useShowTipsAgain()
    return {
        showMore: args.more.show,
        ...(args.choosePages === undefined ? {} : { choosePages: args.choosePages }),
        ...(showAgain === null ? {} : { showTips: (): void => showAgain(args.more.hide) }),
        ...(args.language === undefined ? {} : { language: args.language }),
    }
}

/** Home: the person's library is the live state the document binds to; it needs no one manual's facts. */
export function useHomeSlot(args: Common & { readonly native: boolean }): ScreenSlot | undefined {
    const extras = useExtras(args)
    return useScreenSlot({
        kind: 'home',
        spec:
            args.native || args.state.loading
                ? null
                : spec('home', undefined, { uiState: homeUiState(args.state.entries) }, false),
        facts: NO_FACTS,
        ...args,
        extras,
        heroMode: 'inline',
        whilePending: 'skeleton',
    })
}

/** Add manual: the empty state is the `add` screen, a manual with pages is `pages`. */
export function usePagesSlot(args: Common & { readonly native: boolean }): ScreenSlot | undefined {
    const extras = useExtras(args)
    const pages = args.entry?.session.pages.length ?? 0
    return useScreenSlot({
        kind: pages > 0 ? 'pages' : 'add',
        spec: args.native || args.entry === undefined ? null : pagesSpec(args.entry),
        facts: NO_FACTS,
        ...args,
        extras,
        heroMode: 'inline',
        whilePending: 'skeleton',
    })
}

export function useReadingSlot(args: Common & { readonly native: boolean }): ScreenSlot | undefined {
    const extras = useExtras(args)
    return useScreenSlot({
        kind: 'reading',
        spec: args.native || args.entry === undefined ? null : readingSpec(args.entry),
        facts: NO_FACTS,
        ...args,
        extras,
        heroMode: 'inset',
        whilePending: 'native',
    })
}

export function useQuickCheckSlot(args: Common & { readonly native: boolean }): ScreenSlot | undefined {
    const extras = useExtras(args)
    return useScreenSlot({
        kind: 'quick-check',
        spec:
            args.native || args.entry === undefined
                ? null
                : spec('quick-check', args.entry, {
                      uiState: reviewUiState(args.entry, args.live?.quick),
                      keepRaw: args.entry.session.reviewStatus !== 'reviewed',
                  }),
        facts: NO_FACTS,
        ...args,
        extras,
        heroMode: 'inset',
        whilePending: 'skeleton',
    })
}

export function useDoneSlot(args: Common & { readonly native: boolean }): ScreenSlot | undefined {
    const extras = useExtras(args)
    return useScreenSlot({
        kind: 'completion',
        spec: args.native || args.entry === undefined ? null : completionSpec(args.entry, args.entry.completedStepIds),
        facts: NO_FACTS,
        ...args,
        extras,
        heroMode: 'inset',
        heroTestID: 'done-hero',
        whilePending: 'skeleton',
    })
}

/** The More sheet's document. It is composed only while the sheet is open, and shared by every screen. */
export function useMoreSlot(args: Common & { readonly kind?: ScreenKind }): ScreenSlot | undefined {
    const extras = useExtras(args)
    const showAgain = useShowTipsAgain()
    return useScreenSlot({
        kind: 'more',
        spec: args.more.open
            ? spec('more', undefined, { uiState: moreUiState({ tips: showAgain !== null }) }, false)
            : null,
        facts: NO_FACTS,
        ...args,
        extras,
        heroMode: 'inline',
        whilePending: 'native',
    })
}

function stepOf(entry: LibraryEntry | undefined): ManualStep | undefined {
    return entry?.session.reviewedSteps[entry.stepIndex]
}

type GuideScreenKind = Extract<ScreenKind, 'guide' | 'result' | 'answer' | 'error'>

/**
 * Which document the Guide shows. A held verdict is a `result` screen, a held answer an `answer` screen, a failed call
 * an `error` screen, and otherwise the step's own `guide` page. Anything that makes the native state the only honest one
 * (unconfirmed facts, missing manual pages, a call still running) keeps the native screen.
 */
export function guideSpec(
    state: WorkflowState,
    entry: LibraryEntry | undefined,
    blocked: boolean,
    coverage: boolean,
): { readonly kind: GuideScreenKind; readonly spec: ScreenSpec; readonly facts: ScreenFacts } | null {
    const step = stepOf(entry)
    if (entry === undefined || step === undefined || blocked || coverage) return null
    if (entry.session.reviewStatus !== 'reviewed') return null
    const capture = state.capture
    const closerLook = state.pending !== null && state.pending.startsWith('Second opinion')
    const ui = captureUiState(state)
    if (state.answer !== null && capture !== null && capture.reusable) {
        const answer: QuestionResult = state.answer
        return {
            kind: 'answer',
            spec: spec('answer', entry, {
                stepId: step.stepId,
                captureId: capture.binding.captureId,
                result: publishableResult({
                    kind: 'question',
                    question: state.question.trim() || 'Question',
                    value: answer,
                }),
                uiState: ui,
            }),
            facts: {},
        }
    }
    if (state.check !== null && capture !== null && capture.reusable) {
        // The verdict stays on screen as it is; the composed result waits for the closer look so it describes the final one.
        if (closerLook) return null
        const check: CheckResult = state.check
        return {
            kind: 'result',
            spec: spec('result', entry, {
                stepId: step.stepId,
                captureId: capture.binding.captureId,
                result: publishableResult({ kind: 'check', value: check }),
                uiState: ui,
            }),
            facts: { decision: check.decision },
        }
    }
    if (state.pending !== null) return null
    const failure = capture !== null ? failureFromNotice(state.notice) : null
    if (failure !== null && state.check === null) {
        return { kind: 'error', spec: spec('error', entry, { failure }, false), facts: {} }
    }
    return { kind: 'guide', spec: spec('guide', entry, { stepId: step.stepId, uiState: ui }), facts: {} }
}

export function useGuideSlot(
    args: Common & { readonly native: boolean; readonly blocked: boolean; readonly coverage: boolean },
): ScreenSlot | undefined {
    const extras = useExtras(args)
    const chosen = args.native ? null : guideSpec(args.state, args.entry, args.blocked, args.coverage)
    return useScreenSlot({
        kind: chosen?.kind ?? 'guide',
        spec: chosen?.spec ?? null,
        facts: chosen?.facts ?? NO_FACTS,
        ...args,
        extras,
        heroMode: 'flush',
        heroTestID: 'guide-hero-picture',
        heroRootTestID: 'guide-hero',
        whilePending: chosen?.kind === 'guide' ? 'skeleton' : 'native',
        marks:
            args.state.stages != null &&
            args.state.capture !== null &&
            args.state.stages.captureId === args.state.capture.binding.captureId
                ? args.state.stages.masks
                : [],
    })
}

/**
 * Asking about the held photo: a `questions` document, requested only while the ask view is open on a held capture.
 * Until it arrives (or if it never does) the native composer is the screen.
 */
export function useQuestionsSlot(
    args: Common & { readonly native: boolean; readonly blocked: boolean },
): ScreenSlot | undefined {
    const extras = useExtras(args)
    const step = stepOf(args.entry)
    const capture = args.state.capture
    const wanted =
        !args.native &&
        !args.blocked &&
        args.more.open &&
        args.more.mode === 'ask' &&
        args.entry !== undefined &&
        step !== undefined &&
        capture !== null &&
        capture.reusable &&
        args.entry.session.reviewStatus === 'reviewed'
    return useScreenSlot({
        kind: 'questions',
        spec: wanted
            ? spec('questions', args.entry, {
                  stepId: step.stepId,
                  captureId: capture.binding.captureId,
                  result:
                      args.state.check === null ? null : publishableResult({ kind: 'check', value: args.state.check }),
                  uiState: captureUiState(args.state),
              })
            : null,
        facts: { decision: args.state.check?.decision ?? null },
        ...args,
        extras,
        heroMode: 'inline',
        whilePending: 'native',
    })
}

/**
 * The camera's words: the step's own plain guide page (the same screen the Guide shows before a photo is held, so it is
 * usually already composed), read for its CameraGuidance block and camera tips. It is requested only for a step photo
 * of a reviewed manual, never counted as a screen shown, and the camera falls back to its own words until it arrives.
 */
export function useCameraSlot(args: Common & { readonly blocked: boolean }): ScreenSlot | undefined {
    const extras = useExtras(args)
    const step = stepOf(args.entry)
    const intent = args.state.cameraIntent
    const wanted =
        !args.blocked &&
        args.entry !== undefined &&
        step !== undefined &&
        intent !== null &&
        intent.kind !== 'page' &&
        args.entry.session.reviewStatus === 'reviewed'
    return useScreenSlot({
        kind: 'guide',
        spec: wanted ? guidePageSpec(args.entry, step.stepId) : null,
        facts: { tipTargets: [...CAMERA_TIP_TARGETS] },
        ...args,
        extras,
        heroMode: 'inline',
        whilePending: 'native',
        counted: false,
    })
}

/**
 * The screens the person is most likely to open next, from facts the app already holds and nothing it would have to
 * guess: a sole build's own stop, the reading of pages already added and the done screen after the last step. Each is
 * the destination's own spec, so a different manual revision, step, page set or photo is a different key and never
 * reuses this one. Quick check needs the question being asked and a result needs a photo, so neither is predicted.
 */
export function nextScreenSpecs(
    from: 'home' | 'pages' | 'guide',
    state: WorkflowState,
    entry: LibraryEntry | undefined,
): readonly ScreenSpec[] {
    if (from === 'home') {
        const sole = state.loading || state.storageReadOnly || state.entries.length !== 1 ? undefined : state.entries[0]
        if (sole === undefined) return []
        const stop = stopFor(sole)
        const step = stepOf(sole)
        if (stop === 'pages') return [pagesSpec(sole)]
        if (stop === 'done') return [completionSpec(sole, sole.completedStepIds)]
        return stop === 'guide' && step !== undefined && sole.capture === null ? [guidePageSpec(sole, step.stepId)] : []
    }
    if (entry === undefined || state.pending !== null) return []
    if (from === 'pages') {
        return entry.session.reviewStatus !== 'reviewed' && entry.session.pages.length > 0 ? [readingSpec(entry)] : []
    }
    if (entry.session.reviewStatus !== 'reviewed') return []
    const steps = entry.session.reviewedSteps
    const here = steps[entry.stepIndex]
    // Another step's guide page is the background precompute's job. What it does not cover is the done screen, which
    // opens only when every step is marked, so it is predicted only when the last mark is the one missing.
    if (here === undefined || steps[entry.stepIndex + 1] !== undefined) return []
    const finishing = steps.every((step) => step === here || entry.completedStepIds.includes(step.stepId))
    return finishing ? [completionSpec(entry, [...new Set([...entry.completedStepIds, here.stepId])])] : []
}

/** Starts the next screens' documents while this one is open, so they are ready or nearly so when it is left. */
export function useNextScreenWarmUp(
    from: 'home' | 'pages' | 'guide',
    state: WorkflowState,
    entry: LibraryEntry | undefined,
): void {
    useWarmUp(nextScreenSpecs(from, state, entry))
}
