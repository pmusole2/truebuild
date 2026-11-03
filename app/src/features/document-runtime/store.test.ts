import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    waitCopyV2,
    verifyDocumentAgainstInputsV2,
    screenDocumentV2Schema,
    SCREEN_KINDS_V2,
    type ScreenKindV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
} from '@truebuild/contracts'
import type { ScreensV2Result } from '@truebuild/contracts/model'
import { inputsFromDocumentMetadata } from '../../api/document-client'
import type { ModelApiClient } from '../../api/model-client'
import { sha256Hex } from '../documents/sha256'
import { DOCUMENT_CACHE_MAX_BYTES, DocumentStore, localDocument } from './store'

// This suite deliberately exercises the shipped offline recordings.
beforeEach(() => vi.stubEnv('EXPO_PUBLIC_RELEASE_FIXTURE', '1'))
afterEach(() => vi.unstubAllEnvs())

const session = createDemoManual()
const inputs: ScreenContextInputsV2 = {
    kind: 'guide',
    session,
    stepId: 'step-1',
    captureId: null,
    result: null,
    failure: null,
}
const fixture = (request: ScreenContextInputsV2): ScreenDocumentV2 => {
    const material = documentMaterialV2(request)
    return screenDocumentV2Schema.parse(
        assembleDocumentV2(
            material,
            buildFallbackProposalV2(material),
            {
                source: 'generated',
                evidence: 'synthetic-fixture',
                fallbackReason: null,
            },
            { sha256Hex, now: () => new Date('2026-01-01T00:00:00Z') },
        ),
    )
}
const ok = (document: ScreenDocumentV2, requestId: string): Extract<ScreensV2Result, { status: 'ok' }> => ({
    status: 'ok' as const,
    requestId,
    mode: 'fixture' as const,
    value: { document, documents: [], progress: null },
})
const successful = (): Mock<ModelApiClient['screensV2']> =>
    vi.fn<ModelApiClient['screensV2']>(async (metadata) =>
        ok(fixture(inputsFromDocumentMetadata(metadata)), metadata.requestId),
    )

