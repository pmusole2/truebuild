import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import {
    LIMITS,
    pieceBatchRequestSchema,
    pieceBatchResultSchema,
    pieceSpecSchema,
    trackMaskSchema,
    type ManualPieceInput,
    type PieceBatchRequest,
    type PieceBatchResult,
    type TrackRecord,
} from '@truebuild/contracts'
import { MetaProviderError, type MetaProvider, type ScreenGeneration } from '../providers/meta-provider'
import type { SamProvider } from '../providers/sam'
import { PIECE_GEOMETRY_PROMPT_VERSION } from '../providers/piece-prompt'
import { AuthenticationError, type SharedKeyAuth } from './auth'
import { ConcurrencyGate } from './budget'
import { createDeadline, RequestStoppedError } from './deadline'
import { exactModelFiles, ModelBodyError, modelFileBytes, readModelMultipart } from './model-multipart'
import { validateAndNormalizeImages, type ObservationImage } from './media'
import type { BackgroundWork } from './screens/service'

interface PiecePorts {
    provider: Pick<MetaProvider, 'generatePieces'> | null
    samProvider: SamProvider | null
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

async function cutout(image: ObservationImage, record: TrackRecord): Promise<string | null> {
    if (!record.mask || !trackMaskSchema.safeParse(record.mask).success) return null
    const left = Math.max(0, Math.floor(record.box.x * image.width))
    const top = Math.max(0, Math.floor(record.box.y * image.height))
    const width = Math.min(image.width - left, Math.ceil(record.box.width * image.width))
    const height = Math.min(image.height - top, Math.ceil(record.box.height * image.height))
    if (width < 1 || height < 1) return null
    // The existing SAM contract permits path commands/numbers only, never SVG markup or external references.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><g transform="translate(${record.box.x * image.width} ${record.box.y * image.height}) scale(${(record.box.width * image.width) / record.mask.width} ${(record.box.height * image.height) / record.mask.height})"><path d="${record.mask.path}" fill="white"/></g></svg>`
    const png = await sharp(image.bytes)
        .ensureAlpha()
        .composite([{ input: Buffer.from(svg), blend: 'dest-in' }])
        .extract({ left, top, width, height })
        .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer()
    const uri = `data:image/png;base64,${png.toString('base64')}`
    return uri.length <= 360_000 ? uri : null
}

async function segmentPart(
    part: ManualPieceInput,
    image: ObservationImage | undefined,
    ports: PiecePorts,
    signal: AbortSignal,
): Promise<string | null> {
    if (part.cutoutUri) return part.cutoutUri
    if (!image || !ports.samProvider) return null
    const prompt = part.name
        .replace(/[^\p{L}\p{N} '-]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 100)
    if (!prompt || /\b(and|or|not|without)\b/iu.test(prompt)) return null
    try {
        return await counted(ports, signal, 12_000, async (): Promise<string | null> => {
            const deadline = createDeadline(12_000, signal)
            try {
                const stream = ports.samProvider!.segment(
                    {
                        requestId: randomUUID(),
                        binding: {
                            kind: 'capture',
                            manualId: 'piece-inventory',
                            revision: 1,
                            stepId: part.id,
                            captureId: randomUUID(),
                        },
                        capturedAt: new Date().toISOString(),
                        prompt,
                        media: { kind: 'image', image },
                    },
                    deadline.signal,
                )
                let selected: TrackRecord | undefined
                for await (const event of stream) {
                    deadline.checkpoint()
                    if (event.type === 'snapshot')
                        selected = event.snapshot.records.find((record) => record.mask !== undefined) ?? selected
                }
                deadline.checkpoint()
                return selected ? await cutout(image, selected) : null
            } finally {
                deadline.dispose()
            }
        })
    } catch {
        // An absent SAM cutout is normal: name/dimensions can still produce a useful approximate piece.
        signal.throwIfAborted()
        return null
    }
}

/** Independently accept each requested id. A broken sibling never erases a valid piece or its 2D cutout. */
export async function generatePieceBatch(
    metadata: PieceBatchRequest,
    pages: ReadonlyMap<string, ObservationImage>,
    ports: PiecePorts,
    signal: AbortSignal,
): Promise<PieceBatchResult> {
    const started = performance.now()
    const cuts = new Map<string, string | null>()
    let next = 0
    const segment = async (): Promise<void> => {
        while (next < metadata.parts.length) {
            const part = metadata.parts[next++]!
            cuts.set(
                part.id,
                await segmentPart(part, part.pageId === null ? undefined : pages.get(part.pageId), ports, signal),
            )
        }
    }
    await Promise.all([segment(), segment()])
    const images: ObservationImage[] = []
    const imagePieceIds: string[] = []
    for (const part of metadata.parts) {
        const uri = cuts.get(part.id)
        if (!uri) continue
        try {
            const bytes = new Uint8Array(Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64'))
            const info = await sharp(bytes, { limitInputPixels: LIMITS.imagePixels }).metadata()
            if (!info.width || !info.height || info.format !== 'png' || (info.pages !== undefined && info.pages > 1)) {
                cuts.set(part.id, null)
                continue
            }
            images.push({ bytes, width: info.width, height: info.height, mimeType: 'image/png' })
            imagePieceIds.push(part.id)
        } catch {
            cuts.set(part.id, null)
        }
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
        (generation.telemetry.model !== 'muse-wonder-1.0' || generation.telemetry.effort !== 'medium')
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
        const parsed = candidates.length === 1 ? pieceSpecSchema.safeParse(candidates[0]) : null
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
        const result = {
            id: part.id,
            name: part.name,
            status: piece === null ? ('invalid' as const) : part.repair ? ('repaired' as const) : ('passed' as const),
            piece,
            cutoutUri: cuts.get(part.id) ?? null,
            issueCodes,
        }
        console.info(
            JSON.stringify({
                event: 'piece_generation',
                promptVersion: PIECE_GEOMETRY_PROMPT_VERSION,
                requestId: metadata.requestId,
                pieceId: part.id,
                status: result.status,
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
        effort: generation?.telemetry.effort === 'medium' ? 'medium' : null,
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
