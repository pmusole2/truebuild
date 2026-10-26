import {
    type ApiResult,
    type ManualBinding,
    type ManualPage,
    type ParsedManual,
} from '@truebuild/contracts'
import * as Crypto from 'expo-crypto'
import { BoundedApiClient } from '../api/client'
import { ModelApiClient, type ImageBytes } from '../api/model-client'
import type { SourcePageAsset } from '../features/assembly/model-check'
import { freshRequestId } from '../features/assembly/identity'
import { captureObservation } from '../features/assembly/observation'
import { MediaRejectedError, userMessageForMediaError } from '../media/media-errors'

export type ParseRuntime = {
    readonly mode: 'fixture' | 'model'
    readonly baseUrl: string
    readonly secret: string
    readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export type ParseOutcome =
    | {
          readonly status: 'parsed'
          readonly mode: 'fixture' | 'model'
          readonly parsed: ParsedManual
          readonly pages: readonly ManualPage[]
          readonly sources: readonly SourcePageAsset[]
      }
    | { readonly status: 'failed'; readonly message: string }
    | { readonly status: 'cancelled' }

const DEMO_BINDING: ManualBinding = { kind: 'manual', manualId: 'demo-divider', revision: 1 }

function hexDigest(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Fixture mode never sees a photo. The "photo" is simulated and the parse result is labelled as such by the caller.
async function parseFixture(runtime: ParseRuntime): Promise<ParseOutcome> {
    const client = new BoundedApiClient({
        baseUrl: runtime.baseUrl,
        mode: 'fixture',
        secret: runtime.secret,
        fetch: runtime.fetch,
    })
    const result: ApiResult<ParsedManual> = await client.parse(DEMO_BINDING, { requestId: freshRequestId('extract') })
    if (result.status !== 'ok') {
        return { status: 'failed', message: `Parse unavailable (${result.code}). Nothing was read.` }
    }
    return { status: 'parsed', mode: 'fixture', parsed: result.value, pages: [], sources: [] }
}

async function parseModel(runtime: ParseRuntime): Promise<ParseOutcome> {
    const picked = await captureObservation('camera')
    if (picked === null) {
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
    const image: ImageBytes = { bytes: picked.bytes, mimeType: picked.mimeType, width: picked.width, height: picked.height }
    const client = new ModelApiClient({
        baseUrl: runtime.baseUrl,
        secret: runtime.secret,
        fetch: runtime.fetch,
    })
    const result = await client.parse(DEMO_BINDING, [page], [image], { requestId: freshRequestId('extract') })
    if (result.status !== 'ok') {
        return { status: 'failed', message: `Parse unavailable (${result.code}). Nothing was read.` }
    }
    return {
        status: 'parsed',
        mode: 'model',
        parsed: result.value,
        pages: [page],
        sources: [{ assetId: page.assetId, mimeType: page.mimeType, bytes: picked.bytes }],
    }
}

/** One action for both modes: the caller shows the result as a readonly summary until the user confirms it. */
export async function parseManualPhoto(runtime: ParseRuntime): Promise<ParseOutcome> {
    try {
        return runtime.mode === 'fixture' ? await parseFixture(runtime) : await parseModel(runtime)
    } catch (error: unknown) {
        return error instanceof MediaRejectedError
            ? { status: 'failed', message: userMessageForMediaError(error) }
            : { status: 'failed', message: 'The manual photo could not be read. Nothing was sent.' }
    }
}
