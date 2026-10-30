import { MAX_PARSE_PAGES, PARSE_SPLIT_MESSAGE, parseLanguageSchema } from '@truebuild/contracts/model'
import { releaseTemporaryImage } from '../../media/owned-temporary-images'
import { selectedStepSourcePageIds } from '../assembly/source-selection'
import {
    checkResultSchema,
    LIMITS,
    manualSessionSchema,
    matchesBinding,
    parsedManualSchema,
    type ApiResult,
    type CaptureBinding,
    type CheckResult,
    type ManualPage,
    type ManualBinding,
    type ManualSession,
    type NormalizedBox,
    type ParsedManual,
    type QuestionResult,
    type QuestionTarget,
    type TrackRecord,
} from '@truebuild/contracts'
import {
    MODEL_CHECK_TIMEOUT_MS,
    MODEL_OVERLAY_TIMEOUT_MS,
    MODEL_PARSE_TIMEOUT_MS,
    MODEL_SECOND_OPINION_TIMEOUT_MS,
    type ImageBytes,
    type ModelApiClient,
} from '../../api/model-client'
import { awaitStopped, createCallGuard } from '../../api/transport'
import type { locateInPhoto } from '../assembly/localize'
import type { NormalizedImage, SourceImageAsset } from '../../media/normalize-image'
import { bytesToDataUri } from '../../media/image-source'
import { userMessageForMediaError } from '../../media/media-errors'
import { askModelQuestion, loadCitedSources, observationImage } from '../assembly/model-check'
import type { Observation } from '../assembly/observation'
import type { OverlayResult, ScreenContext } from '@truebuild/contracts/model'
import type { Digest, LibraryEntry, LibraryStorage } from './library'
import { secondOpinionTarget } from './provenance-copy'

const QUESTION_CAPTURE_TIMEOUT_MS = 30_000
const LOCAL_LIBRARY_READ_FAILURE =
    'Local library images could not be read. Original data is retained. Retry reading the local library before making changes.'
const LOCAL_LIBRARY_SAVE_FAILURE =
    'Could not save on this device. Original library data is retained. Retry reading the local library before making changes.'

/** The complete registered page identity, independent of whichever manual is currently selected. */
export function manualPageImagesKey(session: Pick<ManualSession, 'manualId' | 'revision' | 'pages'>): string {
    return JSON.stringify([
        session.manualId,
        session.revision,
        session.pages.map((page) => [
            page.pageId,
            page.assetId,
            page.contentHash,
            page.width,
            page.height,
            page.mimeType,
        ]),
    ])
}

export type ScreenRoute = 'library' | 'pages' | 'overview' | 'guide' | 'camera'
export type CameraIntent = { kind: 'page'; replaceIndex?: number } | { kind: 'check' | 'question' }
export type CaptureView = { binding: CaptureBinding; observation: Observation; capturedAt: number; reusable: boolean }
export type StepFactResolution = {
    readonly orientation?: { readonly partId: string; readonly description: string }
    readonly visibleChecks?: readonly string[]
}
/** What one background follow-up of a published verdict did, from observed facts only. */
export type StageStatus =
    | { readonly status: 'pending' }
    | { readonly status: 'landed'; readonly elapsedMs: number }
    | { readonly status: 'skipped'; readonly reason: 'not_offered' | 'no_prompts' | 'unavailable' }
    | { readonly status: 'failed'; readonly code: string; readonly elapsedMs: number | null }
export type OverlayStage = StageStatus & { readonly model?: string; readonly effort?: string }
/** `modelElapsedMs` is the server's own SAM stage time when it reported one; otherwise null (never estimated). */
export type SegmentsStage = StageStatus & { readonly modelElapsedMs?: number | null; readonly model?: string }
export type SegmentMark = { readonly label: string; readonly box: NormalizedBox; readonly mask?: TrackRecord['mask'] }
/**
 * The same photo's stages after the verdict. Times are measured on this device (monotonic enough for display) and
 * labelled that way; nothing here is a server claim except what each response itself carries.
 */
export type CheckStages = {
    readonly captureId: string
    /** This device's clock when the verdict was published; the follow-ups' times count from here. */
    readonly publishedAt?: number
    readonly verdictMs: number | null
    readonly overlay: OverlayStage
    readonly segments: SegmentsStage
    readonly masks: readonly SegmentMark[]
}
/**
 * The verdict as the primary check published it, kept apart from the check on screen: an automatic closer look can
 * replace the shown check, and the judge layer must still show what each model really contributed. Telemetry is the
 * server's observation of that one call; `deviceMs` is this device's own elapsed wait, a different measure.
 */
export type PrimaryVerdict = {
    readonly captureId: string
    readonly decision: CheckResult['decision']
    readonly model: CheckResult['model']
    readonly telemetry: CheckResult['telemetry'] | null
    readonly deviceMs: number
}
const SEGMENT_PROMPTS_USED = 3

export type WorkflowState = {
    route: ScreenRoute
    entries: readonly LibraryEntry[]
    selectedId: string | null
    pending: string | null
    notice: string | null
    loading: boolean
    storageReadOnly: boolean
    cameraIntent: CameraIntent | null
    capture: CaptureView | null
    check: CheckResult | null
    answer: QuestionResult | null
    /** Exact submitted question paired with this answer; the editable draft is never its provenance. */
    answeredQuestion?: string | null
    question: string
    target: QuestionTarget | null
    pageUris: Readonly<Record<string, string>>
    /** Present only when the server offered follow-ups for the current capture. */
    stages?: CheckStages | null
    /** The primary verdict of the current capture, retained when a closer look replaces the shown check. */
    primary?: PrimaryVerdict | null
}
export type CapturePorts = {
    storage: LibraryStorage
    client: Pick<ModelApiClient, 'parse' | 'check' | 'questions' | 'secondOpinion'> &
        Partial<Pick<ModelApiClient, 'overlay' | 'segments' | 'questionResult' | 'questionCancel'>>
    normalize: (asset: SourceImageAsset) => Promise<NormalizedImage>
    digest: Digest
    id: () => string
    now?: () => number
    /**
     * The identity of the VALIDATED generated guide page currently shown for this exact manual revision and step, or null
     * when none is. It rides on the check, the closer look, the overlay and the question so the server can ground them in
     * the wording the person actually read; absent behaves exactly as before.
     */
    screenContext?: (session: ManualSession, stepId: string) => ScreenContext | null
    /**
     * Finds named parts in the frozen photo (prepares the image, then streams `/api/segments`). Injected so this module
     * stays free of native image code; absent means no mask follow-up is attempted.
     */
    locate?: typeof locateInPhoto
}

