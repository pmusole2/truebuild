import type { WaitCompatibilityV2 } from './document-v2-copy'
import { nodeTextRefsV2, variantsOfV2, visitVariantNodesV2, type ScreenDocumentV2, type TextRefV2 } from './document-v2'
import { screenContextJsonV2, screenContextPartsV2, type ScreenContextInputsV2 } from './document-v2-context'
import { semanticIssuesV2 } from './document-v2-semantic'
import { availableBoundKeysV2, documentMaterialV2 } from './document-v2-material'
import { canonicalJson } from './screen-context'

/**
 * What a request-bound client checks of every server document, recomputed from ITS OWN inputs: the screen kind and
 * identity, the authoritative facts, sources and requirements (the shared material), the interface wording and the
 * earned progress. A matching context-key hash alone proves only that both sides hashed the same inputs, not that the
 * document restates the manual faithfully. Pass `sha256Hex` to also check the context key. Machine codes only.
 */
export function verifyDocumentAgainstInputsV2(
    document: ScreenDocumentV2,
    inputs: ScreenContextInputsV2,
    sha256Hex?: (text: string) => string,
    options: WaitCompatibilityV2 = {},
): string[] {
    const material = documentMaterialV2(inputs, document.metadata.stepActions !== 1)
    const { identity } = screenContextPartsV2(inputs)
    const issues = new Set<string>()
    if (document.kind !== inputs.kind) issues.add('kind_mismatch')
    const { bound } = document
    if (
        bound.manualId !== identity.manualId ||
        bound.revision !== identity.revision ||
        bound.stepId !== identity.stepId ||
        bound.captureId !== identity.captureId ||
        (sha256Hex !== undefined && bound.contextKey !== sha256Hex(screenContextJsonV2(inputs)))
    ) {
        issues.add('bound_mismatch')
    }
    if (canonicalJson(document.facts) !== canonicalJson(material.facts)) issues.add('facts_mismatch')
    if (canonicalJson(document.sources) !== canonicalJson(material.sources)) issues.add('sources_mismatch')
    if (canonicalJson(document.requirements) !== canonicalJson(material.requirements))
        issues.add('requirements_mismatch')
    const available = new Set(availableBoundKeysV2(material))
    const checkRef = (ref: TextRefV2 | null): void => {
        if (ref?.kind === 'bound' && !available.has(ref.key)) issues.add('bound_unavailable')
    }
    for (const { variant, prefix } of variantsOfV2(document)) {
        checkRef(variant.header.title)
        checkRef(variant.header.subtitle)
        visitVariantNodesV2(variant, prefix, ({ node }) => nodeTextRefsV2(node).forEach(checkRef))
    }
    for (const issue of semanticIssuesV2(document, material, options)) {
        issues.add(issue.slice(issue.lastIndexOf(':') + 1))
    }
    return [...issues]
}
