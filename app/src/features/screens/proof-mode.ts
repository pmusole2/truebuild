import { API_BASE_URL } from '../../config'
import { nativeProofConfig } from '../ai-effort-proof/config'
import { PROOF_EVIDENCE_LABEL } from '../ai-effort-proof/evidence'

/**
 * The evidence line the judge layer must carry while the native proof's fixture IO is active, else null. In that run
 * nothing was inferred: model names on offers are intended targets, and provider effort, timing and usage are unknown.
 * An invalid proof configuration is not a proof run (the app refuses to start in one), so it reads as none here.
 */
export function proofEvidenceLabel(): string | null {
    if (!__DEV__) return null
    try {
        return nativeProofConfig(API_BASE_URL) === null ? null : PROOF_EVIDENCE_LABEL
    } catch {
        return null
    }
}
