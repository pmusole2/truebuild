import { z } from 'zod'
import {
    canonicalJson,
    manualPieceInputSchema,
    PIECE_BATCH_LIMIT,
    PIECE_CROP_VERSION,
    PIECE_GEOMETRY_PROMPT_VERSION,
    PIECE_SPEC_LIMITS,
    pieceCutoutSchema,
    pieceDrawingBoxSchema,
    pieceIdSchema,
    pieceSpecSchema,
    type ManualPage,
    type ManualPieceInput,
    type ManualSession,
    type PieceBatchRequest,
    type PieceBatchResult,
    type PieceSpec,
} from '@truebuild/contracts'
import type { KeyValueStorage } from '../capture/library'
import { sha256Hex } from '../documents/sha256'

/** Batches in flight at once. Each wave runs up to this many batches together; the next wave starts after both settle. */
export const PIECE_CONCURRENCY = 2
const MAX_PARTS = PIECE_SPEC_LIMITS.pieces
/** Each eligible part gets at most two attempts (the first, and one repair), so a manual has at most this many batches. */
const MAX_BATCHES = 2 * MAX_PARTS
const STORAGE_PREFIX = 'truebuild/pieces/v1/'
const MANIFEST_VERSION = 1
/** A manifest holds piece specs but no cutouts; one row stays far below the AsyncStorage per-row ceiling. */
const MANIFEST_MAX_CHARS = 1_000_000
/**
 * Cutouts of one manual share this budget, so a manual cannot fill local storage. A cutout past it is not stored and its
 * piece falls back to the name card on revisit; the piece itself is still kept.
 */
export const PIECE_CUTOUT_BUDGET_CHARS = 1_500_000
const PIN_LIMIT = 64
const PIECE_NAME_MAX = 80

type PieceDrawingBox = z.infer<typeof pieceDrawingBoxSchema>
export type PieceManualPage = Pick<ManualPage, 'pageId' | 'width' | 'height' | 'mimeType' | 'contentHash'>
/** Parse identity is app-local; geometry requests and persisted manifests retain their existing wire shape. */
export type PieceRequestPart = ManualPieceInput & { readonly partId?: string }
/** A manual as the registry sees it: ordered page identities and the parts a request may name. */
export type PieceManualInput = {
    readonly pages: readonly PieceManualPage[]
    readonly parts: readonly PieceRequestPart[]
}

/** `name` is the bounded display name; `identityName` is the full manual name, so truncation can never merge two parts. */
type StableFacts = {
    readonly name: string
    readonly identityName: string
    readonly label: string | null
    readonly dimensions: string | null
}
const normalizeFact = (value: string | null): string | null =>
    value === null ? null : value.normalize('NFC').trim().replace(/\s+/gu, ' ')

const slugOf = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 40)
        .replace(/-+$/u, '') || 'part'

/**
 * Piece ids from the part's own name, label and dimensions, never from its parse id (a re-parse may change that). Repeats
 * of identical facts get their occurrence number, so ids stay unique and stable for the same manual order.
 */
export function stablePieceIds(parts: readonly StableFacts[]): string[] {
    const seen = new Map<string, number>()
    return parts.map((part) => {
        const facts = canonicalJson([
            normalizeFact(part.identityName),
            normalizeFact(part.label),
            normalizeFact(part.dimensions),
        ])
        const occurrence = seen.get(facts) ?? 0
        seen.set(facts, occurrence + 1)
        return `${slugOf(part.name)}-${sha256Hex(canonicalJson([facts, occurrence])).slice(0, 8)}`
    })
}

/** A box is kept exactly as written and only when the contract accepts it as written; an invalid hint is never repaired. */
function validDrawingBox(box: readonly number[] | null | undefined): PieceDrawingBox | undefined {
    if (box === null || box === undefined) return undefined
    const parsed = pieceDrawingBoxSchema.safeParse(box)
    return parsed.success ? parsed.data : undefined
}

