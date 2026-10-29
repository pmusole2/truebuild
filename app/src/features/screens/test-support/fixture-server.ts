import {
    requiredManualFacts,
    type AppIntent,
    type ManualSession,
    type PublishedManualFact,
    type ScreenDocument,
    type ScreenDocumentSource,
    type ScreenKind,
    type ScreenNode,
    type ScreensResult,
} from '@truebuild/contracts'
import type { ModelRequestContext, ScreenRequest } from '../../../api/model-client'
import { hashText, sessionForScreens, specKey, type ScreenSpec } from '../screen-spec'
import type { ScreenClient } from '../screen-store'
import { contextKeyOf, hex, instruction, liveMetadata, makeDocument } from './documents'

// A stand-in for /api/screens used by UI tests only. Its documents are synthetic test inputs: with `generated` they
// carry recorded-looking metadata so the renderer and the judge layer can be exercised, which is not evidence of any
// model output. The real API fixture runtime is exercised separately by the root's simulator run.

const intent = <I extends AppIntent['intent']>(
    name: I,
    target: Extract<AppIntent, { intent: I }>['target'],
): AppIntent => ({ intent: name, target }) as AppIntent

function key64(seed: string): string {
    return Array.from(hashText(seed))
        .map((character) => character.charCodeAt(0).toString(16))
        .join('')
        .padEnd(64, '0')
        .slice(0, 64)
}

export type FixtureServerOptions = {
    /** Kinds composed as `generated` (test-input metadata); every other kind is a deterministic `fallback`. */
    readonly generated?: readonly ScreenKind[]
    /** Kinds that fail outright (the app keeps the native screen). */
    readonly failing?: readonly ScreenKind[]
    /** Holds each generate call until released, to exercise the pending state and the grace period. */
    readonly gate?: Promise<void>
    readonly onRequest?: (request: ScreenRequest) => void
    /** Lets a test hand the app a document it must refuse (for example one that contradicts the held verdict). */
    readonly transform?: (document: ScreenDocument, spec: ScreenSpec) => ScreenDocument
}

export type FixtureServer = ScreenClient & { readonly requests: ScreenRequest[] }

type Composed = {
    title: string
    nodes: ScreenNode[]
    primary: [string, AppIntent, 'camera' | 'plus' | 'check' | 'arrowRight' | 'chevronLeft' | 'refresh' | null]
    secondary: [string, AppIntent] | null
    sources?: ScreenDocumentSource[]
    manualFacts?: PublishedManualFact[]
}

const hero = (pageId: string | undefined, caption: string | null = null): ScreenNode[] =>
    pageId === undefined ? [] : [{ type: 'HeroFigure', source: 'page', refId: pageId, caption, fit: 'cover' }]

