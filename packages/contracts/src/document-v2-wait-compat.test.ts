import legacyWaitCopy from './fixtures/prompt39/wait-copy'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import home from './fixtures/prompt39/recorded-home.proposal.json'
import homeInputs from './fixtures/prompt39/recorded-home.inputs.json'
import homeRuntime from './fixtures/prompt39/recorded-home.runtime.json'
import camera from './fixtures/prompt39/recorded-camera-page.proposal.json'
import cameraInputs from './fixtures/prompt39/recorded-camera-page.inputs.json'
import cameraRuntime from './fixtures/prompt39/recorded-camera-page.runtime.json'
import saving from './fixtures/prompt39/recorded-home-saving.proposal.json'
import savingInputs from './fixtures/prompt39/recorded-home-saving.inputs.json'
import savingRuntime from './fixtures/prompt39/recorded-home-saving.runtime.json'
import {
    assembleDocumentV2,
    buildFallbackDocumentV2,
    canonicalJson,
    documentMaterialV2,
    manualOpeningTitleV2,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    sourceMapV2,
    syntheticDocumentFactsV2,
    syntheticAuthorV2Schema,
    verifyDocumentAgainstInputsV2,
    waitCopyV2,
    waitVariantV2,
    type ScreenContextInputsV2,
} from './index'

const deps = {
    sha256Hex: (text: string): string => createHash('sha256').update(text).digest('hex'),
    now: (): Date => new Date('2026-01-01T00:00:00Z'),
}

describe('app-only legacy wait presentation', () => {
    it.each([
        [home, homeInputs, homeRuntime],
        [camera, cameraInputs, cameraRuntime],
        [saving, savingInputs, savingRuntime],
    ])(
        'accepts an original pre-Prompt40 fixture only through the app compatibility boundary %#',
        (proposal, rawInputs, runtime) => {
            const inputs = rawInputs as ScreenContextInputsV2
            const parsedProposal = screenProposalV2Schema.parse(proposal)
            expect(deps.sha256Hex(canonicalJson(parsedProposal))).toBe(runtime.proposalSha256)
            const document = assembleDocumentV2(
                documentMaterialV2(inputs),
                parsedProposal,
                syntheticDocumentFactsV2(syntheticAuthorV2Schema.parse(runtime.authoring)),
                deps,
            )
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
            expect(verifyDocumentAgainstInputsV2(document, inputs, deps.sha256Hex)).toContain('literal_not_listed')
            expect(verifyDocumentAgainstInputsV2(document, inputs, deps.sha256Hex, { legacyWaitCopy: true })).toEqual(
                [],
            )
            const before = canonicalJson(document)
            for (const state of ['busy', 'pending'] as const) {
                const variant = document.states[state]
                if (variant === null) continue
                const shown = waitVariantV2(variant, inputs.kind, state, inputs.uiState?.busy?.activity)
                expect(JSON.stringify(shown)).not.toMatch(/Working on it|One moment, please\.|Working…|Please wait/u)
                expect(sourceMapV2({ ...document, states: { ...document.states, [state]: shown } })).toEqual(
                    document.metadata.sourceMap,
                )
            }
            expect(canonicalJson(document)).toBe(before)
            const current = buildFallbackDocumentV2(inputs, {
                ...deps,
                reason: 'fixture',
                evidence: 'synthetic-fixture',
            })
            expect(screenDocumentV2Schema.safeParse(current).success).toBe(true)
            expect(verifyDocumentAgainstInputsV2(current, inputs, deps.sha256Hex)).toEqual([])
            const changed = structuredClone(document)
            changed.header.title = { kind: 'literal', text: legacyWaitCopy.headings[0]! }
            expect(verifyDocumentAgainstInputsV2(changed, inputs, deps.sha256Hex, { legacyWaitCopy: true })).toContain(
                'literal_not_listed',
            )
            changed.bound.contextKey = '0'.repeat(64)
            expect(verifyDocumentAgainstInputsV2(changed, inputs, deps.sha256Hex, { legacyWaitCopy: true })).toContain(
                'bound_mismatch',
            )
        },
    )

    it('keeps compatibility out of failure states and requires the matching activity for historical detail', () => {
        const inputs = savingInputs as ScreenContextInputsV2
        const current = buildFallbackDocumentV2(inputs, { ...deps, reason: 'fixture', evidence: 'synthetic-fixture' })
        for (const state of ['error', 'recovery'] as const) {
            const changed = structuredClone(current)
            changed.states[state]!.header.title = { kind: 'literal', text: legacyWaitCopy.headings[0]! }
            expect(verifyDocumentAgainstInputsV2(changed, inputs, deps.sha256Hex, { legacyWaitCopy: true })).toContain(
                'literal_not_listed',
            )
        }
        const unlisted = structuredClone(current)
        unlisted.states.busy!.header.subtitle = { kind: 'literal', text: 'An unlisted wait sentence' }
        expect(verifyDocumentAgainstInputsV2(unlisted, inputs, deps.sha256Hex, { legacyWaitCopy: true })).toContain(
            'literal_not_listed',
        )
        const historical = structuredClone(current)
        historical.states.busy!.header.subtitle = { kind: 'literal', text: legacyWaitCopy.activities.saving.detail }
        expect(verifyDocumentAgainstInputsV2(historical, inputs, deps.sha256Hex, { legacyWaitCopy: true })).toEqual([])
        historical.states.pending!.header.subtitle = historical.states.busy!.header.subtitle
        expect(verifyDocumentAgainstInputsV2(historical, inputs, deps.sha256Hex, { legacyWaitCopy: true })).toContain(
            'literal_not_listed',
        )
        expect(waitVariantV2(historical.states.busy!, 'home', 'busy', 'saving').header.subtitle).toEqual({
            kind: 'literal',
            text: '',
        })
    })

    it('uses only a bounded saved product title and distinguishes opening from step layout', () => {
        expect(manualOpeningTitleV2({ title: '  Untitled manual ' })).toBeNull()
        expect(manualOpeningTitleV2({ title: '   ' })).toBeNull()
        expect(manualOpeningTitleV2({ title: 'A'.repeat(80) })).toBe(`${'A'.repeat(39)}…`)
        expect(waitCopyV2('home')).toMatchObject({ heading: 'Opening your manuals', detail: '' })
        expect(waitCopyV2('guide')).toMatchObject({ heading: 'Laying out this step', detail: '' })
        expect(waitCopyV2('guide', null, null)).toMatchObject({
            heading: 'Opening your manual',
            action: 'Opening…',
            detail: '',
        })
        expect(waitCopyV2('guide', null, 'Shelf')).toMatchObject({
            heading: 'Opening Shelf',
            action: 'Opening…',
            detail: '',
        })
        expect(waitCopyV2('guide', null, undefined, { targetStepNumber: 2 })).toMatchObject({
            heading: 'Getting step 2 ready',
            detail: '',
        })
        expect(waitCopyV2('guide', 'saving')).toMatchObject({ heading: 'Saving your progress', detail: '' })
    })
})
