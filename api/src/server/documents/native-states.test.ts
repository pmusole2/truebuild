import { createHash } from 'node:crypto'
import {
    SCREEN_KINDS_V2,
    checkResultSchema,
    manualSessionSchema,
    questionResultSchema,
    type CheckResult,
    type ManualSession,
    type QuestionResult,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
} from '@truebuild/contracts'
import { screensV2GenerateRequest } from '@truebuild/contracts/model'
import { describe, expect, it } from 'vitest'

import { ModelApiClient, type ImageBytes } from '../../../../app/src/api/model-client'
import { PROOF_ASSETS } from '../../../../app/src/features/ai-effort-proof/assets'
import {
    createDocumentFixtureGenerator,
    fixtureArrangement,
    INVALID_QUESTIONS_MANUAL,
} from '../../providers/document-fixtures'
import { documentInputs, fullUi } from '../../test-support/document-inputs'
import { createNativeFixtureApp } from '../../test-support/native-fixture-app'
import { NATIVE_FIXTURE_ASSETS } from '../../test-support/native-fixture-assets'
import { stepFixtures } from '../../test-support/step-fixtures'
import { aiPolicyFromEnvironment } from '../ai-policy'
import type { BackgroundWork } from '../screens/service'
import { createDocumentService } from './service'

/**
 * The documents the native app asks for while a person works through a manual, composed by the isolated fixture runtime
 * for BOTH of its arrangements. Each must be published as `generated` (never the deterministic fallback), carry the
 * origin of a generated document on every component, and keep every mandatory witness in every variant.
 */

const work: BackgroundWork = {
    run: (_options, job) => job(),
    repair: (job) => job(),
    tryAcquire: () => () => {},
    acquire: async () => () => {},
}

const policy = aiPolicyFromEnvironment(
    {},
    {
        checkTimeoutMs: 8_000,
        parseModel: 'muse-spark-1.3',
        verdictModel: 'muse-spark-1.3',
        secondOpinionModel: 'muse-wonder-1.0',
    },
)

function service(): ReturnType<typeof createDocumentService> {
    return createDocumentService({
        provider: null,
        fixtureGenerator: createDocumentFixtureGenerator(),
        policy,
        runtimeMode: 'fixture',
        work,
    })
}

/** A manual id the fixture generator arranges the requested way (the choice is the generator's own, not copied here). */
function manualIdFor(arrangement: 'stacked' | 'cards'): string {
    for (let at = 0; at < 64; at += 1) {
        const id = `arranged-${at}`
        if (fixtureArrangement(id) === arrangement && id !== INVALID_QUESTIONS_MANUAL) return id
    }
    throw new Error('no manual id for arrangement')
}

/**
 * The session the native parser returns: every step explicitly declares its safety notes (an empty list is "none
 * printed"), which is what leaves a held result's source cited only by the coverage section.
 */
function nativeSession(session: ManualSession, manualId: string): ManualSession {
    return manualSessionSchema.parse({
        ...session,
        manualId,
        reviewedSteps: session.reviewedSteps.map((step) => ({ ...step, safetyNotes: step.safetyNotes ?? [] })),
    })
}

function refsOf(session: ManualSession, stepIndex: number): CheckResult['sourceRefs'] {
    const step = session.reviewedSteps[stepIndex]!
    return step.orientation.state === 'known' ? step.orientation.sourceRefs : step.sourceRefs
}

/** The three verdicts the native fixture provider returns, shaped exactly as it returns them. */
function checkResults(
    session: ManualSession,
    stepIndex: number,
): Record<'pass' | 'cannot_verify' | 'refuse', CheckResult> {
    const step = session.reviewedSteps[stepIndex]!
    const sourceRefs = refsOf(session, stepIndex)
    return {
        pass: checkResultSchema.parse({
            decision: 'pass',
            orientationAssessment: 'correct',
            reason: step.orientation.state === 'known' ? step.orientation.value.description : step.title,
            sourceRefs,
            observedRegion: null,
            missingEvidence: [],
        }),
        cannot_verify: checkResultSchema.parse({
            decision: 'cannot_verify',
            orientationAssessment: 'uncertain',
            reason: 'A closer look is needed.',
            sourceRefs,
            observedRegion: null,
            missingEvidence: ['The connection needs a closer look.'],
        }),
        refuse: checkResultSchema.parse({
            decision: 'refuse',
            orientationAssessment: 'reversed',
            reason: 'Check the connection against the manual picture.',
            sourceRefs,
            observedRegion: { x: 260 / 960, y: 190 / 720, width: 144 / 960, height: 350 / 720 },
            missingEvidence: [],
        }),
    }
}

