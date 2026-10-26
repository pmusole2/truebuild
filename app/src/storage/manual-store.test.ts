import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { createDemoManual, type ManualSession } from '@truebuild/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManualStorageError } from './manual-store.core'
import { webManualStore } from './manual-store.web'
import { assetFor, bytesFor, pageFor, sessionOf } from './storage-test-fixtures'

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    globalThis.IDBKeyRange = IDBKeyRange
})

afterEach(() => {
    vi.restoreAllMocks()
})

function openTruebuild(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject): void => {
        const request = globalThis.indexedDB.open('truebuild', 1)

        request.onsuccess = (): void => resolve(request.result)
        request.onerror = (): void => reject(request.error)
    })
}

/** Writes a raw record, bypassing the store, to simulate damage at rest. */
async function putRaw(storeName: 'sessions' | 'assets', value: unknown): Promise<void> {
    // The first store operation creates the schema on a fresh database; raw writes need it to exist.
    await webManualStore.listManuals()

    const database = await openTruebuild()

    try {
        await new Promise<void>((resolve, reject): void => {
            const transaction = database.transaction(storeName, 'readwrite')

            transaction.objectStore(storeName).put(value)
            transaction.oncomplete = (): void => resolve()
            transaction.onerror = (): void => reject(transaction.error)
            transaction.onabort = (): void => reject(transaction.error)
        })
    } finally {
        database.close()
    }
}

/** Each page's asset is `asset-<pageId>`; callers pass the same bytes they hand to saveManual. */
async function sessionWithPages(
    manualId: string,
    title: string,
    pages: readonly { readonly pageId: string; readonly bytes: Uint8Array<ArrayBuffer> }[],
): Promise<ManualSession> {
    const built = await Promise.all(pages.map(({ pageId, bytes }) => pageFor(pageId, `asset-${pageId}`, bytes)))

    return sessionOf(manualId, built, { title })
}

describe('web manual store round trips', () => {
    it('persists a session and each image with its exact bytes and MIME type', async () => {
        const jpeg = bytesFor('jpeg', 120)
        const png = bytesFor('png', 90)
        const webp = bytesFor('webp', 64)
        const session = sessionOf('m-types', [
            await pageFor('p-jpeg', 'a-jpeg', jpeg, 'image/jpeg'),
            await pageFor('p-png', 'a-png', png, 'image/png'),
            await pageFor('p-webp', 'a-webp', webp, 'image/webp'),
        ])

        await webManualStore.saveManual(session, [
            assetFor('a-jpeg', jpeg, 'image/jpeg'),
            assetFor('a-png', png, 'image/png'),
            assetFor('a-webp', webp, 'image/webp'),
        ])

        expect(await webManualStore.loadManual('m-types')).toEqual(session)
        expect(await webManualStore.loadPageAsset('a-png')).toEqual({
            assetId: 'a-png',
            mimeType: 'image/png',
            bytes: png,
        })
        expect(await webManualStore.loadPageAsset('a-webp')).toEqual({
            assetId: 'a-webp',
            mimeType: 'image/webp',
            bytes: webp,
        })
    })

    it('returns null for absent manuals and absent assets', async () => {
        expect(await webManualStore.loadManual('never-saved')).toBeNull()
        expect(await webManualStore.loadPageAsset('never-saved')).toBeNull()
        expect(await webManualStore.listManuals()).toEqual([])
    })

    it('persists the synthetic demo manual without bytes and exposes no demo image', async () => {
        const demo = createDemoManual()

        await webManualStore.saveManual(demo)

        expect(await webManualStore.loadManual(demo.manualId)).toEqual(demo)
        expect(await webManualStore.loadPageAsset('demo-asset-1')).toBeNull()
    })

    it('lists summaries and deletes a manual with its owned images while leaving others intact', async () => {
        const keepBytes = bytesFor('keep', 50)
        const dropBytes = bytesFor('drop', 60)
        const keep = sessionOf('m-keep', [await pageFor('kp', 'keep-asset', keepBytes)], { title: 'Keep' })
        const drop = sessionOf('m-drop', [await pageFor('dp', 'drop-asset', dropBytes)], { title: 'Drop' })

        await webManualStore.saveManual(keep, [assetFor('keep-asset', keepBytes)])
        await webManualStore.saveManual(drop, [assetFor('drop-asset', dropBytes)])

        expect(await webManualStore.listManuals()).toEqual(
            expect.arrayContaining([
                {
                    manualId: 'm-keep',
                    title: 'Keep',
                    updatedAt: keep.updatedAt,
                    stepCount: 0,
                    reviewStatus: 'unreviewed',
                },
                {
                    manualId: 'm-drop',
                    title: 'Drop',
                    updatedAt: drop.updatedAt,
                    stepCount: 0,
                    reviewStatus: 'unreviewed',
                },
            ]),
        )

        await webManualStore.deleteManual('m-drop')

        expect(await webManualStore.loadManual('m-drop')).toBeNull()
        expect(await webManualStore.loadPageAsset('drop-asset')).toBeNull()
        expect(await webManualStore.loadPageAsset('keep-asset')).toEqual({
            assetId: 'keep-asset',
            mimeType: 'image/jpeg',
            bytes: keepBytes,
        })
    })

    it('rejects an invalid identifier before touching storage', async () => {
        await expect(webManualStore.loadManual('   ')).rejects.toMatchObject({ code: 'invalid_input' })
        await expect(webManualStore.deleteManual('')).rejects.toMatchObject({ code: 'invalid_input' })
    })

    it('reports unavailable storage explicitly when IndexedDB is absent', async () => {
        Reflect.deleteProperty(globalThis, 'indexedDB')

        await expect(webManualStore.loadManual('m')).rejects.toMatchObject({ code: 'unavailable' })
        await expect(webManualStore.listManuals()).rejects.toBeInstanceOf(ManualStorageError)
    })
})

