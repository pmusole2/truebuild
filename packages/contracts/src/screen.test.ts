import { describe, expect, it } from 'vitest'

import {
    APP_INTENTS,
    SCREEN_CATALOG_VERSION,
    SCREEN_KINDS,
    SCREEN_LIMITS,
    callTelemetrySchema,
    checkResultSchema,
    countScreenNodes,
    createDemoManual,
    parsedManualSchema,
    questionResultSchema,
    manualDirectionFacts,
    manualSessionSchema,
    requiredManualFacts,
    screenComponentPaths,
    screenContextJson,
    screenDocumentSchema,
    screenMatches,
    screenProposalSchema,
    screenUiStateSchema,
    segmentEventSchema,
    unresolvedSafetyNotes,
    type ManualSession,
    type ScreenContextInputs,
    type ScreenDocument,
} from './index'
import {
    modelCheckMetadataSchema,
    modelOverlayMetadataSchema,
    modelQuestionJobMetadataSchema,
    modelScreensMetadataSchema,
    overlayResultSchema,
    pendingResultSchema,
    screensGenerateRequest,
    unresolvedCriticalFacts,
} from './model'

const hash = 'a'.repeat(64)
const primary = {
    type: 'PrimaryAction',
    label: 'Take photo',
    icon: 'camera',
    intent: { intent: 'capture', target: 'take-photo' },
} as const
const instruction = {
    type: 'Instruction',
    text: 'Slide the bracket onto the post.',
    emphasis: 'strong',
    citations: [0],
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: 1,
        kind: 'guide',
        screenId: hash,
        bound: { manualId: 'm1', revision: 1, stepId: 's1', captureId: null, contextKey: hash },
        metadata: {
            source: 'fallback',
            evidence: 'synthetic-fixture',
            stage: 'step-page',
            model: null,
            effort: null,
            fallbackReason: 'fixture',
            repaired: false,
            cacheHit: false,
            catalogVersion: SCREEN_CATALOG_VERSION,
            promptVersion: 1,
            generatedAt: '2026-01-01T00:00:00.000Z',
            timing: { timeToProviderMs: null, providerMs: null, parseValidateMs: null, totalMs: null },
            usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null },
            droppedFacts: 0,
            forcedSafety: 0,
        },
        header: { type: 'ScreenHeader', title: 'Step 1', subtitle: null, trailing: null },
        body: [instruction],
        bar: { primary, secondary: null },
        sources: [{ pageId: 'p1', region: null }],
        ...overrides,
    }
}

