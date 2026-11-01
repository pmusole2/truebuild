import type { PieceBatchResult } from '@truebuild/contracts'
import { API_BASE_URL, API_SECRET, GENERATIVE_UI } from '../../config'
import { ModelApiClient } from '../../api/model-client'
import type { KeyValueStorage } from '../capture/library'
import { PieceRegistry } from './piece-registry'

/**
 * Device storage is loaded on first use. Importing the workflow must never evaluate the native key-value store, which is
 * unavailable in some test and preview hosts; a failed load is a failed read, and the registry then dispatches nothing.
 */
const lazyStorage: KeyValueStorage = {
    async getItem(key: string): Promise<string | null> {
        return (await import('../capture/device-storage')).deviceStorage.getItem(key)
    },
    async setItem(key: string, value: string): Promise<void> {
        return (await import('../capture/device-storage')).deviceStorage.setItem(key, value)
    },
    async removeItem(key: string): Promise<void> {
        return (await import('../capture/device-storage')).deviceStorage.removeItem(key)
    },
    async getAllKeys(): Promise<readonly string[]> {
        return (await import('../capture/device-storage')).deviceStorage.getAllKeys()
    },
}

/** Request ids only need to be unique per attempt; they are not secrets, so no random-UUID module is loaded here. */
let requestSequence = 0
const newRequestId = (): string => {
    requestSequence += 1
    return `pieces-${Date.now().toString(36)}-${requestSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Production manual piece registry. Device storage holds manifests and cutouts; the geometry client is wired only when
 * generative UI is on, so off makes no piece request and still reads what an earlier run stored.
 */
export function createPieces(): PieceRegistry {
    const client = new ModelApiClient({ baseUrl: API_BASE_URL, secret: API_SECRET })
    return new PieceRegistry({
        storage: lazyStorage,
        generate:
            GENERATIVE_UI === 'off'
                ? null
                : ({ request, pageUris }): Promise<PieceBatchResult | null> => client.pieceBatch(request, pageUris),
        newId: newRequestId,
    })
}