function body(spec: ScreenSpec): Composed {
    const session = spec.session
    const steps =
        session === null
            ? []
            : session.reviewStatus === 'reviewed'
              ? session.reviewedSteps
              : (session.rawExtraction?.steps ?? [])
    const step = steps.find((candidate) => candidate.stepId === spec.stepId)
    const firstPage = session?.pages[0]?.pageId
    switch (spec.kind) {
        case 'home': {
            const library = spec.uiState?.library
            const any = (library?.entries.length ?? 0) > 0
            return {
                title: 'Your builds',
                nodes: [
                    {
                        type: 'ManualLibrary',
                        entries: 'recent',
                        layout: 'cards',
                        showProgress: true,
                        emptyText: 'Turn your paper manual into steps.',
                    },
                    {
                        type: 'Tip',
                        targetId: 'home-add',
                        heading: 'Start here',
                        text: 'Tap here to add your paper manual.',
                    },
                ],
                primary: any
                    ? ['Continue building', intent('navigate', 'guide'), 'arrowRight']
                    : ['Add a manual', intent('navigate', 'add'), 'plus'],
                secondary: any ? ['Add manual', intent('navigate', 'add')] : null,
            }
        }
        case 'add':
            return {
                title: 'Add manual',
                nodes: [
                    instruction('Take a photo of each manual page.'),
                    {
                        type: 'Tip',
                        targetId: 'take-page-photo',
                        heading: 'First page',
                        text: 'Take a photo of each page.',
                    },
                ],
                primary: ['Take photo', intent('capture', 'take-photo'), 'camera'],
                secondary: ['Choose from photos', intent('capture', 'choose-pages')],
            }
        case 'pages':
            return {
                title: 'Your pages',
                nodes: [
                    instruction('Add every page, even the parts list.'),
                    { type: 'PageGallery', pages: 'session', layout: 'list', showNumbers: true, action: null },
                ],
                primary: ['Read my manual', intent('confirm', 'reading'), 'arrowRight'],
                secondary: ['Add a page', intent('capture', 'add-page')],
            }
        case 'reading':
            return {
                title: 'Reading your manual',
                nodes: [
                    ...hero(firstPage),
                    instruction('Reading each page. This can take a minute.'),
                    { type: 'Skeleton', variant: 'lines', lines: 3 },
                ],
                primary: ['Back to pages', intent('navigate', 'pages'), 'chevronLeft'],
                secondary: null,
            }
        case 'quick-check': {
            const question = spec.uiState?.review?.currentQuestion ?? null
            const asked =
                question === null ? undefined : steps.find((candidate) => candidate.stepId === question.stepId)
            if (question !== null && asked !== undefined) {
                return {
                    title: 'Quick check',
                    nodes: [
                        ...hero(asked.sourceRefs[0]?.pageId),
                        {
                            type: 'FactPrompt',
                            questionRef: 'current',
                            prompt:
                                question.kind === 'orientation' ? 'Which way should it face?' : 'What should you see?',
                            detail: null,
                            citations: [],
                        },
                        {
                            type: 'FactEditor',
                            questionRef: 'current',
                            kind: question.kind,
                            label: 'What the picture shows',
                            saveLabel: 'Save',
                            cancelLabel: 'Cancel',
                        },
                    ],
                    primary: ['Add clearer photos', intent('navigate', 'pages'), 'plus'],
                    secondary: null,
                }
            }
            return {
                title: 'Quick check',
                nodes: [
                    ...hero(steps[0]?.sourceRefs[0]?.pageId),
                    instruction('Check what we read before you start building.'),
                ],
                primary: ['Start building', intent('confirm', 'facts'), 'check'],
                secondary: ['Read again', intent('retry', 'reading')],
            }
        }
        case 'result': {
            const decision = spec.result?.kind === 'check' ? spec.result.value.decision : 'cannot_verify'
            const reason = spec.result?.kind === 'check' ? spec.result.value.reason : 'Not checked.'
            const page = step?.sourceRefs[0]?.pageId
            return {
                title:
                    decision === 'pass' ? 'Looks right' : decision === 'refuse' ? 'Not quite right' : 'Cannot tell yet',
                nodes: [
                    ...(spec.captureId === null
                        ? []
                        : ([
                              {
                                  type: 'HeroFigure',
                                  source: 'capture',
                                  refId: spec.captureId,
                                  caption: null,
                                  fit: 'cover',
                              },
                          ] as ScreenNode[])),
                    { type: 'ResultBanner', verdict: decision, text: reason.slice(0, 150), citations: [] },
                    ...(page === undefined
                        ? []
                        : ([
                              {
                                  type: 'SourceDetails',
                                  label: 'See the manual page',
                                  sources: [0],
                                  fit: 'contain',
                                  initiallyOpen: false,
                              },
                          ] as ScreenNode[])),
                ],
                primary:
                    decision === 'pass'
                        ? ['Next step', intent('confirm', 'step'), 'arrowRight']
                        : ['Take another photo', intent('capture', 'retake'), 'camera'],
                secondary: ['Ask about this step', intent('ask', 'about-step')],
                ...(page === undefined ? {} : { sources: [{ pageId: page, region: null }] }),
            }
        }
        case 'answer': {
            const answer = spec.result?.kind === 'question' ? spec.result.value.answer : 'No answer.'
            return {
                title: 'Answer',
                nodes: [{ type: 'AnswerCard', text: answer.slice(0, 480), caveat: null, citations: [] }],
                primary: ['Back to the step', intent('navigate', 'guide'), 'chevronLeft'],
                secondary: ['Ask another', intent('ask', 'about-step')],
            }
        }
        case 'questions':
            return {
                title: 'Ask about your photo',
                nodes: [
                    {
                        type: 'QuestionComposer',
                        captureRef: 'current',
                        prompt: 'What do you want to know?',
                        partScope: 'step-parts',
                        submitLabel: 'Ask',
                    },
                ],
                primary: ['Take another photo', intent('capture', 'retake'), 'camera'],
                secondary: null,
            }
        case 'completion':
            return {
                title: 'All steps done',
                nodes: [
                    ...hero(session?.reviewedSteps[(session?.reviewedSteps.length ?? 1) - 1]?.sourceRefs[0]?.pageId),
                    instruction(`You finished all ${session?.reviewedSteps.length ?? 0} steps.`),
                ],
                primary: ['Back to Home', intent('navigate', 'home'), 'check'],
                secondary: null,
            }
        case 'error':
            return {
                title: 'Something went wrong',
                nodes: [instruction('Smart help is unavailable right now. Try again in a moment.', 'normal')],
                primary: ['Try again', intent('retry', 'last-action'), 'refresh'],
                secondary: ['Back', intent('navigate', 'home')],
            }
        case 'more':
            return {
                title: 'More',
                nodes: [
                    instruction('Settings and help.', 'normal'),
                    {
                        type: 'ActionLink',
                        label: 'Show tips again',
                        icon: 'help',
                        intent: intent('show-tips', 'screen'),
                        emphasis: 'quiet',
                    },
                ],
                primary: ['Back', intent('navigate', 'home'), 'chevronLeft'],
                secondary: null,
            }
        case 'recovery':
        case 'guide':
        default: {
            const required =
                session !== null && step !== undefined && session.reviewStatus === 'reviewed'
                    ? requiredManualFacts(session, step.stepId)
                    : []
            const manualFacts: PublishedManualFact[] = required.map((fact) => ({ ...fact, placement: 'body' as const }))
            return {
                title: step === undefined ? 'This step' : `Step ${step.order}`,
                nodes: [
                    ...hero(step?.sourceRefs[0]?.pageId),
                    {
                        type: 'StepProgress',
                        current: step?.order ?? 1,
                        total: session?.reviewedSteps.length ?? 1,
                        label: null,
                    },
                    instruction(step?.title ?? 'Pick up where you left off.'),
                    ...(manualFacts.length === 0
                        ? []
                        : ([
                              {
                                  type: 'ManualDirections',
                                  factIds: manualFacts.map((fact) => fact.factId),
                                  emphasis: 'normal',
                              },
                          ] as ScreenNode[])),
                    {
                        type: 'Tip',
                        targetId: 'guide-primary',
                        heading: 'The big button',
                        text: 'Take a photo to check your work.',
                    },
                    {
                        type: 'CameraGuidance',
                        cue: 'Line up the part with the picture.',
                        pill: 'Step photo',
                        tipTarget: 'camera-shutter',
                    },
                ],
                primary: ['Take photo', intent('capture', 'take-photo'), 'camera'],
                secondary: ['Ask about this step', intent('ask', 'about-step')],
                manualFacts,
            }
        }
    }
}