describe('screen document catalog', (): void => {
    it('parses a minimal valid document and keeps the closed intent and kind sets exact', (): void => {
        expect(screenDocumentSchema.safeParse(document()).success).toBe(true)
        expect(APP_INTENTS).toEqual([
            'navigate',
            'capture',
            'check',
            'ask',
            'confirm',
            'retry',
            'open-details',
            'show-tips',
        ])
        expect(SCREEN_KINDS).toHaveLength(13)
    })

    it.each([
        ['an unknown block type', { body: [{ type: 'Html', html: '<b>x</b>' }] }],
        ['an extra style key', { body: [{ ...instruction, style: { color: 'red' } }] }],
        ['a missing header', { header: undefined }],
        ['a missing primary action', { bar: { secondary: null } }],
        ['a second primary in the secondary slot', { bar: { primary, secondary: primary } }],
        [
            'an unknown intent',
            { bar: { primary: { ...primary, intent: { intent: 'delete', target: 'all' } }, secondary: null } },
        ],
        [
            'a target that does not belong to the intent',
            { bar: { primary: { ...primary, intent: { intent: 'check', target: 'take-photo' } }, secondary: null } },
        ],
        ['a future version', { version: 2 }],
    ])('rejects %s', (_label, overrides): void => {
        expect(screenDocumentSchema.safeParse(document(overrides)).success).toBe(false)
    })

    it.each([
        'See <b>this</b>',
        'Open https://example.test/x',
        'Open xhttps://example.test/x',
        'Use www.example.test',
        'Run `rm -rf`',
        'Tap [here](x)',
        'Line\nbreak',
    ])('rejects non-plain text %j', (text): void => {
        expect(screenDocumentSchema.safeParse(document({ body: [{ ...instruction, text }] })).success).toBe(false)
    })

    it('limits the up-front instruction to twenty words', (): void => {
        const twenty = Array.from({ length: 20 }, () => 'a').join(' ')
        const long = `${twenty} b`
        expect(screenDocumentSchema.safeParse(document({ body: [{ ...instruction, text: twenty }] })).success).toBe(
            true,
        )
        expect(screenDocumentSchema.safeParse(document({ body: [{ ...instruction, text: long }] })).success).toBe(false)
    })

    it('accepts plain numeric comparisons without allowing HTML tags', (): void => {
        for (const text of ['Keep the load < 5 kg.', 'Keep the load <= +5 kg.', 'Rotate > -90 degrees.']) {
            expect(screenDocumentSchema.safeParse(document({ body: [{ ...instruction, text }] })).success).toBe(true)
        }
    })

    it('bounds depth structurally and total block count', (): void => {
        const group = (children: unknown[]): unknown => ({ type: 'Group', layout: 'stack', children })
        expect(screenDocumentSchema.safeParse(document({ body: [group([instruction])] })).success).toBe(true)
        expect(screenDocumentSchema.safeParse(document({ body: [group([group([instruction])])] })).success).toBe(false)
        const full = Array.from({ length: SCREEN_LIMITS.bodyNodes }, () =>
            group(Array.from({ length: 6 }, () => instruction)),
        )
        expect(countScreenNodes(full as never)).toBeGreaterThan(SCREEN_LIMITS.totalNodes)
        expect(screenDocumentSchema.safeParse(document({ body: full })).success).toBe(false)
        expect(
            screenDocumentSchema.safeParse(document({ body: Array.from({ length: 15 }, () => instruction) })).success,
        ).toBe(false)
    })

    it('keeps provenance honest: live generated content names its model, a synthetic example claims no observation', (): void => {
        const metadata = document().metadata as Record<string, unknown>
        const generated = { ...metadata, source: 'generated', evidence: 'live', fallbackReason: null }
        expect(screenDocumentSchema.safeParse(document({ metadata: { ...generated, model: null } })).success).toBe(
            false,
        )
        expect(
            screenDocumentSchema.safeParse(
                document({ metadata: { ...generated, model: 'muse-wonder-1.0', effort: 'max' } }),
            ).success,
        ).toBe(true)
        // An honest synthetic example may be `generated`, but only with nothing observed.
        const synthetic = { ...generated, evidence: 'synthetic-fixture' }
        expect(screenDocumentSchema.safeParse(document({ metadata: synthetic })).success).toBe(true)
        for (const claim of [
            { model: 'muse-wonder-1.0' },
            { effort: 'max' },
            { timing: { ...(metadata.timing as object), providerMs: 12 } },
            { usage: { ...(metadata.usage as object), outputTokens: 3 } },
        ]) {
            expect(screenDocumentSchema.safeParse(document({ metadata: { ...synthetic, ...claim } })).success).toBe(
                false,
            )
        }
        expect(
            screenDocumentSchema.safeParse(document({ metadata: { ...metadata, fallbackReason: null } })).success,
        ).toBe(false)
    })

    it('names the origin of every component and keeps the document source consistent with them', (): void => {
        const metadata = document().metadata as Record<string, unknown>
        const withOrigins = (origins: Record<string, string>, source: string): Record<string, unknown> => ({
            metadata: { ...metadata, source, fallbackReason: source === 'generated' ? null : 'timeout', origins },
        })
        const doc = document()
        expect(screenComponentPaths(doc as never)).toEqual(['header', 'body.0', 'bar.primary'])
        const mixed = { header: 'fallback', 'body.0': 'generated', 'bar.primary': 'fallback' }
        expect(screenDocumentSchema.safeParse(document(withOrigins(mixed, 'generated'))).success).toBe(true)
        // A document is not generated just because some deterministic component sits in it, and vice versa.
        expect(screenDocumentSchema.safeParse(document(withOrigins(mixed, 'fallback'))).success).toBe(false)
        const allFallback = { header: 'fallback', 'body.0': 'fallback', 'bar.primary': 'fallback' }
        expect(screenDocumentSchema.safeParse(document(withOrigins(allFallback, 'generated'))).success).toBe(false)
        expect(screenDocumentSchema.safeParse(document(withOrigins(allFallback, 'fallback'))).success).toBe(true)
        // Missing or unknown component paths are refused.
        const missing = { header: 'fallback', 'bar.primary': 'fallback' }
        expect(screenDocumentSchema.safeParse(document(withOrigins(missing, 'fallback'))).success).toBe(false)
        const extra = { ...allFallback, 'body.9': 'fallback' }
        expect(screenDocumentSchema.safeParse(document(withOrigins(extra, 'fallback'))).success).toBe(false)
    })

    it('cites only the document sources and keeps source figure regions inside the published block', (): void => {
        expect(screenDocumentSchema.safeParse(document({ body: [{ ...instruction, citations: [1] }] })).success).toBe(
            false,
        )
        expect(screenDocumentSchema.safeParse(document({ sources: undefined })).success).toBe(false)
        const hero = { type: 'HeroFigure', source: 'page', refId: 'p1', caption: null, fit: 'contain' }
        const region = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }
        expect(screenDocumentSchema.safeParse(document({ body: [{ ...hero, region }] })).success).toBe(true)
        expect(screenDocumentSchema.safeParse(document({ body: [hero] })).success).toBe(true)
        // A proposal selects an existing source by index; it cannot write the region itself.
        const proposal = { header: document().header, bar: { primary, secondary: null } }
        expect(screenProposalSchema.safeParse({ ...proposal, body: [{ ...hero, sourceRefIndex: 0 }] }).success).toBe(
            true,
        )
        expect(screenProposalSchema.safeParse({ ...proposal, body: [{ ...hero, region }] }).success).toBe(false)
    })

    it('does not let a model proposal carry identity, provenance or geometry', (): void => {
        const proposal = { header: document().header, body: [instruction], bar: { primary, secondary: null } }
        expect(screenProposalSchema.safeParse(proposal).success).toBe(true)
        expect(screenProposalSchema.safeParse({ ...proposal, metadata: document().metadata }).success).toBe(false)
        expect(screenProposalSchema.safeParse({ ...proposal, bound: document().bound }).success).toBe(false)
        const photo = {
            type: 'PhotoWithRegions',
            captureId: 'c1',
            showObserved: true,
            regions: [{ partId: 'p', role: 'next' }],
        }
        expect(screenProposalSchema.safeParse({ ...proposal, body: [photo] }).success).toBe(true)
        const withBox = { ...photo, regions: [{ partId: 'p', role: 'next', box: { x: 0, y: 0, width: 1, height: 1 } }] }
        expect(screenProposalSchema.safeParse({ ...proposal, body: [withBox] }).success).toBe(false)
    })

    it('publishes only in-image positive-area region geometry', (): void => {
        const photo = (box: unknown): unknown => ({
            type: 'PhotoWithRegions',
            captureId: 'c1',
            observed: null,
            regions: [{ partId: 'p', role: 'next', box }],
        })
        const parse = (box: unknown): boolean =>
            screenDocumentSchema.safeParse(document({ body: [photo(box)] })).success
        expect(parse({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 })).toBe(true)
        expect(parse({ x: 0.8, y: 0.1, width: 0.5, height: 0.5 })).toBe(false)
        expect(parse({ x: 0.1, y: 0.1, width: 0, height: 0.5 })).toBe(false)
    })

    it('matches a document only to the exact manual, revision, step, capture and context key it was bound to', (): void => {
        const parsed = screenDocumentSchema.parse(document()) as ScreenDocument
        const current = { manualId: 'm1', revision: 1, stepId: 's1', captureId: null, contextKey: hash }
        expect(screenMatches(parsed.bound, current)).toBe(true)
        expect(screenMatches(parsed.bound, { ...current, revision: 2 })).toBe(false)
        expect(screenMatches(parsed.bound, { ...current, stepId: 's2' })).toBe(false)
        expect(screenMatches(parsed.bound, { ...current, captureId: 'c2' })).toBe(false)
        expect(screenMatches(parsed.bound, { ...current, contextKey: 'b'.repeat(64) })).toBe(false)
    })
})

