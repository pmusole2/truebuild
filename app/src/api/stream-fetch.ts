/** Streaming transport. Web and tests use the global fetch; native swaps in expo/fetch (see stream-fetch.native.ts). */
export type StreamFetch = (url: string, init: RequestInit) => Promise<Response>

export const streamFetch: StreamFetch = (url: string, init: RequestInit): Promise<Response> => fetch(url, init)
