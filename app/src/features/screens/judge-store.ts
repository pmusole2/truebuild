import type { OnboardingStorage } from '../onboarding/onboarding-store'

/**
 * The judge layer's one preference: whether to show how a screen was built. Device-only. It is never sent to the
 * server, never part of any request, and defaults to off, so a person who never opens the judge entry sees no change.
 */
export const JUDGE_STORAGE_KEY = 'truebuild/judge/v1'

export type JudgeSnapshot = Readonly<{ ready: boolean; showBuilt: boolean }>

export type JudgeStore = {
    restore(): Promise<void>
    setShowBuilt(on: boolean): void
    subscribe(listener: () => void): () => void
    getSnapshot(): JudgeSnapshot
}

function readShowBuilt(value: string | null): boolean {
    if (value === null) return false
    try {
        const parsed: unknown = JSON.parse(value)
        return (
            typeof parsed === 'object' &&
            parsed !== null &&
            'version' in parsed &&
            parsed.version === 1 &&
            'showBuilt' in parsed &&
            parsed.showBuilt === true
        )
    } catch {
        return false
    }
}

/** Same key-value pattern as onboarding: a failed read is "off", a failed write keeps the choice for this session. */
export function createJudgeStore(storage: OnboardingStorage): JudgeStore {
    let snapshot: JudgeSnapshot = Object.freeze({ ready: false, showBuilt: false })
    let restoration: Promise<void> | undefined
    let touched = false
    let writes: Promise<void> = Promise.resolve()
    const listeners = new Set<() => void>()
    const publish = (next: JudgeSnapshot): void => {
        snapshot = Object.freeze(next)
        for (const listener of listeners) listener()
    }
    return {
        restore(): Promise<void> {
            restoration ??= Promise.resolve().then(async (): Promise<void> => {
                const stored = await storage.getItem(JUDGE_STORAGE_KEY).then(readShowBuilt, (): boolean => false)
                // A choice made before the read finished is newer than the stored one.
                publish({ ready: true, showBuilt: touched ? snapshot.showBuilt : stored })
            })
            return restoration
        },
        setShowBuilt(on): void {
            touched = true
            publish({ ready: snapshot.ready, showBuilt: on })
            writes = writes
                .then(() => storage.setItem(JUDGE_STORAGE_KEY, JSON.stringify({ version: 1, showBuilt: on })))
                .catch((): void => undefined)
        },
        subscribe(listener): () => void {
            listeners.add(listener)
            return (): void => {
                listeners.delete(listener)
            }
        },
        getSnapshot: (): JudgeSnapshot => snapshot,
    }
}
