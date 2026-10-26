import { manualSessionSchema, type ManualSession } from '@truebuild/contracts'
import { z } from 'zod'
import {
    MAX_ASSET_BYTES,
    ManualStorageError,
    digestToHex,
    isSyntheticPage,
    parseStoredId,
    prepareSave,
    summarize,
    verifyStoredBytes,
    type PreparedSave,
} from './manual-store.core'
import type { ManualStore, ManualSummary, StoredPageAsset } from './manual-store.types'

const DB_NAME = 'truebuild'
const DB_VERSION = 1
const SESSIONS_STORE = 'sessions'
const ASSETS_STORE = 'assets'
const OWNER_INDEX = 'manualId'

const sessionRecordSchema = z.strictObject({ manualId: z.string().min(1), session: z.unknown() })

const assetRecordSchema = z
    .strictObject({
        assetId: z.string().min(1),
        manualId: z.string().min(1),
        mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        byteLength: z.number().int().min(1).max(MAX_ASSET_BYTES),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
        bytes: z.instanceof(Uint8Array),
    })
    .superRefine((record, ctx): void => {
        if (record.bytes.byteLength !== record.byteLength) {
            ctx.addIssue({ code: 'custom', message: 'Stored byte length does not match its metadata' })
        }
    })

type AssetRecord = z.infer<typeof assetRecordSchema>

interface Stores {
    readonly sessions: IDBObjectStore
    readonly assets: IDBObjectStore
}

function corrupt(message: string, cause?: unknown): ManualStorageError {
    return new ManualStorageError('corrupt', message, cause === undefined ? undefined : { cause })
}

function request<T>(pending: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject): void => {
        pending.onsuccess = (): void => resolve(pending.result)
        pending.onerror = (): void => {
            reject(new ManualStorageError('io', 'Local database request failed', { cause: pending.error }))
        }
    })
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject): void => {
        const factory: IDBFactory | undefined = globalThis.indexedDB

        if (factory === undefined) {
            reject(new ManualStorageError('unavailable', 'IndexedDB is not available in this environment'))
            return
        }

        const pending = factory.open(DB_NAME, DB_VERSION)

        pending.onupgradeneeded = (): void => {
            const database = pending.result
            database.createObjectStore(SESSIONS_STORE, { keyPath: 'manualId' })
            database.createObjectStore(ASSETS_STORE, { keyPath: 'assetId' }).createIndex(OWNER_INDEX, OWNER_INDEX)
        }
        pending.onsuccess = (): void => resolve(pending.result)
        pending.onerror = (): void => {
            reject(new ManualStorageError('unavailable', 'Could not open local database', { cause: pending.error }))
        }
    })
}

async function withDatabase<T>(use: (database: IDBDatabase) => Promise<T>): Promise<T> {
    const database = await openDatabase()

    try {
        return await use(database)
    } finally {
        database.close()
    }
}

/**
 * Runs one transaction over both stores. The transaction commits only after `work` resolves and settles once:
 * a rejected `work` aborts it and the original error is preserved; a transaction abort (including one raised by a
 * failed request) rejects with its recorded cause. `work` must await only IndexedDB requests, because awaiting any
 * other promise lets the browser commit the transaction early.
 */
function runTransaction<T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    work: (stores: Stores) => Promise<T>,
): Promise<T> {
    return new Promise<T>((resolve, reject): void => {
        let transaction: IDBTransaction

        try {
            transaction = database.transaction([SESSIONS_STORE, ASSETS_STORE], mode)
        } catch (error: unknown) {
            reject(new ManualStorageError('unavailable', 'Could not start a local transaction', { cause: error }))
            return
        }

        let failure: { readonly error: unknown } | null = null
        let outcome: { readonly value: T } | null = null
        let settled = false
        const settle = (action: () => void): void => {
            if (!settled) {
                settled = true
                action()
            }
        }

        transaction.oncomplete = (): void => {
            settle((): void => {
                if (failure !== null) {
                    reject(failure.error)
                } else if (outcome !== null) {
                    resolve(outcome.value)
                } else {
                    reject(new ManualStorageError('io', 'Local transaction completed before its work finished'))
                }
            })
        }
        transaction.onabort = (): void => {
            settle((): void => {
                reject(
                    failure?.error ??
                        new ManualStorageError('io', 'Local transaction was aborted', { cause: transaction.error }),
                )
            })
        }

        work({
            sessions: transaction.objectStore(SESSIONS_STORE),
            assets: transaction.objectStore(ASSETS_STORE),
        }).then(
            (value: T): void => {
                outcome = { value }
            },
            (error: unknown): void => {
                failure = { error }

                try {
                    transaction.abort()
                } catch {
                    // The transaction is already finishing or finished, so there is nothing left to roll back.
                }
            },
        )
    })
}

function parseSessionRecord(raw: unknown): ManualSession {
    const record = sessionRecordSchema.safeParse(raw)

    if (!record.success) {
        throw corrupt('Stored manual record has an invalid shape', record.error)
    }

    const session = manualSessionSchema.safeParse(record.data.session)

    if (!session.success || session.data.manualId !== record.data.manualId) {
        throw corrupt('Stored manual failed validation', session.success ? undefined : session.error)
    }

    return session.data
}

function parseAssetRecord(raw: unknown): AssetRecord {
    const record = assetRecordSchema.safeParse(raw)

    if (!record.success) {
        throw corrupt('Stored image record failed validation', record.error)
    }

    return record.data
}

async function readSession(sessions: IDBObjectStore, manualId: string): Promise<ManualSession | null> {
    const raw = await request(sessions.get(manualId))

    if (raw === undefined) {
        return null
    }

    const session = parseSessionRecord(raw)

    if (session.manualId !== manualId) {
        throw corrupt('Stored manual is filed under a different identifier')
    }

    return session
}

