import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
    LIMITS,
    pieceBatchRequestSchema,
    pieceBatchResultSchema,
    type ManualPieceInput,
    type PieceBatchRequest,
    type PieceBatchResult,
} from '@truebuild/contracts'
import { MetaProviderError, type MetaProvider, type ScreenGeneration } from '../providers/meta-provider'
import { PIECE_GEOMETRY_PROMPT_VERSION } from '../providers/piece-prompt'
import { AuthenticationError, type SharedKeyAuth } from './auth'
import { ConcurrencyGate } from './budget'
import { createDeadline, RequestStoppedError } from './deadline'
import { exactModelFiles, ModelBodyError, modelFileBytes, readModelMultipart } from './model-multipart'
import { validateAndNormalizeImages, type ObservationImage } from './media'
import { refinePieceCrop, type PieceCropResult } from './piece-crop'
import { salvagePiece } from './piece-salvage'
import type { BackgroundWork } from './screens/service'

interface PiecePorts {
    provider: Pick<MetaProvider, 'generatePieces'> | null
    work: BackgroundWork
    deadlineMs: number
}

async function counted<T>(
    ports: PiecePorts,
    signal: AbortSignal,
    deadlineMs: number,
    work: () => Promise<T>,
): Promise<T> {
    const release = await ports.work.acquire(signal)
    try {
        return await ports.work.run({ deadlineMs, signal }, work)
    } finally {
        release()
    }
}

interface PieceCrop {
    uri: string
    image: ObservationImage
    /** Refined drawing box; null when the crop is a client cutout reused for repair. */
    box: PieceCropResult['box'] | null
    inkRatio: number | null
    /** Broader figure context is sent to the model but is never shown or stored as this piece's own cutout. */
    contextOnly: boolean
}

