import { composeFallbackDocumentV2, type ScreenDocumentV2, type ScreenContextInputsV2 } from '@truebuild/contracts'
import { adaptScreenDocumentV2, type BoundTextResolver } from './adapt'
import { sha256Hex } from './sha256'
import type { FrameDocument } from './types'

/**
 * The one local fallback path: the shared contracts composer builds a complete deterministic v2 document
 * (off/steps, no network), and the single adapter re-keys it for the renderer. No handcrafted fallback documents.
 */
export function sharedFallbackDocument(inputs: ScreenContextInputsV2): ScreenDocumentV2 {
    return composeFallbackDocumentV2(inputs, {
        sha256Hex,
        now: () => new Date(),
        reason: 'disabled',
        evidence: 'local-deterministic',
    })
}

export function sharedFallbackFrame(
    inputs: ScreenContextInputsV2,
    boundText: BoundTextResolver = (): string => '',
): FrameDocument {
    return adaptScreenDocumentV2(sharedFallbackDocument(inputs), boundText)
}
