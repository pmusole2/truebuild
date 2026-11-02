import { buildFallbackDocumentV2, type ScreenDocumentV2, type ScreenContextInputsV2 } from '@truebuild/contracts'
import { sha256Hex } from './sha256'

/**
 * The one local fallback path: the shared contracts composer builds a complete deterministic v2 document
 * (off/steps, no network), and the renderer consumes it intact. No handcrafted fallback documents.
 */
export function sharedFallbackDocument(inputs: ScreenContextInputsV2): ScreenDocumentV2 {
    return buildFallbackDocumentV2(inputs, {
        sha256Hex,
        now: () => new Date(),
        reason: 'disabled',
        evidence: 'local-deterministic',
    })
}