function answerOf(session: ManualSession, stepIndex: number): QuestionResult {
    const step = session.reviewedSteps[stepIndex]!
    return questionResultSchema.parse({
        answer: step.orientation.state === 'known' ? step.orientation.value.description : step.title,
        sourceRefs: refsOf(session, stepIndex),
        missingEvidence: [],
    })
}

const QUESTION = 'Which way does it face?'
const heldPhoto = { capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false } }

/** The step-bound documents of one held photo, as the app requests them. */
function heldInputs(session: ManualSession, stepIndex: number): [string, ScreenContextInputsV2][] {
    const step = session.reviewedSteps[stepIndex]!
    const base = { session, stepId: step.stepId, captureId: 'cap-1', result: null, failure: null, uiState: heldPhoto }
    const checks = checkResults(session, stepIndex)
    const answer = answerOf(session, stepIndex)
    return [
        ...(['pass', 'cannot_verify', 'refuse'] as const).map((verdict): [string, ScreenContextInputsV2] => [
            `result ${verdict}`,
            { ...base, kind: 'result', result: { kind: 'check', value: checks[verdict] } },
        ]),
        ['answer', { ...base, kind: 'answer', result: { kind: 'question', question: QUESTION, value: answer } }],
        [
            'more over a held check and answer',
            {
                ...base,
                kind: 'more',
                result: { kind: 'check', value: checks.refuse },
                companionAnswer: { question: QUESTION, value: answer },
            },
        ],
        ['questions', { ...base, kind: 'questions' }],
        ['recovery', { ...base, kind: 'recovery', failure: 'provider_error' }],
        ['camera', { ...base, kind: 'camera', uiState: { camera: { mode: 'build-photo', permission: 'granted' } } }],
        ['guide', { ...base, kind: 'guide', captureId: null, uiState: null }],
    ]
}

function expectGenerated(document: ScreenDocumentV2): void {
    expect(document.metadata.source).toBe('generated')
    expect(document.metadata.fallbackReason).toBeNull()
    expect(Object.values(document.metadata.origins ?? {}).every((origin) => origin === 'generated')).toBe(true)
    // A waiting screen says one calm thing and offers exactly one action.
    for (const name of ['busy', 'pending'] as const) {
        expect(document.states[name]?.bar.secondary ?? null, name).toBeNull()
    }
}

describe.each(['stacked', 'cards'] as const)('native states in the %s arrangement', (arrangement) => {
    const manualId = manualIdFor(arrangement)

    it.each(stepFixtures().map((fixture) => [fixture.name, fixture.session] as const))(
        'publishes every held-photo document of %s as generated',
        async (_name, base) => {
            const session = nativeSession(base, manualId)
            const documents = service()
            for (const stepIndex of session.reviewedSteps.keys()) {
                for (const [label, inputs] of heldInputs(session, stepIndex)) {
                    const document = await documents.generate(inputs)
                    expect(document.kind, label).toBe(inputs.kind)
                    expect({
                        label,
                        source: document.metadata.source,
                        reason: document.metadata.fallbackReason,
                    }).toEqual({ label, source: 'generated', reason: null })
                    expectGenerated(document)
                }
            }
        },
    )

    it.each(
        SCREEN_KINDS_V2.filter(
            (kind): kind is ScreenKindV2 => kind !== 'questions' || manualId !== INVALID_QUESTIONS_MANUAL,
        ),
    )('publishes the %s screen as generated with every app state present', async (kind) => {
        const session = nativeSession(stepFixtures()[0]!.session, manualId)
        const document = await service().generate(documentInputs(kind, session, fullUi))
        expectGenerated(document)
    })
})

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const image = (index: number): ImageBytes => {
    const asset = PROOF_ASSETS[index]!
    return {
        bytes: Buffer.from(asset.base64, 'base64'),
        width: asset.width,
        height: asset.height,
        mimeType: 'image/png',
    }
}
const PAGE_ASSETS = [[0], [2, 3]] as const
const BUILD_ASSET = [1, 4] as const

