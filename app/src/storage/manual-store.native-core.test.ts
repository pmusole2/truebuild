import type { ManualSession } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import { ManualStorageError } from './manual-store.core'
import { createNativeManualStore, type NativeStoragePort } from './manual-store.native-core'
import { assetFor, bytesFor, nodeDigest, pageFor, sessionOf } from './storage-test-fixtures'

const SAFE_FILE_NAME = /^[a-f0-9]{32}\.bin$/u

/**
 * In-memory port with failure injection at the boundaries that matter: directory setup, each file write, each
 * manifest commit (counted), and file deletion. Writes never overwrite, matching the port contract.
 */
class MemoryPort implements NativeStoragePort {
    manifest: string | null = null
    readonly files = new Map<string, Uint8Array<ArrayBuffer>>()
    readonly ids: string[] = []
    directoryAvailable = true
    writeFailureOn: number | null = null
    manifestFailureOn: number | null = null
    manifestCommittedFailureOn: number | null = null
    deleteFailures = false
    manifestWrites = 0
    fileWrites = 0
    private nextId = 0

    async ensureDirectory(): Promise<void> {
        if (!this.directoryAvailable) {
            throw new ManualStorageError('unavailable', 'directory unavailable')
        }
    }

    async readManifestText(): Promise<string | null> {
        await Promise.resolve()
        return this.manifest
    }

    async writeManifestText(text: string): Promise<void> {
        await Promise.resolve()
        this.manifestWrites += 1

        if (this.manifestWrites === this.manifestFailureOn) {
            throw new Error('injected manifest failure')
        }

        this.manifest = text

        if (this.manifestWrites === this.manifestCommittedFailureOn) {
            throw new Error('injected failure after manifest commit')
        }
    }

    async fileExists(fileName: string): Promise<boolean> {
        await Promise.resolve()
        return this.files.has(fileName)
    }

    async writeNewFile(fileName: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        await Promise.resolve()
        this.fileWrites += 1

        if (this.fileWrites === this.writeFailureOn) {
            throw new Error('injected file failure')
        }

        if (this.files.has(fileName)) {
            throw new Error('refusing to overwrite an existing file')
        }

        this.files.set(fileName, new Uint8Array(bytes))
    }

    async readFile(fileName: string): Promise<Uint8Array<ArrayBuffer> | null> {
        await Promise.resolve()
        const stored = this.files.get(fileName)
        return stored === undefined ? null : new Uint8Array(stored)
    }

    async deleteFile(fileName: string): Promise<void> {
        await Promise.resolve()

        if (this.deleteFailures) {
            throw new Error('injected delete failure')
        }

        this.files.delete(fileName)
    }

    randomId(): string {
        const scripted = this.ids.shift()

        if (scripted !== undefined) {
            return scripted
        }

        this.nextId += 1
        return this.nextId.toString(16).padStart(32, '0')
    }

    manifestJson(): {
        manuals: { manualId: string; assets: { fileName: string; assetId: string }[] }[]
        pendingDeletes: { fileName: string; manualId: string }[]
    } {
        if (this.manifest === null) {
            throw new Error('no manifest was written')
        }

        return JSON.parse(this.manifest)
    }
}

function createStore(port: MemoryPort): ReturnType<typeof createNativeManualStore> {
    return createNativeManualStore(port, nodeDigest)
}

async function sessionAndAsset(
    manualId: string,
    assetId: string,
    label: string,
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg',
): Promise<{ session: ManualSession; bytes: Uint8Array<ArrayBuffer> }> {
    const bytes = bytesFor(label, 80)
    const session = sessionOf(manualId, [await pageFor(`${manualId}-page`, assetId, bytes, mimeType)], {
        title: `Title ${manualId}`,
    })

    return { session, bytes }
}