/** Owned by one capture action; never reconstructed from mutable UI state for the follow-up. */
type FrozenCheckContext = {
    screen?: ScreenContext
    requestId: string
    binding: CaptureBinding
    session: ManualSession
    sourcePageIds: string[]
    sources: ImageBytes[]
    observation: ImageBytes
}

export function reviewedSession(session: ManualSession): ManualSession | null {
    const candidate = {
        ...session,
        reviewStatus: 'reviewed',
        reviewedSteps: session.reviewedSteps.map((step) => ({
            ...step,
            correction: step.correction === null ? null : { ...step.correction, reviewed: true },
        })),
    }
    const valid = manualSessionSchema.safeParse(candidate)
    return valid.success ? valid.data : null
}

export { unresolvedCriticalFacts } from '@truebuild/contracts/model'

/** Adds the overlay's regions to a verdict. The decision is never touched; an absent overlay region leaves the verdict's own. */
function mergeOverlay(check: CheckResult, overlay: OverlayResult): CheckResult {
    return {
        ...check,
        observedRegion: overlay.observedRegion ?? check.observedRegion,
        ...(overlay.nextPartRegion === undefined ? {} : { nextPartRegion: overlay.nextPartRegion }),
        ...(overlay.targetRegion === undefined ? {} : { targetRegion: overlay.targetRegion }),
        ...(overlay.layout === undefined ? {} : { layout: overlay.layout }),
    }
}

/** One application owner. Epoch + abort + binding checks fence every asynchronous handoff; persisted state never includes
 * verdicts/answers or pending work. Restored captures are view-only until a fresh photo is taken.
 */
