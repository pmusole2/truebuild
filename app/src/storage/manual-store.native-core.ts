import { LIMITS, manualSessionSchema, type ManualSession } from '@truebuild/contracts'
import { z } from 'zod'
import {
    ManualStorageError,
    isSyntheticPage,
    parseStoredId,
    prepareSave,
    summarize,
    verifyStoredBytes,
    type ContentDigest,
    type PreparedAsset,
} from './manual-store.core'
import type { ManualStore, ManualSummary, StoredPageAsset } from './manual-store.types'

/**
 * Narrow filesystem and metadata surface. The Expo adapter implements it on app-private storage; tests implement it
 * in memory with failure injection. Contract: `writeNewFile` must refuse an existing file, and `deleteFile` must
 * succeed when the file is already gone.
 */
export interface NativeStoragePort {
    ensureDirectory(): Promise<void>
    readManifestText(): Promise<string | null>
    writeManifestText(text: string): Promise<void>
    fileExists(fileName: string): Promise<boolean>
    writeNewFile(fileName: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>
    readFile(fileName: string): Promise<Uint8Array<ArrayBuffer> | null>
    deleteFile(fileName: string): Promise<void>
    /** Returns 32 lowercase hex characters from a cryptographic source. */
    randomId(): string
}

const MANIFEST_VERSION = 1
const MAX_MANUALS = 500
const MAX_PENDING_DELETES = 5_000
const ASSET_FILE_NAME = /^[a-f0-9]{32}\.bin$/u
const MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

const fileNameSchema = z.string().regex(ASSET_FILE_NAME)

const assetRecordSchema = z.strictObject({
    assetId: z.string().min(1).max(128),
    fileName: fileNameSchema,
    mimeType: z.enum(MIME_TYPES),
    byteLength: z.number().int().min(1).max(LIMITS.imageBytes),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
})

const pendingDeleteSchema = z.strictObject({
    fileName: fileNameSchema,
    // Owner is retained so a file that could not be removed is still attributable to the manual it came from.
    manualId: z.string().min(1).max(128),
})

const manualEntrySchema = z
    .strictObject({
        manualId: z.string().min(1).max(128),
        session: manualSessionSchema,
        assets: z.array(assetRecordSchema).max(LIMITS.manualPages),
    })
    .superRefine((entry, ctx): void => {
        if (entry.manualId !== entry.session.manualId) {
            ctx.addIssue({ code: 'custom', message: 'Manifest entry does not match its session' })
        }

        const expected = new Map<string, ManualSession['pages'][number]>()

        for (const page of entry.session.pages) {
            if (!isSyntheticPage(entry.session.manualId, page)) {
                expected.set(page.assetId, page)
            }
        }

        const recorded = new Set(entry.assets.map((asset) => asset.assetId))

        if (recorded.size !== entry.assets.length || recorded.size !== expected.size) {
            ctx.addIssue({ code: 'custom', message: 'Manifest assets do not match the pages of their manual' })
            return
        }

        for (const asset of entry.assets) {
            const page = expected.get(asset.assetId)

            if (page === undefined || page.mimeType !== asset.mimeType || page.contentHash !== asset.contentHash) {
                ctx.addIssue({ code: 'custom', message: 'Manifest asset metadata does not match its page' })
            }
        }
    })

const manifestSchema = z
    .strictObject({
        version: z.literal(MANIFEST_VERSION),
        manuals: z.array(manualEntrySchema).max(MAX_MANUALS),
        pendingDeletes: z.array(pendingDeleteSchema).max(MAX_PENDING_DELETES),
    })
    .superRefine((manifest, ctx): void => {
        const manualIds = manifest.manuals.map((entry) => entry.manualId)
        const assetIds = manifest.manuals.flatMap((entry) => entry.assets.map((asset) => asset.assetId))
        // A file is either live or pending deletion, never both, so one name cannot be claimed twice.
        const fileNames = [
            ...manifest.manuals.flatMap((entry) => entry.assets.map((asset) => asset.fileName)),
            ...manifest.pendingDeletes.map((pending) => pending.fileName),
        ]

        if (new Set(manualIds).size !== manualIds.length) {
            ctx.addIssue({ code: 'custom', message: 'Duplicate manual identity' })
        }

        if (new Set(assetIds).size !== assetIds.length) {
            ctx.addIssue({ code: 'custom', message: 'An asset is owned by more than one manual' })
        }

        if (new Set(fileNames).size !== fileNames.length) {
            ctx.addIssue({ code: 'custom', message: 'Duplicate asset file name' })
        }
    })

type Manifest = z.infer<typeof manifestSchema>
type ManualEntry = Manifest['manuals'][number]
type AssetRecord = z.infer<typeof assetRecordSchema>
type PendingDelete = Manifest['pendingDeletes'][number]

interface StagedAsset {
    readonly record: AssetRecord
    readonly bytes: Uint8Array<ArrayBuffer>
}

function emptyManifest(): Manifest {
    return { version: MANIFEST_VERSION, manuals: [], pendingDeletes: [] }
}

function corrupt(message: string, cause?: unknown): ManualStorageError {
    return new ManualStorageError('corrupt', message, cause === undefined ? undefined : { cause })
}

function parseManifestText(text: string): Manifest {
    let raw: unknown

    try {
        raw = JSON.parse(text)
    } catch (error: unknown) {
        throw corrupt('Local manual index is not valid JSON', error)
    }

    const parsed = manifestSchema.safeParse(raw)

    if (!parsed.success) {
        throw corrupt('Local manual index failed validation', parsed.error)
    }

    return parsed.data
}

/** A missing index is a fresh install; a present but unreadable index is never replaced with an empty one. */
async function readManifest(port: NativeStoragePort): Promise<Manifest> {
    const text = await port.readManifestText()

    return text === null ? emptyManifest() : parseManifestText(text)
}

async function writeManifest(port: NativeStoragePort, manifest: Manifest): Promise<void> {
    const checked = manifestSchema.safeParse(manifest)

    if (!checked.success) {
        throw new Error('Internal manual index invariant violated')
    }

    await port.writeManifestText(JSON.stringify(checked.data))
}

async function io<T>(operation: () => Promise<T>, message: string): Promise<T> {
    try {
        return await operation()
    } catch (error: unknown) {
        if (error instanceof ManualStorageError) {
            throw error
        }

        throw new ManualStorageError('io', message, { cause: error })
    }
}

function allFileNames(manifest: Manifest): string[] {
    return [
        ...manifest.manuals.flatMap((entry) => entry.assets.map((asset) => asset.fileName)),
        ...manifest.pendingDeletes.map((pending) => pending.fileName),
    ]
}

const NAME_ATTEMPTS = 8

/**
 * Picks a name that no manifest entry and no file already uses. Because every name recorded as pending was chosen
 * here, cleanup can only ever remove files this store created; a file it did not create is never a removal target.
 */
async function allocateFileName(port: NativeStoragePort, taken: Set<string>): Promise<string> {
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
        const fileName = `${port.randomId()}.bin`

        if (ASSET_FILE_NAME.test(fileName) && !taken.has(fileName) && !(await port.fileExists(fileName))) {
            taken.add(fileName)
            return fileName
        }
    }

