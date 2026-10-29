import { describe, expect, it, vi } from 'vitest'

import { createOnboardingStore, ONBOARDING_STORAGE_KEY, type OnboardingStorage } from './onboarding-store.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })

    return { promise, resolve, reject }
}

function memoryStorage(initial: string | null = null): {
    storage: OnboardingStorage
    records: Map<string, string>
    reads: string[]
    writes: [string, string][]
} {
    const records = new Map([['unrelated/manuals', 'preserve']])
    if (initial !== null) {
        records.set(ONBOARDING_STORAGE_KEY, initial)
    }
    const reads: string[] = []
    const writes: [string, string][] = []

    return {
        records,
        reads,
        writes,
        storage: {
            async getItem(key): Promise<string | null> {
                reads.push(key)

                return records.get(key) ?? null
            },
            async setItem(key, value): Promise<void> {
                writes.push([key, value])
                records.set(key, value)
            },
        },
    }
}

const record = (seen: string[]): string => JSON.stringify({ version: 1, seen })

// Exercises the storage port, not React/native or a mock of the store.
describe('onboarding persistence', () => {
    it('restores once, publishes stable snapshots, persists completion once across a new store, and owns one key', async () => {
        const disk = memoryStorage()
        const store = createOnboardingStore(disk.storage)
        const listener = vi.fn()
        const unsubscribe = store.subscribe(listener)
        const initial = store.getSnapshot()
        expect(initial).toEqual({ ready: false, seen: [], resetEpoch: 0 })
        expect(store.getSnapshot()).toBe(initial)
        const restoration = store.restore()
        expect(store.restore()).toBe(restoration)
        await restoration
        expect(store.getSnapshot()).toEqual({ ready: true, seen: [], resetEpoch: 0 })
        expect(listener).toHaveBeenCalledTimes(1)

        store.complete('home')
        const completed = store.getSnapshot()
        store.complete('home')
        expect(store.getSnapshot()).toBe(completed)
        expect(listener).toHaveBeenCalledTimes(2)
        await vi.waitFor(() => expect(disk.records.get(ONBOARDING_STORAGE_KEY)).toBe(record(['home'])))
        expect(disk.writes).toEqual([[ONBOARDING_STORAGE_KEY, record(['home'])]])
        unsubscribe()
        store.complete('guide')
        expect(listener).toHaveBeenCalledTimes(2)
        await vi.waitFor(() => expect(disk.writes).toHaveLength(2))

        const nextStore = createOnboardingStore(disk.storage)
        await nextStore.restore()
        expect(nextStore.getSnapshot().seen).toEqual(['home', 'guide'])
        nextStore.complete('home')
        expect(disk.writes).toHaveLength(2)
        expect(disk.reads).toEqual([ONBOARDING_STORAGE_KEY, ONBOARDING_STORAGE_KEY])
        expect([...disk.records.keys()]).toEqual(['unrelated/manuals', ONBOARDING_STORAGE_KEY])
        expect(disk.records.get('unrelated/manuals')).toBe('preserve')
    })

    it('merges completion made during hydration into memory and the persisted record', async () => {
        const loading = deferred<string | null>()
        const disk = memoryStorage()
        const store = createOnboardingStore({ ...disk.storage, getItem: (): Promise<string | null> => loading.promise })
        const restoration = store.restore()
        store.complete('camera')
        expect(store.getSnapshot().seen).toEqual(['camera'])
        loading.resolve(record(['home']))
        await restoration
        expect(new Set(store.getSnapshot().seen)).toEqual(new Set(['home', 'camera']))
        await vi.waitFor(() => expect(disk.writes).toHaveLength(1))
        expect(JSON.parse(disk.records.get(ONBOARDING_STORAGE_KEY) ?? '').seen).toEqual(['home', 'camera'])
    })

    it('fences reset against late hydration and writes completions after reset without restoring old seen screens', async () => {
        const loading = deferred<string | null>()
        const disk = memoryStorage()
        const store = createOnboardingStore({ ...disk.storage, getItem: (): Promise<string | null> => loading.promise })
        const restoration = store.restore()
        store.complete('pages')
        store.reset()
        expect(store.getSnapshot()).toEqual({ ready: false, seen: [], resetEpoch: 1 })
        store.complete('quick-check')
        loading.resolve(record(['home', 'guide']))
        await restoration
        expect(store.getSnapshot()).toEqual({ ready: true, seen: ['quick-check'], resetEpoch: 1 })
        await vi.waitFor(() => expect(disk.writes).toHaveLength(3))
        expect(disk.writes.map(([, value]) => JSON.parse(value).seen)).toEqual([
            ['home', 'guide', 'pages'],
            [],
            ['quick-check'],
        ])
        const secondStore = createOnboardingStore(disk.storage)
        await secondStore.restore()
        expect(secondStore.getSnapshot().seen).toEqual(['quick-check'])
    })

    it('serializes writes even when an earlier storage write remains pending', async () => {
        const firstWrite = deferred<void>()
        const values: string[] = []
        let persisted: string | null = null
        const store = createOnboardingStore({
            async getItem(): Promise<string | null> {
                return null
            },
            async setItem(_key, value): Promise<void> {
                values.push(value)
                if (values.length === 1) {
                    await firstWrite.promise
                }
                persisted = value
            },
        })
        await store.restore()
        store.complete('home')
        store.reset()
        store.complete('camera')
        expect(store.getSnapshot()).toEqual({ ready: true, seen: ['camera'], resetEpoch: 1 })
        await vi.waitFor(() => expect(values).toHaveLength(1))
        expect(persisted).toBeNull()
        firstWrite.resolve()
        await vi.waitFor(() => expect(persisted).toBe(record(['camera'])))
        expect(values).toEqual([record(['home']), record([]), record(['camera'])])
    })

    it('re-reads saved history after a failed hydration before persisting new completions', async () => {
        const disk = memoryStorage(record(['guide']))
        let reads = 0
        const store = createOnboardingStore({
            ...disk.storage,
            async getItem(key): Promise<string | null> {
                reads += 1
                if (reads === 1) throw new Error('temporarily unavailable')
                return disk.storage.getItem(key)
            },
        })
        await store.restore()
        expect(store.getSnapshot().ready).toBe(true)
        store.complete('home')
        expect(store.getSnapshot().seen).toEqual(['home'])
        await vi.waitFor(() => expect(disk.records.get(ONBOARDING_STORAGE_KEY)).toBe(record(['guide', 'home'])))
        expect(store.getSnapshot().seen).toEqual(['guide', 'home'])
        const nextStore = createOnboardingStore(disk.storage)
        await nextStore.restore()
        expect(nextStore.getSnapshot().seen).toEqual(['guide', 'home'])
        expect(disk.records.get('unrelated/manuals')).toBe('preserve')
    })

    it('keeps unknown saved history intact while reads fail, but permits an explicit reset', async () => {
        const disk = memoryStorage(record(['guide']))
        const getItem = vi.fn(async (): Promise<string | null> => {
            throw new Error('read unavailable')
        })
        const store = createOnboardingStore({ ...disk.storage, getItem })
        await store.restore()
        store.complete('home')
        store.complete('camera')
        await vi.waitFor(() => expect(getItem).toHaveBeenCalledTimes(3))
        expect(store.getSnapshot().seen).toEqual(['home', 'camera'])
        expect(disk.writes).toEqual([])
        expect(disk.records.get(ONBOARDING_STORAGE_KEY)).toBe(record(['guide']))
        store.reset()
        await vi.waitFor(() => expect(disk.records.get(ONBOARDING_STORAGE_KEY)).toBe(record([])))
        store.complete('pages')
        await vi.waitFor(() => expect(disk.records.get(ONBOARDING_STORAGE_KEY)).toBe(record(['pages'])))
    })

    it('contains rejected reads and writes, keeps actions synchronous, and resumes later queued writes', async () => {
        const disk = memoryStorage()
        let reads = 0
        let writes = 0
        const store = createOnboardingStore({
            async getItem(key): Promise<string | null> {
                reads += 1
                if (reads === 1) throw new Error('read unavailable')
                return disk.storage.getItem(key)
            },
            async setItem(key, value): Promise<void> {
                writes += 1
                if (writes === 1) {
                    throw new Error('write unavailable')
                }
                await disk.storage.setItem(key, value)
            },
        })
        await expect(store.restore()).resolves.toBeUndefined()
        expect(store.getSnapshot().ready).toBe(true)
        expect(store.complete('home')).toBeUndefined()
        expect(store.complete('guide')).toBeUndefined()
        expect(store.getSnapshot().seen).toEqual(['home', 'guide'])
        await vi.waitFor(() => expect(disk.records.get(ONBOARDING_STORAGE_KEY)).toBe(record(['home', 'guide'])))
        expect(store.reset()).toBeUndefined()
        expect(store.getSnapshot().seen).toEqual([])
        await vi.waitFor(() => expect(disk.records.get(ONBOARDING_STORAGE_KEY)).toBe(record([])))
        // Vitest fails the run on any unhandled rejection, including fire-and-forget writes.
    })

    it('contains synchronous storage throws and preserves a reset made before restore', async () => {
        const store = createOnboardingStore({
            getItem(): Promise<string | null> {
                throw new Error('sync read unavailable')
            },
            setItem(): Promise<void> {
                throw new Error('sync write unavailable')
            },
        })
        expect(store.reset()).toBeUndefined()
        await expect(store.restore()).resolves.toBeUndefined()
        expect(store.getSnapshot()).toEqual({ ready: true, seen: [], resetEpoch: 1 })
        expect(store.complete('home')).toBeUndefined()
        expect(store.getSnapshot().seen).toEqual(['home'])
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    it.each(['not json', 'null', '[]', '{"version":2,"seen":["home"]}', '{"version":1,"seen":"home"}'])(
        'ignores malformed or unsupported record %s without touching storage',
        async (stored) => {
            const disk = memoryStorage(stored)
            const store = createOnboardingStore(disk.storage)
            await store.restore()
            expect(store.getSnapshot()).toEqual({ ready: true, seen: [], resetEpoch: 0 })
            expect(disk.writes).toEqual([])
            expect(disk.records.get(ONBOARDING_STORAGE_KEY)).toBe(stored)
        },
    )

    it('filters unknown and duplicate persisted IDs without allowing unknown runtime IDs to alter the record', async () => {
        const disk = memoryStorage('{"version":1,"seen":["guide","future",null,"guide",3,"camera"]}')
        const store = createOnboardingStore(disk.storage)
        await store.restore()
        expect(store.getSnapshot().seen).toEqual(['guide', 'camera'])
        const before = store.getSnapshot()
        // @ts-expect-error Runtime inputs can still be invalid despite the public union.
        store.complete('future')
        expect(store.getSnapshot()).toBe(before)
        store.complete('pages')
        await vi.waitFor(() => expect(disk.writes).toHaveLength(1))
        expect(disk.records.get(ONBOARDING_STORAGE_KEY)).toBe(record(['guide', 'camera', 'pages']))
    })
})
