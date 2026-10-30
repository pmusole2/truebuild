import { compileLayoutTemplateV2, type ScreenContextInputsV2, type ScreenDocumentV2 } from '@truebuild/contracts'
import result from '../documents/recorded-layouts/recorded-result-layout-sol-v1.template.json'
import resultProvenance from '../documents/recorded-layouts/recorded-result-layout-sol-v1.runtime.json'
import answer from '../documents/recorded-layouts/recorded-answer-layout-sol-v1.template.json'
import answerProvenance from '../documents/recorded-layouts/recorded-answer-layout-sol-v1.runtime.json'
import { sha256Hex } from '../documents/sha256'

/** A model-authored layout of current witnessed truth, not a receipt for an exact-context provider request. */
export function resultLayoutDocument(inputs: ScreenContextInputsV2): ScreenDocumentV2 | null {
    if (inputs.kind !== 'result' && inputs.kind !== 'answer') return null
    const compiled = compileLayoutTemplateV2({
        inputs,
        template: inputs.kind === 'result' ? result : answer,
        provenance: inputs.kind === 'result' ? resultProvenance : answerProvenance,
        deps: { sha256Hex, now: (): Date => new Date() },
    })
    return compiled.ok ? compiled.document : null
}

export function isResultLayoutDocument(document: ScreenDocumentV2): boolean {
    const fixtureId = document.metadata.authoring?.fixtureId
    return (
        document.metadata.source === 'generated' &&
        (fixtureId === resultProvenance.authoring.fixtureId || fixtureId === answerProvenance.authoring.fixtureId)
    )
}
