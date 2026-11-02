export const AI_CONSENT_KEY = 'truebuild/ai-consent/v1'

export type ConsentStorage = {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
}
export type ConsentSnapshot = Readonly<{
    choice: 'accepted' | 'declined' | null
    visible: boolean
    saving: boolean
    error: string | null
}>

/** One local permission record. No upload may infer acceptance from a failed read or write. */
export class AiConsentStore {
    private state: ConsentSnapshot = { choice: null, visible: false, saving: false, error: null }
    private readonly listeners = new Set<() => void>()
    private readonly pending = new Set<(allowed: boolean) => void>()
    private restored: Promise<void> | undefined

    constructor(
        private readonly storage: ConsentStorage,
        private readonly developmentAcceptance: () => Promise<boolean> = async (): Promise<boolean> => false,
    ) {}

    readonly getSnapshot = (): ConsentSnapshot => this.state
    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return (): void => {
            this.listeners.delete(listener)
        }
    }

    private publish(next: Partial<ConsentSnapshot>): void {
        this.state = { ...this.state, ...next }
        this.listeners.forEach((listener) => listener())
    }

    restore(): Promise<void> {
        this.restored ??= (async (): Promise<void> => {
            try {
                if (await this.developmentAcceptance()) {
                    this.publish({ choice: 'accepted' })
                    return
                }
                const value = await this.storage.getItem(AI_CONSENT_KEY)
                this.publish({ choice: value === 'accepted' || value === 'declined' ? value : null })
            } catch {
                // An unreadable record is not permission.
            }
        })()
        return this.restored
    }

    async request(signal?: AbortSignal, promptAfterDecline = false): Promise<boolean> {
        await this.restore()
        if (signal?.aborted) return false
        if (this.state.choice === 'accepted') return true
        if (this.state.choice === 'declined' && !promptAfterDecline) return false
        this.publish({ visible: true, error: null })
        return new Promise<boolean>((resolve) => {
            const finish = (allowed: boolean): void => {
                this.pending.delete(finish)
                signal?.removeEventListener('abort', abort)
                resolve(allowed && signal?.aborted !== true)
            }
            const abort = (): void => finish(false)
            this.pending.add(finish)
            signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) abort()
        })
    }

    async choose(accepted: boolean): Promise<void> {
        if (this.state.saving) return
        this.publish({ saving: true, error: null })
        try {
            await this.storage.setItem(AI_CONSENT_KEY, accepted ? 'accepted' : 'declined')
        } catch {
            if (accepted) {
                this.publish({ saving: false, error: "We couldn't save your choice. Try again." })
                return
            }
        }
        this.publish({ choice: accepted ? 'accepted' : 'declined', visible: false, saving: false })
        for (const finish of [...this.pending]) finish(accepted)
    }
}