    throw new ManualStorageError('io', 'Could not allocate a unique asset file name')
}

/**
 * Retries file removal for pending records and commits the records that succeeded. It never throws: it runs both
 * before a mutation and after a publication point, and a failed removal stays durably recorded with its owner.
 */
async function drainPendingDeletes(
    port: NativeStoragePort,
    manifest: Manifest,
    only?: ReadonlySet<string>,
): Promise<Manifest> {
    const targets: PendingDelete[] = manifest.pendingDeletes.filter(
        (pending) => only === undefined || only.has(pending.fileName),
    )
    const removed = new Set<string>()

    for (const pending of targets) {
        try {
            await port.deleteFile(pending.fileName)
            removed.add(pending.fileName)
        } catch {
            // Intentionally retained: the pending record keeps this file owned until a later attempt succeeds.
        }
    }

    if (removed.size === 0) {
        return manifest
    }

    const next: Manifest = {
        ...manifest,
        pendingDeletes: manifest.pendingDeletes.filter((pending) => !removed.has(pending.fileName)),
    }

    try {
        await writeManifest(port, next)
        return next
    } catch {
        // The removed files are gone; their records are retried and harmlessly no-op on the next attempt.
        return manifest
    }
}

async function deleteQuietly(port: NativeStoragePort, fileName: string): Promise<void> {
    try {
        await port.deleteFile(fileName)
    } catch {
        // Intentionally retained: the intent record written before staging keeps this name pending.
    }
}

