import {
    canonicalJson,
    buildFallbackDocumentV2,
    rebindGeneratedStatesV2,
    screenContextJsonV2,
    screenDocumentV2Schema,
    screenManualJsonV2,
    screenUiForKindV2,
    screenUiStateV2Schema,
    type FallbackReasonV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenUiStateV2,
} from '@truebuild/contracts'
import type { PrecomputeKindV2, ScreenContext, ScreensV2Result } from '@truebuild/contracts/model'
import {
    documentJobContextKey,
    documentMatchesInputs,
    documentPrecomputeInputs,
    documentRequest,
    interpretDocuments,
    type ScreensV2Request,
} from '../../api/document-client'
import type { ModelApiClient } from '../../api/model-client'
import { sha256Hex } from '../documents/sha256'
import { recordedDocument } from './recorded-runtime'
import { futureDocumentStates } from './future-states'
import { isResultLayoutDocument } from './result-layout-runtime'

export type DocumentRuntimeEntry = {
    readonly status: 'pending' | 'ready'
    readonly document: ScreenDocumentV2
    readonly issue: string | null
    /** A complete authored layout may be ready while its exact-context provider composition is still being collected. */
    readonly exactGeneration?: 'pending' | 'unavailable'
}
export type DocumentStoreOptions = {
    readonly client?: Pick<ModelApiClient, 'screensV2'>
    readonly mode: 'full' | 'steps' | 'off'
    readonly id: () => string
    readonly now?: () => number
    readonly pollMs?: number
    readonly maxPolls?: number
    readonly warmupConcurrency?: number
    readonly maxDocumentBytes?: number
    readonly recordings?: typeof recordedDocument
}
export interface DocumentCacheUsage {
    readonly entries: number
    readonly documents: number
    /** Unique cached document objects serialized as UTF8 JSON, not an estimate of the JavaScript/native heap. */
    readonly documentBytes: number
    readonly limitBytes: number
}
type Held = {
    entry: DocumentRuntimeEntry
    readyAt: number | null
    readonly inputs: ScreenContextInputsV2
    readonly manualHash: string | null
    readonly abort: AbortController
}
type Job = {
    readonly session: ManualSession
    readonly abort: AbortController
    readonly context: string
    readonly uiState: ScreenUiStateV2 | null | undefined
    readonly completedStepIds: readonly string[] | undefined
    readonly requestedKinds: readonly PrecomputeKindV2[] | undefined
}
export const DOCUMENT_CACHE_MAX_ENTRIES = 512
export const DOCUMENT_CACHE_MAX_BYTES = 32 * 1_024 * 1_024
const MAX_ENTRIES = DOCUMENT_CACHE_MAX_ENTRIES
export const DOCUMENT_PROGRESS_POLL_MS = 1_500
export const DOCUMENT_PROGRESS_MAX_POLLS = 60
/** Bound phone-side background collection; server generation and cache may finish afterwards. */
export const DOCUMENT_COLLECTION_DEADLINE_MS = 120_000

export function documentKey(inputs: ScreenContextInputsV2): string {
    return sha256Hex(
        canonicalJson([
            screenContextJsonV2(inputs),
            inputs.session === null ? null : screenManualJsonV2(inputs.session),
        ]),
    )
}
export function localDocument(
    inputs: ScreenContextInputsV2,
    reason: FallbackReasonV2,
    now: () => number = Date.now,
): ScreenDocumentV2 {
    return screenDocumentV2Schema.parse(
        buildFallbackDocumentV2(inputs, {
            sha256Hex,
            now: () => new Date(now()),
            reason,
            evidence: 'local-deterministic',
        }),
    )
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const finish = (): void => {
            clearTimeout(timer)
            signal.removeEventListener('abort', finish)
            resolve()
        }
        const timer = setTimeout(finish, ms)
        signal.addEventListener('abort', finish, { once: true })
        if (signal.aborted) finish()
    })
}
function reasonFor(code: string): FallbackReasonV2 {
    if (code === 'timeout' || code === 'unconfigured' || code === 'invalid_output' || code === 'provider_error')
        return code
    if (code === 'budget_exhausted') return 'busy'
    if (code === 'duplicate_request' || code === 'stale') return 'stale'
    return 'invalid_output'
}
function inFlight(entry: DocumentRuntimeEntry | undefined): boolean {
    return entry?.status === 'pending' || entry?.exactGeneration === 'pending'
}

