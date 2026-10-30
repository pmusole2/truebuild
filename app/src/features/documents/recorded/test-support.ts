/** Test-only assembly of complete AI-authored raw trees; never part of the application runtime graph. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    assembleDocumentV2,
    canonicalJson,
    documentMaterialV2,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    syntheticAuthorV2Schema,
    syntheticDocumentFactsV2,
    verifyDocumentAgainstInputsV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
} from '@truebuild/contracts'
import { sha256Hex } from '../sha256'

const read = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, name), 'utf8'))

export function recordedDocumentForTest(name: string): ScreenDocumentV2 {
    const raw = read(`${name}.proposal.json`)
    const proposal = screenProposalV2Schema.parse(raw)
    if (canonicalJson(raw) !== canonicalJson(proposal)) throw new Error(`${name}: raw tree would be changed`)
    const inputs = read(`${name}.inputs.json`) as ScreenContextInputsV2
    const runtime = read(`${name}.runtime.json`) as Record<string, unknown>
    if (runtime.evidence !== 'synthetic-fixture' || runtime.model !== null || runtime.effort !== null) {
        throw new Error(`${name}: unexpected recording evidence`)
    }
    const author = syntheticAuthorV2Schema.parse(runtime.authoring)
    const document = screenDocumentV2Schema.parse(
        assembleDocumentV2(documentMaterialV2(inputs), proposal, syntheticDocumentFactsV2(author), {
            sha256Hex,
            now: () => new Date(author.recordedAt),
        }),
    )
    const issues = verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)
    if (issues.length > 0) throw new Error(`${name}: ${issues.join(',')}`)

    return document
}
