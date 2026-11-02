import { createDemoManual, type ManualSession, type ScreensResult } from '@truebuild/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { ScreenRequest } from '../../api/model-client'
import { ScreenStore, type ScreenClient } from './screen-store'
import { guideKey, sessionForScreens, specKey, type ScreenSpec } from './screen-spec'
import { contextKeyOf, hex, liveMetadata, makeDocument, nodeDigest } from './test-support/documents'

const manual = createDemoManual()
const session = sessionForScreens(manual)
const stepId = manual.reviewedSteps[0]!.stepId

const guide = (overrides: Partial<ScreenSpec> = {}): ScreenSpec => ({
    kind: 'guide',
    session,
    stepId,
    captureId: null,
    result: null,
    failure: null,
    ...overrides,
})
/** The document a faithful server returns for this request: composed for exactly its inputs. */
const docFor = (spec: ScreenSpec, options: Parameters<typeof makeDocument>[0] = {}): ReturnType<typeof makeDocument> =>
    makeDocument({ ...options, stepId: spec.stepId, contextKey: contextKeyOf(spec) })
const home: ScreenSpec = { kind: 'home', session: null, stepId: null, captureId: null, result: null, failure: null }

function ok(value: Partial<Extract<ScreensResult, { status: 'ok' }>['value']>): ScreensResult {
    return {
        status: 'ok',
        requestId: 'r',
        mode: 'model',
        value: { document: null, progress: null, documents: [], ...value },
    }
}
const failed: ScreensResult = {
    status: 'unavailable',
    requestId: 'r',
    binding: null,
    code: 'provider_error',
    retryable: true,
}

type Handler = (request: ScreenRequest, signal: AbortSignal | undefined) => Promise<ScreensResult>
function harness(
    handler: Handler,
    options: {
        mode?: 'off' | 'steps' | 'full'
        maxPolls?: number
        now?: () => number
        sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    } = {},
): { store: ScreenStore; calls: ScreenRequest[] } {
    const calls: ScreenRequest[] = []
    const client: ScreenClient = {
        screens: async (request, ctx) => {
            calls.push(request)
            return handler(request, ctx.signal)
        },
    }
    let id = 0
    const store = new ScreenStore({
        client,
        mode: options.mode ?? 'full',
        id: (): string => `id-${++id}`,
        pollMs: 1,
        maxPolls: options.maxPolls ?? 5,
        sleep: options.sleep ?? (async (): Promise<void> => undefined),
        digest: nodeDigest,
        ...(options.now === undefined ? {} : { now: options.now }),
    })
    return { store, calls }
}
const settle = async (): Promise<void> => {
    for (let index = 0; index < 5; index++) await Promise.resolve()
}

describe('modes', () => {
    it('off makes no request at all and leaves every screen native', () => {
        const { store, calls } = harness(async () => ok({ document: makeDocument() }), { mode: 'off' })
        expect(store.enabled('guide')).toBe(false)
        expect(store.request(guide())).toBeUndefined()
        store.precompute(manual, stepId)
        expect(calls).toEqual([])
    })

    it('steps generates guide pages only', () => {
        const { store, calls } = harness(async () => ok({ document: makeDocument() }), { mode: 'steps' })
        expect(store.request(home)).toBeUndefined()
        expect(store.request(guide())).toEqual({ status: 'pending' })
        expect(calls.map((call) => call.op)).toEqual(['generate'])
    })
})

