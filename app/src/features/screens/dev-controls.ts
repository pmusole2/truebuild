import { SCREEN_KINDS, type ScreenKind, type ScreensResult } from '@truebuild/contracts'
import type { ScreenClient } from './screen-store'

export type DevScenario = { readonly delayMs: number; readonly failKinds: ReadonlySet<ScreenKind> }

const MAX_DELAY_MS = 60_000

/**
 * Parses the development scenario controls. `delay` holds every screen generation for that long (to show the calm
 * pending state and the native hand-over after the grace period); `fail` is a comma list of screen kinds, or `all`,
 * that fail as an unavailable server would (to show each native fallback). Anything malformed is ignored, not guessed.
 */
export function parseDevScenario(delay: string | undefined, fail: string | undefined): DevScenario | null {
    const delayMs = Number(delay)
    const hold = Number.isSafeInteger(delayMs) && delayMs > 0 && delayMs <= MAX_DELAY_MS ? delayMs : 0
    const listed = (fail ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
    const kinds = new Set<ScreenKind>(
        listed.includes('all') ? SCREEN_KINDS : SCREEN_KINDS.filter((kind) => listed.includes(kind)),
    )
    return hold === 0 && kinds.size === 0 ? null : { delayMs: hold, failKinds: kinds }
}

/**
 * Wraps a screens client for evidence runs. Only a development build ever calls this; a production build is never
 * wrapped. It changes timing and availability and nothing else: no document is edited and no request is added.
 */
export function withDevScenario(client: ScreenClient, scenario: DevScenario | null): ScreenClient {
    if (scenario === null) return client
    return {
        screens: async (request, context): Promise<ScreensResult> => {
            if (request.op !== 'generate') return client.screens(request, context)
            if (scenario.delayMs > 0) {
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, scenario.delayMs)
                    context.signal?.addEventListener(
                        'abort',
                        () => {
                            clearTimeout(timer)
                            resolve()
                        },
                        { once: true },
                    )
                })
            }
            if (scenario.failKinds.has(request.kind)) {
                return {
                    status: 'unavailable',
                    requestId: context.requestId,
                    binding: null,
                    code: 'provider_error',
                    retryable: true,
                }
            }
            return client.screens(request, context)
        },
    }
}