describe('screen route and follow-up contracts', (): void => {
    const session = createDemoManual()
    const base = {
        mode: 'model',
        requestId: 'r1',
        op: 'generate',
        kind: 'home',
        binding: null,
        session: null,
        stepId: null,
        captureId: null,
        result: null,
        failure: null,
        focusStepId: null,
        want: [],
    }
    const binding = { kind: 'manual', manualId: session.manualId, revision: session.revision }
    const check = {
        decision: 'cannot_verify',
        reason: 'Cannot tell.',
        sourceRefs: [],
        observedRegion: null,
        missingEvidence: ['A clearer view'],
    }

    it('lets Home, add and error compose before any manual exists, and requires context for the rest', (): void => {
        expect(modelScreensMetadataSchema.safeParse(base).success).toBe(true)
        expect(modelScreensMetadataSchema.safeParse({ ...base, kind: 'error', failure: 'timeout' }).success).toBe(true)
        expect(modelScreensMetadataSchema.safeParse({ ...base, kind: 'error' }).success).toBe(false)
        expect(modelScreensMetadataSchema.safeParse({ ...base, kind: 'guide' }).success).toBe(false)
        expect(modelScreensMetadataSchema.safeParse({ ...base, kind: null }).success).toBe(false)
    })

    it('binds step screens to the supplied session revision and a real step', (): void => {
        const step = { ...base, kind: 'guide', binding, session, stepId: 'step-1' }
        expect(modelScreensMetadataSchema.safeParse(step).success).toBe(true)
        expect(modelScreensMetadataSchema.safeParse({ ...step, stepId: 'missing' }).success).toBe(false)
        expect(modelScreensMetadataSchema.safeParse({ ...step, binding: { ...binding, revision: 9 } }).success).toBe(
            false,
        )
        expect(modelScreensMetadataSchema.safeParse({ ...step, binding: null }).success).toBe(false)
    })

    it('requires the current result and its capture identity for result and answer screens', (): void => {
        const result = { ...base, kind: 'result', binding, session, stepId: 'step-1' }
        expect(modelScreensMetadataSchema.safeParse(result).success).toBe(false)
        const withCheck = { ...result, captureId: 'cap-1', result: { kind: 'check', value: check } }
        expect(modelScreensMetadataSchema.safeParse(withCheck).success).toBe(true)
        expect(modelScreensMetadataSchema.safeParse({ ...withCheck, captureId: null }).success).toBe(false)
        const answer = { ...withCheck, kind: 'answer' }
        expect(modelScreensMetadataSchema.safeParse(answer).success).toBe(false)
    })

    it('reads progress and cancels by binding alone, without resending the session', (): void => {
        for (const op of ['progress', 'cancel'] as const) {
            expect(modelScreensMetadataSchema.safeParse({ ...base, op, kind: null, binding }).success).toBe(true)
            expect(modelScreensMetadataSchema.safeParse({ ...base, op, kind: null }).success).toBe(false)
        }
        expect(
            modelScreensMetadataSchema.safeParse({ ...base, op: 'precompute', kind: null, binding, session }).success,
        ).toBe(true)
        expect(modelScreensMetadataSchema.safeParse({ ...base, op: 'precompute', kind: null }).success).toBe(false)
    })

    it('accepts follow-up offers only as optional additions and carries SAM masks only within bounds', (): void => {
        expect(checkResultSchema.safeParse(check).success).toBe(true)
        const offered = {
            ...check,
            followUps: { overlay: { status: 'available', model: 'muse-wonder-1.0', token: 't' } },
        }
        expect(checkResultSchema.safeParse(offered).success).toBe(true)
        expect(
            checkResultSchema.safeParse({ ...check, followUps: { overlay: { status: 'available', token: 't' } } })
                .success,
        ).toBe(false)
        const snapshot = (mask: Record<string, unknown>): unknown => ({
            type: 'snapshot',
            snapshot: {
                binding: { kind: 'capture', manualId: 'm', revision: 1, stepId: 's', captureId: 'c' },
                streamId: 'x',
                frameIndex: 0,
                capturedAt: '2026-01-01T00:00:00.000Z',
                records: [{ objectId: 'o', label: 'divider', box: { x: 0, y: 0, width: 0.5, height: 0.5 }, ...mask }],
                complete: false,
            },
        })
        expect(segmentEventSchema.safeParse(snapshot({})).success).toBe(true)
        expect(segmentEventSchema.safeParse(snapshot({ mask: { width: 20, height: 16, path: 'M0 0Z' } })).success).toBe(
            true,
        )
        expect(
            segmentEventSchema.safeParse(snapshot({ mask: { width: 20, height: 16, path: 'M'.repeat(12_001) } }))
                .success,
        ).toBe(false)
        // Only path data is a path: markup, a URL, a script or text that is not a path command is refused.
        for (const path of [
            '<svg onload=1>',
            'M0 0 L1 1 <script>',
            'javascript:alert(1)',
            'url(#x)',
            'L0 0',
            ' M0 0',
            'M0 0 Z; rm',
        ]) {
            expect(
                segmentEventSchema.safeParse(snapshot({ mask: { width: 20, height: 16, path } })).success,
                path,
            ).toBe(false)
        }
        expect(
            segmentEventSchema.safeParse(
                snapshot({ mask: { width: 20, height: 16, path: 'M0.5,1e-3 l-2 3.25 c1 1 2 2 3 3 A1 1 0 0 1 2 2 Z' } }),
            ).success,
        ).toBe(true)
    })

    it('has no decision field on the overlay result and carries one-use tokens only on the bound follow-up request', (): void => {
        const overlay = { model: 'muse-wonder-1.0', effort: 'max', observedRegion: null }
        expect(overlayResultSchema.safeParse(overlay).success).toBe(true)
        expect(overlayResultSchema.safeParse({ ...overlay, decision: 'pass' }).success).toBe(false)
        const request = {
            mode: 'model',
            requestId: 'r',
            binding: {
                kind: 'capture',
                manualId: session.manualId,
                revision: session.revision,
                stepId: 'step-1',
                captureId: 'c',
            },
            session,
            sourcePageIds: ['demo-page-1'],
            observation: { mimeType: 'image/png', width: 20, height: 16 },
        }
        expect(modelOverlayMetadataSchema.safeParse({ ...request, overlayToken: 't' }).success).toBe(true)
        expect(modelOverlayMetadataSchema.safeParse(request).success).toBe(false)
        const pending = {
            status: 'pending',
            requestId: 'r',
            binding: request.binding,
            ticket: 't',
            retryAfterMs: 2000,
            expiresInMs: 60000,
        }
        expect(pendingResultSchema.safeParse(pending).success).toBe(true)
        expect(
            modelQuestionJobMetadataSchema.safeParse({
                mode: 'model',
                requestId: 'r',
                binding: request.binding,
                ticket: 't',
            }).success,
        ).toBe(true)
    })

    it('carries optional observed call telemetry where unknown stays null and old results still parse', (): void => {
        const telemetry = {
            stage: 'verdict',
            model: 'muse-spark-1.3',
            effort: 'low',
            timing: {
                timeToProviderMs: 12,
                paceWaitMs: 0,
                networkMs: 3000,
                bodyMs: 4,
                providerMs: 3004,
                parseValidateMs: 2,
                totalMs: 3018,
            },
            usage: { inputTokens: 100, cachedTokens: null, outputTokens: 20, reasoningTokens: null },
        }
        expect(callTelemetrySchema.safeParse(telemetry).success).toBe(true)
        expect(
            callTelemetrySchema.safeParse({ ...telemetry, usage: { ...telemetry.usage, outputTokens: -1 } }).success,
        ).toBe(false)
        expect(callTelemetrySchema.safeParse({ ...telemetry, effort: 'none' }).success).toBe(false)
        expect(checkResultSchema.safeParse({ ...check, telemetry }).success).toBe(true)
        expect(checkResultSchema.safeParse(check).success).toBe(true)
        expect(
            questionResultSchema.safeParse({ answer: 'a', sourceRefs: [], missingEvidence: [], telemetry }).success,
        ).toBe(true)
        expect(
            overlayResultSchema.safeParse({ model: 'muse-wonder-1.0', effort: 'max', observedRegion: null, telemetry })
                .success,
        ).toBe(true)
        expect(parsedManualSchema.safeParse({ parts: [], steps: [], unknowns: [], telemetry }).success).toBe(true)
    })

    it('accepts an optional completion witness only for the completion screen', (): void => {
        const completion = { ...base, kind: 'completion', binding, session }
        expect(modelScreensMetadataSchema.safeParse(completion).success).toBe(true)
        expect(modelScreensMetadataSchema.safeParse({ ...completion, completedStepIds: ['step-1'] }).success).toBe(true)
        expect(
            modelScreensMetadataSchema.safeParse({ ...base, kind: 'home', completedStepIds: ['step-1'] }).success,
        ).toBe(false)
    })

    it('accepts an optional generated-screen identity on the check metadata and nothing else about it', (): void => {
        const request = {
            mode: 'model',
            requestId: 'r',
            binding: {
                kind: 'capture',
                manualId: session.manualId,
                revision: session.revision,
                stepId: 'step-1',
                captureId: 'c',
            },
            session,
            sourcePageIds: ['demo-page-1'],
            observation: { mimeType: 'image/png', width: 20, height: 16 },
        }
        const screen = { screenId: hash, contextKey: hash }
        expect(modelCheckMetadataSchema.safeParse(request).success).toBe(true)
        expect(modelCheckMetadataSchema.safeParse({ ...request, screen }).success).toBe(true)
        expect(modelCheckMetadataSchema.safeParse({ ...request, screen: { ...screen, text: 'x' } }).success).toBe(false)
        expect(
            modelCheckMetadataSchema.safeParse({ ...request, screen: { screenId: 'short', contextKey: hash } }).success,
        ).toBe(false)
    })
})