export class CaptureController {
    private state: WorkflowState = {
        route: 'library',
        entries: [],
        selectedId: null,
        pending: null,
        notice: null,
        loading: true,
        storageReadOnly: false,
        cameraIntent: null,
        capture: null,
        check: null,
        answer: null,
        answeredQuestion: null,
        question: '',
        target: null,
        pageUris: {},
    }
    private saving = false
    private writeSettlement: Promise<void> | null = null
    private openRequest = 0
    private readonly listeners = new Set<() => void>()
    private epoch = 0
    private operation: AbortController | null = null
    private operationKind: 'pages' | 'parse' | 'capture' | 'check' | 'secondOpinion' | 'ask' | null = null
    private checkCapture: CaptureBinding | null = null
    private followUps: AbortController | null = null
    private overlayPatch: OverlayResult | null = null
    private readonly now: () => number
    constructor(private readonly ports: CapturePorts) {
        this.now = ports.now ?? ((): number => Date.now())
    }
    getSnapshot = (): WorkflowState => this.state
    /** App presentation witness only; no wire assertion and no action/reuse permission. */
    get pendingCheckCapture(): CaptureBinding | null {
        const capture = this.state.capture
        const entry = this.current
        return this.checkCapture !== null &&
            capture?.binding === this.checkCapture &&
            this.state.check === null &&
            this.operation !== null &&
            !this.operation.signal.aborted &&
            (this.operationKind === 'capture' || this.operationKind === 'check') &&
            this.state.pending !== null &&
            entry?.session.manualId === this.checkCapture.manualId &&
            entry.session.revision === this.checkCapture.revision &&
            entry.session.reviewStatus === 'reviewed' &&
            entry.session.reviewedSteps[entry.stepIndex]?.stepId === this.checkCapture.stepId
            ? this.checkCapture
            : null
    }
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return (): void => {
            this.listeners.delete(listener)
        }
    }
    private publish(patch: Partial<WorkflowState>): void {
        this.state = { ...this.state, ...patch }
        for (const listener of this.listeners) {
            listener()
        }
    }
    get current(): LibraryEntry | undefined {
        return this.state.entries.find((e) => e.session.manualId === this.state.selectedId)
    }
    private stopOperation(): number {
        this.epoch++
        this.operation?.abort()
        this.operation = null
        this.operationKind = null
        this.checkCapture = null
        // Background presentation work belongs to the capture that started it and never outlives it.
        this.followUps?.abort()
        this.followUps = null
        this.overlayPatch = null
        return this.epoch
    }
    private invalidate(preserveQuestion = false): number {
        const previousUri = this.state.capture?.observation.uri
        const question = preserveQuestion ? this.state.question : ''
        const token = this.stopOperation()
        this.publish({
            pending: null,
            check: null,
            answer: null,
            answeredQuestion: null,
            capture: null,
            target: null,
            question,
            ...(this.state.stages === undefined ? {} : { stages: null }),
            ...(this.state.primary === undefined ? {} : { primary: null }),
        })
        if (previousUri !== undefined) {
            void releaseTemporaryImage(previousUri)
        }
        return token
    }
    get canCompose(): boolean {
        return (
            !this.saving && !this.state.storageReadOnly && (this.state.pending === null || this.operationKind === 'ask')
        )
    }
    cancel = (): void => {
        if (this.saving) {
            this.publish({ notice: 'Finishing the local save. Please wait a moment.' })
            return
        }
        const route =
            this.state.route === 'camera'
                ? this.state.cameraIntent?.kind === 'page'
                    ? 'pages'
                    : 'guide'
                : this.state.route
        const check = this.state.check
        const offer = check?.secondOpinion
        const cancelledCheck =
            this.operationKind === 'secondOpinion' && check && offer?.status === 'available'
                ? {
                      ...check,
                      secondOpinion: { model: offer.model, status: 'unavailable' as const },
                      modelNotes: [
                          ...(check.modelNotes ?? []).slice(0, 9),
                          'Second opinion cancelled. Primary result retained.',
                      ],
                  }
                : check
        this.stopOperation()
        this.publish({
            pending: null,
            check: cancelledCheck,
            route,
            cameraIntent: null,
            notice: 'Cancelled. No late reply will be shown. Retry is a new request.',
        })
    }
    dispose = (): void => {
        this.invalidate()
        this.listeners.clear()
    }

    async restore(): Promise<void> {
        if (this.saving || this.state.pending !== null) {
            return
        }
        this.publish({ loading: true })
        const restored = await this.ports.storage.restore()
        this.publish({
            entries: restored.entries,
            notice: restored.warning,
            loading: false,
            storageReadOnly: restored.readOnly,
        })
    }
    async createManual(): Promise<void> {
        if (this.state.pending !== null || this.saving || this.state.storageReadOnly || this.state.loading) {
            return
        }
        const session: ManualSession = {
            manualId: `manual-${this.ports.id()}`,
            title: 'Untitled manual',
            updatedAt: new Date(this.now()).toISOString(),
            revision: 1,
            pages: [],
            parts: [],
            rawExtraction: null,
            reviewedSteps: [],
            reviewStatus: 'unreviewed',
        }
        const entry: LibraryEntry = { session, stepIndex: 0, completedStepIds: [], capture: null }
        const token = this.epoch
        if ((await this.persist([...this.state.entries, entry])) && token === this.epoch) {
            this.invalidate()
            this.publish({ selectedId: session.manualId, route: 'pages', notice: null, pageUris: {} })
        }
    }
    async open(manualId: string, route: 'pages' | 'overview' | 'guide' = 'overview'): Promise<void> {
        // A durable replacement may precede its controller publication while cleanup settles.
        // Wait before invalidating: a later navigation supersedes this request, and the save keeps its pending owner.
        const requestedAt = this.epoch
        const request = ++this.openRequest
        while (this.writeSettlement !== null) {
            await this.writeSettlement
            if (requestedAt !== this.epoch || request !== this.openRequest) return
        }
        this.invalidate()
        const token = this.epoch
        const entry = this.state.entries.find((e) => e.session.manualId === manualId)
        if (entry === undefined) {
            return
        }
        this.publish({ selectedId: manualId, route, notice: null, pageUris: {} })
        try {
            const uris: Record<string, string> = {}
            for (const page of entry.session.pages) {
                const bytes = await this.readPage(page)
                if (token !== this.epoch) {
                    return
                }
                uris[page.pageId] = bytesToDataUri(bytes, page.mimeType)
            }
            this.publish({ pageUris: uris })
            if (entry.capture !== null) {
                const bytes = await this.readPage(entry.capture.page)
                if (token !== this.epoch) {
                    return
                }
                this.publish({
                    capture: {
                        binding: entry.capture.binding,
                        capturedAt: entry.capture.capturedAt,
                        reusable: false,
                        observation: {
                            ...entry.capture.page,
                            bytes,
                            uri: bytesToDataUri(bytes, entry.capture.page.mimeType),
                        },
                    },
                    notice: 'Saved photo restored for reference. Take a new photo before checking or asking.',
                })
            }
        } catch {
            if (token === this.epoch) {
                this.publish({
                    notice: 'Local images could not be read. Original facts and photo references are retained. Retry reading the library.',
                    storageReadOnly: true,
                })
            }
        }
    }
    /** Reads without selecting a manual; genuine storage failures report the library's global write pause. */
    async pageImages(
        manualId: string,
        revision: number,
        signal?: AbortSignal,
    ): Promise<Readonly<Record<string, string>>> {
        const session = this.state.entries.find((entry) => entry.session.manualId === manualId)?.session
        if (session === undefined || session.revision !== revision) throw new Error('Manual pictures unavailable.')
        const key = manualPageImagesKey(session)
        const pages = session.pages.map((page) => ({ ...page }))
        const assertCurrent = (): void => {
            const current = this.state.entries.find((entry) => entry.session.manualId === manualId)?.session
            if (signal?.aborted === true || current === undefined || manualPageImagesKey(current) !== key)
                throw new Error('Manual pictures are no longer current.')
        }
        const uris = Object.create(null) as Record<string, string>
        for (const page of pages) {
            while (this.writeSettlement !== null) {
                const settling = this.writeSettlement
                if (signal === undefined) await settling
                else await awaitStopped(settling, signal)
                assertCurrent()
            }
            assertCurrent()
            // Attach the integrity-error reporter before racing cancellation: even a late failed verification
            // pauses writes in LibraryStorage, so the workflow must explain that pause immediately.
            const pending = this.readPage(page)
            const bytes = signal === undefined ? await pending : await awaitStopped(pending, signal)
            assertCurrent()
            uris[page.pageId] = bytesToDataUri(bytes, page.mimeType)
        }
        assertCurrent()
        return uris
    }
    home = (): void => {
        this.invalidate()
        this.publish({ route: 'library', selectedId: null, notice: null, pageUris: {} })
    }
    navigate = (route: 'pages' | 'overview' | 'guide'): void => {
        this.invalidate()
        this.publish({ route, notice: null, cameraIntent: null })
    }
    camera = (intent: CameraIntent): void => {
        if (this.state.pending !== null || this.saving || this.state.storageReadOnly) {
            return
        }
        if (intent.kind !== 'page' && this.current?.session.reviewStatus !== 'reviewed') {
            this.publish({ notice: 'Review and confirm the extracted facts first.' })
            return
        }
        this.invalidate(intent.kind === 'question')
        this.publish({ route: 'camera', cameraIntent: intent, notice: null })
    }
    private async readPage(page: ManualPage): Promise<Uint8Array<ArrayBuffer>> {
        try {
            return await this.ports.storage.readAsset(page)
        } catch (error: unknown) {
            this.publish({ storageReadOnly: true, notice: LOCAL_LIBRARY_READ_FAILURE })
            throw error
        }
    }
    private async persist(
        entries: readonly LibraryEntry[],
        writes: Parameters<LibraryStorage['save']>[1] = [],
    ): Promise<boolean> {
        if (this.saving) {
            return false
        }
        this.saving = true
        let settle!: () => void
        const settlement = new Promise<void>((resolve) => {
            settle = resolve
        })
        this.writeSettlement = settlement
        const token = this.epoch
        const operation = this.operation
        const previous = this.state.pending
        this.publish({ pending: previous ?? 'Saving on this device…' })
        try {
            await this.ports.storage.save(entries, writes)
            this.publish({ entries })
            return true
        } catch {
            if (token === this.epoch) {
                this.publish({
                    notice: LOCAL_LIBRARY_SAVE_FAILURE,
                    storageReadOnly: true,
                })
            }
            return false
        } finally {
            this.saving = false
            try {
                if (token === this.epoch && operation === this.operation) {
                    this.publish({ pending: previous })
                }
            } finally {
                // A publication listener may already have started a later write; never clear its settlement.
                if (this.writeSettlement === settlement) this.writeSettlement = null
                settle()
            }
        }
    }
    private replacement(entry: LibraryEntry): LibraryEntry[] {
        return this.state.entries.map((e) => (e.session.manualId === entry.session.manualId ? entry : e))
    }
    private changedPages(entry: LibraryEntry, pages: ManualPage[]): LibraryEntry {
        return {
            ...entry,
            stepIndex: 0,
            completedStepIds: [],
            capture: null,
            session: {
                ...entry.session,
                pages,
                revision: entry.session.revision + 1,
                updatedAt: new Date(this.now()).toISOString(),
                parts: [],
                rawExtraction: null,
                reviewedSteps: [],
                reviewStatus: 'unreviewed',
                extractionSourcePageIds: [],
            },
        }
    }
    async rename(title: string): Promise<void> {
        const entry = this.current
        if (
            entry === undefined ||
            this.state.pending !== null ||
            this.saving ||
            this.state.storageReadOnly ||
            title.trim().length === 0 ||
            title.length > 200
        ) {
            return
        }
        await this.persist(this.replacement({ ...entry, session: { ...entry.session, title: title.trim() } }))
    }
    async editPage(index: number, action: 'remove' | 'up' | 'down'): Promise<void> {
        const entry = this.current
        if (entry === undefined || this.state.pending !== null || this.saving || this.state.storageReadOnly) {
            return
        }
        const pages = [...entry.session.pages]
        if (action === 'remove') {
            pages.splice(index, 1)
        } else {
            const target = index + (action === 'up' ? -1 : 1)
            const page = pages[index]
            const other = pages[target]
            if (page === undefined || other === undefined) {
                return
            }
            pages[index] = other
            pages[target] = page
        }
        this.invalidate()
        await this.persist(this.replacement(this.changedPages(entry, pages)))
    }
    async importPages(select: () => Promise<readonly SourceImageAsset[]>, replaceIndex?: number): Promise<void> {
        const entry = this.current
        if (entry === undefined || this.state.pending !== null || this.saving || this.state.storageReadOnly) {
            return
        }
        const token = this.invalidate()
        const operation = new AbortController()
        this.operation = operation
        this.operationKind = 'pages'
        this.publish({ route: 'pages', pending: 'Choosing manual pages…', notice: null, cameraIntent: null })
        let assets: readonly SourceImageAsset[] = []
        try {
            assets = await select()
            if (token !== this.epoch || operation.signal.aborted) {
                for (const asset of assets) {
                    await releaseTemporaryImage(asset.uri)
                }
                return
            }
            if (assets.length === 0) {
                return
            }
            const count = entry.session.pages.length + assets.length - (replaceIndex === undefined ? 0 : 1)
            if (count > LIMITS.manualPages || (replaceIndex !== undefined && assets.length !== 1)) {
                this.publish({
                    notice: `Choose up to ${LIMITS.manualPages} pages per manual. Retake replaces exactly one page.`,
                })
                return
            }
            const pages = [...entry.session.pages]
            const writes: { assetId: string; bytes: Uint8Array }[] = []
            const uris = { ...this.state.pageUris }
            for (const [index, asset] of assets.entries()) {
                this.publish({ pending: `Preparing page ${index + 1} of ${assets.length}…` })
                const image = await this.ports.normalize(asset)
                try {
                    if (token !== this.epoch || operation.signal.aborted) {
                        return
                    }
                    const page = await this.pageFor(image)
                    if (token !== this.epoch || operation.signal.aborted) {
                        return
                    }
                    if (replaceIndex === undefined) {
                        pages.push(page)
                    } else {
                        pages[replaceIndex] = page
                    }
                    writes.push({ assetId: page.assetId, bytes: image.bytes })
                    uris[page.pageId] = bytesToDataUri(image.bytes, image.mimeType)
                } finally {
                    await releaseTemporaryImage(image.uri)
                }
            }
            if (token !== this.epoch || operation.signal.aborted) {
                return
            }
            this.publish({ pending: 'Saving manual pages…' })
            if (await this.persist(this.replacement(this.changedPages(entry, pages)), writes)) {
                if (token === this.epoch) {
                    this.publish({ pageUris: uris })
                }
            }
        } catch (error: unknown) {
            if (token === this.epoch) {
                this.publish({ notice: userMessageForMediaError(error) })
            }
        } finally {
            for (const asset of assets) {
                await releaseTemporaryImage(asset.uri)
            }
            if (token === this.epoch) {
                this.operation = null
                this.operationKind = null
                this.publish({ pending: null })
            }
        }
    }
    private async pageFor(image: NormalizedImage): Promise<ManualPage> {
        const id = this.ports.id()
        return {
            pageId: `page-${id}`,
            assetId: `asset-${id}`,
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            contentHash: await this.ports.digest(image.bytes),
        }
    }
    async parse(language = 'en'): Promise<void> {
        const entry = this.current
        if (
            entry === undefined ||
            entry.session.pages.length === 0 ||
            this.state.pending !== null ||
            this.saving ||
            this.state.storageReadOnly
        ) {
            return
        }
        if (entry.session.pages.length > MAX_PARSE_PAGES) {
            this.publish({ notice: PARSE_SPLIT_MESSAGE })
            return
        }
        const parsedLanguage = parseLanguageSchema.safeParse(language)
        if (!parsedLanguage.success) {
            this.publish({ notice: 'Enter a language code such as en, fr or pt-BR.' })
            return
        }
        const token = this.invalidate()
        const operation = new AbortController()
        this.operation = operation
        this.operationKind = 'parse'
        const revision = entry.session.revision + 1
        const guard = createCallGuard(MODEL_PARSE_TIMEOUT_MS, operation.signal)
        this.publish({ pending: 'Reading manual pages…', notice: null })
        try {
            const images = []
            for (const page of entry.session.pages) {
                const bytes = await awaitStopped(this.readPage(page), guard.signal)
                guard.checkpoint()
                images.push({ ...page, bytes })
            }
            const result = await this.ports.client.parse(
                { kind: 'manual', manualId: entry.session.manualId, revision },
                entry.session.pages,
                images,
                {
                    requestId: `extract-${this.ports.id()}`,
                    signal: guard.signal,
                    checkpoint: guard.checkpoint,
                    language: parsedLanguage.data,
                },
            )
            guard.checkpoint()
            if (token !== this.epoch) {
                return
            }
            if (result.status !== 'ok') {
                this.publish({
                    notice:
                        result.message ??
                        `Manual reading unavailable (${result.code}). Check the connection and page/upload budgets, then retry as a new request.`,
                })
                return
            }
            const parsed: ParsedManual = result.value
            // Contract data is JSON-only. Keep every nested working value separate from the original extraction,
            // without depending on structuredClone being available in the native runtime.
            const working = parsedManualSchema.parse(JSON.parse(JSON.stringify(parsed)))
            const next: LibraryEntry = {
                ...entry,
                capture: null,
                completedStepIds: [],
                stepIndex: 0,
                session: {
                    ...entry.session,
                    revision,
                    updatedAt: new Date(this.now()).toISOString(),
                    parts: working.parts,
                    rawExtraction: parsed,
                    reviewedSteps: [...working.steps].sort((a, b) => a.order - b.order),
                    reviewStatus: 'unreviewed',
                    extractionSourcePageIds: entry.session.pages.map((p) => p.pageId),
                },
            }
            if ((await this.persist(this.replacement(next))) && token === this.epoch) {
                this.publish({
                    route: 'overview',
                    notice: 'Review every fact against the page diagrams before confirming.',
                })
            }
        } catch {
            if (token === this.epoch) {
                this.publish({
                    notice: this.state.storageReadOnly
                        ? LOCAL_LIBRARY_READ_FAILURE
                        : guard.timedOut()
                          ? 'Manual reading timed out. Retry sends a new request.'
                          : 'Manual reading unavailable. Check your connection and retry.',
                })
            }
        } finally {
            guard.dispose()
            if (token === this.epoch) {
                this.operation = null
                this.operationKind = null
                this.publish({ pending: null })
            }
        }
    }
    async acceptStepFacts(binding: ManualBinding, stepId: string, resolution: StepFactResolution): Promise<boolean> {
        const reject = (notice: string): false => {
            this.publish({ notice })
            return false
        }
        if (this.saving) {
            return reject('Finishing the local save. Please wait before accepting step facts.')
        }
        if (this.state.storageReadOnly) {
            return reject('Local library is read-only. Retry reading it before accepting step facts.')
        }
        const entry = this.current
        if (
            entry === undefined ||
            !matchesBinding(binding, {
                kind: 'manual',
                manualId: entry.session.manualId,
                revision: entry.session.revision,
            })
        ) {
            return reject('This draft belongs to an older manual or revision. Open the current step and try again.')
        }
        const step = entry.session.reviewedSteps.find((candidate) => candidate.stepId === stepId)
        if (step === undefined) {
            return reject('This step is no longer available. Open the current manual and try again.')
        }
        if (
            resolution === null ||
            typeof resolution !== 'object' ||
            Object.keys(resolution).some((key) => key !== 'orientation' && key !== 'visibleChecks') ||
            (resolution.visibleChecks !== undefined && !Array.isArray(resolution.visibleChecks))
        ) {
            return reject('Enter a valid orientation or visible checks before accepting.')
        }
        const hasOrientation = resolution.orientation !== undefined
        const hasChecks = resolution.visibleChecks !== undefined
        if (!hasOrientation && !hasChecks) {
            return reject('Enter a missing orientation or visible checks before accepting.')
        }
        if ((hasOrientation && step.orientation.state !== 'unknown') || (hasChecks && step.visibleChecks.length > 0)) {
            return reject('Only an unresolved orientation or missing visible checks can be accepted.')
        }
        if (step.sourceRefs.length === 0) {
            return reject('This step has no diagram citation. Add clearer pages and read the manual again.')
        }
        if (hasChecks && resolution.visibleChecks!.length === 0) {
            return reject('Enter at least one visible check before accepting.')
        }
        const candidate = manualSessionSchema.safeParse({
            ...entry.session,
            revision: entry.session.revision + 1,
            updatedAt: new Date(this.now()).toISOString(),
            reviewStatus: 'unreviewed',
            reviewedSteps: entry.session.reviewedSteps.map((current) =>
                current !== step
                    ? current
                    : {
                          ...step,
                          orientation:
                              resolution.orientation === undefined
                                  ? step.orientation
                                  : {
                                        state: 'known',
                                        value: resolution.orientation,
                                        sourceRefs: step.sourceRefs,
                                    },
                          visibleChecks:
                              resolution.visibleChecks?.map((description) => ({
                                  checkId: this.ports.id(),
                                  description: { state: 'known', value: description, sourceRefs: step.sourceRefs },
                              })) ?? step.visibleChecks,
                      },
            ),
        })
        if (!candidate.success) {
            return reject(
                'Step facts are invalid. Choose a required part and use 1–500 characters per description, with at most 100 visible checks.',
            )
        }
        const acceptedOrientation = candidate.data.reviewedSteps.find(
            (current) => current.stepId === stepId,
        )!.orientation
        if (
            hasOrientation &&
            acceptedOrientation.state === 'known' &&
            !step.parts.some((part) => part.partId === acceptedOrientation.value.partId)
        ) {
            return reject('Choose an existing part required by this step before accepting its orientation.')
        }
        const token = this.invalidate()
        this.publish({ cameraIntent: null, notice: null })
        const saved = await this.persist(
            this.replacement({
                ...entry,
                session: candidate.data,
                stepIndex: 0,
                completedStepIds: [],
                capture: null,
            }),
        )
        if (!saved) {
            // A navigation epoch must suppress stale screen updates, but a failed device write still locks the library.
            this.publish({ notice: LOCAL_LIBRARY_SAVE_FAILURE, storageReadOnly: true })
        } else if (token === this.epoch && this.current?.session.manualId === binding.manualId) {
            this.publish({ notice: 'Step facts saved. Review every fact in the manual before confirming.' })
        }
        return saved
    }
    async confirm(): Promise<void> {
        const entry = this.current
        if (entry === undefined || this.state.pending !== null || this.saving || this.state.storageReadOnly) {
            return
        }
        const session = reviewedSession(entry.session)
        if (session === null) {
            this.publish({ notice: 'Critical facts are missing. Add clearer pages and read the manual again.' })
            return
        }
        this.invalidate()
        await this.persist(this.replacement({ ...entry, session, capture: null }))
    }
    async step(index: number): Promise<void> {
        const entry = this.current
        if (
            entry === undefined ||
            this.saving ||
            this.state.storageReadOnly ||
            entry.session.reviewedSteps[index] === undefined
        ) {
            return
        }
        const token = this.invalidate()
        const saved = await this.persist(this.replacement({ ...entry, stepIndex: index, capture: null }))
        if (saved && token === this.epoch) {
            this.publish({ route: 'guide', notice: null })
        }
    }
    async completeStep(): Promise<void> {
        const entry = this.current
        if (entry === undefined || this.state.pending !== null || this.saving || this.state.storageReadOnly) {
            return
        }
        const step = entry.session.reviewedSteps[entry.stepIndex]
        if (step === undefined) {
            return
        }
        const next = Math.min(entry.stepIndex + 1, entry.session.reviewedSteps.length - 1)
        const token = this.invalidate()
        const saved = await this.persist(
            this.replacement({
                ...entry,
                capture: null,
                stepIndex: next,
                completedStepIds: [...new Set([...entry.completedStepIds, step.stepId])],
            }),
        )
        if (saved && token === this.epoch) {
            this.publish({ notice: 'Progress saved as your own completion. Take a new photo for the next check.' })
        }
    }
    async shutter(photo: () => Promise<SourceImageAsset>): Promise<void> {
        const intent = this.state.cameraIntent
        if (intent === null || this.state.pending !== null || this.saving || this.state.storageReadOnly) {
            return
        }
        if (intent.kind === 'page') {
            await this.importPages(async () => [await photo()], intent.replaceIndex)
            return
        }
        const entry = this.current
        const step = entry?.session.reviewedSteps[entry.stepIndex]
        if (entry === undefined || step === undefined) {
            return
        }
        const token = this.invalidate(intent.kind === 'question')
        const operation = new AbortController()
        this.operation = operation
        this.operationKind = 'capture'
        const guard = createCallGuard(
            intent.kind === 'check' ? MODEL_CHECK_TIMEOUT_MS : QUESTION_CAPTURE_TIMEOUT_MS,
            operation.signal,
        )
        const capturedAt = this.now()
        this.publish({ pending: 'Freezing photo…', notice: null })
        let original: SourceImageAsset | undefined
        let normalized: NormalizedImage | undefined
        let capturedBinding: CaptureBinding | null = null
        try {
            const asset = await awaitStopped(photo(), guard.signal, (late): void => {
                void releaseTemporaryImage(late.uri)
            })
            original = asset
            guard.checkpoint()
            const image = await awaitStopped(this.ports.normalize(asset), guard.signal, (late): void => {
                void releaseTemporaryImage(late.uri)
            })
            normalized = image
            guard.checkpoint()
            const page = await awaitStopped(this.pageFor(image), guard.signal)
            guard.checkpoint()
            if (token !== this.epoch) {
                return
            }
            const binding: CaptureBinding = {
                kind: 'capture',
                manualId: entry.session.manualId,
                revision: entry.session.revision,
                stepId: step.stepId,
                captureId: `capture-${this.ports.id()}`,
            }
            capturedBinding = binding
            this.checkCapture = intent.kind === 'check' ? binding : null
            this.publish({
                capture: { binding, observation: image, capturedAt, reusable: true },
                route: 'guide',
                cameraIntent: null,
            })
            // Retain the photo within the same absolute action budget; persistence never extends the check deadline.
            const saved = await awaitStopped(
                this.persist(this.replacement({ ...entry, capture: { binding, page, capturedAt } }), [
                    { assetId: page.assetId, bytes: image.bytes },
                ]),
                guard.signal,
            )
            guard.checkpoint()
            if (!saved || token !== this.epoch) {
                return
            }
            if (intent.kind === 'check') {
                this.operationKind = 'check'
                this.publish({ pending: 'Checking frozen photo…' })
                const session = manualSessionSchema.parse(entry.session)
                const sourcePageIds = selectedStepSourcePageIds(session, step)
                const requestId = `check-${this.ports.id()}`
                const sources = await loadCitedSources(
                    session,
                    sourcePageIds,
                    async (id) => {
                        const page = session.pages.find((p) => p.assetId === id)
                        return page === undefined
                            ? null
                            : { assetId: id, mimeType: page.mimeType, bytes: await this.readPage(page) }
                    },
                    guard,
                )
                guard.checkpoint()
                if (sources === null || sourcePageIds.length === 0 || sourcePageIds.length > LIMITS.manualPages) {
                    this.publish({
                        notice: this.unavailable({
                            status: 'unavailable',
                            requestId,
                            binding,
                            code: 'invalid_input',
                            retryable: false,
                        }),
                    })
                    return
                }
                const shownGuide = this.ports.screenContext?.(session, step.stepId) ?? null
                const context: FrozenCheckContext = {
                    ...(shownGuide === null ? {} : { screen: shownGuide }),
                    requestId,
                    binding: { ...binding },
                    session,
                    sourcePageIds,
                    sources: sources.map((source) => ({ ...source, bytes: Uint8Array.from(source.bytes) })),
                    observation: { ...observationImage(image), bytes: Uint8Array.from(image.bytes) },
                }
                guard.checkpoint()
                const verdictStart = this.now()
                const result = await awaitStopped(
                    this.ports.client.check(
                        context.binding,
                        session,
                        sourcePageIds,
                        context.sources,
                        context.observation,
                        {
                            requestId,
                            signal: guard.signal,
                            checkpoint: guard.checkpoint,
                            ...(context.screen === undefined ? {} : { screen: context.screen }),
                        },
                    ),
                    guard.signal,
                )
                guard.checkpoint()
                if (this.ownsCaptureOperation(token, operation, context.binding)) {
                    this.publish(
                        result.status === 'ok'
                            ? {
                                  check: result.value,
                                  primary: {
                                      captureId: context.binding.captureId,
                                      decision: result.value.decision,
                                      model: result.value.model,
                                      telemetry: result.value.telemetry ?? null,
                                      deviceMs: this.now() - verdictStart,
                                  },
                              }
                            : { notice: this.unavailable(result) },
                    )
                    // The primary action is complete. A fresh guard below owns only the optional follow-up.
                    guard.dispose()
                    if (result.status === 'ok') {
                        // Overlay and masks are presentation only: they start now, never delay the verdict, the
                        // automatic closer look or the next action, and stop with the capture that owns them.
                        this.startFollowUps(context, result.value, token, this.now() - verdictStart)
                        await this.followSecondOpinion(context, result.value, token, operation)
                    }
                }
            }
        } catch {
            if (token === this.epoch) {
                this.publish({
                    route: 'guide',
                    cameraIntent: null,
                    notice: this.state.storageReadOnly
                        ? LOCAL_LIBRARY_READ_FAILURE
                        : guard.timedOut()
                          ? intent.kind === 'check'
                              ? 'Cannot verify: photo preparation or check exceeded 8 seconds. Take a new photo for another check.'
                              : 'Camera photo preparation timed out. Take a new photo.'
                          : 'Cannot use this camera photo. Check camera access and connection, then take a new photo.',
                })
            }
        } finally {
            if (original !== undefined) {
                await releaseTemporaryImage(original.uri)
            }
            if (normalized !== undefined && this.state.capture?.observation !== normalized) {
                await releaseTemporaryImage(normalized.uri)
            }
            guard.dispose()
            if (this.checkCapture === capturedBinding) this.checkCapture = null
            if (token === this.epoch) {
                this.operation = null
                this.operationKind = null
                this.publish({ pending: null })
            }
        }
    }
    private isCurrentCapture(binding: CaptureBinding): boolean {
        const capture = this.state.capture
        const entry = this.current
        return (
            capture !== null &&
            capture.reusable &&
            matchesBinding(capture.binding, binding) &&
            entry?.session.manualId === binding.manualId &&
            entry.session.revision === binding.revision &&
            entry.session.reviewedSteps[entry.stepIndex]?.stepId === binding.stepId
        )
    }
    private ownsCaptureOperation(token: number, operation: AbortController, binding: CaptureBinding): boolean {
        return (
            token === this.epoch &&
            this.operation === operation &&
            !operation.signal.aborted &&
            this.isCurrentCapture(binding)
        )
    }
    private async followSecondOpinion(
        context: FrozenCheckContext,
        primary: CheckResult,
        token: number,
        operation: AbortController,
    ): Promise<void> {
        const offer = primary.secondOpinion
        if (
            primary.decision !== 'cannot_verify' ||
            offer?.status !== 'available' ||
            !this.ownsCaptureOperation(token, operation, context.binding)
        )
            return

        const guard = createCallGuard(MODEL_SECOND_OPINION_TIMEOUT_MS, operation.signal)
        const retained = (note: string, status: 'completed' | 'unavailable' = 'unavailable'): CheckResult => ({
            ...primary,
            secondOpinion: { model: offer.model, status },
            modelNotes: [...(primary.modelNotes ?? []).slice(0, 9), note],
        })
        this.operationKind = 'secondOpinion'
        this.publish({ pending: `Second opinion pending (${secondOpinionTarget(primary, offer.model)})…` })
        try {
            guard.checkpoint()
            if (!this.ownsCaptureOperation(token, operation, context.binding)) return
            const result = await awaitStopped(
                this.ports.client.secondOpinion(
                    context.binding,
                    context.session,
                    context.sourcePageIds,
                    context.sources,
                    context.observation,
                    offer.token,
                    {
                        requestId: context.requestId,
                        signal: guard.signal,
                        checkpoint: guard.checkpoint,
                        ...(context.screen === undefined ? {} : { screen: context.screen }),
                    },
                ),
                guard.signal,
            )
            guard.checkpoint()
            if (!this.ownsCaptureOperation(token, operation, context.binding)) return
            this.publish({
                check: this.withOverlay(
                    result.status !== 'ok'
                        ? retained('Second opinion unavailable. Primary result retained.')
                        : result.value.decision === 'pass'
                          ? retained(
                                'Second opinion cannot promote this check to pass. Primary result retained.',
                                'completed',
                            )
                          : result.value,
                ),
            })
        } catch {
            if (this.ownsCaptureOperation(token, operation, context.binding)) {
                this.publish({
                    check: this.withOverlay(
                        retained(
                            guard.timedOut()
                                ? 'Second opinion timed out after 60 seconds. Primary result retained.'
                                : 'Second opinion unavailable. Primary result retained.',
                        ),
                    ),
                })
            }
        } finally {
            guard.dispose()
        }
    }

    /** Presentation regions that already landed for this capture survive a later closer-look replacement of the verdict. */
    private withOverlay(check: CheckResult): CheckResult {
        return this.overlayPatch === null ? check : mergeOverlay(check, this.overlayPatch)
    }

    private ownsFollowUp(token: number, signal: AbortSignal, binding: CaptureBinding): boolean {
        return token === this.epoch && !signal.aborted && this.isCurrentCapture(binding)
    }

    private publishStages(captureId: string, change: (stages: CheckStages) => CheckStages): void {
        const current = this.state.stages
        if (current === undefined || current === null || current.captureId !== captureId) return
        this.publish({ stages: change(current) })
    }

    /**
     * After a verdict is published: the Wonder overlay (regions/layout) and the SAM masks, each only if the server
     * offered it. Neither can change the decision, neither is retried, and a stale capture's late reply is dropped.
     */
    private startFollowUps(context: FrozenCheckContext, primary: CheckResult, token: number, verdictMs: number): void {
        const offers = primary.followUps
        const capture = this.state.capture
        if (offers === undefined || capture === null) return
        const captureId = context.binding.captureId
        const abort = new AbortController()
        this.followUps?.abort()
        this.followUps = abort
        this.overlayPatch = null
        const overlayOffer = offers.overlay?.status === 'available' ? offers.overlay : null
        const prompts = offers.segments?.prompts.slice(0, SEGMENT_PROMPTS_USED) ?? []
        const runOverlay = overlayOffer !== null && this.ports.client.overlay !== undefined
        const runSegments =
            prompts.length > 0 && this.ports.client.segments !== undefined && this.ports.locate !== undefined
        this.publish({
            stages: {
                captureId,
                publishedAt: this.now(),
                verdictMs,
                overlay: runOverlay
                    ? { status: 'pending' }
                    : { status: 'skipped', reason: offers.overlay === undefined ? 'not_offered' : 'unavailable' },
                segments: runSegments
                    ? { status: 'pending' }
                    : { status: 'skipped', reason: offers.segments === undefined ? 'not_offered' : 'no_prompts' },
                masks: [],
            },
        })
        if (runOverlay) {
            void this.runOverlay(context, overlayOffer.token, token, abort.signal)
        }
        if (runSegments) {
            void this.runSegments(context, capture.observation, prompts, token, abort.signal)
        }
    }

    private async runOverlay(
        context: FrozenCheckContext,
        overlayToken: string,
        token: number,
        signal: AbortSignal,
    ): Promise<void> {
        const overlay = this.ports.client.overlay
        if (overlay === undefined) return
        const started = this.now()
        const captureId = context.binding.captureId
        const guard = createCallGuard(MODEL_OVERLAY_TIMEOUT_MS, signal)
        try {
            guard.checkpoint()
            const result = await awaitStopped(
                overlay.call(
                    this.ports.client,
                    context.binding,
                    context.session,
                    context.sourcePageIds,
                    context.sources,
                    context.observation,
                    overlayToken,
                    {
                        requestId: context.requestId,
                        signal: guard.signal,
                        checkpoint: guard.checkpoint,
                        ...(context.screen === undefined ? {} : { screen: context.screen }),
                    },
                ),
                guard.signal,
            )
            guard.checkpoint()
            if (!this.ownsFollowUp(token, signal, context.binding)) return
            const elapsedMs = this.now() - started
            if (result.status !== 'ok') {
                this.publishStages(captureId, (stages) => ({
                    ...stages,
                    overlay: { status: 'failed', code: result.code, elapsedMs },
                }))
                return
            }
            const merged = this.state.check === null ? null : mergeOverlay(this.state.check, result.value)
            const valid = merged === null ? null : checkResultSchema.safeParse(merged)
            if (valid === null || !valid.success) {
                this.publishStages(captureId, (stages) => ({
                    ...stages,
                    overlay: { status: 'failed', code: 'invalid_output', elapsedMs },
                }))
                return
            }
            this.overlayPatch = result.value
            this.publish({ check: valid.data })
            this.publishStages(captureId, (stages) => ({
                ...stages,
                overlay: {
                    status: 'landed',
                    elapsedMs,
                    // A fixture overlay ran no model: it names none, and no effort, rather than an invented one.
                    ...(result.value.model === undefined ? {} : { model: result.value.model }),
                    ...(result.value.effort === undefined ? {} : { effort: result.value.effort }),
                },
            }))
        } catch {
            if (this.ownsFollowUp(token, signal, context.binding)) {
                this.publishStages(captureId, (stages) => ({
                    ...stages,
                    overlay: {
                        status: 'failed',
                        code: guard.timedOut() ? 'timeout' : 'provider_error',
                        elapsedMs: this.now() - started,
                    },
                }))
            }
        } finally {
            guard.dispose()
        }
    }

    private async runSegments(
        context: FrozenCheckContext,
        observation: Observation,
        prompts: readonly string[],
        token: number,
        signal: AbortSignal,
    ): Promise<void> {
        const client = this.ports.client
        const locate = this.ports.locate
        if (client.segments === undefined || locate === undefined) return
        const started = this.now()
        const captureId = context.binding.captureId
        const done: SegmentMark[] = []
        let modelElapsedMs: number | null = null
        let model: string | undefined
        let failure: string | null = null
        const marksOf = (records: readonly TrackRecord[]): SegmentMark[] =>
            records.map((record) => ({
                label: record.label,
                box: record.box,
                ...(record.mask === undefined ? {} : { mask: record.mask }),
            }))
        try {
            for (const prompt of prompts) {
                let latest: SegmentMark[] = []
                for await (const result of locate({
                    client: { segments: client.segments.bind(client) },
                    requestId: `segment-${this.ports.id()}`,
                    binding: context.binding,
                    prompt,
                    observation,
                    signal,
                })) {
                    if (!this.ownsFollowUp(token, signal, context.binding)) return
                    if (result.status === 'unavailable') {
                        failure = result.code
                        break
                    }
                    if (result.value.type === 'snapshot') {
                        latest = marksOf(result.value.snapshot.records)
                        modelElapsedMs = result.value.snapshot.stage?.elapsedMs ?? modelElapsedMs
                        model = result.value.snapshot.stage?.model ?? model
                        const shown = [...done, ...latest]
                        this.publishStages(captureId, (stages) => ({ ...stages, masks: shown }))
                    } else if (result.value.type === 'unavailable') {
                        failure = result.value.code
                    }
                }
                if (failure !== null) break
                done.push(...latest)
            }
        } catch {
            failure = 'provider_error'
        }
        if (!this.ownsFollowUp(token, signal, context.binding)) return
        const elapsedMs = this.now() - started
        this.publishStages(captureId, (stages) => ({
            ...stages,
            masks: done,
            segments:
                failure === null
                    ? { status: 'landed', elapsedMs, modelElapsedMs, ...(model === undefined ? {} : { model }) }
                    : { status: 'failed', code: failure, elapsedMs, modelElapsedMs },
        }))
    }
    private cancelPendingAnswer(): boolean {
        if (!this.canCompose) {
            return false
        }
        // Composition can cancel only the current ask. Checks require an explicit Cancel action.
        if (this.operationKind === 'ask') {
            this.stopOperation()
        }
        return true
    }
    questionChanged = (question: string): void => {
        if (!this.cancelPendingAnswer()) {
            return
        }
        this.publish({ question: question.slice(0, 500), answer: null, answeredQuestion: null, pending: null })
    }
    targetChanged = (target: QuestionTarget): void => {
        if (!this.cancelPendingAnswer()) {
            return
        }
        this.publish({ target, answer: null, answeredQuestion: null, pending: null })
    }
    async ask(): Promise<void> {
        const entry = this.current
        const capture = this.state.capture
        const step = entry?.session.reviewedSteps[entry.stepIndex]
        const question = this.state.question.trim()
        const target = this.state.target
        if (
            entry === undefined ||
            capture === null ||
            step === undefined ||
            target === null ||
            question.length === 0 ||
            this.state.pending !== null ||
            this.saving ||
            this.state.storageReadOnly
        ) {
            return
        }
        if (!this.isCurrentCapture(capture.binding)) {
            this.publish({ notice: 'Saved photo is view-only. Take a new photo before asking.' })
            return
        }
        const token = this.epoch
        const operation = new AbortController()
        this.operation = operation
        this.operationKind = 'ask'
        const requestId = `question-${this.ports.id()}`
        const shownGuide = this.ports.screenContext?.(entry.session, step.stepId) ?? null
        this.publish({ pending: 'Asking about frozen photo…', answer: null, answeredQuestion: null, notice: null })
        try {
            const result = await askModelQuestion({
                client: this.ports.client,
                binding: capture.binding,
                requestId,
                session: entry.session,
                step,
                observation: capture.observation,
                question,
                target,
                signal: operation.signal,
                ...(shownGuide === null ? {} : { screen: shownGuide }),
                // A ticket instead of an answer: same request, same photo, still working. The wording is the only change.
                onSlow: (): void => {
                    if (token === this.epoch && this.operation === operation) {
                        this.publish({ pending: 'Still thinking about your question…' })
                    }
                },
                loadPageAsset: async (id) => {
                    const page = entry.session.pages.find((p) => p.assetId === id)
                    return page === undefined
                        ? null
                        : { assetId: id, mimeType: page.mimeType, bytes: await this.readPage(page) }
                },
            })
            if (
                token === this.epoch &&
                this.operation === operation &&
                !operation.signal.aborted &&
                this.isCurrentCapture(capture.binding)
            ) {
                this.publish(
                    result.status === 'ok'
                        ? { answer: result.value, answeredQuestion: question }
                        : { notice: this.unavailable(result) },
                )
            }
        } catch {
            if (token === this.epoch && this.operation === operation) {
                this.publish({
                    notice: this.state.storageReadOnly
                        ? LOCAL_LIBRARY_READ_FAILURE
                        : 'Question unavailable. Check connection and take a new photo.',
                })
            }
        } finally {
            if (token === this.epoch && this.operation === operation) {
                this.operation = null
                this.operationKind = null
                this.publish({ pending: null })
            }
        }
    }
    coverageNotice(): string | null {
        const entry = this.current
        const step = entry?.session.reviewedSteps[entry.stepIndex]
        if (entry === undefined || step === undefined) {
            return 'Review a manual step first.'
        }
        const count = selectedStepSourcePageIds(entry.session, step).length
        return count < 1 || count > 20
            ? 'Complete manual context is unavailable. Use up to 20 ordered manual pages and a frozen photo within the 8 MiB image budget.'
            : null
    }
    private unavailable(result: Extract<ApiResult<unknown>, { status: 'unavailable' }>): string {
        if (this.state.storageReadOnly) return LOCAL_LIBRARY_READ_FAILURE
        return result.code === 'invalid_input'
            ? 'Cannot verify: the full reviewed plan, up to 20 ordered manual pages, and the frozen photo must fit the API context and 8 MiB image budget.'
            : `Unavailable (${result.code}). Check connection/configuration. Retry is a new request; cancelled calls are not repeated automatically.`
    }
}
