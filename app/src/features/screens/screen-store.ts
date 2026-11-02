import type { ManualBinding, ManualSession, ScreenDocument, ScreenKind, ScreensResult } from '@truebuild/contracts'
import type { ScreenContext } from '@truebuild/contracts/model'
import type { ModelApiClient } from '../../api/model-client'
import type { GenerativeUiMode } from '../../config'
import {
    expectedContextKey,
    hashText,
    guideKey,
    identityOf,
    sessionForScreens,
    sessionFingerprint,
    specKey,
    STEPS_MODE_KINDS,
    type Digest256,
    type ScreenSpec,
} from './screen-spec'

export type ScreenClient = Pick<ModelApiClient, 'screens'>

export type ScreenEntry =
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly document: ScreenDocument }
    | { readonly status: 'failed'; readonly code: string }

type Held = {
    entry: ScreenEntry
    readonly manualId: string | null
    readonly revision: number | null
    abort: AbortController | null
    /** Transient fallbacks (a busy or timed-out server) are shown once and regenerated after this time. */
    expiresAt: number | null
    /** This device's clock when the document became ready; null while pending or failed. */
    readyAt: number | null
}

/** What the judge layer may count: documents actually delivered and shown, by the source the server stamped on them. */
export type ShownRecord = {
    readonly kind: ScreenKind
    readonly screenId: string
    readonly source: 'generated' | 'fallback' | 'shell'
    /**
     * Set only for a step's guide page shown with no photo held: the identity a check, closer look, overlay or question
     * about that step may name (the server recomputes the key and rejects any other).
     */
    readonly guide?: {
        readonly manualId: string
        readonly revision: number
        readonly stepId: string
        readonly contextKey: string
    }
}

const TRANSIENT_REASONS: ReadonlySet<string> = new Set(['busy', 'timeout', 'provider_error', 'stale'])
const TRANSIENT_MS = 15_000
export const PROGRESS_POLL_MS = 1_500
// Enough for a long manual to finish at a few steps per read; a job that is still not done is left to on-demand reads.
export const PROGRESS_MAX_POLLS = 60

export type ScreenStoreOptions = {
    readonly client: ScreenClient
    readonly mode: GenerativeUiMode
    readonly id: () => string
    readonly now?: () => number
    readonly pollMs?: number
    readonly maxPolls?: number
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    /** SHA-256 hex of a string; every document's context key is recomputed with it and must match exactly. */
    readonly digest: Digest256
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve): void => {
        if (signal.aborted) {
            resolve()
            return
        }
        const finish = (): void => {
            clearTimeout(timer)
            signal.removeEventListener('abort', finish)
            resolve()
        }
        const timer = setTimeout(finish, ms)
        signal.addEventListener('abort', finish, { once: true })
    })
}

/**
 * The session's screens. One entry per exact screen (kind, manual, revision, step, capture, content fingerprint):
 * repeated requests share one in-flight call and one cached document, a changed fact is a different entry, and a
 * newer revision aborts and forgets the older ones. Nothing is retried on its own; a failure is final until the
 * caller asks again. Documents are published only after the client has proven they match the request.
 */
export class ScreenStore {
    readonly mode: GenerativeUiMode
    private readonly client: ScreenClient
    private readonly id: () => string
    private readonly now: () => number
    private readonly pollMs: number
    private readonly maxPolls: number
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
    private readonly digest: Digest256
    private readonly held = new Map<string, Held>()
    private readonly jobs = new Map<string, { abort: AbortController; binding: ManualBinding }>()
    private readonly shown = new Map<string, ShownRecord>()
    private readonly guides = new Map<string, ScreenContext>()
    private readonly listeners = new Set<() => void>()
    private version = 0
    private disposed = false

