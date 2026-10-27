import { selectedStepSourcePageIds } from '../assembly/source-selection'
import {
    LIMITS,
    manualSessionSchema,
    matchesBinding,
    type ApiResult,
    type CaptureBinding,
    type CheckResult,
    type ManualPage,
    type ManualSession,
    type ParsedManual,
    type QuestionResult,
    type QuestionTarget,
} from '@truebuild/contracts'
import { MODEL_CHECK_TIMEOUT_MS, MODEL_PARSE_TIMEOUT_MS, type ModelApiClient } from '../../api/model-client'
import { awaitStopped, createCallGuard } from '../../api/transport'
import type { NormalizedImage, SourceImageAsset } from '../../media/normalize-image'
import { bytesToDataUri } from '../../media/image-source'
import { userMessageForMediaError } from '../../media/media-errors'
import { askModelQuestion, citedPageIds, runModelCheck } from '../assembly/model-check'
import type { Observation } from '../assembly/observation'
import type { Digest, LibraryEntry, LibraryStorage } from './library'

export type ScreenRoute = 'library' | 'pages' | 'overview' | 'guide' | 'camera'
export type CameraIntent = { kind: 'page'; replaceIndex?: number } | { kind: 'check' | 'question' }
export type CaptureView = { binding: CaptureBinding; observation: Observation; capturedAt: number; expiresAt: number }
export type WorkflowState = {
    route: ScreenRoute
    entries: readonly LibraryEntry[]
    selectedId: string | null
    pending: string | null
    notice: string | null
    loading: boolean
    cameraIntent: CameraIntent | null
    capture: CaptureView | null
    check: CheckResult | null
    answer: QuestionResult | null
    question: string
    target: QuestionTarget | null
    pageUris: Readonly<Record<string, string>>
}
export type CapturePorts = {
    storage: LibraryStorage
    client: Pick<ModelApiClient, 'parse' | 'check' | 'questions'>
    normalize: (asset: SourceImageAsset) => Promise<NormalizedImage>
    digest: Digest
    id: () => string
    now?: () => number
    monotonic?: () => number
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
    return valid.success && (session.rawExtraction?.unknowns.length ?? 0) === 0 ? valid.data : null
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
        cameraIntent: null,
        capture: null,
        check: null,
        answer: null,
        question: '',
        target: null,
        pageUris: {},
    }
    private saving = false
    private readonly listeners = new Set<() => void>()
    private epoch = 0
    private operation: AbortController | null = null
    private expiry: ReturnType<typeof setTimeout> | null = null
    private readonly now: () => number
    private readonly monotonic: () => number
    constructor(private readonly ports: CapturePorts) {
        this.now = ports.now ?? ((): number => Date.now())
        this.monotonic = ports.monotonic ?? ((): number => performance.now())
    }
    getSnapshot = (): WorkflowState => this.state
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
    private invalidate(): number {
        this.epoch++
        this.operation?.abort()
        this.operation = null
        if (this.expiry !== null) {
            clearTimeout(this.expiry)
            this.expiry = null
        }
        this.publish({ pending: null, check: null, answer: null, capture: null, target: null, question: '' })
        return this.epoch
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
        this.invalidate()
        this.publish({
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
        const restored = await this.ports.storage.restore()
        this.publish({ entries: restored.entries, notice: restored.warning, loading: false })
    }
    async createManual(): Promise<void> {
        if (this.state.pending !== null || this.saving || this.state.loading) {
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
                const bytes = await this.ports.storage.readAsset(page)
                if (token !== this.epoch) {
                    return
                }
                uris[page.pageId] = bytesToDataUri(bytes, page.mimeType)
            }
            this.publish({ pageUris: uris })
            if (entry.capture !== null) {
                const bytes = await this.ports.storage.readAsset(entry.capture.page)
                if (token !== this.epoch) {
                    return
                }
                this.publish({
                    capture: {
                        binding: entry.capture.binding,
                        capturedAt: 0,
                        expiresAt: 0,
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
                this.publish({ notice: 'Local images are unavailable. Scan this manual again.' })
            }
        }
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
        if (this.state.pending !== null || this.saving) {
            return
        }
        if (intent.kind !== 'page' && this.current?.session.reviewStatus !== 'reviewed') {
            this.publish({ notice: 'Review and confirm the extracted facts first.' })
            return
        }
        this.invalidate()
        this.publish({ route: 'camera', cameraIntent: intent, notice: null })
    }
    private async persist(
        entries: readonly LibraryEntry[],
        writes: Parameters<LibraryStorage['save']>[1] = [],
    ): Promise<boolean> {
        if (this.saving) {
            return false
        }
        this.saving = true
        const token = this.epoch
        const previous = this.state.pending
        this.publish({ pending: previous ?? 'Saving on this device…' })
        try {
            await this.ports.storage.save(entries, writes)
            this.publish({ entries })
            return true
        } catch {
            if (token === this.epoch) {
                this.publish({
                    notice: 'Could not save on this device. Free storage or retry. Your previous saved library is preserved.',
                })
            }
            return false
        } finally {
            this.saving = false
            if (token === this.epoch) {
                this.publish({ pending: previous })
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
            title.trim().length === 0 ||
            title.length > 200
        ) {
            return
        }
        await this.persist(this.replacement({ ...entry, session: { ...entry.session, title: title.trim() } }))
    }
    async editPage(index: number, action: 'remove' | 'up' | 'down'): Promise<void> {
        const entry = this.current
        if (entry === undefined || this.state.pending !== null || this.saving) {
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
        if (entry === undefined || this.state.pending !== null || this.saving) {
            return
        }
        const token = this.invalidate()
        const operation = new AbortController()
        this.operation = operation
        this.publish({ route: 'pages', pending: 'Choosing manual pages…', notice: null, cameraIntent: null })
        try {
            const assets = await select()
            if (token !== this.epoch || operation.signal.aborted) {
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
                uris[page.pageId] = image.uri
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
            if (token === this.epoch) {
                this.operation = null
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
    async parse(): Promise<void> {
        const entry = this.current
        if (entry === undefined || entry.session.pages.length === 0 || this.state.pending !== null || this.saving) {
            return
        }
        const token = this.invalidate()
        const operation = new AbortController()
        this.operation = operation
        const guard = createCallGuard(MODEL_PARSE_TIMEOUT_MS, operation.signal)
        this.publish({ pending: 'Reading manual pages…', notice: null })
        try {
            const images = []
            for (const page of entry.session.pages) {
                const bytes = await awaitStopped(this.ports.storage.readAsset(page), guard.signal)
                guard.checkpoint()
                images.push({ ...page, bytes })
            }
            const result = await this.ports.client.parse(
                { kind: 'manual', manualId: entry.session.manualId, revision: entry.session.revision },
                entry.session.pages,
                images,
                { requestId: `extract-${this.ports.id()}`, signal: guard.signal, checkpoint: guard.checkpoint },
            )
            guard.checkpoint()
            if (token !== this.epoch) {
                return
            }
            if (result.status !== 'ok') {
                this.publish({
                    notice: `Manual reading unavailable (${result.code}). Check the connection and page/upload budgets, then retry as a new request.`,
                })
                return
            }
            const parsed: ParsedManual = result.value
            const next: LibraryEntry = {
                ...entry,
                capture: null,
                completedStepIds: [],
                stepIndex: 0,
                session: {
                    ...entry.session,
                    parts: parsed.parts,
                    rawExtraction: parsed,
                    reviewedSteps: [...parsed.steps].sort((a, b) => a.order - b.order),
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
                    notice: guard.timedOut()
                        ? 'Manual reading timed out. Retry sends a new request.'
                        : 'Manual reading unavailable. Check your connection and retry.',
                })
            }
        } finally {
            guard.dispose()
            if (token === this.epoch) {
                this.operation = null
                this.publish({ pending: null })
            }
        }
    }
    async confirm(): Promise<void> {
        const entry = this.current
        if (entry === undefined || this.state.pending !== null || this.saving) {
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
        if (entry === undefined || this.saving || entry.session.reviewedSteps[index] === undefined) {
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
        if (entry === undefined || this.state.pending !== null || this.saving) {
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
        if (intent === null || this.state.pending !== null || this.saving) {
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
        const token = this.invalidate()
        const operation = new AbortController()
        this.operation = operation
        const guard = createCallGuard(MODEL_CHECK_TIMEOUT_MS, operation.signal)
        const capturedAt = this.now()
        const expiresAt = this.monotonic() + MODEL_CHECK_TIMEOUT_MS
        this.publish({ pending: 'Freezing photo…', notice: null })
        try {
            const asset = await awaitStopped(photo(), guard.signal)
            guard.checkpoint()
            const image = await awaitStopped(this.ports.normalize(asset), guard.signal)
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
            this.publish({
                capture: { binding, observation: image, capturedAt, expiresAt },
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
            this.armExpiry(expiresAt, token)
            if (intent.kind === 'check') {
                this.publish({ pending: 'Checking frozen photo…' })
                const result = await runModelCheck({
                    client: this.ports.client,
                    requestId: `check-${this.ports.id()}`,
                    binding,
                    session: entry.session,
                    step,
                    observation: image,
                    signal: guard.signal,
                    loadPageAsset: async (id) => {
                        const page = entry.session.pages.find((p) => p.assetId === id)
                        return page === undefined
                            ? null
                            : { assetId: id, mimeType: page.mimeType, bytes: await this.ports.storage.readAsset(page) }
                    },
                })
                guard.checkpoint()
                if (token === this.epoch && this.freshCapture(binding)) {
                    this.publish(
                        result.status === 'ok' ? { check: result.value } : { notice: this.unavailable(result) },
                    )
                }
            }
        } catch {
            if (token === this.epoch) {
                this.publish({
                    route: 'guide',
                    cameraIntent: null,
                    notice: guard.timedOut()
                        ? 'Cannot verify: photo preparation or check exceeded 8 seconds. Take a new photo.'
                        : 'Cannot use this camera photo. Check camera access and connection, then take a new photo.',
                })
            }
        } finally {
            guard.dispose()
            if (token === this.epoch) {
                this.operation = null
                this.publish({ pending: null })
            }
        }
    }
    private armExpiry(expiresAt: number, token: number): void {
        this.expiry = setTimeout(
            (): void => {
                if (token === this.epoch) {
                    this.operation?.abort()
                    this.epoch++
                    this.publish({
                        check: null,
                        answer: null,
                        pending: null,
                        notice: 'Frozen photo expired. Take a new photo to check or ask.',
                    })
                }
            },
            Math.max(0, expiresAt - this.monotonic()),
        )
    }
    private freshCapture(binding: CaptureBinding): boolean {
        const capture = this.state.capture
        return capture !== null && matchesBinding(capture.binding, binding) && this.monotonic() < capture.expiresAt
    }
    private cancelPendingAnswer(): void {
        this.operation?.abort()
        this.operation = null
        this.epoch++
        if (this.expiry !== null) {
            clearTimeout(this.expiry)
            this.expiry = null
        }
        const capture = this.state.capture
        if (capture !== null && this.freshCapture(capture.binding)) {
            this.armExpiry(capture.expiresAt, this.epoch)
        } else if (capture !== null) {
            this.publish({
                check: null,
                answer: null,
                notice: 'Frozen photo expired. Take a new photo to check or ask.',
            })
        }
    }
    questionChanged = (question: string): void => {
        if (this.saving) {
            return
        }
        this.cancelPendingAnswer()
        this.publish({ question: question.slice(0, 500), answer: null, pending: null })
    }
    targetChanged = (target: QuestionTarget): void => {
        if (this.saving) {
            return
        }
        this.cancelPendingAnswer()
        this.publish({ target, answer: null, pending: null })
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
            this.saving
        ) {
            return
        }
        if (!this.freshCapture(capture.binding)) {
            this.publish({ notice: 'Frozen photo expired. Take a new photo before asking.' })
            return
        }
        const token = this.epoch
        const operation = new AbortController()
        this.operation = operation
        const requestId = `question-${this.ports.id()}`
        this.publish({ pending: 'Asking about frozen photo…', answer: null, notice: null })
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
                loadPageAsset: async (id) => {
                    const page = entry.session.pages.find((p) => p.assetId === id)
                    return page === undefined
                        ? null
                        : { assetId: id, mimeType: page.mimeType, bytes: await this.ports.storage.readAsset(page) }
                },
            })
            if (
                token === this.epoch &&
                this.operation === operation &&
                !operation.signal.aborted &&
                this.freshCapture(capture.binding)
            ) {
                this.publish(result.status === 'ok' ? { answer: result.value } : { notice: this.unavailable(result) })
            }
        } catch {
            if (token === this.epoch && this.operation === operation) {
                this.publish({ notice: 'Question unavailable. Check connection and take a new photo.' })
            }
        } finally {
            if (token === this.epoch && this.operation === operation) {
                this.operation = null
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
        const count = selectedStepSourcePageIds(entry.session, step, citedPageIds(entry.session, step)).length
        return count < 1 || count > 2
            ? 'This step needs citations from more than the supported 1–2 pages, or has no cited page. Cannot verify with partial sources. Review the manual pages.'
            : null
    }
    private unavailable(result: Extract<ApiResult<unknown>, { status: 'unavailable' }>): string {
        return result.code === 'invalid_input'
            ? 'Cannot verify: selected 1–2 pages must cover every step citation and fit the app upload budget.'
            : `Unavailable (${result.code}). Check connection/configuration. Retry is a new request; cancelled calls are not repeated automatically.`
    }
}