/**
 * Serialized store over a port. Every mutation follows one order:
 *   1. record intent: staged names become pending deletions owned by the manual (manifest commit, session unchanged);
 *   2. write immutable files under freshly generated names (never overwriting, never derived from caller IDs);
 *   3. publish: one manifest commit replaces the session and its asset records, and queues replaced files;
 *   4. remove queued files and commit the removals.
 * A failure before step 3 leaves the previous manifest authoritative; its staged files are retried from pending.
 */
export function createNativeManualStore(port: NativeStoragePort, digest: ContentDigest): ManualStore {
    let queue: Promise<unknown> = Promise.resolve()

    const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
        const run = queue.then(task)
        queue = run.then(
            (): void => undefined,
            (): void => undefined,
        )
        return run
    }

    return {
        async saveManual(session: ManualSession, assets: readonly StoredPageAsset[] = []): Promise<void> {
            const prepared = await prepareSave(session, assets, digest)

            await exclusive(async (): Promise<void> => {
                await io(() => port.ensureDirectory(), 'Private manual storage directory is unavailable')

                const current = await drainPendingDeletes(port, await readManifest(port))
                const manualId = prepared.session.manualId
                const index = current.manuals.findIndex((entry) => entry.manualId === manualId)
                const previous: ManualEntry | undefined = current.manuals[index]
                const ownerByAsset = new Map<string, string>()

                for (const entry of current.manuals) {
                    for (const asset of entry.assets) {
                        ownerByAsset.set(asset.assetId, entry.manualId)
                    }
                }

                const retainedByAsset = new Map((previous?.assets ?? []).map((asset) => [asset.assetId, asset]))
                const taken = new Set(allFileNames(current))
                const kept: AssetRecord[] = []
                const staged: StagedAsset[] = []

                for (const page of prepared.session.pages) {
                    if (isSyntheticPage(manualId, page)) {
                        continue
                    }

                    const owner = ownerByAsset.get(page.assetId)

                    if (owner !== undefined && owner !== manualId) {
                        throw new ManualStorageError(
                            'asset_conflict',
                            `Asset for page ${page.pageId} is owned by another manual`,
                        )
                    }

                    const supplied: PreparedAsset | undefined = prepared.assets.get(page.assetId)
                    const retained = retainedByAsset.get(page.assetId)

                    if (retained !== undefined) {
                        if (retained.mimeType !== page.mimeType || retained.contentHash !== page.contentHash) {
                            throw new ManualStorageError(
                                'asset_conflict',
                                `Stored bytes for page ${page.pageId} no longer match its metadata`,
                            )
                        }

                        if (supplied !== undefined && supplied.contentHash !== retained.contentHash) {
                            throw new ManualStorageError(
                                'asset_conflict',
                                `Asset for page ${page.pageId} already has different stored bytes`,
                            )
                        }

                        kept.push(retained)
                    } else if (supplied !== undefined) {
                        const fileName = await io(
                            (): Promise<string> => allocateFileName(port, taken),
                            'Could not allocate an asset file name',
                        )

                        staged.push({
                            record: {
                                assetId: page.assetId,
                                fileName,
                                mimeType: supplied.mimeType,
                                byteLength: supplied.bytes.byteLength,
                                contentHash: supplied.contentHash,
                            },
                            bytes: supplied.bytes,
                        })
                    } else {
                        throw new ManualStorageError(
                            'missing_bytes',
                            `Page ${page.pageId} has no stored or supplied image bytes`,
                        )
                    }
                }

                const referenced = new Set(prepared.session.pages.map((page) => page.assetId))
                const removed = (previous?.assets ?? []).filter((asset) => !referenced.has(asset.assetId))
                const stagedNames = new Set(staged.map((item) => item.record.fileName))

                // Only a save that writes new files needs the intent commit; a metadata-only save publishes once.
                const intent: Manifest =
                    staged.length === 0
                        ? current
                        : {
                              ...current,
                              pendingDeletes: [
                                  ...current.pendingDeletes,
                                  ...[...stagedNames].map((fileName: string): PendingDelete => ({
                                      fileName,
                                      manualId,
                                  })),
                              ],
                          }

                if (staged.length > 0) {
                    await io(() => writeManifest(port, intent), 'Could not record pending image files')
                }

                const entry: ManualEntry = {
                    manualId,
                    session: prepared.session,
                    assets: [...kept, ...staged.map((item) => item.record)],
                }
                const manuals =
                    index >= 0
                        ? current.manuals.map((item, position) => (position === index ? entry : item))
                        : [...current.manuals, entry]
                const published: Manifest = {
                    version: MANIFEST_VERSION,
                    manuals,
                    pendingDeletes: [
                        ...intent.pendingDeletes.filter((pending) => !stagedNames.has(pending.fileName)),
                        ...removed.map((asset): PendingDelete => ({ fileName: asset.fileName, manualId })),
                    ],
                }

                let publicationAttempted = false

                try {
                    for (const item of staged) {
                        await io(
                            () => port.writeNewFile(item.record.fileName, item.bytes),
                            `Could not write the image file for asset ${item.record.assetId}`,
                        )
                    }

                    publicationAttempted = true
                    await io(() => writeManifest(port, published), 'Could not publish the manual')
                } catch (error: unknown) {
                    // A rejected publication may already be committed. Keep its bytes: either the published
                    // manifest owns them, or the prior intent still records them for safe later cleanup.
                    if (!publicationAttempted) {
                        for (const fileName of stagedNames) {
                            await deleteQuietly(port, fileName)
                        }
                    }

                    throw error
                }

                await drainPendingDeletes(port, published, new Set(removed.map((asset) => asset.fileName)))
            })
        },

        async loadManual(manualId: string): Promise<ManualSession | null> {
            const id = parseStoredId(manualId, 'manualId')

            return exclusive(async (): Promise<ManualSession | null> => {
                const manifest = await readManifest(port)

                return manifest.manuals.find((entry) => entry.manualId === id)?.session ?? null
            })
        },

        async listManuals(): Promise<ManualSummary[]> {
            return exclusive(async (): Promise<ManualSummary[]> => {
                const manifest = await readManifest(port)

                return manifest.manuals.map((entry) => summarize(entry.session))
            })
        },

        async deleteManual(manualId: string): Promise<void> {
            const id = parseStoredId(manualId, 'manualId')

            await exclusive(async (): Promise<void> => {
                await io(() => port.ensureDirectory(), 'Private manual storage directory is unavailable')

                const current = await drainPendingDeletes(port, await readManifest(port))
                const index = current.manuals.findIndex((entry) => entry.manualId === id)

                if (index < 0) {
                    return
                }

                const entry = current.manuals[index]

                if (entry === undefined) {
                    return
                }

                const next: Manifest = {
                    version: MANIFEST_VERSION,
                    manuals: current.manuals.filter(
                        (_item: ManualEntry, position: number): boolean => position !== index,
                    ),
                    pendingDeletes: [
                        ...current.pendingDeletes,
                        ...entry.assets.map((asset): PendingDelete => ({ fileName: asset.fileName, manualId: id })),
                    ],
                }

                await io(() => writeManifest(port, next), 'Could not remove the manual')
                await drainPendingDeletes(port, next, new Set(entry.assets.map((asset) => asset.fileName)))
            })
        },

        async loadPageAsset(assetId: string): Promise<StoredPageAsset | null> {
            const id = parseStoredId(assetId, 'assetId')

            return exclusive(async (): Promise<StoredPageAsset | null> => {
                const manifest = await readManifest(port)
                const record = manifest.manuals.flatMap((entry) => entry.assets).find((asset) => asset.assetId === id)

                if (record === undefined) {
                    return null
                }

                const bytes = await io(() => port.readFile(record.fileName), 'Could not read the stored image')

                if (bytes === null) {
                    throw corrupt('Stored image bytes are missing for a manual that still owns them')
                }

                return {
                    assetId: record.assetId,
                    mimeType: record.mimeType,
                    bytes: await verifyStoredBytes(bytes, record, digest),
                }
            })
        },
    }
}
