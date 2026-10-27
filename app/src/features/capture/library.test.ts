import { describe, expect, it } from 'vitest'
import { createDemoManual } from '@truebuild/contracts'
import { LibraryStorage, type KeyValueStorage } from './library'

function memory(): KeyValueStorage & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
        data,
        getItem: async (key): Promise<string | null> => data.get(key) ?? null,
        setItem: async (key, value): Promise<void> => {
            data.set(key, value)
        },
        removeItem: async (key): Promise<void> => {
            data.delete(key)
        },
        getAllKeys: async (): Promise<string[]> => [...data.keys()],
    }
}
const digest = async (bytes: Uint8Array): Promise<string> => {
    const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
    return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('')
}

async function entry(): Promise<Parameters<LibraryStorage['save']>[0][number]> {
    const session = createDemoManual()
    const bytes = new Uint8Array([1, 4, 9])
    session.pages[0]!.contentHash = await digest(bytes)
    return { session, stepIndex: 0, completedStepIds: [], capture: null }
}

describe('durable manual library', () => {
    it('starts empty and restores usable bytes with metadata after a new storage instance', async () => {
        const kv = memory()
        const first = new LibraryStorage(kv, digest)
        expect((await first.restore()).entries).toEqual([])
        const manual = await entry()
        await first.save([manual], [{ assetId: manual.session.pages[0]!.assetId, bytes: new Uint8Array([1, 4, 9]) }])
        const second = new LibraryStorage(kv, digest)
        expect((await second.restore()).entries).toEqual([manual])
        expect(await second.readAsset(manual.session.pages[0]!)).toEqual(new Uint8Array([1, 4, 9]))
    })

    it('chunks a large image and cleans removed assets only after a durable manifest commit', async () => {
        const kv = memory()
        const store = new LibraryStorage(kv, digest)
        const manual = await entry()
        const bytes = new Uint8Array(300_000).fill(24)
        manual.session.pages[0]!.contentHash = await digest(bytes)
        await store.save([manual], [{ assetId: manual.session.pages[0]!.assetId, bytes }])
        expect([...kv.data.entries()].filter(([key]) => key.includes('/bytes/')).length).toBeGreaterThan(1)
        expect(Math.max(...[...kv.data.values()].map((value) => value.length))).toBeLessThanOrEqual(65_536)
        expect(await store.readAsset(manual.session.pages[0]!)).toEqual(bytes)
        await store.save([])
        expect([...kv.data.keys()].some((key) => key.includes('/bytes/'))).toBe(false)
    })

    it('drops corrupted bytes rather than publishing a reviewed manual with unusable sources', async () => {
        const kv = memory()
        const store = new LibraryStorage(kv, digest)
        const manual = await entry()
        await store.save([manual], [{ assetId: manual.session.pages[0]!.assetId, bytes: new Uint8Array([1, 4, 9]) }])
        const key = [...kv.data.keys()].find((key) => key.includes('/bytes/'))!
        kv.data.set(key, 'AQEK')
        const restored = await new LibraryStorage(kv, digest).restore()
        expect(restored.entries).toEqual([])
        expect(restored.warning).toMatch(/could not be restored/)
    })

    it('schema-validates metadata and rejects oversized saves without overwriting the previous library', async () => {
        const kv = memory()
        kv.data.set('truebuild/library/v1', '{"version":9}')
        expect((await new LibraryStorage(kv, digest).restore()).warning).toMatch(/could not be restored/)
        const store = new LibraryStorage(memory(), digest)
        await expect(store.save([], [{ assetId: 'large', bytes: new Uint8Array(4_194_305) }])).rejects.toThrow()
    })

    it('does not remove assets or write a new manifest after a storage read failure', async () => {
        let writes = 0
        let removes = 0
        const inaccessible: KeyValueStorage = {
            getItem: async (): Promise<never> => {
                throw new Error('Storage not accessible')
            },
            setItem: async (): Promise<void> => {
                writes++
            },
            removeItem: async (): Promise<void> => {
                removes++
            },
            getAllKeys: async (): Promise<string[]> => ['truebuild/library/bytes/previous'],
        }
        const store = new LibraryStorage(inaccessible, digest)
        expect((await store.restore()).warning).not.toBeNull()
        await expect(store.save([])).rejects.toThrow('Storage unavailable')
        expect(writes).toBe(0)
        expect(removes).toBe(0)
    })

    it('keeps the prior manifest and assets usable when a metadata write fails', async () => {
        const kv = memory()
        const store = new LibraryStorage(kv, digest)
        const manual = await entry()
        await store.save([manual], [{ assetId: manual.session.pages[0]!.assetId, bytes: new Uint8Array([1, 4, 9]) }])
        const failed: KeyValueStorage = {
            ...kv,
            setItem: async (): Promise<void> => {
                throw new Error('disk')
            },
        }
        await expect(new LibraryStorage(failed, digest).save([])).rejects.toThrow()
        expect((await new LibraryStorage(kv, digest).restore()).entries).toEqual([manual])
    })
})
