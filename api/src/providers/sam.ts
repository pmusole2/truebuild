import { randomUUID } from 'node:crypto'

import {
    decodeMaskToSVGPath,
    frameIndexOf,
    parseImageStream,
    parseVideoStream,
    ResponsesStreamSourceError,
    type SegmentationSnapshot,
    type SegmentationMaskRecord,
    type SegmentationResult,
} from '@meta-sam/parser'
import {
    captureBindingSchema,
    MAX_MASK_PATH_CHARS,
    trackSnapshotSchema,
    LIMITS,
    type CaptureBinding,
    type SegmentEvent,
    type TrackRecord,
} from '@truebuild/contracts'
import { z } from 'zod'

import { BudgetError } from '../server/budget'
import { MetaTransport, usageMetrics, type ProviderMetrics } from './meta-transport'
import { ClipError, normalizeClip } from '../server/clip'
import { createDeadline, RequestStoppedError, type Deadline } from '../server/deadline'
import { MediaValidationError, validateAndNormalizeImages, type ObservationImage } from '../server/media'
import { guardSamGrammar, readSamSse, SamStreamError, withSamDeadline, type SamGeometry } from '../server/sam-sse'

const MAX_CLIP_BYTES = 20 * 1_024 * 1_024

export interface SamInput {
    requestId: string
    binding: CaptureBinding
    capturedAt: string
    prompt: string
    media:
        | { kind: 'image'; image: ObservationImage }
        | { kind: 'clip'; bytes: Uint8Array; mimeType: 'video/mp4' | 'video/quicktime' }
}

export interface SamProvider {
    segment(input: SamInput, signal: AbortSignal): AsyncIterable<SegmentEvent>
}

const inputSchema = z.strictObject({
    requestId: z.string().trim().min(1).max(128),
    binding: captureBindingSchema,
    capturedAt: z.iso.datetime(),
    prompt: z
        .string()
        .refine((text): boolean => !/[\r\n]/u.test(text))
        .trim()
        .min(1)
        .max(100)
        .refine(
            (text): boolean =>
                /^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u.test(text) &&
                !/\b(and|or|not|without)\b/iu.test(text) &&
                !/^(find|segment|show|locate|identify|detect|ignore|explain|describe|where|which|what|please|is|are|do|does|can|could|should|would|will|why|how|when|who|count|tell|compare|check|verify|inspect|look|return|output|give|answer)\b/iu.test(
                    text,
                ),
        ),
    media: z.discriminatedUnion('kind', [
        z.strictObject({
            kind: z.literal('image'),
            image: z.strictObject({
                bytes: z
                    .instanceof(Uint8Array)
                    .refine((bytes): boolean => bytes.length > 0 && bytes.length <= LIMITS.imageBytes),
                mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
                width: z.number().int().positive(),
                height: z.number().int().positive(),
            }),
        }),
        z.strictObject({
            kind: z.literal('clip'),
            bytes: z
                .instanceof(Uint8Array)
                .refine((bytes): boolean => bytes.length > 0 && bytes.length <= MAX_CLIP_BYTES),
            mimeType: z.enum(['video/mp4', 'video/quicktime']),
        }),
    ]),
})

function ownInput(input: SamInput): SamInput {
    const result = inputSchema.safeParse(input)
    if (!result.success) {
        throw new SamStreamError('invalid_output')
    }
    const value = result.data
    if (value.media.kind === 'image') {
        value.media.image.bytes = new Uint8Array(value.media.image.bytes)
    } else {
        value.media.bytes = new Uint8Array(value.media.bytes)
    }
    return value
}

type TrackMask = NonNullable<TrackRecord['mask']>

/**
 * The validated mask for the native outline. The path lives on the mask's own raster grid, which maps onto the
 * record's box. A mask that cannot be converted or exceeds its bound is omitted (the box remains); never truncated.
 */
function maskFor(mask: SegmentationMaskRecord['mask']): TrackMask | undefined {
    try {
        const path = decodeMaskToSVGPath(mask)
        return path.length > 0 && path.length <= MAX_MASK_PATH_CHARS
            ? { width: mask.width, height: mask.height, path }
            : undefined
    } catch {
        return undefined
    }
}

const SAM_MODEL = 'sam-3.1'

/**
 * What a streamed `Response` says about the model that produced it. A response that does not state a model (the
 * field is absent) neither confirms nor contradicts the request; one that states anything but the requested SAM
 * model, in any form, is a stream that cannot be trusted.
 */
function samResponseIdentity(response: unknown): 'confirmed' | 'silent' {
    if (typeof response !== 'object' || response === null || !('model' in response)) return 'silent'
    if (response.model === SAM_MODEL) return 'confirmed'
    throw new SamStreamError('invalid_output')
}

function reportsModel(response: unknown): boolean {
    return typeof response === 'object' && response !== null && 'model' in response && response.model === SAM_MODEL
}

