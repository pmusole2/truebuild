import { manualSessionSchema, type ManualPage, type ManualSession } from '@truebuild/contracts'
import { digestToHex, type ContentDigest } from './manual-store.core'
import type { StoredPageAsset } from './manual-store.types'

export const FIXTURE_TIME = '2026-01-01T00:00:00.000Z'

/** Deterministic, non-uniform bytes so that a truncated, shifted or swapped buffer changes the digest. */
export function bytesFor(label: string, length: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(length)

    for (let index = 0; index < length; index++) {
        bytes[index] = (label.charCodeAt(index % label.length) + index * 7) % 256
    }

    return bytes
}

/**
 * Fixture oracle built on WebCrypto. The known-answer vectors in manual-store.rules.test.ts pin it to the standard
 * SHA-256 output, so fixture hashes are not produced by the code under test.
 */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    return digestToHex(await crypto.subtle.digest('SHA-256', bytes))
}

export const nodeDigest: ContentDigest = sha256Hex

export async function pageFor(
    pageId: string,
    assetId: string,
    bytes: Uint8Array<ArrayBuffer>,
    mimeType: ManualPage['mimeType'] = 'image/jpeg',
): Promise<ManualPage> {
    return { pageId, assetId, width: 640, height: 480, mimeType, contentHash: await sha256Hex(bytes) }
}

export function assetFor(
    assetId: string,
    bytes: Uint8Array<ArrayBuffer>,
    mimeType: ManualPage['mimeType'] = 'image/jpeg',
): StoredPageAsset {
    return { assetId, mimeType, bytes }
}

export function sessionOf(
    manualId: string,
    pages: ManualPage[],
    overrides: Partial<ManualSession> = {},
): ManualSession {
    return manualSessionSchema.parse({
        manualId,
        title: `Manual ${manualId}`,
        updatedAt: FIXTURE_TIME,
        revision: 1,
        pages,
        parts: [],
        rawExtraction: null,
        reviewedSteps: [],
        reviewStatus: 'unreviewed',
        ...overrides,
    })
}