describe('cache and sharing', () => {
    it('shares one in-flight call between callers and serves the cached document afterwards', async () => {
        let release: (result: ScreensResult) => void = () => undefined
        const { store, calls } = harness(() => new Promise<ScreensResult>((resolve) => (release = resolve)))
        expect(store.request(guide())).toEqual({ status: 'pending' })
        expect(store.request(guide())).toEqual({ status: 'pending' })
        expect(calls).toHaveLength(1)
        const document = docFor(guide())
        release(ok({ document }))
        await settle()
        expect(store.request(guide())).toEqual({ status: 'ready', document })
        expect(calls).toHaveLength(1)
    })

    it('treats an edited fact, another step or another revision as another screen', async () => {
        const { store, calls } = harness(async () => ok({ document: makeDocument() }))
        store.request(guide())
        const edited = {
            ...session,
            reviewedSteps: session.reviewedSteps.map((step, index) =>
                index === 0 ? { ...step, title: 'A new title' } : step,
            ),
        }
        store.request(guide({ session: edited }))
        store.request(guide({ stepId: manual.reviewedSteps[1]?.stepId ?? 'step-2' }))
        store.request(guide({ session: { ...session, revision: session.revision + 1 } }))
        expect(calls).toHaveLength(4)
        expect(new Set([specKey(guide()), specKey(guide({ session: edited }))]).size).toBe(2)
    })

    it('does not re-key on a timestamp or the raw extraction', () => {
        const touched = { ...session, updatedAt: '2030-01-01T00:00:00.000Z' }
        expect(specKey(guide({ session: touched }))).toBe(specKey(guide()))
    })

    it.each(['geometry', 'sources', 'missing evidence'] as const)(
        'does not reuse an in-flight result when only %s changes',
        (change) => {
            const original = guide({
                kind: 'result',
                captureId: 'photo-1',
                result: {
                    kind: 'check',
                    value: {
                        decision: 'pass',
                        reason: 'Matches.',
                        sourceRefs: [],
                        missingEvidence: [],
                        observedRegion: null,
                    },
                },
            })
            if (original.result?.kind !== 'check') throw new Error('test result')
            const changed = {
                ...original,
                result: {
                    ...original.result,
                    value: {
                        ...original.result.value,
                        ...(change === 'geometry'
                            ? { observedRegion: { x: 0.1, y: 0.2, width: 0.4, height: 0.5 } }
                            : change === 'sources'
                              ? { sourceRefs: [{ pageId: 'demo-page-1', region: null }] }
                              : { missingEvidence: ['The rear fixing is hidden.'] }),
                    },
                },
            }
            const { store, calls } = harness(() => new Promise<ScreensResult>(() => undefined))
            store.request(original)
            store.request(changed)
            expect(calls).toHaveLength(2)
            expect(specKey(changed)).not.toBe(specKey(original))
            store.dispose()
        },
    )

    it('fails once without retrying itself, and an explicit retry makes exactly one new call', async () => {
        let attempt = 0
        const { store, calls } = harness(async () => (++attempt === 1 ? failed : ok({ document: docFor(guide()) })))
        store.request(guide())
        await settle()
        expect(store.request(guide())).toEqual({ status: 'failed', code: 'provider_error' })
        expect(calls).toHaveLength(1)
        store.retry(guide())
        expect(store.request(guide())).toEqual({ status: 'pending' })
        await settle()
        expect(store.request(guide())).toMatchObject({ status: 'ready' })
        expect(calls).toHaveLength(2)
    })

    it('regenerates a transient fallback (busy, timeout) after it expires but keeps a final one', async () => {
        let now = 1_000
        const transient = docFor(guide(), {
            metadata: { ...liveMetadata({ source: 'fallback', model: null, effort: null }), fallbackReason: 'busy' },
        })
        const { store, calls } = harness(async () => ok({ document: transient }), { now: () => now })
        store.request(guide())
        await settle()
        now += 1_000
        expect(store.request(guide())).toMatchObject({ status: 'ready' })
        expect(calls).toHaveLength(1)
        now += 16_000
        expect(store.request(guide())).toEqual({ status: 'pending' })
        expect(calls).toHaveLength(2)
    })

    it('shows a document only when its context key is exactly the one computed from the request', async () => {
        let key = contextKeyOf(guide())
        const { store } = harness(async () => ok({ document: makeDocument({ contextKey: key }) }))
        store.request(guide())
        await settle()
        expect(store.peek(guide())).toMatchObject({ status: 'ready' })
        store.retry(guide())
        // A document composed around something else: same identity fields, a different grounding context.
        key = hex('e')
        store.request(guide())
        await settle()
        expect(store.peek(guide())).toEqual({ status: 'failed', code: 'context_changed' })
    })

    it('a first-seen key is never trusted: a wrong key is refused even the first time', async () => {
        const { store } = harness(async () => ok({ document: makeDocument({ contextKey: hex('f') }) }))
        store.request(guide())
        await settle()
        expect(store.peek(guide())).toEqual({ status: 'failed', code: 'context_changed' })
    })

    it('sends the live state a screen binds to, and keys the screen by the part of it that kind uses', async () => {
        const withUi = guide({
            kind: 'home',
            session: null,
            stepId: null,
            uiState: { library: { entries: [], soleManualId: null } },
        })
        const other = { ...withUi, uiState: { pages: null } }
        const { store, calls } = harness(async () =>
            ok({
                document: makeDocument({ kind: 'home', session: null, stepId: null, contextKey: contextKeyOf(withUi) }),
            }),
        )
        store.request(withUi)
        store.request(other)
        await settle()
        expect(calls).toHaveLength(2)
        expect(calls[0]).toMatchObject({ op: 'generate', uiState: { library: { entries: [], soleManualId: null } } })
        expect(store.peek(withUi)).toMatchObject({ status: 'ready' })
    })
})