describe('web manual store ownership and retained bytes', () => {
    it('keeps retained bytes when the same manual is saved without re-supplying them', async () => {
        const bytes = bytesFor('retained', 70)
        const first = sessionOf('m-retain', [await pageFor('p1', 'a1', bytes)], { title: 'First' })

        await webManualStore.saveManual(first, [assetFor('a1', bytes)])
        await webManualStore.saveManual({ ...first, title: 'Second', revision: 2 })

        expect((await webManualStore.loadManual('m-retain'))?.title).toBe('Second')
        expect((await webManualStore.loadPageAsset('a1'))?.bytes).toEqual(bytes)
    })

    it('removes the images of pages dropped from the manual in the same save', async () => {
        const aBytes = bytesFor('pa', 40)
        const bBytes = bytesFor('pb', 44)
        const both = sessionOf('m-drop-page', [await pageFor('pa', 'a', aBytes), await pageFor('pb', 'b', bBytes)])

        await webManualStore.saveManual(both, [assetFor('a', aBytes), assetFor('b', bBytes)])
        await webManualStore.saveManual(sessionOf('m-drop-page', [await pageFor('pa', 'a', aBytes)], { revision: 2 }))

        expect(await webManualStore.loadPageAsset('b')).toBeNull()
        expect((await webManualStore.loadPageAsset('a'))?.bytes).toEqual(aBytes)
    })

    it('rejects a new page without bytes and leaves the stored snapshot untouched', async () => {
        const aBytes = bytesFor('stable', 33)
        const stored = sessionOf('m-atomic', [await pageFor('pa', 'a', aBytes)], { title: 'Stable' })

        await webManualStore.saveManual(stored, [assetFor('a', aBytes)])

        const attempted = sessionOf(
            'm-atomic',
            [await pageFor('pa', 'a', aBytes), await pageFor('pb', 'b', bytesFor('x', 9))],
            {
                title: 'Attempted',
                revision: 2,
            },
        )

        await expect(webManualStore.saveManual(attempted)).rejects.toMatchObject({ code: 'missing_bytes' })

        expect(await webManualStore.loadManual('m-atomic')).toEqual(stored)
        expect(await webManualStore.loadPageAsset('b')).toBeNull()
        expect((await webManualStore.loadPageAsset('a'))?.bytes).toEqual(aBytes)
    })

    it("refuses another manual's asset with or without bytes and keeps both owners intact", async () => {
        const shared = bytesFor('shared', 52)
        const owner = sessionOf('m-owner', [await pageFor('o', 'shared-asset', shared)])
        const intruder = sessionOf('m-intruder', [await pageFor('i', 'shared-asset', shared)])

        await webManualStore.saveManual(owner, [assetFor('shared-asset', shared)])

        await expect(webManualStore.saveManual(intruder, [assetFor('shared-asset', shared)])).rejects.toMatchObject({
            code: 'asset_conflict',
        })
        await expect(webManualStore.saveManual(intruder)).rejects.toMatchObject({ code: 'asset_conflict' })

        await webManualStore.deleteManual('m-intruder')

        expect((await webManualStore.loadPageAsset('shared-asset'))?.bytes).toEqual(shared)

        await webManualStore.deleteManual('m-owner')

        expect(await webManualStore.loadPageAsset('shared-asset')).toBeNull()
    })

    it('rejects changed page metadata for bytes already stored', async () => {
        const bytes = bytesFor('meta', 41)
        const stored = sessionOf('m-meta', [await pageFor('p', 'meta-asset', bytes)], { title: 'Original' })

        await webManualStore.saveManual(stored, [assetFor('meta-asset', bytes)])

        const changed = sessionOf('m-meta', [await pageFor('p', 'meta-asset', bytesFor('other', 41))], {
            title: 'Changed',
            revision: 2,
        })

        await expect(webManualStore.saveManual(changed)).rejects.toMatchObject({ code: 'asset_conflict' })
        expect((await webManualStore.loadManual('m-meta'))?.title).toBe('Original')
    })
})