describe('native manual store round trips', () => {
    it('persists a session and its image with the exact bytes and the recorded MIME type', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const { session, bytes } = await sessionAndAsset('n-round', 'asset-round', 'round', 'image/webp')

        await store.saveManual(session, [assetFor('asset-round', bytes, 'image/webp')])

        expect(await store.loadManual('n-round')).toEqual(session)
        expect(await store.loadPageAsset('asset-round')).toEqual({
            assetId: 'asset-round',
            mimeType: 'image/webp',
            bytes,
        })
        expect(await store.listManuals()).toEqual([
            {
                manualId: 'n-round',
                title: 'Title n-round',
                updatedAt: session.updatedAt,
                stepCount: 0,
                reviewStatus: 'unreviewed',
            },
        ])
    })

    it('stores files under generated names even when the caller identifier is a path', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const hostile = '../escape/../../outside'
        const { session, bytes } = await sessionAndAsset('n-path', hostile, 'path')

        await store.saveManual(session, [assetFor(hostile, bytes)])

        expect([...port.files.keys()].every((name: string): boolean => SAFE_FILE_NAME.test(name))).toBe(true)
        expect((await store.loadPageAsset(hostile))?.bytes).toEqual(bytes)
    })

    it('returns null for absent manuals and absent assets on a fresh install', async () => {
        const store = createStore(new MemoryPort())

        expect(await store.loadManual('none')).toBeNull()
        expect(await store.loadPageAsset('none')).toBeNull()
        expect(await store.listManuals()).toEqual([])
    })

    it('removes the replaced image file after publication and leaves no pending records', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const first = await sessionAndAsset('n-replace', 'old-asset', 'old')
        const second = await sessionAndAsset('n-replace', 'new-asset', 'new')

        await store.saveManual(first.session, [assetFor('old-asset', first.bytes)])
        await store.saveManual(second.session, [assetFor('new-asset', second.bytes)])

        expect(await store.loadPageAsset('old-asset')).toBeNull()
        expect(port.files.size).toBe(1)
        expect(port.manifestJson().pendingDeletes).toEqual([])
    })
})