const here = { pageId: 'demo-page-1', region: null }
const knownFact = (value: string, ref: { pageId: string; region: unknown } = here): Record<string, unknown> => ({
    state: 'known',
    value,
    sourceRefs: [ref],
})

function withStep(change: (step: Record<string, unknown>) => void): ManualSession {
    const value = createDemoManual() as unknown as { reviewedSteps: Record<string, unknown>[] }
    change(value.reviewedSteps[0]!)
    return manualSessionSchema.parse(value)
}

describe('typed manual safety notes and required manual facts', (): void => {
    const NOTE = 'Keep children away from the moving mechanism.'

    it('carries optional source-witnessed safety notes through the step, session and parse schemas', (): void => {
        const session = withStep((step) => {
            step.safetyNotes = [{ noteId: 'n1', note: knownFact(NOTE) }]
        })
        expect(session.reviewedSteps[0]!.safetyNotes?.[0]?.note).toMatchObject({ state: 'known', value: NOTE })
        // Old stored sessions have no field at all and still parse.
        expect(manualSessionSchema.safeParse(createDemoManual()).success).toBe(true)
        const parsed = parsedManualSchema.safeParse({
            parts: createDemoManual().parts,
            steps: [
                {
                    ...createDemoManual().reviewedSteps[0]!,
                    correction: null,
                    safetyNotes: [{ noteId: 'n1', note: knownFact(NOTE) }],
                },
            ],
            unknowns: [],
        })
        expect(parsed.success).toBe(true)
    })

    it('rejects duplicate note ids, a note citing an unresolved page, and an uncited known note', (): void => {
        const notes = (list: unknown): ManualSession => {
            const value = createDemoManual() as unknown as { reviewedSteps: Record<string, unknown>[] }
            value.reviewedSteps[0]!.safetyNotes = list
            return value as unknown as ManualSession
        }
        const note = { noteId: 'n1', note: knownFact(NOTE) }
        expect(manualSessionSchema.safeParse(notes([note, note])).success).toBe(false)
        expect(
            manualSessionSchema.safeParse(
                notes([{ noteId: 'n1', note: knownFact(NOTE, { pageId: 'missing-page', region: null }) }]),
            ).success,
        ).toBe(false)
        expect(
            manualSessionSchema.safeParse(
                notes([{ noteId: 'n1', note: { state: 'known', value: NOTE, sourceRefs: [] } }]),
            ).success,
        ).toBe(false)
    })

    it('keeps an unreadable safety note unresolved: it blocks a reviewed manual and is reported, never displayed as a fact', (): void => {
        const unreadable = { noteId: 'n2', note: { state: 'unknown', reason: 'The warning box is cut off.' } }
        const value = createDemoManual() as unknown as { reviewedSteps: Record<string, unknown>[] }
        value.reviewedSteps[0]!.safetyNotes = [unreadable]
        expect(manualSessionSchema.safeParse(value).success).toBe(false)
        const draft = createDemoManual() as unknown as ManualSession & { reviewStatus: string }
        const unreviewed = manualSessionSchema.parse({
            ...draft,
            reviewStatus: 'unreviewed',
            reviewedSteps: [],
            rawExtraction: {
                parts: draft.parts,
                steps: [{ ...draft.reviewedSteps[0]!, correction: null, safetyNotes: [unreadable] }],
                unknowns: [],
            },
        })
        expect(unresolvedSafetyNotes(unreviewed, 'step-1')).toEqual([
            { noteId: 'n2', reason: 'The warning box is cut off.' },
        ])
        expect(requiredManualFacts(unreviewed, 'step-1').some((fact) => fact.text.includes('cut off'))).toBe(false)
        expect(
            unresolvedCriticalFacts({
                parts: draft.parts,
                reviewedSteps: [{ ...draft.reviewedSteps[0]!, safetyNotes: [unreadable] } as never],
            }),
        ).toContain('Step 1, safety note n2: The warning box is cut off.')
    })

    it('requires every known explicit safety note, complete and with its own actual source references', (): void => {
        const other = { pageId: 'demo-page-1', region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }
        const session = withStep((step) => {
            step.safetyNotes = [
                { noteId: 'n1', note: knownFact(NOTE) },
                { noteId: 'n2', note: knownFact('Rotate the panel -90 degrees. Keep load < 5 kg.', other) },
            ]
        })
        const required = requiredManualFacts(session, 'step-1')
        expect(required.map((fact) => [fact.factId, fact.basis, fact.text])).toEqual([
            ['safety:n1', 'safety-note', NOTE],
            ['safety:n2', 'safety-note', 'Rotate the panel -90 degrees. Keep load < 5 kg.'],
        ])
        expect(required[1]!.sourceRefs).toEqual([other])
        // Directions stay available to a composition but are not forced once the step has an explicit classification.
        const all = manualDirectionFacts(session, 'step-1')
        expect(all.filter((fact) => fact.basis === 'direction').map((fact) => fact.factId)).toEqual([
            'orientation',
            'connection',
            'check:groove-inward',
            'correction:turn-panel',
        ])
    })

    it('conservatively requires every known physical direction when the step has no explicit safety classification', (): void => {
        const session = withStep((step) => {
            step.visibleChecks = [{ checkId: 'c1', description: knownFact(NOTE) }]
            step.alternatives = [
                { alternativeId: 'a', title: 'Use tape', description: 'Hold it with tape.', sourceRefs: [here] },
                { alternativeId: 'b', title: 'Use clamp', description: 'Hold it with a clamp.', sourceRefs: [here] },
            ]
            step.selectedAlternativeId = 'b'
        })
        const required = requiredManualFacts(session, 'step-1')
        expect(required.map((fact) => fact.factId)).toEqual([
            'title',
            'alternative:b',
            'orientation',
            'connection',
            'check:c1',
            'correction:turn-panel',
        ])
        expect(required.every((fact) => fact.basis === 'unclassified-step')).toBe(true)
        // The unclassified imperative sentence survives with no keyword classifier involved.
        expect(required.find((fact) => fact.factId === 'check:c1')?.text).toBe(NOTE)
        expect(required.find((fact) => fact.factId === 'alternative:b')?.text).toBe('Use clamp. Hold it with a clamp.')
    })

    it('retains an unclassified step title that may itself state a hazard', (): void => {
        const title = 'Keep children away from the moving mechanism.'
        const session = withStep((step) => {
            step.title = title
            delete step.safetyNotes
        })
        expect(requiredManualFacts(session, 'step-1')).toContainEqual({
            factId: 'title',
            kind: 'title',
            basis: 'unclassified-step',
            text: title,
            sourceRefs: session.reviewedSteps[0]!.sourceRefs,
        })
    })

    it('treats an explicit empty classification as classified, and an unknown or other step as having no facts', (): void => {
        const session = withStep((step) => {
            step.safetyNotes = []
        })
        expect(requiredManualFacts(session, 'step-1')).toEqual([])
        expect(manualDirectionFacts(session, 'step-1').length).toBeGreaterThan(0)
        expect(requiredManualFacts(session, 'nope')).toEqual([])
    })

    it('reads the known raw extraction of a session that has not been reviewed yet', (): void => {
        const draft = createDemoManual()
        const unreviewed = manualSessionSchema.parse({
            ...draft,
            reviewStatus: 'unreviewed',
            reviewedSteps: [],
            rawExtraction: {
                parts: draft.parts,
                steps: [
                    {
                        ...draft.reviewedSteps[0]!,
                        correction: null,
                        visibleChecks: [{ checkId: 'c2', description: { state: 'unknown', reason: 'Not legible.' } }],
                    },
                ],
                unknowns: [],
            },
        })
        const ids = requiredManualFacts(unreviewed, 'step-1').map((fact) => fact.factId)
        expect(ids).toContain('orientation')
        // An unreadable fact is never published as a fact.
        expect(ids).not.toContain('check:c2')
    })
})