export function documentFor(spec: ScreenSpec, options: Pick<FixtureServerOptions, 'generated'> = {}): ScreenDocument {
    const { title, nodes, primary, secondary, sources, manualFacts } = body(spec)
    const generated = options.generated?.includes(spec.kind) === true
    const seed = specKey(spec)
    return makeDocument({
        kind: spec.kind,
        session: spec.session,
        stepId: spec.kind === 'result' || spec.kind === 'answer' || spec.kind === 'guide' ? spec.stepId : null,
        captureId: spec.result === null ? null : spec.captureId,
        contextKey: contextKeyOf(spec),
        screenId: key64(`${seed}:${generated ? 'g' : 'f'}`),
        metadata: generated
            ? liveMetadata({
                  stage:
                      spec.kind === 'guide' || spec.kind === 'result' || spec.kind === 'answer'
                          ? 'step-page'
                          : 'screen',
              })
            : undefined,
        title,
        body: nodes,
        ...(sources === undefined ? {} : { sources }),
        ...(manualFacts === undefined || manualFacts.length === 0 ? {} : { manualFacts }),
        primary: { label: primary[0], intent: primary[1], icon: primary[2] },
        secondary: secondary === null ? null : { label: secondary[0], intent: secondary[1] },
    })
}

export function fixtureScreens(options: FixtureServerOptions = {}): FixtureServer {
    const requests: ScreenRequest[] = []
    const ok = (value: Partial<Extract<ScreensResult, { status: 'ok' }>['value']>): ScreensResult => ({
        status: 'ok',
        requestId: 'fixture',
        mode: 'fixture',
        value: { document: null, progress: null, documents: [], ...value },
    })
    const progressOf = (
        session: ManualSession,
    ): NonNullable<Extract<ScreensResult, { status: 'ok' }>['value']['progress']> => ({
        manualId: session.manualId,
        revision: session.revision,
        contextKey: hex('d'),
        mode: 'full',
        steps: session.reviewedSteps.map((step) => ({
            stepId: step.stepId,
            state: 'ready' as const,
            screenId: hex('b'),
        })),
    })
    const sessions = new Map<string, ManualSession>()
    return {
        requests,
        screens: async (request: ScreenRequest, _context: ModelRequestContext): Promise<ScreensResult> => {
            requests.push(request)
            options.onRequest?.(request)
            if (request.op === 'generate') {
                await options.gate
                if (options.failing?.includes(request.kind) === true) {
                    return {
                        status: 'unavailable',
                        requestId: 'fixture',
                        binding: null,
                        code: 'provider_error',
                        retryable: true,
                    }
                }
                const document = documentFor(request, options)
                return ok({ document: options.transform?.(document, request) ?? document })
            }
            if (request.op === 'precompute') {
                sessions.set(request.session.manualId, request.session)
                return ok({ progress: progressOf(request.session) })
            }
            if (request.op === 'progress') {
                const session = sessions.get(request.binding.manualId)
                if (session === undefined || options.failing?.includes('guide') === true) return ok({})
                return ok({
                    progress: progressOf(session),
                    documents: request.want.map((stepId) =>
                        documentFor(
                            {
                                kind: 'guide',
                                session: sessionForScreens(session),
                                stepId,
                                captureId: null,
                                result: null,
                                failure: null,
                            },
                            options,
                        ),
                    ),
                })
            }
            return ok({})
        },
    }
}