describe('native manual store failure boundaries', () => {
    it('retains published image bytes when the manifest commits and then rejects', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const { session, bytes } = await sessionAndAsset('n-ambiguous', 'ambiguous-asset', 'ambiguous')

        // Intent commits first; publication commits second, but its acknowledgement is lost.
        port.manifestCommittedFailureOn = 2

        await expect(store.saveManual(session, [assetFor('ambiguous-asset', bytes)])).rejects.toMatchObject({
            code: 'io',
        })

        expect(await store.loadManual(session.manualId)).toEqual(session)
        expect((await store.loadPageAsset('ambiguous-asset'))?.bytes).toEqual(bytes)
        expect(port.files.size).toBe(1)

        port.manifestCommittedFailureOn = null
        await store.saveManual({ ...session, title: 'Recovered', revision: 2 })

        expect((await store.loadManual(session.manualId))?.title).toBe('Recovered')
        expect((await store.loadPageAsset('ambiguous-asset'))?.bytes).toEqual(bytes)
    })

    it('keeps the previous snapshot when an image write fails before publication', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const kept = await sessionAndAsset('n-write', 'kept', 'kept')

        await store.saveManual(kept.session, [assetFor('kept', kept.bytes)])

        const attempted = sessionOf(
            'n-write',
            [
                await pageFor('n-write-page', 'kept', kept.bytes),
                await pageFor('n-write-second', 'added', bytesFor('added', 81)),
            ],
            { title: 'Attempted', revision: 2 },
        )

        port.writeFailureOn = port.fileWrites + 1

        await expect(store.saveManual(attempted, [assetFor('added', bytesFor('added', 81))])).rejects.toMatchObject({
            code: 'io',
        })

        expect(await store.loadManual('n-write')).toEqual(kept.session)
        expect(await store.loadPageAsset('added')).toBeNull()
        expect((await store.loadPageAsset('kept'))?.bytes).toEqual(kept.bytes)
        expect(port.files.size).toBe(1)
    })

    it('keeps the previous snapshot when publication fails and reclaims staged files on the next operation', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const kept = await sessionAndAsset('n-publish', 'kept-p', 'kept-p')

        await store.saveManual(kept.session, [assetFor('kept-p', kept.bytes)])

        const addedBytes = bytesFor('added-p', 82)
        const attempted = sessionOf(
            'n-publish',
            [
                await pageFor('n-publish-page', 'kept-p', kept.bytes),
                await pageFor('n-publish-second', 'added-p', addedBytes),
            ],
            { title: 'Attempted', revision: 2 },
        )

        // The intent commit is write N+1; the publication commit is write N+2.
        port.manifestFailureOn = port.manifestWrites + 2

        await expect(store.saveManual(attempted, [assetFor('added-p', addedBytes)])).rejects.toMatchObject({
            code: 'io',
        })

        expect(await store.loadManual('n-publish')).toEqual(kept.session)
        expect(port.files.size).toBe(2)
        expect(port.manifestJson().pendingDeletes.length).toBe(1)

        await store.saveManual({ ...kept.session, title: 'Next', revision: 2 })

        expect(port.manifestJson().pendingDeletes).toEqual([])
        expect(port.files.size).toBe(1)
    })

    it('retains an owner for files that cannot be deleted and retries them later', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const doomed = await sessionAndAsset('n-doomed', 'doomed-asset', 'doomed')

        await store.saveManual(doomed.session, [assetFor('doomed-asset', doomed.bytes)])

        port.deleteFailures = true
        await store.deleteManual('n-doomed')

        expect(await store.loadManual('n-doomed')).toBeNull()
        expect(port.manifestJson().pendingDeletes).toEqual([
            { fileName: port.manifestJson().pendingDeletes[0]?.fileName, manualId: 'n-doomed' },
        ])
        expect(port.files.size).toBe(1)

        port.deleteFailures = false
        const survivor = await sessionAndAsset('n-survivor', 'survivor-asset', 'survivor')
        await store.saveManual(survivor.session, [assetFor('survivor-asset', survivor.bytes)])

        expect(port.manifestJson().pendingDeletes).toEqual([])
        expect(port.files.size).toBe(1)
        expect((await store.loadPageAsset('survivor-asset'))?.bytes).toEqual(survivor.bytes)
    })

    it('removes a manual and its images together and leaves other manuals unaffected', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const one = await sessionAndAsset('n-one', 'one-asset', 'one')
        const two = await sessionAndAsset('n-two', 'two-asset', 'two')

        await store.saveManual(one.session, [assetFor('one-asset', one.bytes)])
        await store.saveManual(two.session, [assetFor('two-asset', two.bytes)])
        await store.deleteManual('n-one')

        expect(await store.loadManual('n-one')).toBeNull()
        expect(await store.loadPageAsset('one-asset')).toBeNull()
        expect((await store.loadPageAsset('two-asset'))?.bytes).toEqual(two.bytes)
        expect(port.files.size).toBe(1)
    })

    it('allocates around a file that already uses the generated name and never touches it', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const collidingName = 'a'.repeat(32) + '.bin'
        const squatter = bytesFor('squatter', 16)

        port.files.set(collidingName, squatter)
        port.ids.push('a'.repeat(32))

        const { session, bytes } = await sessionAndAsset('n-collide', 'collide-asset', 'collide')

        await store.saveManual(session, [assetFor('collide-asset', bytes)])

        expect(port.files.get(collidingName)).toEqual(squatter)
        expect((await store.loadPageAsset('collide-asset'))?.bytes).toEqual(bytes)
        expect(port.manifestJson().pendingDeletes).toEqual([])
    })

    it('allocates around a name already recorded by another manual', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const first = await sessionAndAsset('n-taken-1', 'taken-1', 'taken-1')

        port.ids.push('b'.repeat(32))
        await store.saveManual(first.session, [assetFor('taken-1', first.bytes)])

        const second = await sessionAndAsset('n-taken-2', 'taken-2', 'taken-2')
        port.ids.push('b'.repeat(32))
        await store.saveManual(second.session, [assetFor('taken-2', second.bytes)])

        expect((await store.loadPageAsset('taken-1'))?.bytes).toEqual(first.bytes)
        expect((await store.loadPageAsset('taken-2'))?.bytes).toEqual(second.bytes)
        expect(port.files.size).toBe(2)
    })

    it('fails with a bounded number of allocation attempts and writes nothing when every candidate is taken', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const first = await sessionAndAsset('n-bound-1', 'bound-1', 'bound-1')

        port.ids.push('c'.repeat(32))
        await store.saveManual(first.session, [assetFor('bound-1', first.bytes)])

        const second = await sessionAndAsset('n-bound-2', 'bound-2', 'bound-2')
        port.ids.push(...Array.from({ length: 8 }, (): string => 'c'.repeat(32)))
        const manifestBefore = port.manifest

        await expect(store.saveManual(second.session, [assetFor('bound-2', second.bytes)])).rejects.toMatchObject({
            code: 'io',
        })

        expect(port.manifest).toBe(manifestBefore)
        expect(port.files.size).toBe(1)
    })

    it('fails before any mutation when the private directory is unavailable', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const { session, bytes } = await sessionAndAsset('n-dir', 'dir-asset', 'dir')

        port.directoryAvailable = false

        await expect(store.saveManual(session, [assetFor('dir-asset', bytes)])).rejects.toMatchObject({
            code: 'unavailable',
        })
        await expect(store.deleteManual('n-dir')).rejects.toMatchObject({ code: 'unavailable' })

        expect(port.manifest).toBeNull()
        expect(port.files.size).toBe(0)
    })
})