describe('shared screen context identity', (): void => {
    const base = (): ScreenContextInputs => ({
        kind: 'guide',
        session: createDemoManual(),
        stepId: 'step-1',
        captureId: null,
        result: null,
        failure: null,
    })
    const key = (inputs: ScreenContextInputs): string => screenContextJson(inputs)

    it('is canonical, pure JSON that does not depend on key order', (): void => {
        const a = key(base())
        const reverseKeys = (value: unknown): unknown =>
            Array.isArray(value)
                ? value.map(reverseKeys)
                : typeof value === 'object' && value !== null
                  ? Object.fromEntries(
                        Object.entries(value)
                            .reverse()
                            .map(([name, entry]) => [name, reverseKeys(entry)]),
                    )
                  : value
        const reordered = base()
        reordered.session = reverseKeys(reordered.session) as ManualSession
        expect(JSON.stringify(reordered.session)).not.toBe(JSON.stringify(base().session))
        expect(key(reordered)).toBe(a)
        expect(() => JSON.parse(a)).not.toThrow()
    })

    it('changes with every used identity: page media, fact values and sources, safety notes, result and completion', (): void => {
        const keys = new Set<string>([key(base())])
        const edit = (change: (value: ManualSession) => void): string => {
            const inputs = base()
            change(inputs.session!)
            return key(inputs)
        }
        keys.add(edit((value) => void (value.pages[0] = { ...value.pages[0]!, contentHash: 'f'.repeat(64) })))
        keys.add(edit((value) => void (value.pages[0] = { ...value.pages[0]!, assetId: 'other-asset' })))
        keys.add(edit((value) => void (value.pages[0] = { ...value.pages[0]!, height: value.pages[0]!.height + 1 })))
        keys.add(edit((value) => void (value.reviewedSteps[0]!.title = 'Another title')))
        keys.add(
            edit(
                (value) =>
                    void (value.reviewedSteps[0]!.safetyNotes = [
                        { noteId: 'n', note: { state: 'known', value: 'Wear gloves.', sourceRefs: [here] } },
                    ]),
            ),
        )
        keys.add(
            edit(
                (value) =>
                    void (value.parts[1] = {
                        ...value.parts[1]!,
                        name: { state: 'known', value: 'Renamed', sourceRefs: [here] },
                    }),
            ),
        )
        expect(keys.size).toBe(7)
        // Review state is part of the identity: the same facts reviewed or not are different screens.
        const raw = base()
        raw.session = manualSessionSchema.parse({
            ...raw.session,
            reviewStatus: 'unreviewed',
            reviewedSteps: [],
            rawExtraction: raw.session!.rawExtraction,
        })
        expect(key(raw)).not.toBe(key(base()))
    })

    it('uses the used UI state per kind, and ignores unused or volatile state', (): void => {
        const home: ScreenContextInputs = {
            kind: 'home',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
        }
        const entry = {
            manualId: 'm1',
            title: 'Shelf',
            updatedAt: '2026-01-01T00:00:00.000Z',
            stopStepId: null,
            completed: 1,
            total: 4,
            firstPageId: 'p1',
        }
        const library = (completed: number, updatedAt: string): ScreenContextInputs => ({
            ...home,
            uiState: { library: { entries: [{ ...entry, completed, updatedAt }], soleManualId: 'm1' } },
        })
        expect(key(library(1, '2026-01-01T00:00:00.000Z'))).not.toBe(key(library(2, '2026-01-01T00:00:00.000Z')))
        // updatedAt is not shown to the provider, so it is not part of the identity.
        expect(key(library(1, '2026-01-01T00:00:00.000Z'))).toBe(key(library(1, '2027-01-01T00:00:00.000Z')))
        // Capture state is not used by Home.
        expect(
            key({
                ...home,
                uiState: { capture: { captureId: 'c', reusable: true, target: null, questionDraftPresent: false } },
            }),
        ).toBe(key(home))
        const guide = base()
        const capture = { captureId: 'c', reusable: true, target: null, questionDraftPresent: false }
        // A step's guide is prepared before any photo exists: a held capture never regenerates it.
        expect(key({ ...guide, uiState: { capture } })).toBe(key(guide))
        const questions: ScreenContextInputs = { ...guide, kind: 'questions' }
        const held = { ...questions, uiState: { capture } }
        expect(key(held)).not.toBe(key(questions))
        expect(key({ ...held, uiState: { capture: { ...capture, questionDraftPresent: true } } })).not.toBe(key(held))
    })

    it('ignores result fields the provider never sees (telemetry, one-use tokens) but not the decision geometry', (): void => {
        const check = {
            decision: 'refuse' as const,
            reason: 'Wrong way.',
            sourceRefs: [here],
            observedRegion: null,
            missingEvidence: [],
        }
        const result = (value: Record<string, unknown>): ScreenContextInputs => ({
            ...base(),
            kind: 'result',
            captureId: 'c1',
            result: { kind: 'check', value: { ...check, ...value } as never },
        })
        expect(key(result({}))).toBe(
            key(
                result({
                    followUps: { overlay: { status: 'available', model: 'muse-wonder-1.0', token: 't1' } },
                    telemetry: undefined,
                }),
            ),
        )
        expect(key(result({}))).not.toBe(key(result({ observedRegion: { x: 0, y: 0, width: 0.5, height: 0.5 } })))
        expect(key(result({}))).not.toBe(key(result({ reason: 'Other.' })))
    })

    it('is portable: the module imports nothing from Node', async (): Promise<void> => {
        const { readFileSync } = await import('node:fs')
        for (const file of ['screen-context.ts', 'screen-facts.ts', 'screen.ts']) {
            const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
            expect(source).not.toMatch(/from 'node:/u)
            expect(source).not.toMatch(/require\(/u)
        }
    })

    it('builds the request from the same inputs so the key and the request cannot drift', (): void => {
        const inputs = base()
        const request = screensGenerateRequest('r1', {
            ...inputs,
            uiState: {
                capture: {
                    captureId: 'c',
                    reusable: true,
                    target: { kind: 'part', partId: 'side-panel' },
                    questionDraftPresent: true,
                },
            },
        })
        expect(modelScreensMetadataSchema.safeParse(request).success).toBe(true)
        expect(request).toMatchObject({ op: 'generate', kind: 'guide', stepId: 'step-1', want: [], focusStepId: null })
        expect(request.binding).toEqual({ kind: 'manual', manualId: 'demo-divider', revision: 1 })
    })
})

describe('screen UI state', (): void => {
    const valid = {
        library: {
            entries: [
                {
                    manualId: 'm1',
                    title: 'Shelf',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    stopStepId: 's1',
                    completed: 1,
                    total: 4,
                    firstPageId: 'p1',
                },
            ],
            soleManualId: 'm1',
        },
        pages: {
            items: [{ pageId: 'p1', width: 100, height: 80 }],
            maxPages: 8,
            canRead: true,
            languageOptions: ['en', 'fr'],
        },
        review: {
            currentQuestion: {
                questionId: 's1:orientation',
                kind: 'orientation',
                stepId: 's1',
                stepOrder: 1,
                reason: 'Not shown on the page.',
                parts: [{ partId: 'side-panel', label: 'Side panel' }],
            },
            blockers: 0,
            canConfirm: false,
        },
        capture: { captureId: 'c1', reusable: true, target: { kind: 'point' }, questionDraftPresent: false },
        sections: ['settings', 'about-this-check'],
    }

    it('accepts library summaries, the current review question, page, capture and section state', (): void => {
        expect(screenUiStateSchema.safeParse(valid).success).toBe(true)
        expect(screenUiStateSchema.safeParse({}).success).toBe(true)
        expect(modelScreensMetadataSchema.shape.uiState.safeParse(valid).success).toBe(true)
    })

    it.each([
        ['a raw question draft', { capture: { ...valid.capture, draft: 'text' } }],
        ['a transport ticket', { capture: { ...valid.capture, ticket: 't' } }],
        ['an unknown section', { sections: ['admin'] }],
        [
            'too many library entries',
            { library: { entries: Array.from({ length: 101 }, () => valid.library.entries[0]), soleManualId: null } },
        ],
        ['a question draft body instead of presence', { capture: { ...valid.capture, questionDraftPresent: 'hello' } }],
    ])('rejects %s', (_label, change): void => {
        expect(screenUiStateSchema.safeParse({ ...valid, ...change }).success).toBe(false)
    })
})

describe('full-screen catalog blocks', (): void => {
    const proposal = (body: unknown[]): unknown => ({
        header: { type: 'ScreenHeader', title: 'Your manuals', subtitle: null, trailing: null },
        body,
        bar: { primary, secondary: null },
    })
    const blocks: [string, Record<string, unknown>][] = [
        [
            'ManualLibrary',
            { type: 'ManualLibrary', entries: 'recent', layout: 'cards', showProgress: true, emptyText: null },
        ],
        [
            'ManualLibrary listed',
            {
                type: 'ManualLibrary',
                entries: { manualIds: ['m1'] },
                layout: 'rows',
                showProgress: false,
                emptyText: 'No manuals yet.',
            },
        ],
        [
            'PageGallery',
            {
                type: 'PageGallery',
                pages: 'session',
                layout: 'grid',
                showNumbers: true,
                action: { intent: 'capture', target: 'add-page' },
            },
        ],
        [
            'FactPrompt',
            {
                type: 'FactPrompt',
                questionRef: 'current',
                prompt: 'Which way does it face?',
                detail: null,
                citations: [0],
            },
        ],
        [
            'FactEditor',
            {
                type: 'FactEditor',
                questionRef: 'current',
                kind: 'orientation',
                label: 'Orientation',
                saveLabel: 'Save',
                cancelLabel: 'Cancel',
            },
        ],
        [
            'QuestionComposer',
            {
                type: 'QuestionComposer',
                captureRef: 'current',
                prompt: null,
                partScope: 'step-parts',
                submitLabel: 'Ask',
            },
        ],
        [
            'SourceDetails',
            { type: 'SourceDetails', label: 'Manual pages', sources: [0], fit: 'contain', initiallyOpen: false },
        ],
        [
            'ActionLink',
            {
                type: 'ActionLink',
                label: 'See the manual',
                icon: 'info',
                intent: { intent: 'open-details', target: 'sources' },
                emphasis: 'quiet',
            },
        ],
        [
            'CameraGuidance',
            { type: 'CameraGuidance', cue: 'Keep the whole step in view', pill: null, tipTarget: 'camera-shutter' },
        ],
        ['ManualDirections', { type: 'ManualDirections', factIds: ['safety:n1', 'orientation'], emphasis: 'strong' }],
    ]

    it.each(blocks)('accepts a model proposal with %s', (_name, block): void => {
        expect(screenProposalSchema.safeParse(proposal([block])).success).toBe(true)
    })

    it.each(blocks)('rejects styles, geometry, markup and unknown keys on %s', (_name, block): void => {
        for (const extra of [
            { style: { color: 'red' } },
            { x: 0.1 },
            { html: '<b>x</b>' },
            { url: 'https://x.test' },
        ]) {
            expect(screenProposalSchema.safeParse(proposal([{ ...block, ...extra }])).success).toBe(false)
        }
    })

    it('keeps the catalog closed on text, ids and bounds', (): void => {
        const bad: Record<string, unknown>[] = [
            {
                type: 'ManualLibrary',
                entries: { manualIds: Array.from({ length: 13 }, (_v, i) => `m${i}`) },
                layout: 'rows',
                showProgress: true,
                emptyText: null,
            },
            {
                type: 'ManualLibrary',
                entries: 'recent',
                layout: 'cards',
                showProgress: true,
                emptyText: 'See https://x.test',
            },
            { type: 'ManualDirections', factIds: [], emphasis: 'normal' },
            {
                type: 'ManualDirections',
                factIds: Array.from({ length: 305 }, (_v, i) => `check:${i}`),
                emphasis: 'normal',
            },
            { type: 'SourceDetails', label: 'Manual pages', sources: [], fit: 'cover', initiallyOpen: true },
            { type: 'CameraGuidance', cue: 'Frame it', pill: null, tipTarget: 'home-add-not-a-target' },
            {
                type: 'FactEditor',
                questionRef: 'next',
                kind: 'orientation',
                label: 'a',
                saveLabel: 'b',
                cancelLabel: 'c',
            },
        ]
        for (const block of bad) expect(screenProposalSchema.safeParse(proposal([block])).success).toBe(false)
    })

    it('puts only text-like leaves in a Group and never a heavy list, editor or composer block', (): void => {
        const group = (child: unknown): unknown => ({ type: 'Group', layout: 'stack', children: [child] })
        expect(screenProposalSchema.safeParse(proposal([group(blocks[7]![1])])).success).toBe(true)
        for (const [name, block] of blocks.filter(([n]) => n !== 'ActionLink')) {
            expect(screenProposalSchema.safeParse(proposal([group(block)])).success, name).toBe(false)
        }
    })

    it('publishes manual facts outside the node bound, with directions that reference only published facts', (): void => {
        const fact = (
            factId: string,
            placement: 'body' | 'remainder',
            basis = 'safety-note',
        ): Record<string, unknown> => ({
            factId,
            kind: factId.startsWith('safety') ? 'safety' : 'check',
            basis,
            text: 'Keep children away from the moving mechanism.',
            sourceRefs: [here],
            placement,
        })
        const facts = [fact('safety:n1', 'body'), fact('safety:n2', 'remainder')]
        const origins = (n: number): Record<string, string> => ({
            header: 'fallback',
            'body.0': 'fallback',
            'bar.primary': 'fallback',
            ...Object.fromEntries(Array.from({ length: n }, (_v, i) => [`facts.${i}`, 'fallback'])),
        })
        const published = (
            body: unknown[],
            manualFacts: unknown[],
            metadataOrigins = origins(manualFacts.length),
        ): Record<string, unknown> =>
            document({
                body,
                manualFacts,
                metadata: { ...(document().metadata as object), origins: metadataOrigins },
            })
        const directions = { type: 'ManualDirections', factIds: ['safety:n1'], emphasis: 'strong' }
        expect(screenDocumentSchema.safeParse(published([directions], facts)).success).toBe(true)
        expect(
            screenComponentPaths({ body: [directions], bar: { secondary: null }, manualFacts: facts as never }),
        ).toEqual(['header', 'body.0', 'bar.primary', 'facts.0', 'facts.1'])
        // Unknown id, duplicate id, a body fact nobody references, and a referenced fact marked remainder.
        expect(
            screenDocumentSchema.safeParse(published([{ ...directions, factIds: ['safety:zz'] }], facts)).success,
        ).toBe(false)
        expect(
            screenDocumentSchema.safeParse(
                published([directions, directions], facts, { ...origins(2), 'body.1': 'fallback' }),
            ).success,
        ).toBe(false)
        expect(screenDocumentSchema.safeParse(published([instruction], facts, origins(2))).success).toBe(false)
        expect(
            screenDocumentSchema.safeParse(published([{ ...directions, factIds: ['safety:n2'] }], facts)).success,
        ).toBe(false)
        // An origin must exist for every fact.
        expect(screenDocumentSchema.safeParse(published([directions], facts, origins(1))).success).toBe(false)
        // More facts than body slots are fine: facts are not nodes.
        const many = Array.from({ length: 40 }, (_v, i) => fact(`safety:m${i}`, 'remainder'))
        expect(screenDocumentSchema.safeParse(published([instruction], many, origins(40))).success).toBe(true)
        // A shell may still carry facts.
        const shell = document({
            body: [],
            manualFacts: many,
            metadata: {
                ...(document().metadata as object),
                source: 'shell',
                fallbackReason: 'unsupported_content',
                origins: {
                    header: 'shell',
                    'bar.primary': 'shell',
                    ...Object.fromEntries(many.map((_f, i) => [`facts.${i}`, 'shell'])),
                },
            },
        })
        expect(screenDocumentSchema.safeParse(shell).success).toBe(true)
    })

    it('publishes lossless manual text including operators, and requires an actual source for each fact', (): void => {
        const base = {
            factId: 'check:c',
            kind: 'check',
            basis: 'unclassified-step',
            text: 'Keep load < 5 kg. Turn -90 degrees.',
            sourceRefs: [here],
            placement: 'remainder',
        }
        const doc = (fact: Record<string, unknown>): unknown =>
            document({
                manualFacts: [fact],
                metadata: {
                    ...(document().metadata as object),
                    origins: {
                        header: 'fallback',
                        'body.0': 'fallback',
                        'bar.primary': 'fallback',
                        'facts.0': 'fallback',
                    },
                },
            })
        const parsed = screenDocumentSchema.safeParse(doc(base))
        expect(parsed.success).toBe(true)
        expect(parsed.success && parsed.data.manualFacts?.[0]?.text).toBe('Keep load < 5 kg. Turn -90 degrees.')
        expect(screenDocumentSchema.safeParse(doc({ ...base, sourceRefs: [] })).success).toBe(false)
        expect(screenDocumentSchema.safeParse(doc({ ...base, text: '' })).success).toBe(false)
    })

    it('bumps the catalog version consistently', (): void => {
        expect(SCREEN_CATALOG_VERSION).toBe(2)
        const meta = document().metadata as Record<string, unknown>
        expect(screenDocumentSchema.safeParse(document({ metadata: { ...meta, catalogVersion: 1 } })).success).toBe(
            false,
        )
    })
})