describe('the real client verifies the documents of a real native journey', () => {
    it.each([0, 1])(
        'serves generated held-photo documents for native manual %i',
        async (manualIndex) => {
            const app = createNativeFixtureApp({
                parseDelayMs: 0,
                verdictDelayMs: 0,
                overlayDelayMs: 0,
                maskDelayMs: 0,
                questionDelayMs: 0,
                secondPassDelayMs: 0,
                jobSyncWaitMs: 200,
                stepDelayMs: 0,
            })
            const client = new ModelApiClient({
                baseUrl: 'http://127.0.0.1:3101',
                secret: 'truebuild-fixture-demo',
                fetch: async (url, init): Promise<Response> => app.fetch(new Request(url, init)),
            })
            const manual = stepFixtures()[manualIndex]!.session
            const pageAssets = PAGE_ASSETS[manualIndex]!
            const pages = manual.pages.map((page, index) => ({
                ...page,
                width: image(pageAssets[index]!).width,
                height: image(pageAssets[index]!).height,
                mimeType: 'image/png' as const,
                contentHash: NATIVE_FIXTURE_ASSETS[pageAssets[index]!]!.hash,
            }))
            const binding = { kind: 'manual' as const, manualId: manual.manualId, revision: manual.revision }
            const parsed = await client.parse(binding, pages, pageAssets.map(image), { requestId: 'native-parse' })
            if (parsed.status !== 'ok') throw new Error(`parse ${parsed.status}`)
            const session = manualSessionSchema.parse({
                ...manual,
                pages,
                parts: parsed.value.parts,
                reviewedSteps: parsed.value.steps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: true },
                })),
            })
            const sourceIds = pages.map((page) => page.pageId)
            const sources = pageAssets.map(image)
            const observation = image(BUILD_ASSET[manualIndex]!)
            const outcomes: { label: string; source: string; reason: string | null }[] = []
            for (const [stepIndex, step] of session.reviewedSteps.entries()) {
                const capture = {
                    ...binding,
                    kind: 'capture' as const,
                    stepId: step.stepId,
                    captureId: `cap-${stepIndex}`,
                }
                const checked = await client.check(capture, session, sourceIds, sources, observation, {
                    requestId: `native-check-${stepIndex}`,
                })
                if (checked.status !== 'ok') throw new Error(`check ${checked.status}`)
                const answered = await client.questions(
                    capture,
                    session,
                    sourceIds,
                    sources,
                    observation,
                    QUESTION,
                    { kind: 'point', x: 0.5, y: 0.5 },
                    { requestId: `native-question-${stepIndex}` },
                )
                if (answered.status !== 'ok') throw new Error(`question ${answered.status}`)
                const ui = {
                    capture: {
                        captureId: capture.captureId,
                        reusable: true,
                        target: null,
                        questionDraftPresent: false,
                    },
                }
                const base = {
                    session,
                    stepId: step.stepId,
                    captureId: capture.captureId,
                    result: null,
                    failure: null,
                    uiState: ui,
                }
                const requests: [string, ScreenContextInputsV2][] = [
                    ['result', { ...base, kind: 'result', result: { kind: 'check', value: checked.value } }],
                    [
                        'answer',
                        {
                            ...base,
                            kind: 'answer',
                            result: { kind: 'question', question: QUESTION, value: answered.value },
                        },
                    ],
                    [
                        'more',
                        {
                            ...base,
                            kind: 'more',
                            result: { kind: 'check', value: checked.value },
                            companionAnswer: { question: QUESTION, value: answered.value },
                        },
                    ],
                    [
                        'camera',
                        {
                            ...base,
                            kind: 'camera',
                            uiState: { camera: { mode: 'build-photo', permission: 'granted' } },
                        },
                    ],
                    ['recovery', { ...base, kind: 'recovery', failure: 'provider_error' }],
                    ['guide', { ...base, kind: 'guide', captureId: null, uiState: null }],
                ]
                for (const [label, inputs] of requests) {
                    const requestId = `native-${label}-${stepIndex}`
                    const response = await client.screensV2(screensV2GenerateRequest(requestId, inputs, digest), {
                        requestId,
                    })
                    if (response.status !== 'ok') throw new Error(`${label} ${response.status}`)
                    const document = response.value.document
                    if (document === null) throw new Error(`${label} carried no document`)
                    const { metadata } = document
                    outcomes.push({
                        label: `${label}#${stepIndex}`,
                        source: metadata.source,
                        reason: metadata.fallbackReason,
                    })
                }
            }
            expect(outcomes.filter((outcome) => outcome.source !== 'generated' || outcome.reason !== null)).toEqual([])
            expect(outcomes.length).toBe(session.reviewedSteps.length * 6)
        },
        60_000,
    )
})
