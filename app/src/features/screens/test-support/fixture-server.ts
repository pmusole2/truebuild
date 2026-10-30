import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    documentMaterialV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenProposalV2,
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
import {
    modelScreensV2MetadataSchema,
    type ModelScreensV2Metadata,
    type ScreensV2Result,
} from '@truebuild/contracts/model'
import {
    ModelApiClient,
    type ModelFetch,
    type ModelRequestContext,
    type ScreenRequest,
} from '../../../api/model-client'
import {
    documentJobContextKey,
    documentPrecomputeInputs,
    inputsFromDocumentMetadata,
} from '../../../api/document-client'
import { sha256Hex } from '../../documents/sha256'
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

// V2 production-route fixture boundary. These documents use the same complete shared composer/material and SHA-256
// as the API. Generated examples are explicitly synthetic with null unobserved telemetry. This is not a model run.

export type DocumentFixtureServerOptions = {
    readonly arrange?: (proposal: ScreenProposalV2, inputs: ScreenContextInputsV2) => ScreenProposalV2
    readonly generated?: readonly ScreenKindV2[]
    readonly failing?: readonly ScreenKindV2[]
    readonly gate?: Promise<void>
    readonly onRequest?: (request: ModelScreensV2Metadata) => void
    readonly transform?: (document: ScreenDocumentV2, inputs: ScreenContextInputsV2) => ScreenDocumentV2
    /** Explicit simulated upstream observations for metadata passthrough assertions ONLY. Never native/coverage proof. */
    readonly recordedMetadata?: boolean
}
export type DocumentFixtureServer = Pick<ModelApiClient, 'screensV2'> & { readonly requests: ModelScreensV2Metadata[] }

export function documentForV2(
    inputs: ScreenContextInputsV2,
    options: DocumentFixtureServerOptions = {},
): ScreenDocumentV2 {
    const material = documentMaterialV2(inputs)
    const generated = options.generated?.includes(inputs.kind) === true
    const recorded = options.recordedMetadata === true
    const proposal = buildFallbackProposalV2(material)
    const document = assembleDocumentV2(
        material,
        options.arrange?.(proposal, inputs) ?? proposal,
        {
            source: generated ? 'generated' : 'fallback',
            evidence: recorded ? 'live' : 'synthetic-fixture',
            fallbackReason: generated ? null : 'fixture',
            ...(recorded && generated
                ? {
                      model: 'muse-wonder-1.0',
                      effort: 'max',
                      timing: { timeToProviderMs: 15, providerMs: 3_400, parseValidateMs: 5, totalMs: 3_420 },
                      usage: { inputTokens: 1_200, cachedTokens: 0, outputTokens: 900, reasoningTokens: 700 },
                  }
                : {}),
        },
        { sha256Hex, now: (): Date => new Date('2026-01-01T00:00:00.000Z') },
    )
    return options.transform?.(document, inputs) ?? document
}

export function fixtureDocuments(options: DocumentFixtureServerOptions = {}): DocumentFixtureServer {
    const requests: ModelScreensV2Metadata[] = []
    type Progress = NonNullable<Extract<ScreensV2Result, { status: 'ok' }>['value']['progress']>
    type Job = { context: string; documents: Map<string, ScreenDocumentV2>; progress: Progress }
    const jobs = new Map<string, Job>()
    const fetch: ModelFetch = async (_url, init): Promise<Response> => {
        const metadata = modelScreensV2MetadataSchema.parse(JSON.parse(String((init.body as FormData).get('metadata'))))
        requests.push(metadata)
        options.onRequest?.(metadata)
        const unavailable = (): ScreensV2Result => ({
            status: 'unavailable',
            requestId: metadata.requestId,
            binding: null,
            code: 'provider_error',
            retryable: false,
        })
        const ok = (value: Extract<ScreensV2Result, { status: 'ok' }>['value']): ScreensV2Result => ({
            status: 'ok',
            requestId: metadata.requestId,
            mode: options.recordedMetadata ? 'model' : 'fixture',
            value,
        })
        const value: Extract<ScreensV2Result, { status: 'ok' }>['value'] = {
            document: null,
            documents: [],
            progress: null,
        }
        if (metadata.op === 'generate') {
            await options.gate
            return Response.json(
                options.failing?.includes(metadata.kind!)
                    ? unavailable()
                    : ok({ ...value, document: documentForV2(inputsFromDocumentMetadata(metadata), options) }),
            )
        }
        if (metadata.session === null) return Response.json(unavailable())
        const common = {
            session: metadata.session,
            uiState: metadata.uiState,
            completedStepIds: metadata.completedStepIds,
            requestedKinds: metadata.requestedKinds,
        }
        const context = documentJobContextKey(common)
        const key = `${metadata.session.manualId}:${metadata.session.revision}`
        if (metadata.op === 'precompute') {
            const documents = new Map<string, ScreenDocumentV2>()
            const expected = documentPrecomputeInputs(common)
            const progress: Progress = {
                manualId: metadata.session.manualId,
                revision: metadata.session.revision,
                contextKey: context,
                mode: 'full',
                items: expected.map((item) => ({
                    key: item.key,
                    kind: item.inputs.kind,
                    stepId: item.inputs.stepId,
                    state: 'queued',
                    screenId: null,
                })),
            }
            const job: Job = { context, documents, progress }
            jobs.set(key, job)
            const finish = (): void => {
                if (jobs.get(key) !== job) return
                job.progress = {
                    ...progress,
                    items: expected.map((item) => {
                        if (options.failing?.includes(item.inputs.kind))
                            return {
                                key: item.key,
                                kind: item.inputs.kind,
                                stepId: item.inputs.stepId,
                                state: 'failed',
                                screenId: null,
                            }
                        const document = documentForV2(item.inputs, options)
                        documents.set(item.key, document)
                        return {
                            key: item.key,
                            kind: item.inputs.kind,
                            stepId: item.inputs.stepId,
                            state: document.metadata.source === 'generated' ? 'ready' : 'fallback',
                            screenId: document.screenId,
                        }
                    }),
                }
            }
            const gate = options.gate
            if (gate === undefined) finish()
            else void gate.then(finish)
            return Response.json(ok({ ...value, progress: job.progress }))
        }
        const job = jobs.get(key)
        if (job === undefined || job.context !== context) return Response.json(ok(value))
        if (metadata.op === 'cancel') {
            jobs.delete(key)
            return Response.json(
                ok({
                    ...value,
                    progress: {
                        ...job.progress,
                        items: job.progress.items.map((item) => ({ ...item, state: 'cancelled' })),
                    },
                }),
            )
        }
        return Response.json(
            ok({
                ...value,
                progress: job.progress,
                documents: metadata.want.flatMap((name) => {
                    const document = job.documents.get(name)
                    return document === undefined ? [] : [document]
                }),
            }),
        )
    }
    const client = new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', secret: 'ui-fixture-key', fetch })
    return { requests, screensV2: client.screensV2.bind(client) }
}