    constructor(options: ScreenStoreOptions) {
        this.client = options.client
        this.mode = options.mode
        this.id = options.id
        this.now = options.now ?? ((): number => Date.now())
        this.pollMs = options.pollMs ?? PROGRESS_POLL_MS
        this.maxPolls = options.maxPolls ?? PROGRESS_MAX_POLLS
        this.sleep = options.sleep ?? defaultSleep
        this.digest = options.digest
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return (): void => {
            this.listeners.delete(listener)
        }
    }
    getVersion = (): number => this.version
    private publish(): void {
        this.version++
        for (const listener of this.listeners) listener()
    }

    /** False means this kind is never generated in this mode: the native screen is the screen. */
    enabled(kind: ScreenKind): boolean {
        return this.mode === 'full' || (this.mode === 'steps' && STEPS_MODE_KINDS.has(kind))
    }

    peek(spec: ScreenSpec): ScreenEntry | undefined {
        const held = this.held.get(specKey(spec))
        if (held === undefined) return undefined
        if (held.expiresAt !== null && held.entry.status === 'ready' && this.now() >= held.expiresAt) return undefined
        return held.entry
    }

    /** This device's clock when the screen with this slot key became ready, or null when it is not (or no longer) held. */
    readyAt(key: string): number | null {
        return this.held.get(key)?.readyAt ?? null
    }

    /**
     * Returns the current entry for this screen, starting one call if there is none. `undefined` means this screen is
     * native in the current mode. The call is shared: every caller of the same exact screen gets the same entry.
     */
    request(spec: ScreenSpec): ScreenEntry | undefined {
        if (this.disposed || !this.enabled(spec.kind)) return undefined
        const key = specKey(spec)
        const existing = this.held.get(key)
        if (existing !== undefined) {
            const expired = existing.expiresAt !== null && this.now() >= existing.expiresAt
            if (!expired) return existing.entry
            this.held.delete(key)
        }
        const identity = identityOf(spec)
        const abort = new AbortController()
        const held: Held = {
            entry: { status: 'pending' },
            manualId: identity.manualId,
            revision: identity.revision,
            abort,
            expiresAt: null,
            readyAt: null,
        }
        this.held.set(key, held)
        void this.generate(key, held, spec, abort)
        return held.entry
    }

    /** An explicit "try again": forget a failed entry so the next request makes exactly one new call. */
    retry(spec: ScreenSpec): void {
        const key = specKey(spec)
        const held = this.held.get(key)
        if (held !== undefined && held.entry.status !== 'pending') {
            this.held.delete(key)
            this.publish()
        }
    }

    private async generate(key: string, held: Held, spec: ScreenSpec, abort: AbortController): Promise<void> {
        let result: ScreensResult
        try {
            result = await this.client.screens(
                {
                    op: 'generate',
                    kind: spec.kind,
                    session: spec.session,
                    stepId: spec.stepId,
                    captureId: spec.captureId,
                    result: spec.result,
                    failure: spec.failure,
                    ...(spec.completedStepIds === undefined ? {} : { completedStepIds: spec.completedStepIds }),
                    ...(spec.uiState === undefined ? {} : { uiState: spec.uiState }),
                },
                { requestId: `screens-${this.id()}`, signal: abort.signal },
            )
        } catch {
            result = {
                status: 'unavailable',
                requestId: 'screens',
                binding: null,
                code: 'provider_error',
                retryable: true,
            }
        }
        // Forgotten (a newer revision, a disposed store) or replaced while the call was away: publish nothing.
        if (this.disposed || abort.signal.aborted || this.held.get(key) !== held) return
        held.abort = null
        if (result.status !== 'ok' || result.value.document === null) {
            held.entry = { status: 'failed', code: result.status === 'ok' ? 'invalid_output' : result.code }
        } else {
            let expected: string | null
            try {
                expected = await expectedContextKey(spec, this.digest)
            } catch {
                expected = null
            }
            if (this.disposed || abort.signal.aborted || this.held.get(key) !== held) return
            held.entry =
                expected === null
                    ? { status: 'failed', code: 'context_unverified' }
                    : this.accept(held, result.value.document, expected)
            if (held.entry.status === 'ready') held.readyAt = this.now()
        }
        this.publish()
    }

