import {
    canonicalJson,
    assembleDocumentV2,
    documentMaterialV2,
    pendingCheckV2,
    buildFallbackDocumentV2,
    rebindGeneratedStatesV2,
    screenContextJsonV2,
    screenDocumentV2Schema,
    screenManualJsonV2,
    screenUiForKindV2,
    screenUiStateV2Schema,
    VARIANT_STATES,
    withShellStatesV2,
    type FallbackReasonV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenUiStateV2,
} from '@truebuild/contracts'
import type { ScreenContext } from '@truebuild/contracts/model'
import {
    documentMatchesInputs,
    documentPrecomputeInputs,
    documentRequest,
    interpretDocuments,
} from '../../api/document-client'
import type { ModelApiClient } from '../../api/model-client'
import { sha256Hex } from '../documents/sha256'
import { recordedDocument } from './recorded-runtime'
import { isResultLayoutDocument } from './result-layout-runtime'
import { reviewedSession } from '../capture/reviewed-session'
import { stepPiecesForStep } from '../pieces/piece-registry'

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
    /** Undisplayed work skips donor composition until a real foreground request adopts it. */
    background: boolean
    readonly inputs: ScreenContextInputsV2
    readonly manualHash: string | null
    readonly abort: AbortController
    /** True only while this entry's provider request is actually outstanding. */
    generating: boolean
}
/** The global bound on simultaneous provider generations, displayed and background together. */
const MAX_GENERATIONS = 4
export const DOCUMENT_CACHE_MAX_ENTRIES = 512
export const DOCUMENT_CACHE_MAX_BYTES = 32 * 1_024 * 1_024
const MAX_ENTRIES = DOCUMENT_CACHE_MAX_ENTRIES
/** Bound a navigation waiter; generation may still finish and be cached after that waiter ends. */
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
    /** Future Confirm identity only. It never replaces the observed session or grants shown-Guide custody. */
    private readonly preparedSessions = new Map<string, { sourceHash: string; hash: string; session: ManualSession }>()
    private readonly guides = new Map<
        string,
        { manualId: string; revision: number; screen: ScreenContext; uiState: ScreenUiStateV2; hasStepPieces: boolean }
    >()
    private readonly documentSizes = new WeakMap<ScreenDocumentV2, number>()
    private readonly acceptedDocuments = new WeakSet<ScreenDocumentV2>()
    private readonly listeners = new Set<() => void>()
    private readonly warmQueue = new Map<string, ScreenContextInputsV2>()
    /** A workflow render must not silently regenerate a completed background page after cache eviction. */
    private readonly flowAttempts = new Set<string>()
    /** Protect only the current Guide; its priority never overrides the hard cache limits. */
    private focusedGuide: { manualId: string; revision: number; hash: string; keys: Set<string> } | null = null
    private version = 0
    private disposed = false
    private readonly now: () => number
    constructor(private readonly options: DocumentStoreOptions) {
        this.mode = options.mode
        this.now = options.now ?? Date.now
        for (const value of [options.warmupConcurrency ?? 2, options.maxDocumentBytes ?? DOCUMENT_CACHE_MAX_BYTES]) {
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
    private stale(session: ManualSession | null, prepared = false): boolean {
        if (session === null) return false
        const known = this.manuals.get(session.manualId)
        const hash = sha256Hex(screenManualJsonV2(session))
        return (
            known !== undefined &&
            (session.revision < known.revision ||
                (session.revision === known.revision &&
                    hash !== known.hash &&
                    !(prepared && this.preparedSessions.get(session.manualId)?.hash === hash)))
        )
    }
    observeSession(session: ManualSession): void {
        if (this.disposed) return
        const known = this.manuals.get(session.manualId)
        if (known !== undefined && session.revision < known.revision) return
        const hash = sha256Hex(screenManualJsonV2(session))
        if (known?.revision === session.revision && known.hash === hash) return
        this.manuals.set(session.manualId, { revision: session.revision, hash })
        const candidate = session.reviewStatus === 'reviewed' ? null : reviewedSession(session)
        const preparedHash = candidate === null ? null : sha256Hex(screenManualJsonV2(candidate))
        if (candidate !== null && preparedHash !== null)
            this.preparedSessions.set(session.manualId, { sourceHash: hash, hash: preparedHash, session: candidate })
        else this.preparedSessions.delete(session.manualId)
        if (
            this.focusedGuide?.manualId === session.manualId &&
            this.focusedGuide.hash !== hash &&
            this.focusedGuide.hash !== preparedHash
        )
            this.focusedGuide = null
        for (const [key, held] of this.held)
            if (
                held.inputs.session?.manualId === session.manualId &&
                (held.inputs.session.revision !== session.revision ||
                    (held.manualHash !== hash && held.manualHash !== preparedHash))
            ) {
                held.abort.abort()
                this.held.delete(key)
            }
        for (const [key, record] of this.guides)
            if (record.manualId === session.manualId && record.revision !== session.revision) this.guides.delete(key)
        this.publish()
    }
    invalidateManual(manualId: string, revision: number): void {
        if (this.disposed) return
        const known = this.manuals.get(manualId)
        if (known === undefined || known.revision < revision) {
            this.manuals.set(manualId, { revision, hash: '' })
            this.preparedSessions.delete(manualId)
        }
        if (this.focusedGuide?.manualId === manualId && this.focusedGuide.revision < revision) this.focusedGuide = null
        for (const [key, held] of this.held)
            if (held.inputs.session?.manualId === manualId && held.inputs.session.revision < revision) {
                held.abort.abort()
                this.held.delete(key)
            }
        for (const [key, record] of this.guides)
            if (record.manualId === manualId && record.revision < revision) this.guides.delete(key)
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
        if (changed) this.publish()
    }
    preview(inputs: ScreenContextInputsV2): DocumentRuntimeEntry {
        return this.previewEntry(inputs, true)
    }
    /** Same authored Guide READY, exact current activity shell. This local view earns no server-issued shown custody. */
    private previewGuideActivity(inputs: ScreenContextInputsV2): ScreenDocumentV2 | null {
        if (inputs.kind !== 'guide' || inputs.uiState?.busy == null || this.stale(inputs.session)) return null
        const idle = { ...inputs, uiState: { ...inputs.uiState, busy: null } }
        const donor = this.held.get(documentKey(idle))?.entry
        if (
            donor?.status !== 'ready' ||
            donor.document.metadata.source !== 'generated' ||
            !documentMatchesInputs(donor.document, idle)
        )
            return null
        const { document } = donor
        const material = documentMaterialV2(inputs)
        const proposal = withShellStatesV2(material, {
            header: document.header,
            body: document.body,
            bar: document.bar,
            overlays: document.overlays,
        })
        const candidate = screenDocumentV2Schema.safeParse(
            assembleDocumentV2(
                material,
                proposal,
                {
                    ...document.metadata,
                    shellStates: VARIANT_STATES.filter((state) => proposal.states[state] !== null),
                },
                { sha256Hex, now: (): Date => new Date(this.now()) },
            ),
        )
        return candidate.success && documentMatchesInputs(candidate.data, inputs) ? candidate.data : null
    }
    private previewEntry(inputs: ScreenContextInputsV2, carry: boolean): DocumentRuntimeEntry {
        const enabled = this.enabled(inputs) && this.options.client !== undefined && !this.disposed
        const recorded =
            enabled &&
            (process.env.EXPO_PUBLIC_RELEASE_FIXTURE === '1' || process.env.EXPO_PUBLIC_DOCUMENT_FIXTURES === '1')
                ? (this.options.recordings ?? recordedDocument)(inputs)
                : null
        if (
            recorded !== null &&
            this.documentByteSize(recorded) <= (this.options.maxDocumentBytes ?? DOCUMENT_CACHE_MAX_BYTES)
        ) {
            return {
                status: 'ready',
                document: recorded,
                issue: null,
                ...(isResultLayoutDocument(recorded) && !pendingCheckV2(inputs)
                    ? { exactGeneration: 'pending' as const }
                    : {}),
            }
        }
        const activity = enabled && carry ? this.previewGuideActivity(inputs) : null
        if (
            activity !== null &&
            this.documentByteSize(activity) <= (this.options.maxDocumentBytes ?? DOCUMENT_CACHE_MAX_BYTES)
        )
            return { status: 'ready', document: activity, issue: null }
        const reason = enabled ? 'busy' : this.enabled(inputs) && !this.disposed ? 'unconfigured' : 'disabled'
        const local = localDocument(inputs, reason, this.now)
        const donors =
            enabled && carry
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
        return {
            status: enabled && fits && !pendingCheckV2(inputs) ? 'pending' : 'ready',
            document,
            issue: fits ? null : 'budget_exhausted',
        }
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
        return this.admit(inputs, false)
    }
    private admit(inputs: ScreenContextInputsV2, background: boolean): DocumentRuntimeEntry {
        const revision = inputs.session === null ? undefined : this.manuals.get(inputs.session.manualId)?.revision
        if (this.disposed || (revision !== undefined && inputs.session !== null && inputs.session.revision < revision))
            return { status: 'ready', document: localDocument(inputs, 'stale', this.now), issue: 'stale' }
        if (
            inputs.session !== null &&
            !(
                background &&
                this.preparedSessions.get(inputs.session.manualId)?.hash ===
                    sha256Hex(screenManualJsonV2(inputs.session))
            )
        )
            this.observeSession(inputs.session)
        const key = documentKey(inputs)
        const existing = this.held.get(key)
        if (existing !== undefined) {
            if (!background && existing.background) {
                existing.background = false
                if (inFlight(existing.entry) && existing.entry.document.metadata.source === 'fallback') {
                    existing.entry = this.preview(inputs)
                    this.trimCache(key)
                    this.publish()
                }
            }
            return this.peek(inputs) ?? existing.entry
        }
        const held: Held = {
            entry: this.previewEntry(inputs, !background),
            readyAt: null,
            background,
            inputs,
            manualHash: inputs.session === null ? null : sha256Hex(screenManualJsonV2(inputs.session)),
            abort: new AbortController(),
            generating: false,
        }
        this.evicted.delete(key)
        this.held.set(key, held)
        this.trimCache(background ? undefined : key)
        // At the global bound the entry stays pending in `held`; drainWarmup starts it when a generation completes.
        if (inFlight(held.entry) && this.current(key, held) && this.inFlightTotal() < MAX_GENERATIONS)
            void this.generate(key, held)
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
                if ((!inFlight(held?.entry) && held?.entry.status === 'ready') || this.evicted.has(key)) finish(null)
            }
            const timer = setTimeout(() => finish(null), timeoutMs)
            unsubscribe = this.subscribe(check)
            options.signal?.addEventListener('abort', aborted, { once: true })
            check()
        })
    }
    private trimCache(foregroundKey?: string): void {
        while (
            this.held.size > MAX_ENTRIES ||
            this.getCacheUsage().documentBytes > (this.options.maxDocumentBytes ?? DOCUMENT_CACHE_MAX_BYTES)
        ) {
            // Prefer unrelated LRU payloads, then the current Guide if it cannot fit. A current foreground
            // admission keeps the original MRU behavior; even it is removed when individually oversized.
            const oldest =
                [...this.held].find(([key]) => key !== foregroundKey && !this.focusedGuide?.keys.has(key)) ??
                [...this.held].find(([key]) => key !== foregroundKey) ??
                this.held.entries().next().value
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
            !this.stale(held.inputs.session, held.background)
        )
    }
    /** Every completion, including stale and exact-generation failures, frees a slot and drains the queues. */
    private async generate(key: string, held: Held): Promise<void> {
        held.generating = true
        try {
            await this.collect(key, held)
        } finally {
            held.generating = false
            this.drainWarmup()
        }
    }
    private async collect(key: string, held: Held): Promise<void> {
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
        this.queueWarmup(inputs, false)
    }
    private queueWarmup(inputs: readonly ScreenContextInputsV2[], first: boolean): void {
        if (this.disposed) return
        const previous = first ? [...this.warmQueue] : []
        if (first) this.warmQueue.clear()
        for (const context of inputs) {
            const key = documentKey(context)
            if (!this.held.has(key)) this.warmQueue.set(key, context)
        }
        for (const [key, context] of previous) if (!this.warmQueue.has(key)) this.warmQueue.set(key, context)
        this.drainWarmup()
    }
    /** Every generation in flight, displayed or background, shares the one bound. */
    private inFlightTotal(): number {
        let count = 0
        for (const held of this.held.values()) if (held.generating) count++
        return count
    }
    /** Only undisplayed preparation is bounded by `warmupConcurrency`; a promoted entry keeps running as displayed. */
    private backgroundInFlight(): number {
        let count = 0
        for (const held of this.held.values()) if (held.generating && held.background) count++
        return count
    }
    private drainWarmup(): void {
        // Displayed requests that were queued at the bound start first; they never wait on background preparation.
        for (const [key, held] of [...this.held]) {
            if (this.disposed || this.inFlightTotal() >= MAX_GENERATIONS) return
            if (!held.background && inFlight(held.entry) && !held.generating && this.current(key, held))
                void this.generate(key, held)
        }
        const limit = Math.min(this.options.warmupConcurrency ?? 2, MAX_GENERATIONS)
        while (!this.disposed && this.inFlightTotal() < MAX_GENERATIONS && this.backgroundInFlight() < limit) {
            const next = this.warmQueue.entries().next().value
            if (next === undefined) return
            this.warmQueue.delete(next[0])
            const context = next[1]
            if (this.stale(context.session, true)) continue
            this.admit(context, true)
        }
    }
    /**
     * Prepare only reachable destinations through one bounded queue: the focused Guide and the next step's Guide, never
     * the whole manual. A future Guide is composed for exactly the candidate Confirm will save; its original identity
     * becomes usable only when that actual session is observed.
     * Nonready states already belong to each complete document, so no speculative busy-state model calls are needed.
     */
    prepareFlow(
        session: ManualSession,
        focusKey: string | null,
        quickCheck?: ScreenContextInputsV2,
        uiState?: ScreenUiStateV2 | null,
        upcoming: readonly ScreenContextInputsV2[] = [],
    ): void {
        if (
            this.disposed ||
            this.mode === 'off' ||
            this.options.client === undefined ||
            (session.reviewStatus === 'reviewed' ? session.reviewedSteps : (session.rawExtraction?.steps ?? []))
                .length === 0 ||
            (this.manuals.get(session.manualId)?.revision ?? 0) > session.revision
        )
            return
        this.observeSession(session)
        const preparation = this.preparedSessions.get(session.manualId)
        const target =
            preparation?.sourceHash === sha256Hex(screenManualJsonV2(session)) ? preparation.session : session
        const items = documentPrecomputeInputs({ session: target, uiState }).map((item) => {
            if (item.inputs.kind !== 'guide') return item
            const pieces = stepPiecesForStep(target, item.inputs.stepId)
            return pieces.length === 0 ? item : { ...item, inputs: { ...item.inputs, stepPieces: pieces } }
        })
        const guides = items.filter((item) => item.inputs.kind === 'guide')
        const focused = guides.find((item) => item.key === focusKey) ?? guides[0]
        const next = focused === undefined ? undefined : guides[guides.indexOf(focused) + 1]
        const hash = sha256Hex(screenManualJsonV2(target))
        this.focusedGuide =
            focused === undefined
                ? null
                : {
                      manualId: target.manualId,
                      revision: target.revision,
                      hash,
                      keys: new Set([documentKey(focused.inputs)]),
                  }
        const camera: ScreenContextInputsV2[] =
            this.mode === 'full' && focused !== undefined && target.reviewStatus === 'reviewed'
                ? [
                      {
                          ...focused.inputs,
                          kind: 'camera',
                          stepPieces: undefined,
                          uiState: {
                              camera: {
                                  mode: 'build-photo',
                                  permission: 'granted',
                                  failed: false,
                                  canAskAgain: true,
                              },
                          },
                      },
                  ]
                : []
        const destinations = [
            ...(this.mode === 'full' && session.reviewStatus !== 'reviewed' && quickCheck !== undefined
                ? [quickCheck]
                : []),
            ...(focused === undefined ? [] : [focused.inputs]),
            ...camera,
            // Exact next-screen contexts the caller derived from real state (Home after Confirm, Add and page camera from
            // Home). They are keyed like the screen's own request, so the screen reuses them instead of regenerating.
            ...(this.mode === 'full' ? upcoming : []),
            ...(next === undefined ? [] : [next.inputs]),
        ]
        const pending = destinations.filter((inputs) => {
            const key = documentKey(inputs)
            if (this.flowAttempts.has(key)) return this.warmQueue.has(key)
            this.flowAttempts.add(key)
            return true
        })
        while (this.flowAttempts.size > MAX_ENTRIES) this.flowAttempts.delete(this.flowAttempts.values().next().value!)
        this.queueWarmup(pending, true)
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
            hasStepPieces: inputs.stepPieces !== undefined,
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
            ...(held.hasStepPieces ? { stepPieces: stepPiecesForStep(session, stepId) } : {}),
        }
        return held.screen.contextKey === sha256Hex(screenContextJsonV2(current)) ? held.screen : null
    }
    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        for (const held of this.held.values()) held.abort.abort()
        this.held.clear()
        this.evicted.clear()
        this.preparedSessions.clear()
        this.guides.clear()
        this.warmQueue.clear()
        this.flowAttempts.clear()
        this.focusedGuide = null
        this.publish()
        this.listeners.clear()
    }
}
