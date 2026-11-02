import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Trusted monotonic start of the unit of work being timed (`performance.now()` at real admission: the request was
 * accepted and its body was about to be read; or a background unit began). The route sets it before any body, media
 * or prompt preparation so that `timeToProviderMs` counts all of that, and the provider reads it. Never client-supplied.
 */
export const admission = new AsyncLocalStorage<{ start: number }>()