    /**
     * A document is shown only when the context key it carries is exactly the one this app computes from the inputs it
     * sent (the shared canonical context). A different key means the document was composed around something else.
     */
    private accept(held: Held, document: ScreenDocument, expected: string): ScreenEntry {
        if (document.bound.contextKey !== expected) return { status: 'failed', code: 'context_changed' }
        const reason = document.metadata.fallbackReason
        held.expiresAt =
            document.metadata.source === 'fallback' && reason !== null && TRANSIENT_REASONS.has(reason)
                ? this.now() + TRANSIENT_MS
                : null
        return { status: 'ready', document }
    }

    /**
     * Starts the background generation of every step page right after a manual is read, before the person confirms
     * it: a fresh parse (known raw facts, no build actions) starts the server's job and nothing else; the server keeps
     * the prepared output. Once the facts are confirmed, the reviewed manual starts the job again: identical facts are
     * re-grounded from the prepared output, and each finished page is read and kept as it arrives, current step first.
     * One job per exact session content; a newer revision cancels the older job. Reads are bounded.
     */
    precompute(session: ManualSession, focusStepId: string | null): void {
        const reviewed = session.reviewStatus === 'reviewed'
        if (this.disposed || !this.enabled('guide')) return
        if (!reviewed && (session.rawExtraction?.steps.length ?? 0) === 0) return
        const binding: ManualBinding = { kind: 'manual', manualId: session.manualId, revision: session.revision }
        const key = `${session.manualId}:${session.revision}:${reviewed ? sessionFingerprint(session) : `raw:${hashText(JSON.stringify(session.rawExtraction?.steps))}`}`
        if (this.jobs.has(key)) return
        this.invalidateManual(session.manualId, session.revision)
        const abort = new AbortController()
        this.jobs.set(key, { abort, binding })
        void this.runJob(key, session, focusStepId, abort, reviewed)
    }

    private async runJob(
        key: string,
        session: ManualSession,
        focus: string | null,
        abort: AbortController,
        reviewed: boolean,
    ): Promise<void> {
        const binding: ManualBinding = { kind: 'manual', manualId: session.manualId, revision: session.revision }
        const request = (): string => `screens-${this.id()}`
        try {
            const started = await this.client.screens(
                { op: 'precompute', session, focusStepId: focus },
                { requestId: request(), signal: abort.signal },
            )
            // An unreviewed parse only starts the server's job; its pages are read after the facts are confirmed.
            if (abort.signal.aborted || started.status !== 'ok' || !reviewed) return
            const received = new Set<string>()
            const steps = session.reviewedSteps.map((step) => step.stepId)
            let states = new Map<string, string>()
            for (let poll = 0; poll < this.maxPolls && !abort.signal.aborted; poll++) {
                await this.sleep(this.pollMs, abort.signal)
                if (abort.signal.aborted) return
                // A step that failed or was cancelled will never have a page; the rest are asked for as they finish.
                const open = steps.filter(
                    (stepId) => !received.has(stepId) && !['failed', 'cancelled'].includes(states.get(stepId) ?? ''),
                )
                if (open.length === 0) return
                const finished = open.filter((stepId) => ['ready', 'fallback'].includes(states.get(stepId) ?? ''))
                const want = (states.size === 0 ? open : finished).slice(0, 8)
                if (want.length > 0) {
                    const read = await this.client.screens(
                        { op: 'progress', binding, want },
                        { requestId: request(), signal: abort.signal },
                    )
                    if (abort.signal.aborted || read.status !== 'ok') return
                    for (const document of read.value.documents) {
                        const stepId = document.bound.stepId
                        if (stepId === null || received.has(stepId)) continue
                        await this.fill(session, stepId, document, abort)
                        received.add(stepId)
                    }
                    if (read.value.documents.length > 0) this.publish()
                    if (read.value.progress !== null) {
                        states = new Map(read.value.progress.steps.map((step) => [step.stepId, step.state]))
                    }
                    continue
                }
                // Nothing finished yet: read the job's state alone.
                const read = await this.client.screens(
                    { op: 'progress', binding, want: [] },
                    { requestId: request(), signal: abort.signal },
                )
                if (abort.signal.aborted || read.status !== 'ok') return
                if (read.value.progress !== null) {
                    states = new Map(read.value.progress.steps.map((step) => [step.stepId, step.state]))
                }
            }
        } catch {
            /* A read that fails ends the background job; on-demand generation still serves every screen. */
        } finally {
            this.jobs.delete(key)
        }
    }