async function readCrop(uri: string): Promise<PieceCrop | null> {
    try {
        const bytes = new Uint8Array(Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64'))
        const info = await sharp(bytes, { limitInputPixels: LIMITS.imagePixels }).metadata()
        if (!info.width || !info.height || info.format !== 'png' || (info.pages !== undefined && info.pages > 1))
            return null
        const image: ObservationImage = { bytes, width: info.width, height: info.height, mimeType: 'image/png' }
        // A reused cutout passes the same blank gate as a fresh crop; the whole frame is its drawing box.
        const ink = await refinePieceCrop(image, [0, 0, 1, 1])
        return ink ? { uri, image, box: null, inkRatio: ink.inkRatio, contextOnly: false } : null
    } catch {
        return null
    }
}

async function cropDrawing(part: ManualPieceInput, image: ObservationImage | undefined): Promise<PieceCrop | null> {
    if (part.cutoutUri) return readCrop(part.cutoutUri)
    if (!image) return null
    // Pre-figureBox clients supplied the cited page alone. Its whole frame is context, never an own cutout.
    const box = part.drawingBox ?? part.figureBox ?? [0, 0, 1, 1]
    try {
        const crop = await refinePieceCrop(image, box)
        return crop && crop.uri.length <= 360_000 ? { ...crop, contextOnly: part.drawingBox == null } : null
    } catch {
        return null
    }
}

function drawingKey(part: ManualPieceInput): string | null {
    return part.drawingBox && part.pageId !== null ? `${part.pageId}|${part.drawingBox.join(',')}` : null
}

/**
 * A drawing box that two distinct parts of one batch share is no part's own figure: cropping it for either would give
 * both the same claimed own drawing. Drop that claim and any reused cutout; an explicit step figure remains context.
 */
function ownDrawingParts(parts: readonly ManualPieceInput[]): ManualPieceInput[] {
    const counts = new Map<string, number>()
    for (const part of parts) {
        const key = drawingKey(part)
        if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return parts.map((part) => {
        const key = drawingKey(part)
        return key !== null && counts.get(key)! > 1 ? { ...part, drawingBox: undefined, cutoutUri: undefined } : part
    })
}

/** Independently accept each requested id. A blank or broken sibling never erases a valid piece. */
export async function generatePieceBatch(
    metadata: PieceBatchRequest,
    pages: ReadonlyMap<string, ObservationImage>,
    ports: PiecePorts,
    signal: AbortSignal,
): Promise<PieceBatchResult> {
    const started = performance.now()
    const crops = new Map<string, PieceCrop>()
    for (const part of ownDrawingParts(metadata.parts)) {
        const crop = await cropDrawing(part, part.pageId === null ? undefined : pages.get(part.pageId))
        if (crop) crops.set(part.id, crop)
    }
    const images: ObservationImage[] = []
    const imagePieceIds: string[] = []
    for (const part of metadata.parts) {
        const crop = crops.get(part.id)
        if (!crop) continue
        images.push(crop.image)
        imagePieceIds.push(part.id)
    }
    let generation: ScreenGeneration | undefined
    let failure = 'response:provider_error'
    try {
        if (!ports.provider?.generatePieces) failure = 'response:unconfigured'
        else
            generation = await counted(ports, signal, ports.deadlineMs, () =>
                ports.provider!.generatePieces!(
                    { requestId: metadata.requestId, parts: metadata.parts, imagePieceIds, images },
                    signal,
                ),
            )
    } catch (error) {
        signal.throwIfAborted()
        failure =
            error instanceof RequestStoppedError
                ? 'response:timeout'
                : error instanceof MetaProviderError
                  ? `response:${error.code}`
                  : 'response:provider_error'
    }
    signal.throwIfAborted()
    if (
        generation !== undefined &&
        (generation.telemetry.model !== 'muse-wonder-1.0' || generation.telemetry.effort !== 'high')
    ) {
        generation = undefined
        failure = 'response:model_identity'
    }
    const raw = generation?.value
    const proposals: unknown[] =
        typeof raw === 'object' &&
        raw !== null &&
        'pieces' in raw &&
        Array.isArray(raw.pieces) &&
        raw.pieces.length <= 8
            ? raw.pieces
            : []
    const results: PieceBatchResult['results'] = metadata.parts.map((part) => {
        const candidates = proposals.filter(
            (value) => typeof value === 'object' && value !== null && 'id' in value && value.id === part.id,
        )
        const salvage = candidates.length === 1 ? salvagePiece(candidates[0]) : null
        const parsed = salvage?.parsed ?? null
        const issueCodes =
            generation === undefined
                ? [failure]
                : candidates.length === 0
                  ? ['piece:missing_id']
                  : candidates.length > 1
                    ? ['piece:duplicate_id']
                    : parsed !== null && !parsed.success
                      ? parsed.error.issues
                            .slice(0, 40)
                            .map((issue) => `${issue.path.map(String).join('.') || 'piece'}:${issue.code}`)
                      : parsed?.success && parsed.data.name !== part.name
                        ? ['piece:name_mismatch']
                        : []
        const piece = parsed?.success && issueCodes.length === 0 ? parsed.data : null
        const crop = crops.get(part.id)
        const result = {
            id: part.id,
            name: part.name,
            status: piece === null ? ('invalid' as const) : part.repair ? ('repaired' as const) : ('passed' as const),
            piece,
            cutoutUri: crop && !crop.contextOnly ? crop.uri : null,
            issueCodes,
        }
        console.info(
            JSON.stringify({
                event: 'piece_generation',
                promptVersion: PIECE_GEOMETRY_PROMPT_VERSION,
                requestId: metadata.requestId,
                pieceId: part.id,
                droppedParts: salvage?.droppedParts ?? [],
                originalPartCount: salvage?.originalPartCount ?? null,
                retainedPartCount: piece === null ? 0 : (salvage?.retainedPartCount ?? 0),
                retention: salvage?.retention ?? 'invalid-piece',
                salvaged: piece !== null && (salvage?.salvaged ?? false),
                status: result.status,
                originalBox: part.drawingBox ?? null,
                refinedBox: crop?.box ?? null,
                inkRatio: crop?.inkRatio ?? null,
                cropOK: crop !== undefined,
                cropSha256: crop ? createHash('sha256').update(crop.image.bytes).digest('hex') : null,
                issueCodes,
                model: generation?.telemetry.model ?? null,
                effort: generation?.telemetry.effort ?? null,
            }),
        )
        return result
    })
    return pieceBatchResultSchema.parse({
        contentHash: metadata.contentHash,
        results,
        model: generation?.telemetry.model === 'muse-wonder-1.0' ? generation.telemetry.model : null,
        effort: generation?.telemetry.effort === 'high' ? 'high' : null,
        durationMs: Math.max(0, performance.now() - started),
    })
}

export function createPieceHandler(
    options: PiecePorts & { auth: SharedKeyAuth; runtimeMode: 'meta' | 'fixture' },
): (request: Request) => Promise<Response> {
    const batches = new ConcurrencyGate(2, 0)
    return async (request): Promise<Response> => {
        const deadline = createDeadline(105_000, request.signal)
        let release: (() => void) | null = null
        try {
            options.auth.authenticate(request)
            if (options.runtimeMode !== 'meta' || !options.provider?.generatePieces)
                return Response.json({ status: 'unavailable', code: 'unconfigured' }, { status: 503 })
            release = batches.tryAcquire()
            if (!release) return Response.json({ status: 'unavailable', code: 'busy' }, { status: 503 })
            const { metadata, files } = await readModelMultipart(
                request,
                pieceBatchRequestSchema,
                LIMITS.requestBytes,
                deadline,
                4_194_304,
            )
            exactModelFiles(
                files,
                metadata.pages.map((page) => `page:${page.pageId}`),
                false,
            )
            const inputs: ObservationImage[] = []
            for (const page of metadata.pages)
                inputs.push({
                    ...page,
                    bytes: await modelFileBytes(
                        files,
                        `page:${page.pageId}`,
                        page.mimeType,
                        LIMITS.imageBytes,
                        deadline,
                    ),
                })
            const normalized = inputs.length === 0 ? [] : await validateAndNormalizeImages(inputs, deadline.signal, 8)
            const pages = new Map(metadata.pages.map((page, index) => [page.pageId, normalized[index]!]))
            const result = await generatePieceBatch(metadata, pages, options, deadline.signal)
            deadline.checkpoint()
            return Response.json(result, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            const code =
                error instanceof AuthenticationError
                    ? 'unauthorized'
                    : error instanceof ModelBodyError
                      ? 'invalid_input'
                      : error instanceof RequestStoppedError
                        ? error.reason
                        : 'provider_error'
            return Response.json(
                { status: 'unavailable', code },
                {
                    status:
                        error instanceof AuthenticationError
                            ? 401
                            : error instanceof ModelBodyError
                              ? error.status
                              : 503,
                },
            )
        } finally {
            release?.()
            deadline.dispose()
        }
    }
}