describe('context changes', () => {
    it('aborts and forgets older revisions of the same manual, and nothing else', async () => {
        const signals: (AbortSignal | undefined)[] = []
        const { store } = harness((_request, signal) => {
            signals.push(signal)
            return new Promise<ScreensResult>(() => undefined)
        })
        const older = guide({ session: { ...session, revision: 1 } })
        const newer = guide({ session: { ...session, revision: 2 } })
        const other = guide({ session: { ...session, manualId: 'manual-other' } })
        store.request(older)
        store.request(newer)
        store.request(other)
        store.invalidateManual(session.manualId, 2)
        expect(signals[0]?.aborted).toBe(true)
        expect(signals[1]?.aborted).toBe(false)
        expect(signals[2]?.aborted).toBe(false)
        expect(store.peek(older)).toBeUndefined()
        expect(store.peek(newer)).toEqual({ status: 'pending' })
    })

    it('publishes nothing for a call that finished after its screen was forgotten', async () => {
        let release: (result: ScreensResult) => void = () => undefined
        const { store } = harness(() => new Promise<ScreensResult>((resolve) => (release = resolve)))
        const spec = guide({ session: { ...session, revision: 1 } })
        store.request(spec)
        store.invalidateManual(session.manualId, 2)
        const listener = vi.fn()
        store.subscribe(listener)
        release(ok({ document: docFor(spec) }))
        await settle()
        expect(listener).not.toHaveBeenCalled()
        expect(store.peek(spec)).toBeUndefined()
    })
})