function stepQuantity(session: Pick<ManualSession, 'reviewedSteps'>, partId: string): number | null {
    for (const step of session.reviewedSteps) {
        for (const part of step.parts) {
            if (part.partId === partId && part.quantity.state === 'known') return part.quantity.value
        }
    }
    return null
}

/**
 * The manual parts the generation request names, in parse order. Quantity is the printed inventory count when present,
 * otherwise the first known per-step count. Page ids are carried for the request only; they never enter the identity.
 */
export function manualPieceInputs(
    session: Pick<ManualSession, 'pages' | 'parts' | 'reviewedSteps'>,
): PieceRequestPart[] {
    const pageIds = new Set(session.pages.map((page) => page.pageId))
    const named = session.parts.flatMap((part) => {
        if (part.name.state !== 'known') return []
        const pageId = part.name.sourceRefs.map((ref) => ref.pageId).find((id) => pageIds.has(id)) ?? null
        const quantity = part.inventoryQuantity ?? stepQuantity(session, part.partId)
        const identityName = part.name.value
        // The manual may hold names up to 200 characters; the piece contract allows 80. The display name is bounded, the fact is not.
        const name = Array.from(identityName.trim()).slice(0, PIECE_NAME_MAX).join('')
        const drawingBox = validDrawingBox(part.drawingBox)
        return [
            {
                partId: part.partId,
                name,
                identityName,
                label: part.label ?? null,
                dimensions: part.dimensions ?? null,
                pageId,
                quantity,
                drawingBox,
            },
        ]
    })
    const ids = stablePieceIds(named)
    return named.flatMap((part, index): PieceRequestPart[] => {
        const { identityName: _identity, drawingBox, partId, ...request } = part
        const parsed = manualPieceInputSchema.safeParse({
            id: ids[index],
            ...request,
            ...(drawingBox === undefined ? {} : { drawingBox }),
        })
        return parsed.success ? [{ ...parsed.data, partId }] : []
    })
}

/** The current parse's identities map onto the stable geometry ids, independent of inventory quantities. */
export function pieceIdsByPartId(
    session: Pick<ManualSession, 'pages' | 'parts' | 'reviewedSteps'>,
): ReadonlyMap<string, string> {
    return new Map(
        manualPieceInputs(session)
            .slice(0, MAX_PARTS)
            .flatMap((part): [string, string][] => (part.partId === undefined ? [] : [[part.partId, part.id]])),
    )
}

/** A guide names only the pieces linked to its own step, with that step's count, never the inventory count. */
export function stepPiecesForStep(
    session: Pick<ManualSession, 'pages' | 'parts' | 'reviewedSteps' | 'rawExtraction'>,
    stepId: string | null,
): { pieceId: string; quantity: number | null }[] {
    if (stepId === null) return []
    const step =
        session.reviewedSteps.find((item) => item.stepId === stepId) ??
        session.rawExtraction?.steps.find((item) => item.stepId === stepId)
    if (step === undefined) return []
    const ids = pieceIdsByPartId(session)
    return step.parts.flatMap((part) => {
        const pieceId = ids.get(part.partId)
        return pieceId === undefined
            ? []
            : [{ pieceId, quantity: part.quantity.state === 'known' ? part.quantity.value : null }]
    })
}

function geometryPart(part: PieceRequestPart): ManualPieceInput {
    const { partId: _partId, ...wire } = part
    return wire
}

/** The manual the registry is fed for a session: the same pages and request parts generation and screen bindings read. */
export function manualPieceInputOf(
    session: Pick<ManualSession, 'pages' | 'parts' | 'reviewedSteps'>,
): PieceManualInput {
    return { pages: session.pages, parts: manualPieceInputs(session) }
}

/**
 * Cache identity of a manual's pieces: the ordered page pictures (content hash, size and MIME type), salted with the geometry
 * prompt and crop versions and, per part in parse order, its drawing box with the content hash of the page it cites. Page ids, parsed
 * names, labels and part ids are excluded, so a re-parse of the same pictures keeps its stored result and never pays again.
 */