async function readAsset(assets: IDBObjectStore, assetId: string): Promise<AssetRecord | null> {
    const raw = await request(assets.get(assetId))

    if (raw === undefined) {
        return null
    }

    const record = parseAssetRecord(raw)

    if (record.assetId !== assetId) {
        throw corrupt('Stored image is filed under a different identifier')
    }

    return record
}

function assetConflict(message: string): ManualStorageError {
    return new ManualStorageError('asset_conflict', message)
}

/**
 * Publishes one validated snapshot. Every ownership and retained-byte check reads the committed state inside this
 * transaction, so a rejection or failed write leaves the previous session and its images exactly as they were.
 */
async function writeSnapshot(stores: Stores, prepared: PreparedSave): Promise<void> {
    const { session } = prepared
    const manualId = session.manualId

    // Fail closed on corrupt prior metadata instead of overwriting it.
    await readSession(stores.sessions, manualId)

    const referenced = new Set<string>()
    const newRecords: AssetRecord[] = []

    for (const page of session.pages) {
        if (isSyntheticPage(manualId, page)) {
            continue
        }

        referenced.add(page.assetId)

        const existing = await readAsset(stores.assets, page.assetId)

        if (existing !== null && existing.manualId !== manualId) {
            throw assetConflict(`Asset for page ${page.pageId} is owned by another manual`)
        }

        const supplied = prepared.assets.get(page.assetId)

        if (supplied !== undefined) {
            if (existing === null) {
                newRecords.push({
                    assetId: page.assetId,
                    manualId,
                    mimeType: supplied.mimeType,
                    byteLength: supplied.bytes.byteLength,
                    contentHash: supplied.contentHash,
                    bytes: supplied.bytes,
                })
            } else if (existing.contentHash !== supplied.contentHash || existing.mimeType !== supplied.mimeType) {
                throw assetConflict(`Asset for page ${page.pageId} already has different stored bytes`)
            }
            continue
        }

        if (existing === null) {
            throw new ManualStorageError('missing_bytes', `Page ${page.pageId} has no stored or supplied image bytes`)
        }

        if (existing.contentHash !== page.contentHash || existing.mimeType !== page.mimeType) {
            throw assetConflict(`Stored bytes for page ${page.pageId} no longer match its metadata`)
        }
    }

    const ownedKeys = await request(stores.assets.index(OWNER_INDEX).getAllKeys(manualId))
    const keys = z.array(z.string()).safeParse(ownedKeys)

    if (!keys.success) {
        throw corrupt('Stored image index is invalid', keys.error)
    }

    for (const key of keys.data) {
        if (!referenced.has(key)) {
            await request(stores.assets.delete(key))
        }
    }

    for (const record of newRecords) {
        await request(stores.assets.put(record))
    }

    await request(stores.sessions.put({ manualId, session }))
}

async function digestBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    return digestToHex(await crypto.subtle.digest('SHA-256', bytes))
}

export const webManualStore: ManualStore = {
    async saveManual(session: ManualSession, assets: readonly StoredPageAsset[] = []): Promise<void> {
        const prepared = await prepareSave(session, assets, digestBytes)

        await withDatabase((database: IDBDatabase): Promise<void> => {
            return runTransaction(database, 'readwrite', (stores: Stores): Promise<void> => {
                return writeSnapshot(stores, prepared)
            })
        })
    },

    async loadManual(manualId: string): Promise<ManualSession | null> {
        const id = parseStoredId(manualId, 'manualId')

        return withDatabase((database: IDBDatabase): Promise<ManualSession | null> => {
            return runTransaction(database, 'readonly', (stores: Stores): Promise<ManualSession | null> => {
                return readSession(stores.sessions, id)
            })
        })
    },

    async listManuals(): Promise<ManualSummary[]> {
        return withDatabase((database: IDBDatabase): Promise<ManualSummary[]> => {
            return runTransaction(database, 'readonly', async (stores: Stores): Promise<ManualSummary[]> => {
                const rows = z.array(z.unknown()).safeParse(await request(stores.sessions.getAll()))

                if (!rows.success) {
                    throw corrupt('Stored manual list is invalid', rows.error)
                }

                return rows.data.map((row: unknown): ManualSummary => summarize(parseSessionRecord(row)))
            })
        })
    },

    async deleteManual(manualId: string): Promise<void> {
        const id = parseStoredId(manualId, 'manualId')

        await withDatabase((database: IDBDatabase): Promise<void> => {
            return runTransaction(database, 'readwrite', async (stores: Stores): Promise<void> => {
                // Deletion does not parse stored records, so corrupt data can still be removed by its owner.
                const keys = z
                    .array(z.string())
                    .safeParse(await request(stores.assets.index(OWNER_INDEX).getAllKeys(id)))

                if (!keys.success) {
                    throw corrupt('Stored image index is invalid', keys.error)
                }

                for (const key of keys.data) {
                    await request(stores.assets.delete(key))
                }

                await request(stores.sessions.delete(id))
            })
        })
    },

    async loadPageAsset(assetId: string): Promise<StoredPageAsset | null> {
        const id = parseStoredId(assetId, 'assetId')
        const record = await withDatabase((database: IDBDatabase): Promise<AssetRecord | null> => {
            return runTransaction(database, 'readonly', (stores: Stores): Promise<AssetRecord | null> => {
                return readAsset(stores.assets, id)
            })
        })

        if (record === null) {
            return null
        }

        const bytes = await verifyStoredBytes(record.bytes, record, digestBytes)

        return { assetId: record.assetId, mimeType: record.mimeType, bytes }
    },
}
