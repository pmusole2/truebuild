export const ONBOARDING_SCREENS = ['home', 'pages', 'quick-check', 'guide', 'camera'] as const
export type OnboardingScreen = (typeof ONBOARDING_SCREENS)[number]
export const ONBOARDING_STORAGE_KEY = 'truebuild/onboarding/v1'

export type OnboardingSnapshot = Readonly<{
    ready: boolean
    seen: readonly OnboardingScreen[]
    resetEpoch: number
}>

export interface OnboardingStorage {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
}

export function createOnboardingStore(storage: OnboardingStorage): {
    restore(): Promise<void>
    complete(screen: OnboardingScreen): void
    reset(): void
    subscribe(listener: () => void): () => void
    getSnapshot(): OnboardingSnapshot
} {
    let snapshot: OnboardingSnapshot = Object.freeze({ ready: false, seen: Object.freeze([]), resetEpoch: 0 })
    let restoration: Promise<void> | undefined
    let hydratedSeen: readonly OnboardingScreen[] = []
    let historyReadable = false
    let writes: Promise<void> = Promise.resolve()
    const listeners = new Set<() => void>()

    function publish(ready: boolean, seen: readonly OnboardingScreen[], resetEpoch: number): void {
        snapshot = Object.freeze({ ready, seen: Object.freeze([...seen]), resetEpoch })
        for (const listener of listeners) {
            listener()
        }
    }

    async function readHistory(): Promise<boolean> {
        let value: string | null
        try {
            value = await storage.getItem(ONBOARDING_STORAGE_KEY)
        } catch {
            // A failed read leaves the saved history unknown; do not replace it with this session alone.
            return false
        }
        try {
            hydratedSeen = value === null ? [] : readSeen(value)
        } catch {
            // A readable but malformed record has no usable history.
            hydratedSeen = []
        }
        historyReadable = true
        return true
    }

    function restore(): Promise<void> {
        restoration ??= Promise.resolve().then(async (): Promise<void> => {
            await readHistory()
            const seen = snapshot.resetEpoch === 0 ? [...new Set([...hydratedSeen, ...snapshot.seen])] : snapshot.seen
            publish(true, seen, snapshot.resetEpoch)
        })

        return restoration
    }

    function persist(): void {
        const pending = snapshot
        // Capture each operation before awaiting hydration. Only pre-reset operations
        // inherit persisted history; a reset and its successors must stay cleared.
        writes = writes
            .then(async (): Promise<void> => {
                await restore()
                if (pending.resetEpoch === 0 && !historyReadable) {
                    // Retry once for this queued completion. Repeated failure stays memory-only; a reset explicitly
                    // clears old history and does not need to read it first.
                    if (!(await readHistory())) return
                    if (snapshot.resetEpoch === 0) {
                        publish(true, [...new Set([...hydratedSeen, ...snapshot.seen])], snapshot.resetEpoch)
                    }
                }
                const seen = pending.resetEpoch === 0 ? [...new Set([...hydratedSeen, ...pending.seen])] : pending.seen
                await storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ version: 1, seen }))
            })
            .catch((): void => {
                // Keep the queue usable after either rejected or synchronous failures.
            })
    }

    return {
        restore,
        complete(screen): void {
            if (!isScreen(screen) || snapshot.seen.includes(screen)) {
                return
            }
            publish(snapshot.ready, [...snapshot.seen, screen], snapshot.resetEpoch)
            persist()
        },
        reset(): void {
            publish(snapshot.ready, [], snapshot.resetEpoch + 1)
            persist()
        },
        subscribe(listener): () => void {
            listeners.add(listener)

            return (): void => {
                listeners.delete(listener)
            }
        },
        getSnapshot(): OnboardingSnapshot {
            return snapshot
        },
    }
}

function isScreen(value: unknown): value is OnboardingScreen {
    return ONBOARDING_SCREENS.some((screen) => screen === value)
}

function readSeen(value: string): readonly OnboardingScreen[] {
    const parsed: unknown = JSON.parse(value)
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('version' in parsed) ||
        parsed.version !== 1 ||
        !('seen' in parsed) ||
        !Array.isArray(parsed.seen)
    ) {
        return []
    }

    return [...new Set(parsed.seen.filter(isScreen))]
}