export function manualPieceContentHash(
    manual: PieceManualInput,
    promptVersion: number = PIECE_GEOMETRY_PROMPT_VERSION,
): string {
    const citedContent = new Map(manual.pages.map((page) => [page.pageId, page.contentHash]))
    return sha256Hex(
        canonicalJson([
            manual.pages.map((page) => [page.contentHash, page.width, page.height, page.mimeType]),
            promptVersion,
            PIECE_CROP_VERSION,
            manual.parts.map((part) =>
                part.drawingBox === undefined || part.drawingBox === null
                    ? null
                    : [part.drawingBox, part.pageId === null ? null : (citedContent.get(part.pageId) ?? null)],
            ),
        ]),
    )
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const epochMs = z.number().int().nonnegative().nullable()
const issueCodeSchema = z.string().min(1).max(160)
const storedEntrySchema = z.strictObject({
    part: manualPieceInputSchema,
    state: z.enum(['pending', 'ready', 'rejected']),
    piece: pieceSpecSchema.nullable(),
    issueCodes: z.array(issueCodeSchema).max(40),
    attempts: z.number().int().min(0).max(2),
    hasCutout: z.boolean(),
})
const storedBatchSchema = z.strictObject({
    seq: z.number().int().min(1).max(MAX_BATCHES),
    ids: z.array(pieceIdSchema).min(1).max(PIECE_BATCH_LIMIT),
    repairIds: z.array(pieceIdSchema).max(PIECE_BATCH_LIMIT),
    state: z.enum(['dispatching', 'settled', 'unknown']),
})
const manifestSchema = z
    .strictObject({
        version: z.literal(MANIFEST_VERSION),
        contentHash: hashSchema,
        status: z.enum(['running', 'done', 'halted']),
        requestedAt: epochMs,
        startedAt: epochMs,
        readyAt: epochMs,
        entries: z.array(storedEntrySchema).max(MAX_PARTS),
        batches: z.array(storedBatchSchema).max(MAX_BATCHES),
        omitted: z.number().int().min(0).max(100_000),
    })
    .superRefine((value, context) => {
        const ids = value.entries.map((entry) => entry.part.id)
        if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Piece ids are unique' })
        for (const entry of value.entries) {
            const ready = entry.state === 'ready'
            if (ready !== (entry.piece !== null) || (entry.piece !== null && entry.piece.id !== entry.part.id))
                context.addIssue({ code: 'custom', message: 'A ready piece keeps its own id' })
        }
        if (value.status === 'done' && value.entries.some((entry) => entry.state === 'pending'))
            context.addIssue({ code: 'custom', message: 'A finished manual has no pending part' })
    })
type Manifest = z.infer<typeof manifestSchema>
type StoredEntry = Manifest['entries'][number]
type StoredBatch = Manifest['batches'][number]

export type PieceGenerationPort = (input: {
    readonly request: PieceBatchRequest
    readonly pageUris: Readonly<Record<string, string>>
}) => Promise<PieceBatchResult | null>
type Outcome = PieceBatchResult['results'][number]

/** In-memory form of one part while a run is open. The cutout lives here and in its own key, never in the manifest. */
type Entry = {
    readonly part: PieceRequestPart
    state: 'pending' | 'ready' | 'rejected'
    piece: PieceSpec | null
    issueCodes: string[]
    attempts: number
    cutoutUri: string | null
}
export type PieceTiming = {
    /** When the registry was asked for this manual's pieces (the parse is done by then). */
    readonly requestedAt: number | null
    /** When the first batch's attempt marker was stored, before anything was sent. */
    readonly startedAt: number | null
    /** When every eligible part was settled; null while running, halted, or unknown. */
    readonly readyAt: number | null
}
type Run = {
    readonly hash: string
    readonly timing: { requestedAt: number; startedAt: number | null; readyAt: number | null }
    status: Manifest['status']
    readonly entries: Entry[]
    readonly batches: StoredBatch[]
    readonly omitted: number
}

/** Persisted before any dispatch. A manual with a manifest is never dispatched again by this app. */
const manifestKey = (hash: string): string => `${STORAGE_PREFIX}${hash}/manifest`
const cutoutKey = (hash: string, id: string): string => `${STORAGE_PREFIX}${hash}/cutout/${id}`

type ManifestRead =
    { readonly kind: 'absent' } | { readonly kind: 'present'; readonly manifest: Manifest } | { readonly kind: 'error' }

/** Storage that cannot be read or parsed may hide a sent batch, so it is an error and never an absence. */
async function readManifest(storage: KeyValueStorage, hash: string): Promise<ManifestRead> {
    let raw: string | null
    try {
        raw = await storage.getItem(manifestKey(hash))
    } catch {
        return { kind: 'error' }
    }
    if (raw === null) return { kind: 'absent' }
    try {
        const parsed = manifestSchema.safeParse(JSON.parse(raw))
        return parsed.success && parsed.data.contentHash === hash
            ? { kind: 'present', manifest: parsed.data }
            : { kind: 'error' }
    } catch {
        return { kind: 'error' }
    }
}

async function writeManifest(storage: KeyValueStorage, manifest: Manifest): Promise<boolean> {
    const json = JSON.stringify(manifest)
    if (json.length > MANIFEST_MAX_CHARS) return false
    try {
        await storage.setItem(manifestKey(manifest.contentHash), json)
        return true
    } catch {
        return false
    }
}

/** Saves each cutout once under its own key while the manual's budget allows; a refused cutout simply has no stored image. */
class CutoutLedger {
    private readonly saved = new Map<string, boolean>()
    private chars = 0

    constructor(
        private readonly storage: KeyValueStorage,
        private readonly hash: string,
    ) {}

    async save(id: string, uri: string): Promise<void> {
        if (this.saved.has(id)) return
        if (this.chars + uri.length > PIECE_CUTOUT_BUDGET_CHARS) {
            this.saved.set(id, false)
            return
        }
        try {
            await this.storage.setItem(cutoutKey(this.hash, id), uri)
            this.chars += uri.length
            this.saved.set(id, true)
        } catch {
            this.saved.set(id, false)
        }
    }

    isSaved(id: string): boolean {
        return this.saved.get(id) === true
    }
}

async function readCutout(storage: KeyValueStorage, hash: string, id: string): Promise<string | null> {
    try {
        const uri = await storage.getItem(cutoutKey(hash, id))
        return uri !== null && pieceCutoutSchema.safeParse(uri).success ? uri : null
    } catch {
        return null
    }
}

/** What a screen may show. Ids in `pieces` are the only ids a native node may resolve; cards never enter that gate. */
export type PieceCard = {
    readonly id: string
    readonly name: string
    /** `rejected`: repaired once and still invalid, terminal. `unresolved`: not settled (never retried automatically). */
    readonly state: 'rejected' | 'unresolved'
    readonly issueCodes: readonly string[]
}
export type PieceSnapshot = {
    readonly status: 'idle' | 'pending' | 'ready' | 'incomplete' | 'unavailable'
    readonly contentHash: string | null
    readonly pieces: readonly PieceSpec[]
    /** 2D cutout by ready piece id, kept apart from `pieces`. */
    readonly cutouts: Readonly<Record<string, string>>
    readonly cards: readonly PieceCard[]
    /** 2D cutout by card id. */
    readonly cardCutouts: Readonly<Record<string, string>>
    readonly timing: PieceTiming
}

const NO_TIMING: PieceTiming = { requestedAt: null, startedAt: null, readyAt: null }
const EMPTY: Omit<PieceSnapshot, 'status' | 'contentHash'> = {
    pieces: [],
    cutouts: {},
    cards: [],
    cardCutouts: {},
    timing: NO_TIMING,
}
const IDLE: PieceSnapshot = { status: 'idle', contentHash: null, ...EMPTY }
const unavailable = (hash: string): PieceSnapshot => ({ status: 'unavailable', contentHash: hash, ...EMPTY })

function snapshotOf(
    status: PieceSnapshot['status'],
    hash: string,
    entries: readonly Entry[],
    timing: PieceTiming,
): PieceSnapshot {
    const cutouts: Record<string, string> = {}
    const cardCutouts: Record<string, string> = {}
    const pieces: PieceSpec[] = []
    const cards: PieceCard[] = []
    for (const entry of entries) {
        const id = entry.part.id
        if (entry.state === 'ready' && entry.piece !== null) {
            pieces.push(entry.piece)
            if (entry.cutoutUri !== null) cutouts[id] = entry.cutoutUri
        } else {
            cards.push({
                id,
                name: entry.part.name,
                state: entry.state === 'rejected' ? 'rejected' : 'unresolved',
                issueCodes: entry.issueCodes,
            })
            if (entry.cutoutUri !== null) cardCutouts[id] = entry.cutoutUri
        }
    }
    return { status, contentHash: hash, pieces, cutouts, cards, cardCutouts, timing: { ...timing } }
}

async function restoredSnapshot(storage: KeyValueStorage, manifest: Manifest): Promise<PieceSnapshot> {
    const entries: Entry[] = await Promise.all(
        manifest.entries.map(async (stored: StoredEntry): Promise<Entry> => ({
            part: stored.part,
            state: stored.state,
            piece: stored.piece,
            issueCodes: [...stored.issueCodes],
            attempts: stored.attempts,
            cutoutUri: stored.hasCutout ? await readCutout(storage, manifest.contentHash, stored.part.id) : null,
        })),
    )
    const timing = { requestedAt: manifest.requestedAt, startedAt: manifest.startedAt, readyAt: manifest.readyAt }
    return snapshotOf(manifest.status === 'done' ? 'ready' : 'incomplete', manifest.contentHash, entries, timing)
}

/** The opening step gets singleton batches first; afterward, repairs and fresh parts share the normal bounded waves. */
function takeWave(entries: readonly Entry[], priorityPieceIds: readonly string[]): Entry[][] {
    const pending = entries.filter((entry) => entry.state === 'pending')
    for (const id of priorityPieceIds) {
        const firstStepPiece = pending.find((entry) => entry.part.id === id)
        if (firstStepPiece !== undefined) return [[firstStepPiece]]
    }
    const queue = [
        ...pending.filter((entry) => entry.attempts === 1),
        ...pending.filter((entry) => entry.attempts === 0),
    ]
    const wave: Entry[][] = []
    for (let slot = 0; slot < PIECE_CONCURRENCY && queue.length > 0; slot++)
        wave.push(queue.splice(0, PIECE_BATCH_LIMIT))
    return wave
}

/** Records the attempt before it is sent: a repair is counted here, so an interrupted repair is never sent again. */
function markBatch(run: Run, batch: readonly Entry[]): StoredBatch {
    const mark: StoredBatch = {
        seq: run.batches.length + 1,
        ids: batch.map((entry) => entry.part.id),
        repairIds: batch.filter((entry) => entry.attempts === 1).map((entry) => entry.part.id),
        state: 'dispatching',
    }
    for (const entry of batch) entry.attempts += 1
    run.batches.push(mark)
    return mark
}

async function dispatchBatch(
    generate: PieceGenerationPort,
    manual: PieceManualInput,
    hash: string,
    batch: readonly Entry[],
    repairIds: readonly string[],
    pageUris: Readonly<Record<string, string>>,
    requestId: string,
): Promise<ReadonlyMap<string, Outcome> | null> {
    const parts: ManualPieceInput[] = batch.map((entry) =>
        repairIds.includes(entry.part.id)
            ? { ...geometryPart(entry.part), cutoutUri: entry.cutoutUri, repair: { issueCodes: entry.issueCodes } }
            : geometryPart(entry.part),
    )
    const pageIds = new Set(parts.flatMap((part) => (part.pageId === null ? [] : [part.pageId])))
    const pages = manual.pages.filter((page) => pageIds.has(page.pageId))
    const request: PieceBatchRequest = {
        requestId,
        contentHash: hash,
        parts,
        pages: pages.map((page) => ({
            pageId: page.pageId,
            width: page.width,
            height: page.height,
            mimeType: page.mimeType,
        })),
    }
    const images = Object.fromEntries(
        pages.flatMap((page): [string, string][] => {
            const uri = pageUris[page.pageId]
            return uri === undefined ? [] : [[page.pageId, uri]]
        }),
    )
    try {
        const result = await generate({ request, pageUris: images })
        if (result === null || result.contentHash !== hash) return null
        return new Map(result.results.map((outcome): [string, Outcome] => [outcome.id, outcome]))
    } catch {
        return null
    }
}

function settleBatch(batch: readonly Entry[], outcomes: ReadonlyMap<string, Outcome>): boolean {
    let unavailable = false
    for (const entry of batch) {
        const outcome = outcomes.get(entry.part.id)
        if (
            outcome !== undefined &&
            (outcome.status === 'passed' || outcome.status === 'repaired') &&
            outcome.piece !== null &&
            outcome.piece.id === entry.part.id
        ) {
            entry.state = 'ready'
            entry.piece = outcome.piece
            entry.issueCodes = []
            entry.cutoutUri = outcome.cutoutUri ?? entry.cutoutUri
            continue
        }
        entry.issueCodes =
            outcome === undefined || outcome.issueCodes.length === 0 ? ['missing_piece'] : [...outcome.issueCodes]
        entry.cutoutUri = outcome?.cutoutUri ?? entry.cutoutUri
        // A transport/configuration failure is not invalid geometry to repair. Retain its cutout and sent marker,
        // halt this run, and never pay again for an outcome the provider did not deliver.
        if (entry.issueCodes.some((code) => code.startsWith('response:'))) unavailable = true
        entry.state = entry.attempts >= 2 ? 'rejected' : 'pending'
    }
    return unavailable
}

function toManifest(run: Run, ledger: CutoutLedger): Manifest {
    return {
        version: MANIFEST_VERSION,
        contentHash: run.hash,
        status: run.status,
        entries: run.entries.map((entry) => ({
            part: geometryPart(entry.part),
            state: entry.state,
            piece: entry.piece,
            issueCodes: [...entry.issueCodes],
            attempts: entry.attempts,
            hasCutout: ledger.isSaved(entry.part.id),
        })),
        batches: run.batches.map((batch) => ({ ...batch, ids: [...batch.ids], repairIds: [...batch.repairIds] })),
        omitted: run.omitted,
        requestedAt: run.timing.requestedAt,
        startedAt: run.timing.startedAt,
        readyAt: run.timing.readyAt,
    }
}

export type PieceRegistryPorts = {
    readonly storage: KeyValueStorage
    /** Null while generation is off or the API is not wired: stored manifests still answer, nothing is requested. */
    readonly generate: PieceGenerationPort | null
    readonly newId: () => string
    readonly now?: () => number
}

/**
 * The one owner of the manual piece registry for this app run. A parse hands it the manual. A stored manifest answers
 * without any dispatch; otherwise one run starts, persisting each wave's attempt markers before sending it. Screens pin
 * the snapshot they first display.
 */
export class PieceRegistry {
    private current: PieceSnapshot = IDLE
    /** The manual content the registry is for now; only its run may publish into `current`. */
    private target: string | null = null
    private readonly active = new Map<string, Promise<void>>()
    private readonly listeners = new Set<() => void>()
    private readonly pinned = new Map<string, PieceSnapshot>()
    private generating = 0
    private readonly generationWaiters: (() => void)[] = []

    constructor(private readonly ports: PieceRegistryPorts) {}

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return (): void => {
            this.listeners.delete(listener)
        }
    }

    getSnapshot = (): PieceSnapshot => this.current

    /** Starts (or joins) the registry; opening-step priorities change scheduling only, never its cache identity. */
    prepare(
        manual: PieceManualInput,
        loadPageUris: () => Promise<Readonly<Record<string, string>>>,
        priorityPieceIds: readonly string[] = [],
    ): Promise<void> {
        if (manual.parts.length === 0) return Promise.resolve()
        const hash = manualPieceContentHash(manual)
        if (this.target === hash) return this.active.get(hash) ?? Promise.resolve()
        this.target = hash
        const running = this.active.get(hash)
        if (running !== undefined) {
            this.set({ ...IDLE, status: 'pending', contentHash: hash })
            return running
        }
        const requestedAt = this.now()
        this.set({
            ...IDLE,
            status: 'pending',
            contentHash: hash,
            timing: { requestedAt, startedAt: null, readyAt: null },
        })
        const settled = this.settle(
            hash,
            manual,
            loadPageUris,
            requestedAt,
            priorityPieceIds.slice(0, MAX_PARTS),
        ).finally(() => this.active.delete(hash))
        this.active.set(hash, settled)
        return settled
    }

    private now(): number {
        return (this.ports.now ?? Date.now)()
    }

    /** Slots transfer directly to queued batches, so switching manuals cannot exceed the app-wide two-call bound. */
    private async generateWithSlot(
        generate: PieceGenerationPort,
        input: Parameters<PieceGenerationPort>[0],
    ): Promise<PieceBatchResult | null> {
        if (this.generating < PIECE_CONCURRENCY) this.generating++
        else await new Promise<void>((resolve) => this.generationWaiters.push(resolve))
        try {
            return await generate(input)
        } finally {
            const next = this.generationWaiters.shift()
            if (next === undefined) this.generating--
            else next()
        }
    }

    private async settle(
        hash: string,
        manual: PieceManualInput,
        loadPageUris: () => Promise<Readonly<Record<string, string>>>,
        requestedAt: number,
        priorityPieceIds: readonly string[],
    ): Promise<void> {
        try {
            const read = await readManifest(this.ports.storage, hash)
            if (read.kind === 'error') return this.publish(hash, unavailable(hash))
            if (read.kind === 'present')
                return this.publish(hash, await restoredSnapshot(this.ports.storage, read.manifest))
            const generate = this.ports.generate
            if (generate === null) return this.publish(hash, unavailable(hash))
            this.publish(hash, await this.run(hash, manual, loadPageUris, generate, requestedAt, priorityPieceIds))
        } catch {
            this.publish(hash, unavailable(hash))
        }
    }

    /**
     * Waves of up to two batches run until every eligible part is settled. Any write that fails before a send stops the
     * run, and an unknown or unpersisted outcome stops it too: the stored state then restores as incomplete, never as a
     * new dispatch.
     */
    private async run(
        hash: string,
        manual: PieceManualInput,
        loadPageUris: () => Promise<Readonly<Record<string, string>>>,
        generate: PieceGenerationPort,
        requestedAt: number,
        priorityPieceIds: readonly string[],
    ): Promise<PieceSnapshot> {
        let pageUris: Readonly<Record<string, string>>
        try {
            pageUris = await loadPageUris()
        } catch {
            return unavailable(hash)
        }
        const eligible = manual.parts.slice(0, MAX_PARTS)
        const run: Run = {
            hash,
            timing: { requestedAt, startedAt: null, readyAt: null },
            status: 'running',
            entries: eligible.map((part): Entry => ({
                part,
                state: 'pending',
                piece: null,
                issueCodes: [],
                attempts: 0,
                cutoutUri: null,
            })),
            batches: [],
            omitted: manual.parts.length - eligible.length,
        }
        const ledger = new CutoutLedger(this.ports.storage, hash)
        const persist = (): Promise<boolean> => writeManifest(this.ports.storage, toManifest(run, ledger))
        if (!(await persist())) return unavailable(hash)
        for (;;) {
            const wave = takeWave(run.entries, priorityPieceIds)
            if (wave.length === 0) {
                run.status = 'done'
                run.timing.readyAt = this.now()
                break
            }
            if (run.timing.startedAt === null) run.timing.startedAt = this.now()
            const stored = wave.map((batch) => {
                const repairIds = batch.filter((entry) => entry.attempts === 1).map((entry) => entry.part.id)
                return { batch, repairIds, mark: markBatch(run, batch) }
            })
            if (!(await persist())) {
                run.status = 'halted'
                break
            }
            const outcomes = await Promise.all(
                stored.map(({ batch, repairIds }) =>
                    dispatchBatch(
                        (input) => this.generateWithSlot(generate, input),
                        manual,
                        hash,
                        batch,
                        repairIds,
                        pageUris,
                        this.ports.newId(),
                    ),
                ),
            )
            let unknown = false
            stored.forEach(({ mark, batch }, index) => {
                const outcome = outcomes[index]
                if (outcome === null || outcome === undefined) {
                    mark.state = 'unknown'
                    unknown = true
                    return
                }
                mark.state = 'settled'
                if (settleBatch(batch, outcome)) {
                    mark.state = 'unknown'
                    unknown = true
                }
            })
            for (const entry of run.entries) {
                if (entry.cutoutUri !== null) await ledger.save(entry.part.id, entry.cutoutUri)
            }
            if (unknown || !(await persist())) {
                run.status = 'halted'
                break
            }
            // A valid step need not wait for another step's repair batch before its geometry becomes visible.
            this.publish(hash, snapshotOf('pending', hash, run.entries, run.timing))
        }
        if (run.status === 'done') await persist()
        return snapshotOf(run.status === 'done' ? 'ready' : 'incomplete', hash, run.entries, run.timing)
    }

    /** A run for superseded content still stores its state, but it never replaces the current snapshot. */
    private publish(hash: string, snapshot: PieceSnapshot): void {
        if (this.target === hash) this.set(snapshot)
    }

    private set(snapshot: PieceSnapshot): void {
        this.current = snapshot
        for (const listener of this.listeners) listener()
    }

    /**
     * Keep a displayed screen stable. A guide's non-empty linked catalog remains live until its pieces settle, so a lightweight
     * placeholder may become 3D without composing the page again; other screens preserve their first displayed context.
     */
    pin(identity: string, contentHash?: string, displayed = true, expectedPieceIds?: readonly string[]): PieceSnapshot {
        const known = this.pinned.get(identity)
        if (known !== undefined) return known
        const current = contentHash === undefined || this.current.contentHash === contentHash ? this.current : IDLE
        // Partial waves are a Guide-only delivery. Other pages still receive no registry until the run is ready.
        const snapshot: PieceSnapshot =
            expectedPieceIds === undefined && current.status === 'pending'
                ? { ...current, pieces: [], cutouts: {}, cards: [], cardCutouts: {} }
                : current
        // Hidden stack routes can mount early; only an actual display may freeze their piece context.
        if (!displayed || (expectedPieceIds !== undefined && snapshot.pieces.length === 0)) return snapshot
        if (expectedPieceIds !== undefined) {
            const settled = new Set([
                ...snapshot.pieces.map((piece) => piece.id),
                ...snapshot.cards.filter((card) => card.state === 'rejected').map((card) => card.id),
            ])
            if (expectedPieceIds.some((id) => !settled.has(id))) return snapshot
        }
        if (this.pinned.size >= PIN_LIMIT) {
            const oldest = this.pinned.keys().next().value
            if (oldest !== undefined) this.pinned.delete(oldest)
        }
        this.pinned.set(identity, snapshot)
        return snapshot
    }
}
