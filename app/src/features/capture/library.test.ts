import { describe, expect, it, vi } from 'vitest'
import { createDemoManual } from '@truebuild/contracts'
import { ModelApiClient } from '../../api/model-client'
import { CaptureController } from './controller'
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

async function entry(): Promise<Parameters<LibraryStorage['save']>[0][number]> {
    const session = createDemoManual()
    const bytes = new Uint8Array([1, 4, 9])
    session.pages[0]!.contentHash = await digest(bytes)
    return { session, stepIndex: 0, completedStepIds: [], capture: null }
}

describe('durable manual library', () => {
    it('retains a retired asset until every pending verified read settles, then removes its chunks', async () => {
        const kv = memory()
        const store = new LibraryStorage(kv, digest)
        const manual = await entry()
        const bytes = new Uint8Array([1, 4, 9])
        await store.save([manual], [{ assetId: manual.session.pages[0]!.assetId, bytes }])
        const chunk = [...kv.data.keys()].find((key) => key.includes('/bytes/'))!
        const get = kv.getItem.bind(kv)
        const gates = [deferred(), deferred()]
        let entered = 0
        vi.spyOn(kv, 'getItem').mockImplementation(async (key) => {
            if (key === chunk && entered < gates.length) await gates[entered++]!.promise
            return get(key)
        })
        const first = store.readAsset(manual.session.pages[0]!)
        const second = store.readAsset(manual.session.pages[0]!)
        try {
            expect(entered).toBe(2)
            await store.save([])
            expect(kv.data.has(chunk)).toBe(true)
            gates[0]!.resolve()
            await expect(first).resolves.toEqual(bytes)
            await store.save([])
            expect(kv.data.has(chunk)).toBe(true)
            gates[1]!.resolve()
            await expect(second).resolves.toEqual(bytes)
            await vi.waitFor(() => expect(kv.data.has(chunk)).toBe(false))
            await expect(store.save([])).resolves.toBeUndefined()
            expect((await new LibraryStorage(kv, digest).restore()).readOnly).toBe(false)
        } finally {
            for (const gate of gates) gate.resolve()
            await Promise.allSettled([first, second])
        }
    })

    it('queues released-lease cleanup behind a re-reference commit and rechecks the current registry', async () => {
        const kv = memory()
        const store = new LibraryStorage(kv, digest)
        const manual = await entry()
        const bytes = new Uint8Array([1, 4, 9])
        await store.save([manual], [{ assetId: manual.session.pages[0]!.assetId, bytes }])
        const chunk = [...kv.data.keys()].find((key) => key.includes('/bytes/'))!
        const get = kv.getItem.bind(kv)
        const set = kv.setItem.bind(kv)
        const readGate = deferred()
        const writeGate = deferred()
        const writingManifest = deferred()
        vi.spyOn(kv, 'getItem').mockImplementation(async (key) => {
            if (key === chunk) await readGate.promise
            return get(key)
        })
        const reading = store.readAsset(manual.session.pages[0]!)
        let rereferencing: Promise<void> | undefined
        const remove = vi.spyOn(kv, 'removeItem')
        try {
            await store.save([])
            expect(kv.data.has(chunk)).toBe(true)
            vi.spyOn(kv, 'setItem').mockImplementation(async (key, value) => {
                if (key === 'truebuild/library/v1') {
                    writingManifest.resolve()
                    await writeGate.promise
                }
                await set(key, value)
            })
            rereferencing = store.save([manual], [{ assetId: manual.session.pages[0]!.assetId, bytes }])
            await writingManifest.promise
            readGate.resolve()
            // A read must settle without awaiting cleanup queued behind this blocked commit.
            await expect(reading).resolves.toEqual(bytes)
            expect(kv.data.has(chunk)).toBe(true)
            expect(remove).not.toHaveBeenCalledWith(chunk)
            writeGate.resolve()
            await rereferencing
            await store.save([manual])
            expect(remove).not.toHaveBeenCalledWith(chunk)
            await expect(store.readAsset(manual.session.pages[0]!)).resolves.toEqual(bytes)
            const restored = await new LibraryStorage(kv, digest).restore()
            expect(restored.readOnly).toBe(false)
            expect(restored.entries).toEqual([manual])
        } finally {
            readGate.resolve()
            writeGate.resolve()
            await Promise.allSettled([reading, ...(rereferencing === undefined ? [] : [rereferencing])])
        }
    })

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

    it('round-trips explicitly accepted step facts from a legacy session with preserved raw evidence', async () => {
        const kv = memory()
        const store = new LibraryStorage(kv, digest)
        const manual = await entry()
        // Sessions saved before extraction-page custody/provenance have neither optional field.
        expect(manual.session.extractionSourcePageIds).toBeUndefined()
        expect(manual.session.rawExtraction?.model).toBeUndefined()
        manual.session.reviewStatus = 'unreviewed'
        manual.session.reviewedSteps[0]!.orientation = { state: 'unknown', reason: 'Arrow is unreadable.' }
        manual.session.reviewedSteps[0]!.visibleChecks = []
        manual.session.rawExtraction!.steps[0]!.orientation = { state: 'unknown', reason: 'Arrow is unreadable.' }
        manual.session.rawExtraction!.steps[0]!.visibleChecks = []
        const raw = structuredClone(manual.session.rawExtraction)
        await store.save([manual], [{ assetId: manual.session.pages[0]!.assetId, bytes: new Uint8Array([1, 4, 9]) }])
        let id = 0
        const controller = new CaptureController({
            storage: store,
            client: new ModelApiClient({
                baseUrl: 'http://127.0.0.1:3001',
                secret: '',
                fetch: async (): Promise<never> => {
                    throw new Error('No model requests belong to local fact acceptance.')
                },
            }),
            normalize: async (): Promise<never> => {
                throw new Error('No image normalization belongs to fact acceptance.')
            },
            digest,
            id: (): string => `accepted-${++id}`,
        })
        try {
            await controller.restore()
            await controller.open(manual.session.manualId)
            expect(
                await controller.acceptStepFacts(
                    {
                        kind: 'manual',
                        manualId: manual.session.manualId,
                        revision: manual.session.revision,
                    },
                    'step-1',
                    {
                        orientation: { partId: 'side-panel', description: 'Groove faces inward.' },
                        visibleChecks: ['Groove is visible.', 'Panel stands upright.'],
                    },
                ),
            ).toBe(true)
            const restored = await new LibraryStorage(kv, digest).restore()
            expect(restored.readOnly).toBe(false)
            expect(restored.entries[0]).toEqual(controller.current)
            expect(restored.entries[0]!.session.rawExtraction).toEqual(raw)
            expect(restored.entries[0]!.session.reviewStatus).toBe('unreviewed')
        } finally {
            controller.dispose()
        }
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

    it.each(['digest', 'missing', 'encoded-length', 'decoded-length', 'encoding'])(
        'keeps %s damage read-only without pruning saved facts or chunks',
        async (damage) => {
            const kv = memory()
            const store = new LibraryStorage(kv, digest)
            const manual = await entry()
            await store.save(
                [manual],
                [{ assetId: manual.session.pages[0]!.assetId, bytes: new Uint8Array([1, 4, 9]) }],
            )
            const key = [...kv.data.keys()].find((key) => key.includes('/bytes/'))!
            if (damage === 'missing') kv.data.delete(key)
            else
                kv.data.set(
                    key,
                    damage === 'digest'
                        ? 'AQEK'
                        : damage === 'encoded-length'
                          ? 'AAA'
                          : damage === 'decoded-length'
                            ? 'AQ=='
                            : '!!!!',
                )
            const before = new Map(kv.data)
            const quarantined = new LibraryStorage(kv, digest)
            const restored = await quarantined.restore()
            expect(restored.entries).toEqual([manual])
            expect(restored.readOnly).toBe(true)
            await expect(quarantined.save([])).rejects.toThrow(/read.only/i)
            expect(kv.data).toEqual(before)
        },
    )

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

    it.each(['manifest', 'chunk', 'missing-manifest'])(
        'retains confirmed facts and photos after a transient %s read failure and refuses writes until explicit retry',
        async (failure) => {
            const kv = memory()
            const original = new LibraryStorage(kv, digest)
            const manual = await entry()
            manual.capture = {
                binding: {
                    kind: 'capture',
                    manualId: manual.session.manualId,
                    revision: manual.session.revision,
                    stepId: manual.session.reviewedSteps[0]!.stepId,
                    captureId: 'saved-photo',
                },
                page: manual.session.pages[0]!,
                capturedAt: 100,
            }
            await original.save(
                [manual],
                [{ assetId: manual.session.pages[0]!.assetId, bytes: new Uint8Array([1, 4, 9]) }],
            )
            let fail = false
            const failing: KeyValueStorage = {
                ...kv,
                getItem: async (key): Promise<string | null> => {
                    if (fail && failure === 'missing-manifest' && key === 'truebuild/library/v1') {
                        return null
                    }
                    if (
                        fail &&
                        (failure === 'manifest'
                            ? key === 'truebuild/library/v1'
                            : failure === 'chunk' && key.includes('/bytes/'))
                    ) {
                        throw new Error('Transient IO')
                    }
                    return kv.getItem(key)
                },
            }
            const store = new LibraryStorage(failing, digest)
            expect((await store.restore()).entries).toEqual([manual])
            const before = new Map(kv.data)
            fail = true
            const restored = await store.restore()
            expect(restored.entries).toEqual([manual])
            expect(restored.warning).toMatch(/retry/i)
            // Recovery of IO alone is not authority to clear a library whose restore failed.
            fail = false
            await expect(store.save([])).rejects.toThrow(/read.only|unavailable/i)
            expect(kv.data).toEqual(before)
            expect((await store.restore()).entries).toEqual([manual])
            await store.save([manual])
            expect(await store.readAsset(manual.capture.page)).toEqual(new Uint8Array([1, 4, 9]))
        },
    )

    it('locks writes if a previously restored image becomes unavailable', async () => {
        const kv = memory()
        const store = new LibraryStorage(kv, digest)
        const manual = await entry()
        await store.save([manual], [{ assetId: manual.session.pages[0]!.assetId, bytes: new Uint8Array([1, 4, 9]) }])
        await store.restore()
        const chunk = [...kv.data.keys()].find((key) => key.includes('/bytes/'))!
        kv.data.delete(chunk)
        const before = new Map(kv.data)
        await expect(store.readAsset(manual.session.pages[0]!)).rejects.toThrow()
        await expect(store.save([manual])).rejects.toThrow(/read.only/i)
        expect(kv.data).toEqual(before)
    })

    it('keeps orphan chunks read-only when a fresh instance has no manifest', async () => {
        const kv = memory()
        const manual = await entry()
        await new LibraryStorage(kv, digest).save(
            [manual],
            [{ assetId: manual.session.pages[0]!.assetId, bytes: new Uint8Array([1, 4, 9]) }],
        )
        kv.data.delete('truebuild/library/v1')
        const before = new Map(kv.data)
        const store = new LibraryStorage(kv, digest)
        expect(await store.restore()).toMatchObject({ entries: [], readOnly: true })
        await expect(store.save([])).rejects.toThrow(/read.only/i)
        expect(kv.data).toEqual(before)
    })

    it('keeps malformed manifest chunks untouched and refuses writes until explicit successful restore', async () => {
        const kv = memory()
        const manual = await entry()
        await new LibraryStorage(kv, digest).save(
            [manual],
            [{ assetId: manual.session.pages[0]!.assetId, bytes: new Uint8Array([1, 4, 9]) }],
        )
        const validManifest = kv.data.get('truebuild/library/v1')!
        kv.data.set('truebuild/library/v1', '{"version":9}')
        const before = new Map(kv.data)
        const store = new LibraryStorage(kv, digest)
        await store.restore()
        await expect(store.save([])).rejects.toThrow(/read.only|unavailable/i)
        expect(kv.data).toEqual(before)
        kv.data.set('truebuild/library/v1', validManifest)
        expect((await store.restore()).entries).toEqual([manual])
    })

    it('preserves the previous manifest through a mid-chunk write failure and reclaims only orphans on explicit recovery', async () => {
        const kv = memory()
        const manual = await entry()
        await new LibraryStorage(kv, digest).save(
            [manual],
            [{ assetId: manual.session.pages[0]!.assetId, bytes: new Uint8Array([1, 4, 9]) }],
        )
        const before = new Map(kv.data)
        let chunks = 0
        const failing: KeyValueStorage = {
            ...kv,
            setItem: async (key, value): Promise<void> => {
                if (key.includes('/bytes/') && ++chunks === 2) {
                    throw new Error('Disk write failed')
                }
                await kv.setItem(key, value)
            },
        }
        const store = new LibraryStorage(failing, digest)
        await store.restore()
        const bytes = new Uint8Array(100_000).fill(7)
        const page = {
            ...manual.session.pages[0]!,
            assetId: 'new-asset',
            pageId: 'new-page',
            contentHash: await digest(bytes),
        }
        const next = { ...manual, session: { ...manual.session, pages: [...manual.session.pages, page] } }
        await expect(store.save([next], [{ assetId: page.assetId, bytes }])).rejects.toThrow('Disk write failed')
        for (const [key, value] of before) {
            expect(kv.data.get(key)).toBe(value)
        }
        const orphan = [...kv.data.keys()].find((key) => key.includes('/new-asset/'))!
        expect(orphan).toBeDefined()
        const recovered = new LibraryStorage(kv, digest)
        expect((await recovered.restore()).entries).toEqual([manual])
        await recovered.save([manual])
        expect(kv.data.has(orphan)).toBe(false)
        expect(await recovered.readAsset(manual.session.pages[0]!)).toEqual(new Uint8Array([1, 4, 9]))
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
