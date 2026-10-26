import { useSyncExternalStore } from 'react'

/**
 * Memory-only connection to the owner-authenticated local backend. Nothing here is persisted: no storage, config,
 * environment, query string or log ever receives the token. A reload or app restart clears it.
 *
 * Every connect and clear advances a generation. Asynchronous work captures the generation it started under and may
 * only publish or clear while that generation is still current, so a reply for an earlier token can never change a
 * newer connection.
 */
export type SessionReport = {
    readonly model: 'configured' | 'unconfigured'
    // Epoch milliseconds, as reported by the frozen session wire.
    readonly expiresAt: number
}

export type ModelConnection = {
    readonly origin: string
    readonly token: string
    readonly generation: number
    // Null until an explicit session check; `configured` means a key is present, not that it was exercised.
    readonly session: SessionReport | null
}

type Listener = () => void

let current: ModelConnection | null = null
let generation = 0
const listeners = new Set<Listener>()

function emit(): void {
    for (const listener of listeners) {
        listener()
    }
}

export const modelConnectionStore = {
    get(): ModelConnection | null {
        return current
    },
    /** Identity of the latest connect or clear. Work started under an older value is stale. */
    currentGeneration(): number {
        return generation
    },
    subscribe(listener: Listener): () => void {
        listeners.add(listener)
        return (): void => {
            listeners.delete(listener)
        }
    },
    connect(origin: string, token: string): void {
        generation += 1
        current = { origin, token, generation, session: null }
        emit()
    },
    /** Publishes a session report only if the connection it was requested for is still the current one. */
    recordSession(startedGeneration: number, session: SessionReport): boolean {
        if (current === null || current.generation !== startedGeneration) {
            return false
        }
        current = { ...current, session }
        emit()
        return true
    },
    /** Clears only the connection that produced the rejected request; a newer connection is left alone. */
    clearIfCurrent(startedGeneration: number): boolean {
        if (current === null || current.generation !== startedGeneration) {
            return false
        }
        generation += 1
        current = null
        emit()
        return true
    },
    clear(): void {
        if (current !== null) {
            generation += 1
            current = null
            emit()
        }
    },
}

export function useModelConnection(): ModelConnection | null {
    return useSyncExternalStore(modelConnectionStore.subscribe, modelConnectionStore.get, modelConnectionStore.get)
}
