import { createContext, useContext, type ReactElement, type ReactNode } from 'react'
import { composeNativeMeterMarkers, parseNativeMeterMarkers } from './native-meter-markers'
/** Render-origin inheritance. Renderer sets this per validated node; owned UI hosts read it when no explicit nativeID. Meter parses the `truebuild-render-origin:` segment of nativeID ('|'-joined). */
export type RenderOrigin = 'generated' | 'fallback' | 'shell'
export const RENDER_ORIGIN_NAMESPACE = 'truebuild-render-origin'
export function originId(origin: RenderOrigin): string {
    return `${RENDER_ORIGIN_NAMESPACE}:${origin}`
}
/**
 * Strict origin parse (delegates to the native-meter-markers parser): every reserved segment is
 * validated first, so a later invalid or conflicting segment rejects the whole id instead of being
 * hidden behind an earlier valid origin. Invalid provenance throws before a caller can append inherited credit.
 */
export function parseOrigin(nativeID: string | undefined): RenderOrigin | null {
    if (!nativeID) return null
    return parseNativeMeterMarkers(nativeID).origin
}
/** Join trusted segments with '|', deduped, order preserved, composed through the strict marker helper. */
export function mergeNativeIds(...parts: readonly (string | undefined | null)[]): string | undefined {
    const present = parts.filter((p): p is string => typeof p === 'string' && p !== '')
    if (present.length === 0) return undefined
    return composeNativeMeterMarkers(...present)
}
export function withOriginSegment(nativeID: string | undefined, origin: RenderOrigin): string {
    return composeNativeMeterMarkers(nativeID, originId(origin))
}
const Ctx = createContext<RenderOrigin | null>(null)
export function RenderOriginProvider({
    origin,
    children,
}: {
    origin: RenderOrigin
    children: ReactNode
}): ReactElement {
    return <Ctx.Provider value={origin}>{children}</Ctx.Provider>
}
export function useRenderOrigin(): RenderOrigin | null {
    return useContext(Ctx)
}
/** Explicit nativeID wins (origin segment appended if absent); else inherited origin; else undefined. */
export function useOriginNativeId(explicit?: string): string | undefined {
    const inherited = useContext(Ctx)
    if (explicit) return inherited && !parseOrigin(explicit) ? withOriginSegment(explicit, inherited) : explicit
    return inherited ? originId(inherited) : undefined
}
