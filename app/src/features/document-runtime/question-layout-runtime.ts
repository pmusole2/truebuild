import { compileLayoutTemplateV2, type ScreenContextInputsV2, type ScreenDocumentV2 } from '@truebuild/contracts'
import question from '../documents/recorded-layouts/recorded-question-layout-sol-v1.template.json'
import provenance from '../documents/recorded-layouts/recorded-question-layout-sol-v1.runtime.json'
import { sha256Hex } from '../documents/sha256'

/** One authored editable form, bound to current facts and a usable held photo; no new provider request or receipt. */
export function questionLayoutDocument(inputs: ScreenContextInputsV2): ScreenDocumentV2 | null {
    if (inputs.kind !== 'questions' || inputs.uiState?.capture?.reusable !== true) return null
    const compiled = compileLayoutTemplateV2({
        inputs,
        template: question,
        provenance,
        // Binding the saved layout creates no new generation. Its publication date is the retained author's date.
        deps: { sha256Hex, now: (): Date => new Date(provenance.authoring.recordedAt) },
    })
    return compiled.ok ? compiled.document : null
}

export function isQuestionLayoutDocument(document: ScreenDocumentV2): boolean {
    return (
        document.kind === 'questions' &&
        document.metadata.source === 'generated' &&
        document.metadata.authoring?.fixtureId === provenance.authoring.fixtureId
    )
}