describe('whole-document runtime store', () => {
    it.each<ScreenContextInputsV2>([
        {
            kind: 'more',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: {
                sections: ['how-it-works', 'settings', 'tips', 'about-this-check'],
                language: { options: ['en', 'es', 'fr', 'de', 'pt-BR'] },
                settings: { storage: true },
            },
        },
        {
            kind: 'judge',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: { sections: ['how-it-works', 'settings', 'tips', 'about-this-check'] },
        },
        {
            kind: 'camera',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: { camera: { mode: 'manual-page', permission: 'granted', failed: false, canAskAgain: true } },
        },
    ])('serves initial $kind as its genuine authored record before any network response', (context) => {
        const screensV2 = successful()
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'initial' })
        try {
            const entry = store.request(context)
            expect(entry.status).toBe('ready')
            expect(entry.document.metadata.source).toBe('generated')
            expect(entry.document.metadata.authoring?.model).toBe('Test fixture')
            expect(screensV2).not.toHaveBeenCalled()
            expect(store.readyAt(context)).toBeNull()
        } finally {
            store.dispose()
        }
    })

    it('offers an exact-context loading wait that resolves only to a validated generated payload', async () => {
        let finish!: (response: ScreensV2Result) => void
        let requestId = ''
        const screensV2 = vi.fn<ModelApiClient['screensV2']>((metadata) => {
            requestId = metadata.requestId
            return new Promise((resolve) => {
                finish = resolve
            })
        })
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'wait' })
        try {
            const waiting = store.waitForGenerated(inputs, { timeoutMs: 2_000 })
            expect(store.peek(inputs)?.document.metadata.source).toBe('fallback')
            const document = fixture(inputs)
            finish(ok(document, requestId))
            expect(await waiting).toEqual(document)
            expect(await store.waitForGenerated(inputs)).toBe(store.peek(inputs)?.document)
        } finally {
            store.dispose()
        }
    })

    it('does not return fallback or mismatched facts from a loading wait and releases cancelled waiters', async () => {
        const wrong = fixture({ ...inputs, stepId: 'step-2' })
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) => ok(wrong, metadata.requestId))
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'wrong' })
        try {
            expect(await store.waitForGenerated(inputs, { timeoutMs: 2_000 })).toBeNull()
            expect(store.peek(inputs)?.document.metadata.source).toBe('fallback')
            const controller = new AbortController()
            controller.abort()
            expect(
                await store.waitForGenerated({ ...inputs, stepId: 'step-2' }, { signal: controller.signal }),
            ).toBeNull()
            expect(screensV2).toHaveBeenCalledTimes(1)
        } finally {
            store.dispose()
        }
    })

    it('bounds loading waits and resolves them on abort, stale revision and store disposal', async () => {
        vi.useFakeTimers()
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(() => new Promise(() => {}))
        try {
            for (const stop of ['abort', 'stale', 'dispose', 'deadline'] as const) {
                const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => stop })
                const controller = new AbortController()
                try {
                    const waiting = store.waitForGenerated(inputs, { timeoutMs: 20, signal: controller.signal })
                    if (stop === 'abort') controller.abort()
                    if (stop === 'stale') store.invalidateManual(session.manualId, session.revision + 1)
                    if (stop === 'dispose') store.dispose()
                    if (stop === 'deadline') await vi.advanceTimersByTimeAsync(20)
                    expect(await waiting).toBeNull()
                } finally {
                    store.dispose()
                }
            }
        } finally {
            vi.useRealTimers()
        }
    })
    it('serves the initial recorded Home synchronously without a network request or provider receipt', () => {
        const screensV2 = successful()
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'id' })
        const home: ScreenContextInputsV2 = {
            kind: 'home',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: { library: { entries: [], soleManualId: null } },
        }
        try {
            const entry = store.request(home)
            expect(entry.status).toBe('ready')
            expect(entry.document.metadata).toMatchObject({
                source: 'generated',
                evidence: 'synthetic-fixture',
                model: null,
                authoring: { model: 'Test fixture', effort: 'ultra' },
            })
            expect(store.readyAt(home)).toBeNull()
            expect(screensV2).not.toHaveBeenCalled()
        } finally {
            store.dispose()
        }
    })

    it('uses the real asynchronous generation protocol when the supplied recording resolver has no match', async () => {
        const screensV2 = successful()
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'id',
            recordings: (): null => null,
        })
        const home: ScreenContextInputsV2 = {
            kind: 'home',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: { library: { entries: [], soleManualId: null } },
        }
        try {
            expect(store.request(home).status).toBe('pending')
            await vi.waitFor(() => expect(store.peek(home)?.status).toBe('ready'))
            expect(store.peek(home)?.document.metadata.source).toBe('generated')
            expect(store.readyAt(home)).toBeTypeOf('number')
            expect(screensV2).toHaveBeenCalledTimes(1)
            expect(screensV2.mock.calls[0]![0]).toMatchObject({ op: 'generate', kind: 'home' })
        } finally {
            store.dispose()
        }
    })

    it('keeps an individually oversized local document complete and uncached without dispatching or occupying a warmup flight', () => {
        const screensV2 = successful()
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'id',
            maxDocumentBytes: 1,
        })
        const entry = store.request(inputs)
        expect(entry.status).toBe('ready')
        expect(entry.issue).toBe('budget_exhausted')
        expect(screenDocumentV2Schema.safeParse(entry.document).success).toBe(true)
        expect(store.getCacheUsage()).toEqual({ entries: 0, documents: 0, documentBytes: 0, limitBytes: 1 })
        store.warmup([inputs, { ...inputs, stepId: 'step-2' }])
        expect(screensV2).not.toHaveBeenCalled()
        store.dispose()
    })
    it('bounds unique serialized document bytes, evicts least recently used payloads and keeps only a small shown-guide witness', async () => {
        const contexts: ScreenContextInputsV2[] = [
            inputs,
            { ...inputs, stepId: 'step-2' },
            { ...inputs, uiState: { busy: { activity: 'working' } } },
        ]
        const sizes = contexts.map((context) => new TextEncoder().encode(JSON.stringify(fixture(context))).byteLength)
        const budget = Math.max(sizes[0]! + sizes[1]!, sizes[0]! + sizes[2]!, sizes[1]! + sizes[2]!)
        const screensV2 = successful()
        let next = 0
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => String(next++),
            maxDocumentBytes: budget,
        })
        const land = async (context: ScreenContextInputsV2): Promise<void> => {
            store.request(context)
            await vi.waitFor(() => expect(store.peek(context)?.document.metadata.source).toBe('generated'))
        }
        try {
            await land(contexts[0]!)
            const shown = store.peek(inputs)!.document
            store.noteShown(shown, true)
            await land(contexts[1]!)
            store.peek(inputs) // This actual cache read makes guide1 the most recently used payload.
            await land(contexts[2]!)
            const activity = store.peek(contexts[2]!)!.document
            const activityBytes = new TextEncoder().encode(JSON.stringify(activity)).byteLength
            // The READY tree is already held; only the exact activity shell is assembled locally.
            expect(screensV2).toHaveBeenCalledTimes(2)
            expect(activity.metadata.shellStates).toContain('busy')
            store.noteShown(activity, true)
            expect(store.peek(contexts[1]!)).toBeUndefined()
            expect(store.getCacheUsage()).toEqual({
                entries: 2,
                documents: 2,
                documentBytes: sizes[0]! + activityBytes,
                limitBytes: budget,
            })
            await land(contexts[1]!)
            expect(store.peek(inputs)).toBeUndefined()
            expect(store.getCacheUsage().documentBytes).toBeLessThanOrEqual(budget)
            expect(store.shownGuide(session, 'step-1')).toEqual({
                screenId: shown.screenId,
                contextKey: shown.bound.contextKey,
            })
            expect(DOCUMENT_CACHE_MAX_BYTES).toBe(32 * 1_024 * 1_024)
        } finally {
            store.dispose()
        }
    })

    it('publishes a terminal cache-pressure cause when an in-flight entry is evicted, then permits an explicit new request', () => {
        const next = { ...inputs, stepId: 'step-2' }
        const size = (value: ScreenContextInputsV2): number =>
            new TextEncoder().encode(JSON.stringify(localDocument(value, 'busy'))).byteLength
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(() => new Promise(() => undefined))
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'id',
            maxDocumentBytes: Math.max(size(inputs), size(next)) + 64,
        })
        const changed = vi.fn()
        store.subscribe(changed)
        try {
            store.request(inputs)
            const firstSignal = screensV2.mock.calls[0]![1].signal
            store.request(next)
            expect(firstSignal?.aborted).toBe(true)
            expect(store.peek(inputs)).toBeUndefined()
            expect(store.cacheIssue(inputs)).toBe('budget_exhausted')
            expect(changed).toHaveBeenCalled()
            expect(store.getCacheUsage().documentBytes).toBeLessThanOrEqual(store.getCacheUsage().limitBytes)
            expect(store.request(inputs).status).toBe('pending')
            expect(store.cacheIssue(inputs)).toBeNull()
            expect(screensV2).toHaveBeenCalledTimes(3)
        } finally {
            store.dispose()
        }
    })

    it('supports every kind through complete off documents and bounded warmup without fabricating missing inputs', async () => {
        const actual = (kind: ScreenKindV2): ScreenContextInputsV2 => {
            const stepBound = ['guide', 'result', 'questions', 'answer', 'recovery', 'camera'].includes(kind)
            return {
                kind,
                session: ['home', 'more', 'error', 'judge', 'compare'].includes(kind) ? null : session,
                stepId: stepBound ? 'step-1' : null,
                captureId: ['result', 'answer', 'questions'].includes(kind) ? 'capture-1' : null,
                result:
                    kind === 'result'
                        ? {
                              kind: 'check',
                              value: {
                                  decision: 'cannot_verify',
                                  reason: 'A clearer view is needed.',
                                  sourceRefs: [],
                                  missingEvidence: [],
                                  observedRegion: null,
                              },
                          }
                        : kind === 'answer'
                          ? {
                                kind: 'question',
                                question: 'Which way?',
                                value: {
                                    answer: 'Follow the cited diagram.',
                                    sourceRefs: session.reviewedSteps[0]!.sourceRefs,
                                    missingEvidence: [],
                                },
                            }
                          : null,
                failure: kind === 'error' ? 'timeout' : null,
                uiState: { camera: { mode: 'build-photo', permission: 'granted' }, judge: { builtView: false } },
            }
        }
        const contexts = SCREEN_KINDS_V2.map(actual)
        const screensV2 = successful()
        const off = new DocumentStore({ client: { screensV2 }, mode: 'off', id: (): string => 'id' })
        for (const context of contexts)
            expect(screenDocumentV2Schema.safeParse(off.request(context).document).success).toBe(true)
        expect(screensV2).not.toHaveBeenCalled()
        off.dispose()
        let next = 0
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => String(next++),
            warmupConcurrency: 2,
        })
        store.warmup(contexts)
        expect(screensV2).toHaveBeenCalledTimes(2)
        await vi.waitFor(() => expect(contexts.every((context) => store.peek(context)?.status === 'ready')).toBe(true))
        const recorded = contexts.filter((context) => store.peek(context)?.document.metadata.authoring !== undefined)
        expect(recorded.length).toBeGreaterThan(0)
        expect(screensV2).toHaveBeenCalledTimes(SCREEN_KINDS_V2.length - recorded.length)
        expect(screensV2.mock.calls.map(([metadata]) => metadata.kind).sort()).toEqual(
            contexts
                .filter((context) => !recorded.includes(context))
                .map((context) => context.kind)
                .sort(),
        )
        expect(contexts.every((context) => store.peek(context)?.document.metadata.source === 'generated')).toBe(true)
        store.dispose()
    })
    it('renders a complete pending fallback, shares one flight, publishes and reuses the exact validated document', async () => {
        const screensV2 = successful()
        let clock = 1_000
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'id',
            now: (): number => clock,
        })
        let updates = 0
        store.subscribe(() => {
            updates++
        })
        const pending = store.request(inputs)
        expect(pending.status).toBe('pending')
        expect(store.readyAt(inputs)).toBeNull()
        expect(screenDocumentV2Schema.safeParse(pending.document).success).toBe(true)
        expect(pending.document.metadata).toMatchObject({
            source: 'fallback',
            evidence: 'local-deterministic',
            model: null,
        })
        expect(store.request(inputs)).toBe(pending)
        clock = 2_000
        await vi.waitFor(() => expect(store.peek(inputs)?.document.metadata.source).toBe('generated'))
        expect(store.readyAt(inputs)).toBe(2_000)
        expect(screensV2).toHaveBeenCalledTimes(1)
        expect(store.request(inputs)).toBe(store.peek(inputs))
        clock = 3_000
        expect(store.readyAt(inputs)).toBe(2_000)
        expect(updates).toBeGreaterThan(0)
        store.dispose()
    })

    it('returns complete off/steps fallbacks with zero dispatch and no v1/native-null escape', () => {
        const screensV2 = successful()
        for (const mode of ['off', 'steps'] as const) {
            const store = new DocumentStore({ client: { screensV2 }, mode, id: (): string => 'id' })
            const home: ScreenContextInputsV2 = { ...inputs, kind: 'home', session: null, stepId: null }
            const result = store.request(mode === 'off' ? inputs : home)
            expect(result.status).toBe('ready')
            expect(store.readyAt(mode === 'off' ? inputs : home)).toBeNull()
            expect(screenDocumentV2Schema.safeParse(result.document).success).toBe(true)
            expect(result.document.metadata).toMatchObject({
                source: 'fallback',
                evidence: 'local-deterministic',
                fallbackReason: 'disabled',
            })
            store.dispose()
        }
        expect(screensV2).not.toHaveBeenCalled()
    })

    it('rejects an older API wait vocabulary and publishes the current complete local fallback', async () => {
        const older = fixture(inputs)
        older.states.pending!.header.title = { kind: 'literal', text: 'Working on it' }
        expect(verifyDocumentAgainstInputsV2(older, inputs, sha256Hex)).toEqual(['literal_not_listed'])
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) => ok(older, metadata.requestId))
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'old-api' })
        store.request(inputs)
        await vi.waitFor(() => expect(store.peek(inputs)?.status).toBe('ready'))
        const entry = store.peek(inputs)!
        expect(entry.issue).toBe('invalid_output')
        expect(entry.document.metadata.source).toBe('fallback')
        expect(entry.document.states.pending!.header.title).toEqual({
            kind: 'literal',
            text: waitCopyV2('guide').heading,
        })
        expect(screenDocumentV2Schema.safeParse(entry.document).success).toBe(true)
        expect(screensV2).toHaveBeenCalledTimes(1)
        store.dispose()
    })

    it('rejects corrupt identity as a complete local fallback and never mints B3 credit', async () => {
        const foreign = fixture({ ...inputs, stepId: 'step-2' })
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) => ok(foreign, metadata.requestId))
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'id' })
        store.request(inputs)
        await vi.waitFor(() => expect(store.peek(inputs)?.status).toBe('ready'))
        const entry = store.peek(inputs)!
        expect(entry.issue).toBe('invalid_output')
        expect(entry.document.metadata.source).toBe('fallback')
        store.noteShown(entry.document, true)
        expect(store.shownGuide(session, 'step-1')).toBeNull()
        store.dispose()
    })

    it('aborts older revisions and ignores a response from a transport that refuses cancellation', async () => {
        let resolve: ((value: Awaited<ReturnType<ModelApiClient['screensV2']>>) => void) | undefined
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(
            () =>
                new Promise((done) => {
                    resolve = done
                }),
        )
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'id' })
        store.request(inputs)
        const newer = { ...session, revision: session.revision + 1 }
        store.observeSession(newer)
        expect(screensV2.mock.calls[0]![1].signal?.aborted).toBe(true)
        resolve?.(ok(fixture(inputs), 'documents-id'))
        await Promise.resolve()
        expect(store.peek(inputs)).toBeUndefined()
        expect(store.request(inputs).document.metadata.fallbackReason).toBe('stale')
        store.dispose()
    })

    it('records only focused accepted generated guides and rejects same-revision fact drift for B3', async () => {
        const screensV2 = successful()
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'id' })
        store.request(inputs)
        await vi.waitFor(() => expect(store.peek(inputs)?.document.metadata.source).toBe('generated'))
        const doc = store.peek(inputs)!.document
        store.noteShown(doc, false)
        expect(store.shownGuide(session, 'step-1')).toBeNull()
        store.noteShown(doc, true)
        expect(store.shownGuide(session, 'step-1')).toEqual({
            screenId: doc.screenId,
            contextKey: doc.bound.contextKey,
        })
        const changed = structuredClone(session)
        changed.title = 'A different manual title'
        expect(store.shownGuide(changed, 'step-1')).toBeNull()
        store.dispose()
    })
})
