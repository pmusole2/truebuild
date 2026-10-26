import { type ApiResult, type ManualBinding, type ManualPage, type ParsedManual } from '@truebuild/contracts'
import * as Crypto from 'expo-crypto'
import { BoundedApiClient } from '../api/client'
import { ModelApiClient, type ImageBytes } from '../api/model-client'
import type { SourcePageAsset } from '../features/assembly/model-check'
import { freshRequestId } from '../features/assembly/identity'
import { captureObservation } from '../features/assembly/observation'
import { MediaRejectedError, userMessageForMediaError } from '../media/media-errors'
import { sampleManual, sampleSourceAsset } from './sample-manual'

export type ParseRuntime = {
    readonly mode: 'fixture' | 'model'
    readonly baseUrl: string
    readonly secret: string
    readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export const PARSE_BINDING: ManualBinding = { kind: 'manual', manualId: 'demo-divider', revision: 1 }

export type ParseOutcome =
    | {
          readonly status: 'parsed'
          readonly mode: 'fixture' | 'model'
          readonly binding: ManualBinding
          readonly parsed: ParsedManual
          readonly pages: readonly ManualPage[]
          readonly sources: readonly SourcePageAsset[]
      }
    | { readonly status: 'failed'; readonly message: string }
    | { readonly status: 'cancelled' }
    | { readonly status: 'denied' }

function hexDigest(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Fixture mode never sees a photo. The synthetic reviewed page stands in for it, and the caller labels the result simulated.
async function parseFixture(runtime: ParseRuntime, signal: AbortSignal): Promise<ParseOutcome> {
    const client = new BoundedApiClient({
        baseUrl: runtime.baseUrl,
        mode: 'fixture',
        secret: runtime.secret,
        fetch: runtime.fetch,
    })
    const result: ApiResult<ParsedManual> = await client.parse(PARSE_BINDING, {
        requestId: freshRequestId('extract'),
        signal,
    })
    if (result.status !== 'ok') {
        return { status: 'failed', message: `Parse unavailable (${result.code}). Nothing was read.` }
    }
    return {
        status: 'parsed',
        mode: 'fixture',
        binding: PARSE_BINDING,
        parsed: result.value,
        pages: sampleManual().pages,
        sources: [sampleSourceAsset()],
    }
}

async function parseModel(runtime: ParseRuntime, signal: AbortSignal): Promise<ParseOutcome> {
    const captured = await captureObservation('camera')
    if (captured.status !== 'picked') {
        return captured
    }
    const picked = captured.observation
    if (signal.aborted) {
        return { status: 'cancelled' }
    }
    const id = Crypto.randomUUID()
    const page: ManualPage = {
        pageId: `page-${id}`,
        assetId: `asset-${id}`,
        width: picked.width,
        height: picked.height,
        mimeType: picked.mimeType,
        contentHash: hexDigest(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, picked.bytes)),
    }
    const image: ImageBytes = {
        bytes: picked.bytes,
        mimeType: picked.mimeType,
        width: picked.width,
        height: picked.height,
    }
    const client = new ModelApiClient({ baseUrl: runtime.baseUrl, secret: runtime.secret, fetch: runtime.fetch })
    const result = await client.parse(PARSE_BINDING, [page], [image], { requestId: freshRequestId('extract'), signal })
    if (signal.aborted) {
        return { status: 'cancelled' }
    }
    if (result.status !== 'ok') {
        return { status: 'failed', message: `Parse unavailable (${result.code}). Nothing was read.` }
    }
    return {
        status: 'parsed',
        mode: 'model',
        binding: PARSE_BINDING,
        parsed: result.value,
        pages: [page],
        sources: [{ assetId: page.assetId, mimeType: page.mimeType, bytes: picked.bytes }],
    }
}

/**
 * One action for both modes. The caller shows the result read-only until the user confirms it. Aborting the signal, or
 * the caller moving on, makes the outcome cancelled so a late reply is never shown.
 */
export async function parseManualPhoto(runtime: ParseRuntime, signal: AbortSignal): Promise<ParseOutcome> {
    try {
        const outcome =
            runtime.mode === 'fixture' ? await parseFixture(runtime, signal) : await parseModel(runtime, signal)
        return signal.aborted ? { status: 'cancelled' } : outcome
    } catch (error: unknown) {
        if (signal.aborted) {
            return { status: 'cancelled' }
        }
        return error instanceof MediaRejectedError
            ? { status: 'failed', message: userMessageForMediaError(error) }
            : { status: 'failed', message: 'The manual photo could not be read. Nothing was sent.' }
    }
}
