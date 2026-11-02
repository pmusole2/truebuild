/** Re-export of the shared origin context (ui is the leaf; no cycle). See app/src/ui/render-origin.tsx. */
export type { RenderOrigin } from '../../ui/render-origin'
export {
    RENDER_ORIGIN_NAMESPACE,
    originId,
    parseOrigin,
    mergeNativeIds,
    withOriginSegment,
    RenderOriginProvider,
    useRenderOrigin,
    useOriginNativeId,
} from '../../ui/render-origin'
