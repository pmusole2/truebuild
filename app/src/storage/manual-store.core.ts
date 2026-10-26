import {
    createDemoManual,
    LIMITS,
    manualSessionSchema,
    type ManualPage,
    type ManualSession,
} from '@truebuild/contracts'
import { z } from 'zod'
import type { ManualSummary, StoredPageAsset } from './manual-store.types'

export type ManualStorageErrorCode =
    'invalid_input' | 'missing_bytes' | 'hash_mismatch' | 'asset_conflict' | 'corrupt' | 'unavailable' | 'io'

export class ManualStorageError extends Error {
    readonly code: ManualStorageErrorCode

    constructor(code: ManualStorageErrorCode, message: string, options?: { cause?: unknown }) {
        super(message, options)
        this.name = 'ManualStorageError'
        this.code = code
    }
}

export type PageMimeType = ManualPage['mimeType']

/** Resolves to lowercase hex SHA-256 of exactly the bytes passed in. */
export type ContentDigest = (bytes: Uint8Array<ArrayBuffer>) => Promise<string>

export const MAX_ASSET_BYTES = LIMITS.imageBytes

const storedIdSchema = z.string().trim().min(1).max(128)

export function parseStoredId(value: unknown, label: string): string {
    const parsed = storedIdSchema.safeParse(value)

    if (!parsed.success) {
        throw new ManualStorageError(
            'invalid_input',
            `${label} must be a non-empty identifier of at most 128 characters`,
        )
    }

    return parsed.data
}

export function digestToHex(digest: ArrayBuffer): string {
    return Array.from(new Uint8Array(digest), (byte: number): string => byte.toString(16).padStart(2, '0')).join('')
}

const DEMO_MANUAL = createDemoManual()

/**
 * The only page allowed to exist without stored bytes: the code-defined demo page, identified by its exact
 * synthetic metadata. Any other page, including one in a manual that reuses the demo ID, needs real bytes.
 */
export function isSyntheticPage(manualId: string, page: ManualPage): boolean {
    return (
        manualId === DEMO_MANUAL.manualId &&
        DEMO_MANUAL.pages.some(
            (demo) =>
                demo.pageId === page.pageId && demo.assetId === page.assetId && demo.contentHash === page.contentHash,
        )
    )
}

export function summarize(session: ManualSession): ManualSummary {
    return {
        manualId: session.manualId,
        title: session.title,
        updatedAt: session.updatedAt,
        stepCount: session.reviewedSteps.length,
        reviewStatus: session.reviewStatus,
    }
}

export interface PreparedAsset {
    readonly assetId: string
    readonly mimeType: PageMimeType
    readonly contentHash: string
    readonly bytes: Uint8Array<ArrayBuffer>
}

export interface PreparedSave {
    /** Schema-validated copy; the caller's object is never read again after this point. */
    readonly session: ManualSession
    /** Byte copies keyed by asset ID, each verified against its page's MIME type, size and SHA-256. */
    readonly assets: ReadonlyMap<string, PreparedAsset>
}

function invalidInput(message: string): ManualStorageError {
    return new ManualStorageError('invalid_input', message)
}

/**
 * Validates everything a save can be checked for without the store's current state. Bytes are copied before any
 * await, so later caller mutations cannot change what gets persisted. Ownership and retained bytes are checked by
 * each store against its committed state, in the same unit that publishes the session.
 */
export async function prepareSave(
    session: ManualSession,
    assets: readonly StoredPageAsset[],
    digest: ContentDigest,
): Promise<PreparedSave> {
    const parsed = manualSessionSchema.safeParse(session)

    if (!parsed.success) {
        throw invalidInput('Manual session failed validation')
    }

    const validated = parsed.data
    const prepared = new Map<string, PreparedAsset>()

    for (const asset of assets) {
        const page = validated.pages.find((candidate) => candidate.assetId === asset.assetId)

        if (page === undefined) {
            throw invalidInput('Every supplied asset must be referenced by a page of this manual')
        }

        if (prepared.has(page.assetId)) {
            throw invalidInput('Each asset may be supplied only once')
        }

        if (isSyntheticPage(validated.manualId, page)) {
            throw invalidInput('The synthetic demo page does not accept image bytes')
        }

        if (!(asset.bytes instanceof Uint8Array)) {
            throw invalidInput('Asset bytes must be a Uint8Array')
        }

        if (asset.mimeType !== page.mimeType) {
            throw invalidInput(`Asset MIME type does not match page ${page.pageId}`)
        }

        if (asset.bytes.byteLength === 0 || asset.bytes.byteLength > MAX_ASSET_BYTES) {
            throw invalidInput(`Asset for page ${page.pageId} must be between 1 byte and ${MAX_ASSET_BYTES} bytes`)
        }

        const bytes = new Uint8Array(asset.bytes)
        const contentHash = await digest(bytes)

        if (contentHash !== page.contentHash) {
            throw new ManualStorageError('hash_mismatch', `Bytes for page ${page.pageId} do not match its content hash`)
        }

        prepared.set(page.assetId, { assetId: page.assetId, mimeType: page.mimeType, contentHash, bytes })
    }

    return { session: validated, assets: prepared }
}

/** Copies stored bytes and fails closed when they no longer match the metadata recorded with them. */
export async function verifyStoredBytes(
    bytes: Uint8Array,
    expected: { readonly byteLength: number; readonly contentHash: string },
    digest: ContentDigest,
): Promise<Uint8Array<ArrayBuffer>> {
    const copy = new Uint8Array(bytes)

    if (copy.byteLength !== expected.byteLength || (await digest(copy)) !== expected.contentHash) {
        throw new ManualStorageError('corrupt', 'Stored image bytes do not match their recorded metadata')
    }

    return copy
}