/** Complete v2 documents only. Failure/pending/off use the same shared catalog, never a native or v1 partial escape. */
export class DocumentStore {
    readonly mode: DocumentStoreOptions['mode']
    private readonly held = new Map<string, Held>()
    private readonly evicted = new Map<string, 'budget_exhausted'>()
    private readonly manuals = new Map<string, { revision: number; hash: string }>()
    private readonly jobs = new Map<string, Job>()
    private readonly attemptedJobs = new Map<string, string>()
    private readonly guides = new Map<
        string,
        { manualId: string; revision: number; screen: ScreenContext; uiState: ScreenUiStateV2 }
    >()
    private readonly documentSizes = new WeakMap<ScreenDocumentV2, number>()
    private readonly acceptedDocuments = new WeakSet<ScreenDocumentV2>()
    private readonly listeners = new Set<() => void>()
    private readonly warmQueue = new Map<string, ScreenContextInputsV2>()
    private warming = 0
    private version = 0
    private disposed = false
    private readonly now: () => number
    constructor(private readonly options: DocumentStoreOptions) {
        this.mode = options.mode
        this.now = options.now ?? Date.now
        for (const value of [
            options.pollMs ?? DOCUMENT_PROGRESS_POLL_MS,
            options.maxPolls ?? DOCUMENT_PROGRESS_MAX_POLLS,
            options.warmupConcurrency ?? 2,
            options.maxDocumentBytes ?? DOCUMENT_CACHE_MAX_BYTES,
        ]) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid_document_runtime_limit')
        }
    }
    subscribe = (listener: () => void): (() => void) => {
        if (this.disposed) return (): void => {}
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }
    getVersion = (): number => this.version
    private publish(): void {
        this.version++
        for (const listener of this.listeners) listener()
    }
    private enabled(inputs: ScreenContextInputsV2): boolean {
        return this.mode === 'full' || (this.mode === 'steps' && inputs.kind === 'guide')
    }
    private stale(session: ManualSession | null): boolean {
        if (session === null) return false
        const known = this.manuals.get(session.manualId)
        return (
            known !== undefined &&
            (session.revision < known.revision ||
                (session.revision === known.revision && sha256Hex(screenManualJsonV2(session)) !== known.hash))
        )
    }
    observeSession(session: ManualSession): void {
        if (this.disposed) return
        const known = this.manuals.get(session.manualId)
        if (known !== undefined && session.revision < known.revision) return
        const hash = sha256Hex(screenManualJsonV2(session))
        if (known?.revision === session.revision && known.hash === hash) return
        this.manuals.set(session.manualId, { revision: session.revision, hash })
        for (const [key, held] of this.held)
            if (
                held.inputs.session?.manualId === session.manualId &&
                (held.inputs.session.revision !== session.revision || held.manualHash !== hash)
            ) {
                held.abort.abort()
                this.held.delete(key)
            }
        for (const [key, job] of this.jobs)
            if (job.session.manualId === session.manualId && key !== hash) {
                job.abort.abort()
                this.jobs.delete(key)
                if (job.session.revision < session.revision) void this.cancelJob(job)
            }
        for (const [key, record] of this.guides)
            if (record.manualId === session.manualId && record.revision !== session.revision) this.guides.delete(key)
        this.publish()
    }
    invalidateManual(manualId: string, revision: number): void {
        if (this.disposed) return
        const known = this.manuals.get(manualId)
        if (known === undefined || known.revision < revision) this.manuals.set(manualId, { revision, hash: '' })
        for (const [key, held] of this.held)
            if (held.inputs.session?.manualId === manualId && held.inputs.session.revision < revision) {
                held.abort.abort()
                this.held.delete(key)
            }
        for (const [key, record] of this.guides)
            if (record.manualId === manualId && record.revision < revision) this.guides.delete(key)
        for (const [key, job] of this.jobs) {
            if (job.session.manualId !== manualId || job.session.revision >= revision) continue
            job.abort.abort()
            this.jobs.delete(key)
            void this.cancelJob(job)
        }
        this.publish()
    }
    /** Stop obsolete Reading work without minting another request or accepting a late completed document. */
    cancelReading(manualId: string): void {
        let changed = false
        for (const [key, held] of this.held) {
            if (held.inputs.kind !== 'reading' || held.inputs.session?.manualId !== manualId) continue
            held.abort.abort()
            this.held.delete(key)
            changed = true
        }
        for (const [key, inputs] of this.warmQueue) {
            if (inputs.kind === 'reading' && inputs.session?.manualId === manualId) this.warmQueue.delete(key)
        }
        for (const [key, job] of this.jobs) {
            if (job.session.manualId !== manualId) continue
            job.abort.abort()
            this.jobs.delete(key)
            this.attemptedJobs.delete(key)
            void this.cancelJob(job)
            changed = true
        }
        if (changed) this.publish()
    }
    preview(inputs: ScreenContextInputsV2): DocumentRuntimeEntry {
        const enabled = this.enabled(inputs) && this.options.client !== undefined && !this.disposed
        const recorded = enabled ? (this.options.recordings ?? recordedDocument)(inputs) : null
        if (
            recorded !== null &&
            this.documentByteSize(recorded) <= (this.options.maxDocumentBytes ?? DOCUMENT_CACHE_MAX_BYTES)
        ) {
            return {
                status: 'ready',
                document: recorded,
                issue: null,
                ...(isResultLayoutDocument(recorded) ? { exactGeneration: 'pending' as const } : {}),
            }
        }
        const reason = enabled ? 'busy' : this.enabled(inputs) && !this.disposed ? 'unconfigured' : 'disabled'
        const local = localDocument(inputs, reason, this.now)
        const donors = enabled
            ? [...this.held.values()].flatMap(({ entry }) =>
                  entry.document.metadata.source === 'generated' ? [entry.document] : [],
              )
            : []
        const document =
            donors.length === 0
                ? local
                : rebindGeneratedStatesV2(inputs, local, donors, { sha256Hex, now: (): Date => new Date(this.now()) })
                      .document
        const fits = this.documentByteSize(document) <= (this.options.maxDocumentBytes ?? DOCUMENT_CACHE_MAX_BYTES)
        return { status: enabled && fits ? 'pending' : 'ready', document, issue: fits ? null : 'budget_exhausted' }
    }
    peek(inputs: ScreenContextInputsV2): DocumentRuntimeEntry | undefined {
        const key = documentKey(inputs),
            held = this.held.get(key)
        if (held !== undefined) {
            this.held.delete(key)
            this.held.set(key, held)
        }
        return held?.entry
    }
    /** A lightweight terminal cause, without retaining the evicted document or its inputs. */
    cacheIssue(inputs: ScreenContextInputsV2): 'budget_exhausted' | null {
        return this.evicted.get(documentKey(inputs)) ?? null
    }
    getCacheUsage(): DocumentCacheUsage {
        const documents = new Set([...this.held.values()].map((held) => held.entry.document))
        let documentBytes = 0
        for (const document of documents) {
            documentBytes += this.documentByteSize(document)
        }
        return {
            entries: this.held.size,
            documents: documents.size,
            documentBytes,
            limitBytes: this.options.maxDocumentBytes ?? DOCUMENT_CACHE_MAX_BYTES,
        }
    }
    private documentByteSize(document: ScreenDocumentV2): number {
        const previous = this.documentSizes.get(document)
        if (previous !== undefined) return previous
        const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength
        this.documentSizes.set(document, bytes)
        return bytes
    }
    /** Client receipt time of the validated API document; never render time or invented provider latency. */
    readyAt(inputs: ScreenContextInputsV2): number | null {
        return this.held.get(documentKey(inputs))?.readyAt ?? null
    }
    request(inputs: ScreenContextInputsV2): DocumentRuntimeEntry {
        const revision = inputs.session === null ? undefined : this.manuals.get(inputs.session.manualId)?.revision
        if (this.disposed || (revision !== undefined && inputs.session !== null && inputs.session.revision < revision))
            return { status: 'ready', document: localDocument(inputs, 'stale', this.now), issue: 'stale' }
        if (inputs.session !== null) this.observeSession(inputs.session)
        const key = documentKey(inputs)
        const existing = this.held.get(key)
        if (existing !== undefined) return this.peek(inputs)!
        const held: Held = {
            entry: this.preview(inputs),
            readyAt: null,
            inputs,
            manualHash: inputs.session === null ? null : sha256Hex(screenManualJsonV2(inputs.session)),
            abort: new AbortController(),
        }
        this.evicted.delete(key)
        this.held.set(key, held)
        this.trimCache()
        if (inFlight(held.entry) && this.current(key, held)) void this.generate(key, held)
        this.publish()
        return held.entry
    }
    /**
     * A loading/navigation boundary may await an actual complete composition before presenting a factual route.
     * This never upgrades a pending/fallback document, changes its origin, or invents a usable donor on a cold start.
     */
    waitForGenerated(
        inputs: ScreenContextInputsV2,
        options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
    ): Promise<ScreenDocumentV2 | null> {
        const timeoutMs = options.timeoutMs ?? DOCUMENT_COLLECTION_DEADLINE_MS
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOCUMENT_COLLECTION_DEADLINE_MS)
            throw new Error('invalid_document_wait_limit')
        if (options.signal?.aborted === true || this.disposed || this.stale(inputs.session))
            return Promise.resolve(null)
        this.request(inputs)
        const key = documentKey(inputs)
        return new Promise((resolve) => {
            let stopped = false
            let unsubscribe = (): void => {}
            const finish = (document: ScreenDocumentV2 | null): void => {
                if (stopped) return
                stopped = true
                clearTimeout(timer)
                unsubscribe()
                options.signal?.removeEventListener('abort', aborted)
                resolve(document)
            }
            const aborted = (): void => finish(null)
            const check = (): void => {
                if (this.disposed || options.signal?.aborted === true || this.stale(inputs.session)) {
                    finish(null)
                    return
                }
                const held = this.held.get(key)
                if (
                    held?.entry.status === 'ready' &&
                    held.entry.exactGeneration === undefined &&
                    held.entry.document.metadata.source === 'generated' &&
                    documentMatchesInputs(held.entry.document, inputs)
                ) {
                    finish(held.entry.document)
                    return
                }
                const collecting = [...this.jobs.values()].some((job) =>
                    documentPrecomputeInputs(job).some((item) => documentKey(item.inputs) === key),
                )
                if (
                    !collecting &&
                    ((!inFlight(held?.entry) && held?.entry.status === 'ready') || this.evicted.has(key))
                )
                    finish(null)
            }
            const timer = setTimeout(() => finish(null), timeoutMs)
            unsubscribe = this.subscribe(check)
            options.signal?.addEventListener('abort', aborted, { once: true })
            check()
        })
    }
    private trimCache(): void {
        while (
            this.held.size > MAX_ENTRIES ||
            this.getCacheUsage().documentBytes > (this.options.maxDocumentBytes ?? DOCUMENT_CACHE_MAX_BYTES)
        ) {
            const oldest = this.held.entries().next().value
            if (oldest === undefined) break
            if (inFlight(oldest[1].entry)) {
                this.evicted.set(oldest[0], 'budget_exhausted')
                while (this.evicted.size > MAX_ENTRIES) this.evicted.delete(this.evicted.keys().next().value!)
            }
            oldest[1].abort.abort()
            this.held.delete(oldest[0])
        }
    }
    retry(inputs: ScreenContextInputsV2): void {
        const key = documentKey(inputs),
            held = this.held.get(key)
        if (!inFlight(held?.entry)) {
            this.held.delete(key)
            this.publish()
        }
    }
    private current(key: string, held: Held): boolean {
        return (
            !this.disposed &&
            !held.abort.signal.aborted &&
            this.held.get(key) === held &&
            !this.stale(held.inputs.session)
        )
    }
    private async generate(key: string, held: Held): Promise<void> {
        let issue: string | null = null
        let document: ScreenDocumentV2 | null = null
        try {
            const metadata = documentRequest({ op: 'generate', inputs: held.inputs }, `documents-${this.options.id()}`)
            const response = await this.options.client!.screensV2(metadata, {
                requestId: metadata.requestId,
                signal: held.abort.signal,
            })
            const verified = interpretDocuments(200, JSON.stringify(response), metadata)
            if (verified.status === 'ok') document = verified.value.document
            else issue = verified.code
        } catch {
            issue = 'provider_error'
        }
        if (!this.current(key, held)) return
        const replacementTooLarge =
            document !== null &&
            this.documentByteSize(document) > (this.options.maxDocumentBytes ?? DOCUMENT_CACHE_MAX_BYTES)
        if (
            held.entry.exactGeneration !== undefined &&
            (document?.metadata.source !== 'generated' || replacementTooLarge)
        ) {
            held.entry = {
                status: 'ready',
                document: held.entry.document,
                issue: replacementTooLarge
                    ? 'budget_exhausted'
                    : (issue ?? document?.metadata.fallbackReason ?? 'invalid_output'),
                exactGeneration: 'unavailable',
            }
            this.trimCache()
            this.publish()
            return
        }
        if (document !== null) this.acceptedDocuments.add(document)
        held.readyAt = document === null ? null : this.now()
        held.entry = {
            status: 'ready',
            document: document ?? localDocument(held.inputs, reasonFor(issue ?? 'invalid_output'), this.now),
            issue,
        }
        this.trimCache()
        this.publish()
    }
    /** Any of the16kinds, only when the caller has real available contexts; never invent capture/results. */
    warmup(inputs: readonly ScreenContextInputsV2[]): void {
        if (this.disposed) return
        for (const context of inputs) {
            const key = documentKey(context)
            if (!this.held.has(key)) this.warmQueue.set(key, context)
        }
        this.drainWarmup()
    }
    private drainWarmup(): void {
        while (!this.disposed && this.warming < (this.options.warmupConcurrency ?? 2)) {
            const next = this.warmQueue.entries().next().value
            if (next === undefined) return
            this.warmQueue.delete(next[0])
            const context = next[1]
            if (this.stale(context.session)) continue
            const entry = this.request(context)
            if (!inFlight(entry)) continue
            this.warming++
            const stop = this.subscribe(() => {
                if (inFlight(this.peek(context))) return
                stop()
                this.warming--
                this.drainWarmup()
            })
        }
    }
    precompute(
        session: ManualSession,
        focusKey: string | null,
        uiState?: ScreenUiStateV2 | null,
        completedStepIds?: readonly string[],
    ): void {
        if (
            (session.reviewStatus === 'reviewed' ? session.reviewedSteps : (session.rawExtraction?.steps ?? []))
                .length === 0
        )
            return
        if (
            this.disposed ||
            this.mode === 'off' ||
            this.options.client === undefined ||
            (this.manuals.get(session.manualId)?.revision ?? 0) > session.revision
        )
            return
        this.observeSession(session)
        if (this.mode === 'steps' && session.reviewStatus === 'reviewed') {
            const guides = documentPrecomputeInputs({ session, uiState, completedStepIds }).filter(
                (item) => item.inputs.kind === 'guide',
            )
            guides.sort((a, b) => Number(b.key === focusKey) - Number(a.key === focusKey))
            this.warmup(guides.flatMap((item) => [item.inputs, ...futureDocumentStates(item.inputs)]))
            return
        }
        const requestedKinds: readonly PrecomputeKindV2[] | undefined = this.mode === 'steps' ? ['guide'] : undefined
        const context = documentJobContextKey({ session, uiState, completedStepIds, requestedKinds }),
            key = sha256Hex(screenManualJsonV2(session))
        if (this.attemptedJobs.get(key) === context) return
        this.attemptedJobs.set(key, context)
        while (this.attemptedJobs.size > MAX_ENTRIES) this.attemptedJobs.delete(this.attemptedJobs.keys().next().value!)
        this.jobs.get(key)?.abort.abort()
        const job: Job = { session, abort: new AbortController(), context, uiState, completedStepIds, requestedKinds }
        this.jobs.set(key, job)
        void this.runJob(key, job, focusKey, uiState, completedStepIds)
        this.warmup(
            documentPrecomputeInputs({ session, uiState, completedStepIds })
                .filter((item) => item.inputs.kind === 'guide')
                .flatMap((item) => futureDocumentStates(item.inputs)),
        )
    }
    private async control(request: ScreensV2Request, signal?: AbortSignal): Promise<ScreensV2Result> {
        const metadata = documentRequest(request, `documents-${this.options.id()}`)
        const result = await this.options.client!.screensV2(metadata, { requestId: metadata.requestId, signal })
        return interpretDocuments(200, JSON.stringify(result), metadata)
    }
    private async runJob(
        key: string,
        job: Job,
        focusKey: string | null,
        uiState: ScreenUiStateV2 | null | undefined,
        completedStepIds: readonly string[] | undefined,
    ): Promise<void> {
        const common = { session: job.session, uiState, completedStepIds, requestedKinds: job.requestedKinds },
            expected = documentPrecomputeInputs(common)
        const deadline = setTimeout(() => job.abort.abort(), DOCUMENT_COLLECTION_DEADLINE_MS)
        try {
            let response = await this.control({ ...common, op: 'precompute', focusKey }, job.abort.signal)
            const received = new Set<string>()
            let previousWant: readonly string[] = []
            for (let poll = 0; poll <= (this.options.maxPolls ?? DOCUMENT_PROGRESS_MAX_POLLS); poll++) {
                if (
                    job.abort.signal.aborted ||
                    this.disposed ||
                    this.stale(job.session) ||
                    this.jobs.get(key) !== job ||
                    response.status !== 'ok'
                )
                    return
                if (response.value.progress !== null && response.value.progress.mode !== this.mode) {
                    void this.cancelJob(job)
                    return
                }
                for (const document of response.value.documents) {
                    const name = document.kind === 'guide' ? `guide:${document.bound.stepId}` : document.kind
                    const context = expected.find((item) => item.key === name)?.inputs
                    if (context === undefined || !this.enabled(context) || !documentMatchesInputs(document, context))
                        continue
                    this.acceptedDocuments.add(document)
                    const cacheKey = documentKey(context),
                        held = this.held.get(cacheKey)
                    if (
                        held?.entry.status !== 'ready' ||
                        held.readyAt === null ||
                        (held.entry.document.metadata.source === 'fallback' && document.metadata.source === 'generated')
                    ) {
                        held?.abort.abort()
                        this.held.set(cacheKey, {
                            inputs: context,
                            entry: { status: 'ready', document, issue: null },
                            readyAt: this.now(),
                            manualHash: context.session === null ? null : key,
                            abort: new AbortController(),
                        })
                        this.trimCache()
                        this.publish()
                    }
                    received.add(name)
                }
                const progress = response.value.progress
                if (progress === null) return
                const remaining = progress.items.filter(
                    (item) => !received.has(item.key) && !['failed', 'cancelled'].includes(item.state),
                )
                if (remaining.length === 0) return
                if (poll === (this.options.maxPolls ?? DOCUMENT_PROGRESS_MAX_POLLS)) return
                const want = remaining
                    .filter((item) => ['ready', 'fallback'].includes(item.state))
                    .slice(0, 8)
                    .map((item) => item.key)
                // Collect newly completed real payloads immediately. Only unfinished/repeated work waits for a poll.
                if (!want.some((name) => !previousWant.includes(name)))
                    await pause(this.options.pollMs ?? DOCUMENT_PROGRESS_POLL_MS, job.abort.signal)
                if (job.abort.signal.aborted) return
                previousWant = want
                response = await this.control(
                    { ...common, op: 'progress', want, jobContextKey: job.context },
                    job.abort.signal,
                )
            }
        } catch {
            /* Collection ends quietly; on-demand requests retain a complete fallback. */
        } finally {
            clearTimeout(deadline)
            if (this.jobs.get(key) === job) {
                this.jobs.delete(key)
                if (!this.disposed) this.publish()
            }
        }
    }
    private async cancelJob(job: Job): Promise<void> {
        if (this.options.client === undefined) return
        try {
            await this.control({
                op: 'cancel',
                session: job.session,
                uiState: job.uiState,
                completedStepIds: job.completedStepIds,
                requestedKinds: job.requestedKinds,
            })
        } catch {
            /* Best effort; never retry. */
        }
    }
    noteShown(document: ScreenDocumentV2, focused: boolean, presentedInputs?: ScreenContextInputsV2): void {
        if (
            !focused ||
            this.disposed ||
            document.kind !== 'guide' ||
            document.metadata.source !== 'generated' ||
            !this.acceptedDocuments.has(document) ||
            document.bound.captureId !== null
        )
            return
        const held = [...this.held.values()].find(
            (record) =>
                record.entry.status === 'ready' && record.entry.document === document && record.inputs.result === null,
        )
        const inputs = held?.inputs ?? presentedInputs
        if (
            inputs === undefined ||
            inputs.captureId !== null ||
            inputs.result !== null ||
            inputs.stepId === null ||
            inputs.session?.reviewStatus !== 'reviewed' ||
            this.stale(inputs.session) ||
            !documentMatchesInputs(document, inputs)
        )
            return
        this.guides.set(`${document.bound.manualId}:${document.bound.revision}:${document.bound.stepId}`, {
            manualId: inputs.session.manualId,
            revision: inputs.session.revision,
            screen: { screenId: document.screenId, contextKey: document.bound.contextKey },
            uiState: screenUiStateV2Schema.parse(screenUiForKindV2('guide', inputs.uiState) ?? {}),
        })
        while (this.guides.size > MAX_ENTRIES) this.guides.delete(this.guides.keys().next().value!)
    }
    shownGuide(session: ManualSession, stepId: string): ScreenContext | null {
        if (this.disposed || this.stale(session)) return null
        const held = this.guides.get(`${session.manualId}:${session.revision}:${stepId}`)
        if (held === undefined) return null
        const current: ScreenContextInputsV2 = {
            kind: 'guide',
            session,
            stepId,
            captureId: null,
            result: null,
            failure: null,
            uiState: held.uiState,
        }
        return held.screen.contextKey === sha256Hex(screenContextJsonV2(current)) ? held.screen : null
    }
    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        for (const held of this.held.values()) held.abort.abort()
        for (const job of this.jobs.values()) {
            job.abort.abort()
            void this.cancelJob(job)
        }
        this.held.clear()
        this.evicted.clear()
        this.jobs.clear()
        this.attemptedJobs.clear()
        this.guides.clear()
        this.warmQueue.clear()
        this.publish()
        this.listeners.clear()
    }
}