    /** A precomputed page fills a gap; a page the screen already has is never replaced under it. */
    private async fill(
        session: ManualSession,
        stepId: string,
        document: ScreenDocument,
        abort: AbortController,
    ): Promise<void> {
        // A reviewed step page is requested on demand with the session minus its raw evidence; it is kept under that key.
        const stepKey = guideKey(sessionForScreens(session), stepId)
        const current = this.held.get(stepKey)
        if (current !== undefined && current.entry.status === 'ready') return
        // The same inputs the on-demand guide request would carry, so the same context key must come back.
        const expected = await expectedContextKey(
            { kind: 'guide', session, stepId, captureId: null, result: null, failure: null },
            this.digest,
        )
        if (this.disposed || abort.signal.aborted) return
        const held: Held = {
            entry: { status: 'pending' },
            manualId: session.manualId,
            revision: session.revision,
            abort: null,
            expiresAt: null,
            readyAt: null,
        }
        held.entry = this.accept(held, document, expected)
        if (held.entry.status === 'ready') held.readyAt = this.now()
        this.held.set(stepKey, held)
    }

    /**
     * The context moved on: forget and abort everything for this manual that belongs to an older revision, and ask the
     * server to stop its older background job. Pass `null` to forget every manual (the person left it).
     */
    invalidateManual(manualId: string | null, keepRevision: number | null): void {
        let changed = false
        for (const [key, held] of this.held) {
            if (held.manualId === null) continue
            if (manualId !== null && held.manualId !== manualId) continue
            if (keepRevision !== null && held.revision === keepRevision) continue
            held.abort?.abort()
            this.held.delete(key)
            changed = true
        }
        for (const [key, job] of this.jobs) {
            if (manualId !== null && job.binding.manualId !== manualId) continue
            if (keepRevision !== null && job.binding.revision === keepRevision) continue
            job.abort.abort()
            this.jobs.delete(key)
            void this.client
                .screens({ op: 'cancel', binding: job.binding }, { requestId: `screens-${this.id()}` })
                .catch((): void => undefined)
        }
        if (changed) this.publish()
    }

    /** The judge layer's counts: each distinct delivered screen once, by its server-stamped source. */
    noteShown(record: ShownRecord): void {
        if (record.guide !== undefined) {
            const { manualId, revision, stepId, contextKey } = record.guide
            this.guides.set(`${manualId}:${revision}:${stepId}`, { screenId: record.screenId, contextKey })
        }
        const key = `${record.kind}:${record.screenId}`
        if (this.shown.has(key)) return
        this.shown.set(key, record)
        this.publish()
    }

    /** The verified guide page last shown for this exact manual revision and step, or null when none is. */
    shownGuide(manualId: string, revision: number, stepId: string): ScreenContext | null {
        return this.guides.get(`${manualId}:${revision}:${stepId}`) ?? null
    }

    shownCounts(): Readonly<Record<'generated' | 'fallback' | 'shell', number>> {
        const counts = { generated: 0, fallback: 0, shell: 0 }
        for (const record of this.shown.values()) counts[record.source]++
        return counts
    }

    dispose(): void {
        this.disposed = true
        for (const held of this.held.values()) held.abort?.abort()
        for (const job of this.jobs.values()) job.abort.abort()
        this.held.clear()
        this.jobs.clear()
        this.guides.clear()
        this.listeners.clear()
    }
}