function snapshots(
    view: SegmentationSnapshot,
    geometry: SamGeometry,
    seen: Set<number>,
    input: SamInput,
    streamId: string,
    startedAt: number,
    identified: boolean,
): SegmentEvent[] {
    if (view.diagnostics.length > 0) {
        throw new SamStreamError('invalid_output')
    }
    const frames = new Map<number, TrackRecord[]>()
    const masks = new Set<string>()
    const maskShapes = new Map<string, TrackMask>()
    const boxes = new Set<string>()
    const identities = new Map<TrackRecord, string>()
    for (const record of view.records) {
        if (record.kind === 'text') {
            throw new SamStreamError('invalid_output')
        }
        const frameIndex = geometry.kind === 'image' ? 0 : frameIndexOf(record)
        if (frameIndex === undefined || frameIndex < 0 || frameIndex >= geometry.frameCount) {
            throw new SamStreamError('invalid_output')
        }
        const identity = `${frameIndex}:${record.objectId}`
        if (record.kind === 'mask') {
            if (masks.has(identity)) {
                throw new SamStreamError('invalid_output')
            }
            masks.add(identity)
            const shape = maskFor(record.mask)
            if (shape) maskShapes.set(identity, shape)
        } else {
            if (boxes.has(identity)) {
                throw new SamStreamError('invalid_output')
            }
            boxes.add(identity)
            const records = frames.get(frameIndex) ?? []
            const track: TrackRecord = {
                objectId: record.objectId,
                label: input.prompt,
                box: {
                    x: record.left / geometry.width,
                    y: record.top / geometry.height,
                    width: (record.right - record.left) / geometry.width,
                    height: (record.bottom - record.top) / geometry.height,
                },
            }
            identities.set(track, identity)
            records.push(track)
            frames.set(frameIndex, records)
        }
    }
    if (boxes.size !== masks.size || [...boxes].some((identity) => !masks.has(identity))) {
        throw new SamStreamError('invalid_output')
    }
    const events: SegmentEvent[] = []
    for (const [frameIndex, records] of frames) {
        if (seen.has(frameIndex)) {
            continue
        }
        if (records.length > 16 || seen.size >= 150) {
            throw new SamStreamError('invalid_output')
        }
        seen.add(frameIndex)
        const withMasks = records.map((track): TrackRecord => {
            const shape = maskShapes.get(identities.get(track) ?? '')
            return shape ? { ...track, mask: shape } : track
        })
        events.push({
            type: 'snapshot',
            snapshot: trackSnapshotSchema.parse({
                binding: input.binding,
                streamId,
                frameIndex,
                capturedAt: input.capturedAt,
                records: withMasks,
                complete: false,
                // Only after a response confirmed the model; before that nothing is claimed about what answered.
                ...(identified
                    ? { stage: { model: SAM_MODEL, elapsedMs: Math.max(0, performance.now() - startedAt) } }
                    : {}),
            }),
        })
    }
    return events
}

function unavailable(error: unknown, deadline?: Deadline): SegmentEvent {
    try {
        deadline?.checkpoint()
    } catch (stopped) {
        error = stopped
    }
    if (error instanceof RequestStoppedError) {
        return { type: 'unavailable', code: error.reason === 'timeout' ? 'timeout' : 'provider_error' }
    }
    if (error instanceof ResponsesStreamSourceError) {
        error = error.cause instanceof SamStreamError ? error.cause : new SamStreamError('provider_error')
    }
    if (error instanceof ClipError) {
        return { type: 'unavailable', code: error.code === 'unavailable' ? 'provider_error' : 'invalid_output' }
    }
    if (error instanceof MediaValidationError) {
        return { type: 'unavailable', code: 'invalid_output' }
    }
    if (error instanceof SamStreamError) {
        return { type: 'unavailable', code: error.code }
    }
    return { type: 'unavailable', code: 'invalid_output' }
}