describe('native manual store ownership and integrity', () => {
    it('keeps exclusive asset ownership across manuals and cleans only the deleted owner', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const shared = await sessionAndAsset('n-owner', 'shared-n', 'shared-n')
        const intruder = sessionOf('n-intruder', [await pageFor('n-intruder-page', 'shared-n', shared.bytes)])

        await store.saveManual(shared.session, [assetFor('shared-n', shared.bytes)])

        await expect(store.saveManual(intruder, [assetFor('shared-n', shared.bytes)])).rejects.toMatchObject({
            code: 'asset_conflict',
        })
        await expect(store.saveManual(intruder)).rejects.toMatchObject({ code: 'asset_conflict' })

        await store.deleteManual('n-intruder')

        expect((await store.loadPageAsset('shared-n'))?.bytes).toEqual(shared.bytes)
    })

    it('fails closed on a corrupt index and never replaces it with an empty one', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        port.manifest = '{"version":1,"manuals":[{'

        await expect(store.listManuals()).rejects.toMatchObject({ code: 'corrupt' })
        await expect(store.loadManual('anything')).rejects.toMatchObject({ code: 'corrupt' })

        const { session, bytes } = await sessionAndAsset('n-corrupt', 'corrupt-asset', 'corrupt')

        await expect(store.saveManual(session, [assetFor('corrupt-asset', bytes)])).rejects.toMatchObject({
            code: 'corrupt',
        })
        expect(port.manifest).toBe('{"version":1,"manuals":[{')
    })

    it('rejects a structurally valid index whose asset records no longer match their pages', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const { session, bytes } = await sessionAndAsset('n-incoherent', 'incoherent-asset', 'incoherent')

        await store.saveManual(session, [assetFor('incoherent-asset', bytes)])

        const manifest = port.manifestJson()
        const withoutAssets = { ...manifest, manuals: manifest.manuals.map((entry) => ({ ...entry, assets: [] })) }
        port.manifest = JSON.stringify(withoutAssets)

        await expect(store.loadManual('n-incoherent')).rejects.toMatchObject({ code: 'corrupt' })
    })

    it('reports a missing image file for an owned asset as corruption rather than absence', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const { session, bytes } = await sessionAndAsset('n-missing', 'missing-asset', 'missing')

        await store.saveManual(session, [assetFor('missing-asset', bytes)])
        port.files.clear()

        await expect(store.loadPageAsset('missing-asset')).rejects.toMatchObject({ code: 'corrupt' })
    })

    it('rejects image bytes that no longer match their recorded hash', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const { session, bytes } = await sessionAndAsset('n-tamper', 'tamper-asset', 'tamper')

        await store.saveManual(session, [assetFor('tamper-asset', bytes)])
        const [fileName] = [...port.files.keys()]

        if (fileName === undefined) {
            throw new Error('expected one stored file')
        }

        port.files.set(fileName, bytesFor('altered', 80))

        await expect(store.loadPageAsset('tamper-asset')).rejects.toMatchObject({ code: 'corrupt' })
    })

    it('rejects invalid identifiers before touching the index', async () => {
        const port = new MemoryPort()
        const store = createStore(port)

        await expect(store.loadManual('')).rejects.toMatchObject({ code: 'invalid_input' })
        await expect(store.loadPageAsset('')).rejects.toMatchObject({ code: 'invalid_input' })
        expect(port.manifest).toBeNull()
    })

    it('serializes overlapping saves so neither manual is lost', async () => {
        const port = new MemoryPort()
        const store = createStore(port)
        const first = await sessionAndAsset('n-par-1', 'par-1', 'par-1')
        const second = await sessionAndAsset('n-par-2', 'par-2', 'par-2')

        await Promise.all([
            store.saveManual(first.session, [assetFor('par-1', first.bytes)]),
            store.saveManual(second.session, [assetFor('par-2', second.bytes)]),
        ])

        expect((await store.listManuals()).map((summary) => summary.manualId).sort()).toEqual(['n-par-1', 'n-par-2'])
    })
})
