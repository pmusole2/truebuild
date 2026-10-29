/**
 * Render-origin markers. A host root whose structure and content were composed from a validated screen document carries
 * `nativeID="truebuild-render-origin:<origin>"`; a nested marker overrides its ancestor, and anything unmarked is the
 * native shell. The renderer assigns these; a document can never label itself. Markers go on existing roots only, never
 * on wrappers added to raise a count.
 */
export type RenderOrigin = 'generated' | 'fallback' | 'shell'

export const RENDER_ORIGIN_NAMESPACE = 'truebuild-render-origin'

export function originId(origin: RenderOrigin): string {
    return `${RENDER_ORIGIN_NAMESPACE}:${origin}`
}