async function* run(
    input: SamInput,
    apiKey: string,
    transport: MetaTransport,
    deadline: Deadline,
    onMetrics?: (metrics: ProviderMetrics) => void,
): AsyncGenerator<SegmentEvent> {
    let response: Response | undefined
    const started = performance.now()
    try {
        deadline.checkpoint()
        let geometry: SamGeometry
        let mediaPart: { type: 'input_image'; image_url: string } | { type: 'input_video'; video_url: string }
        if (input.media.kind === 'image') {
            const normalized = await withSamDeadline(
                validateAndNormalizeImages([input.media.image], deadline.signal),
                deadline,
            )
            deadline.checkpoint()
            const image = normalized[0]
            if (!image) {
                throw new SamStreamError('invalid_output')
            }
            geometry = { kind: 'image', width: image.width, height: image.height, frameCount: 1 }
            mediaPart = {
                type: 'input_image',
                image_url: `data:image/jpeg;base64,${Buffer.from(image.bytes).toString('base64')}`,
            }
        } else {
            const clip = await normalizeClip(input.media, deadline)
            deadline.checkpoint()
            geometry = { kind: 'clip', width: clip.width, height: clip.height, frameCount: clip.frameCount }
            mediaPart = {
                type: 'input_video',
                video_url: `data:video/mp4;base64,${Buffer.from(clip.bytes).toString('base64')}`,
            }
        }
        deadline.checkpoint()
        const body = JSON.stringify({
            model: SAM_MODEL,
            stream: true,
            store: false,
            input: [
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.prompt }, mediaPart] },
            ],
        })
        deadline.checkpoint()
        const pending = transport
            .send(
                SAM_MODEL,
                {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${apiKey}`,
                        'content-type': 'application/json',
                        accept: 'text/event-stream',
                    },
                    body,
                    signal: deadline.signal,
                    redirect: 'error',
                },
                deadline,
                (status, latencyMs) => onMetrics?.({ operation: 'segment', model: SAM_MODEL, status, latencyMs }),
                2, // One short Retry-After 429 plus one eligible network retry; all response-body failures remain final.
                undefined,
                2,
            )
            .then((settled): Response => {
                response = settled
                try {
                    deadline.checkpoint()
                } catch (error) {
                    void settled.body?.cancel().catch((): void => {})
                    throw error
                }
                return settled
            })
            .catch((error: unknown): never => {
                if (error instanceof BudgetError || error instanceof RequestStoppedError) {
                    throw error
                }
                throw new SamStreamError('provider_error')
            })
        response = await withSamDeadline(pending, deadline)
        deadline.checkpoint()
        // Set only by a streamed Response that itself reported the requested model.
        let identified = false
        const source = guardSamGrammar(
            readSamSse(
                response,
                deadline,
                (value) =>
                    onMetrics?.({
                        operation: 'segment',
                        model: SAM_MODEL,
                        modelIdentity: reportsModel(value) ? 'verified' : 'unverified',
                        status: response!.status,
                        latencyMs: Math.max(0, performance.now() - started),
                        ...usageMetrics(value),
                    }),
                (value) => {
                    if (samResponseIdentity(value) === 'confirmed') identified = true
                },
            ),
            geometry,
            deadline,
        )
        const parsed = geometry.kind === 'image' ? parseImageStream(source) : parseVideoStream(source)
        const streamId = randomUUID()
        const seen = new Set<number>()
        for await (const view of parsed) {
            deadline.checkpoint()
            for (const snapshot of snapshots(view, geometry, seen, input, streamId, started, identified)) {
                deadline.checkpoint()
                yield snapshot
                deadline.checkpoint()
            }
        }
        deadline.checkpoint()
        const final = await withSamDeadline<SegmentationResult>(parsed.finalResult, deadline)
        deadline.checkpoint()
        if (final.outcome.status !== 'completed' || final.diagnostics.length > 0) {
            throw new SamStreamError('invalid_output')
        }
        // A finalized trailing line may be the first parser snapshot; never synthesize missing frames.
        for (const snapshot of snapshots(final, geometry, seen, input, streamId, started, identified)) {
            deadline.checkpoint()
            yield snapshot
            deadline.checkpoint()
        }
        deadline.checkpoint()
        yield { type: 'completed' }
    } catch (error) {
        if (error instanceof BudgetError) throw error
        yield unavailable(error, deadline)
    } finally {
        deadline.dispose()
        if (response?.body && !response.body.locked) {
            void response.body.cancel().catch((): void => {})
        }
    }
}

export function createSamProvider(options: {
    apiKey?: string
    fetchImpl?: typeof fetch
    onMetrics?: (metrics: ProviderMetrics) => void
}): SamProvider {
    const apiKey = options.apiKey
    const transport = new MetaTransport(options.fetchImpl ?? fetch)
    return {
        segment(input: SamInput, signal: AbortSignal): AsyncIterable<SegmentEvent> {
            if (!apiKey?.trim()) {
                return (async function* (): AsyncGenerator<SegmentEvent> {
                    yield { type: 'unavailable', code: 'provider_error' }
                })()
            }
            const cancellation = new AbortController()
            const deadline = createDeadline(30_000, AbortSignal.any([signal, cancellation.signal]))
            let owned: SamInput
            try {
                deadline.checkpoint()
                owned = ownInput(input)
            } catch (error) {
                const terminal = unavailable(error, deadline)
                deadline.dispose()
                return (async function* (): AsyncGenerator<SegmentEvent> {
                    yield terminal
                })()
            }
            const source = run(owned, apiKey, transport, deadline, options.onMetrics)
            let consumed = false
            return {
                [Symbol.asyncIterator](): AsyncIterator<SegmentEvent> {
                    if (consumed) {
                        throw new SamStreamError('invalid_output')
                    }
                    consumed = true
                    return {
                        next: (): Promise<IteratorResult<SegmentEvent>> => source.next(),
                        return: async (): Promise<IteratorResult<SegmentEvent>> => {
                            cancellation.abort()
                            try {
                                return await source.return(undefined)
                            } finally {
                                deadline.dispose()
                            }
                        },
                    }
                },
            }
        },
    }
}