describe('precompute and progress', () => {
    const twoSteps: ManualSession = {
        ...manual,
        reviewedSteps: [manual.reviewedSteps[0]!, { ...manual.reviewedSteps[0]!, stepId: 'step-2', order: 2 }],
    }
    const progressOf = (
        states: [string, string],
    ): NonNullable<Extract<ScreensResult, { status: 'ok' }>['value']['progress']> => ({
        manualId: manual.manualId,
        revision: manual.revision,
        contextKey: hex('d'),
        mode: 'full',
        steps: [
            { stepId, state: states[0] as 'ready', screenId: hex('b') },
            { stepId: 'step-2', state: states[1] as 'ready', screenId: null },
        ],
    })

    it('does nothing for a manual with nothing read yet', () => {
        const { store, calls } = harness(async () => ok({}))
        store.precompute({ ...manual, reviewStatus: 'unreviewed', rawExtraction: null, reviewedSteps: [] }, stepId)
        expect(calls).toEqual([])
    })

    it('starts every step right after a fresh read, before the facts are confirmed, and reads nothing back yet', async () => {
        const { store, calls } = harness(async () => ok({ progress: progressOf(['running', 'queued']) }))
        const fresh: ManualSession = { ...twoSteps, reviewStatus: 'unreviewed' }
        store.precompute(fresh, null)
        store.precompute(fresh, null)
        await settle()
        expect(calls.map((call) => call.op)).toEqual(['precompute'])
        expect(calls[0]).toMatchObject({ op: 'precompute', session: { reviewStatus: 'unreviewed' } })
        // The unreviewed session keeps the raw facts the server prepares from.
        expect((calls[0] as { session: ManualSession }).session.rawExtraction).not.toBeNull()
    })

    it('refuses a prepared page whose context key is not the one its request would carry', async () => {
        const bad = makeDocument({ session: twoSteps, stepId, contextKey: hex('1') })
        const { store } = harness(async (request) =>
            request.op === 'precompute'
                ? ok({ progress: progressOf(['ready', 'queued']) })
                : ok({ progress: progressOf(['ready', 'queued']), documents: [bad] }),
        )
        store.precompute(twoSteps, stepId)
        await vi.waitFor(() =>
            expect(store.peek(guide({ session: sessionForScreens(twoSteps) }))).toEqual({
                status: 'failed',
                code: 'context_changed',
            }),
        )
    })

    it('starts one job, reads progress for finished steps only, and fills each page as it arrives', async () => {
        const second = makeDocument({
            session: twoSteps,
            stepId: 'step-2',
            contextKey: contextKeyOf(guide({ session: twoSteps, stepId: 'step-2' })),
            screenId: hex('9'),
        })
        const first = makeDocument({
            session: twoSteps,
            stepId,
            contextKey: contextKeyOf(guide({ session: twoSteps })),
        })
        let reads = 0
        const { store, calls } = harness(async (request) => {
            if (request.op === 'precompute') return ok({ progress: progressOf(['running', 'queued']) })
            if (request.op === 'progress') {
                reads++
                if (reads === 1) return ok({ progress: progressOf(['ready', 'running']), documents: [] })
                if (request.want.includes(stepId))
                    return ok({ progress: progressOf(['ready', 'ready']), documents: [first] })
                return ok({ progress: progressOf(['ready', 'ready']), documents: [second] })
            }
            return ok({})
        })
        store.precompute(twoSteps, stepId)
        store.precompute(twoSteps, stepId)
        await vi.waitFor(() =>
            expect(store.peek({ ...guide({ session: sessionForScreens(twoSteps) }) })).toMatchObject({
                status: 'ready',
            }),
        )
        await vi.waitFor(() =>
            expect(store.peek(guide({ session: sessionForScreens(twoSteps), stepId: 'step-2' }))).toMatchObject({
                status: 'ready',
            }),
        )
        expect(calls.filter((call) => call.op === 'precompute')).toHaveLength(1)
        const wants = calls.flatMap((call) => (call.op === 'progress' ? [call.want] : []))
        expect(wants.every((want) => want.length <= 8)).toBe(true)
        expect(guideKey(sessionForScreens(twoSteps), stepId)).toBe(
            specKey(guide({ session: sessionForScreens(twoSteps) })),
        )
    })

    it('stops reading after the poll budget and never loops forever', async () => {
        const { store, calls } = harness(
            async (request) =>
                request.op === 'precompute'
                    ? ok({ progress: progressOf(['running', 'queued']) })
                    : ok({ progress: progressOf(['running', 'queued']) }),
            { maxPolls: 3 },
        )
        store.precompute(twoSteps, stepId)
        await vi.waitFor(() => expect(calls.filter((call) => call.op === 'progress')).toHaveLength(3))
        await settle()
        expect(calls.filter((call) => call.op === 'progress')).toHaveLength(3)
    })

    it('stops at once when every remaining step failed (they will never have a page)', async () => {
        const { store, calls } = harness(async () => ok({ progress: progressOf(['failed', 'failed']) }))
        store.precompute(twoSteps, stepId)
        await vi.waitFor(() => expect(calls.filter((call) => call.op === 'progress').length).toBeGreaterThanOrEqual(1))
        await settle()
        expect(calls.filter((call) => call.op === 'progress').length).toBeLessThanOrEqual(2)
    })

    it('cancels the server job and stops reading when a newer revision of the manual takes over', async () => {
        // The job waits between reads until it is stopped, so the newer revision arrives while it is still running.
        const { store, calls } = harness(async () => ok({ progress: progressOf(['running', 'queued']) }), {
            maxPolls: 50,
            sleep: (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())),
        })
        store.precompute(twoSteps, stepId)
        await vi.waitFor(() => expect(calls.some((call) => call.op === 'precompute')).toBe(true))
        store.precompute({ ...twoSteps, revision: twoSteps.revision + 1 }, stepId)
        await settle()
        const cancels = calls.filter((call) => call.op === 'cancel')
        expect(cancels).toHaveLength(1)
        expect(cancels[0]).toMatchObject({ binding: { manualId: twoSteps.manualId, revision: twoSteps.revision } })
    })
})

describe('judge counts', () => {
    it('counts each delivered screen once by the source the server stamped on it', () => {
        const { store } = harness(async () => ok({}))
        store.noteShown({ kind: 'guide', screenId: 'a', source: 'generated' })
        store.noteShown({ kind: 'guide', screenId: 'a', source: 'generated' })
        store.noteShown({ kind: 'home', screenId: 'b', source: 'fallback' })
        expect(store.shownCounts()).toEqual({ generated: 1, fallback: 1, shell: 0 })
    })
})
