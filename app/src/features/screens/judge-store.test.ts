import { describe, expect, it, vi } from 'vitest'
import { createJudgeStore, JUDGE_STORAGE_KEY } from './judge-store'
import type { OnboardingStorage } from '../onboarding/onboarding-store'

function memory(initial?: string): OnboardingStorage & { data: Map<string, string>; writes: [string, string][] } {
    const data = new Map<string, string>()
    if (initial !== undefined) data.set(JUDGE_STORAGE_KEY, initial)
    const writes: [string, string][] = []
    return {
        data,
        writes,
        getItem: async (key) => data.get(key) ?? null,
        setItem: async (key, value): Promise<void> => {
            writes.push([key, value])
            data.set(key, value)
        },
    }
}

describe('judge preference store', () => {
    it('is off by default and writes nothing until the person turns it on', async () => {
        const storage = memory()
        const store = createJudgeStore(storage)
        expect(store.getSnapshot()).toEqual({ ready: false, showBuilt: false })
        await store.restore()
        expect(store.getSnapshot()).toEqual({ ready: true, showBuilt: false })
        expect(storage.writes).toEqual([])
    })

    it('persists only on the device under its own key, and survives a restart', async () => {
        const storage = memory()
        const first = createJudgeStore(storage)
        await first.restore()
        first.setShowBuilt(true)
        await vi.waitFor(() => expect(storage.writes).toHaveLength(1))
        expect(storage.writes[0]![0]).toBe(JUDGE_STORAGE_KEY)
        expect(JSON.parse(storage.writes[0]![1])).toEqual({ version: 1, showBuilt: true })
        const second = createJudgeStore(storage)
        await second.restore()
        expect(second.getSnapshot().showBuilt).toBe(true)
        second.setShowBuilt(false)
        await vi.waitFor(() => expect(storage.writes).toHaveLength(2))
        const third = createJudgeStore(storage)
        await third.restore()
        expect(third.getSnapshot().showBuilt).toBe(false)
    })

    it.each(['not json', '{"version":2,"showBuilt":true}', '{"version":1,"showBuilt":"yes"}', 'null', '[]'])(
        'reads an unusable record (%s) as off',
        async (record) => {
            const store = createJudgeStore(memory(record))
            await store.restore()
            expect(store.getSnapshot().showBuilt).toBe(false)
        },
    )

    it('reads a failing store as off and keeps a choice made in the session when the write fails', async () => {
        const broken: OnboardingStorage = {
            getItem: async () => {
                throw new Error('storage unavailable')
            },
            setItem: async () => {
                throw new Error('storage full')
            },
        }
        const store = createJudgeStore(broken)
        await store.restore()
        expect(store.getSnapshot()).toEqual({ ready: true, showBuilt: false })
        store.setShowBuilt(true)
        await Promise.resolve()
        expect(store.getSnapshot().showBuilt).toBe(true)
    })

    it('lets a choice made before the stored value arrived win over the stale stored value', async () => {
        let release: (value: string | null) => void = () => undefined
        let asked = false
        const storage: OnboardingStorage = {
            getItem: () =>
                new Promise((resolve) => {
                    asked = true
                    release = resolve
                }),
            setItem: async () => undefined,
        }
        const store = createJudgeStore(storage)
        const restoring = store.restore()
        await vi.waitFor(() => expect(asked).toBe(true))
        await Promise.resolve()
        store.setShowBuilt(true)
        release(JSON.stringify({ version: 1, showBuilt: false }))
        await restoring
        expect(store.getSnapshot().showBuilt).toBe(true)
    })

    it('notifies subscribers and stops after unsubscribe', async () => {
        const store = createJudgeStore(memory())
        await store.restore()
        const listener = vi.fn()
        const stop = store.subscribe(listener)
        store.setShowBuilt(true)
        expect(listener).toHaveBeenCalledTimes(1)
        stop()
        store.setShowBuilt(false)
        expect(listener).toHaveBeenCalledTimes(1)
    })
})
