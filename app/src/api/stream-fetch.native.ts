import { fetch as expoFetch } from 'expo/fetch'
import type { StreamFetch } from './stream-fetch'

/** Native response bodies stream through expo/fetch; the global fetch buffers them, which would hide early events. */
export type { StreamFetch } from './stream-fetch'

export const streamFetch: StreamFetch = (url: string, init: RequestInit): Promise<Response> =>
    expoFetch(url, init) as Promise<Response>