describe('web manual store transactions', () => {
    it('rolls back a publication whose second write fails midway and keeps the previous snapshot', async () => {
        const aBytes = bytesFor('rb-a', 36)
        const bBytes = bytesFor('rb-b', 37)
        const previous = await sessionWithPages('m-rollback', 'Previous', [{ pageId: 'a', bytes: aBytes }])

        await webManualStore.saveManual(previous, [assetFor('asset-a', aBytes)])

        // Fail the second put of the next save: the new image has been written, the session has not.
        const database = await openTruebuild()
        const storePrototype: IDBObjectStore = Object.getPrototypeOf(
            database.transaction('assets', 'readonly').objectStore('assets'),
        )
        database.close()
        const originalPut = storePrototype.put

        let writes = 0
        vi.spyOn(storePrototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown): IDBRequest {
            writes += 1

            if (writes === 2) {
                throw new Error('injected write failure')
            }

            return originalPut.call(this, value)
        })

        const next = await sessionWithPages('m-rollback', 'Next', [
            { pageId: 'a', bytes: aBytes },
            { pageId: 'b', bytes: bBytes },
        ])

        await expect(webManualStore.saveManual(next, [assetFor('asset-b', bBytes)])).rejects.toThrow(
            'injected write failure',
        )
        vi.restoreAllMocks()

        expect((await webManualStore.loadManual('m-rollback'))?.title).toBe('Previous')
        expect(await webManualStore.loadPageAsset('asset-b')).toBeNull()
        expect((await webManualStore.loadPageAsset('asset-a'))?.bytes).toEqual(aBytes)
    })

    it('settles reads and writes when a stored record fails validation inside the transaction', async () => {
        await putRaw('sessions', { manualId: 'm-damaged', session: { broken: true } })

        await expect(webManualStore.loadManual('m-damaged')).rejects.toMatchObject({ code: 'corrupt' })
        await expect(webManualStore.listManuals()).rejects.toMatchObject({ code: 'corrupt' })
        await expect(webManualStore.saveManual(sessionOf('m-damaged', []))).rejects.toMatchObject({ code: 'corrupt' })

        // The failed transactions above must not have wedged the database for unrelated manuals.
        await webManualStore.saveManual(sessionOf('m-healthy', []))

        expect((await webManualStore.loadManual('m-healthy'))?.manualId).toBe('m-healthy')
    })

    it("does not reset damaged metadata when deleting by the owner's identifier", async () => {
        await putRaw('sessions', { manualId: 'm-to-remove', session: 'not a session' })

        await webManualStore.deleteManual('m-to-remove')

        expect(await webManualStore.loadManual('m-to-remove')).toBeNull()
    })

    it('rejects corrupted image bytes instead of returning them', async () => {
        const bytes = bytesFor('integrity', 48)

        await webManualStore.saveManual(sessionOf('m-integrity', [await pageFor('p', 'int-asset', bytes)]), [
            assetFor('int-asset', bytes),
        ])
        await putRaw('assets', {
            assetId: 'int-asset',
            manualId: 'm-integrity',
            mimeType: 'image/jpeg',
            byteLength: bytes.byteLength,
            contentHash: (await pageFor('p', 'int-asset', bytes)).contentHash,
            bytes: bytesFor('altered', 48),
        })

        await expect(webManualStore.loadPageAsset('int-asset')).rejects.toMatchObject({ code: 'corrupt' })
    })

    it('serializes concurrent saves of different manuals without losing either', async () => {
        const xBytes = bytesFor('x', 33)
        const yBytes = bytesFor('y', 34)
        const first = await sessionWithPages('m-parallel-1', 'One', [{ pageId: 'x', bytes: xBytes }])
        const second = await sessionWithPages('m-parallel-2', 'Two', [{ pageId: 'y', bytes: yBytes }])

        await Promise.all([
            webManualStore.saveManual(first, [assetFor('asset-x', xBytes)]),
            webManualStore.saveManual(second, [assetFor('asset-y', yBytes)]),
        ])

        const titles = (await webManualStore.listManuals()).map((summary) => summary.title).sort()

        expect(titles).toEqual(['One', 'Two'])
    })
})
