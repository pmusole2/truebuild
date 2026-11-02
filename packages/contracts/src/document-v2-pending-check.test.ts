import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    BUSY_COPY_V2,
    allowedLiteralsV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    captureWitnessV2,
    createDemoManual,
    documentMaterialV2,
    nodeIntentsV2,
    pendingCheckV2,
    photoSpineV2,
    screenContextJsonV2,
    screenContextPartsV2,
    screenDocumentV2Schema,
    semanticIssuesV2,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
} from './index'
import { createHeroResponse } from './hero'
import { modelScreensV2MetadataSchema, screensV2GenerateRequest } from './model'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = {
    sha256Hex,
    reason: 'disabled' as const,
    evidence: 'local-deterministic' as const,
    now: (): Date => new Date('2026-10-30T00:00:00.000Z'),
}

const CAPTURE = { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false } as const
const CHECKING = { activity: 'checking' } as const

/** The held photo of step 1 while its check is still running: exactly what the app holds before Spark answers. */
function pending(patch: Partial<ScreenContextInputsV2> = {}): ScreenContextInputsV2 {
    return {
        kind: 'result',
        session: createDemoManual(),
        stepId: 'step-1',
        captureId: 'cap-1',
        result: null,
        failure: null,
        uiState: { capture: CAPTURE, busy: CHECKING },
        ...patch,
    }
}

/** The same photo once the actual check has returned. */
function answered(orientation: 'correct' | 'reversed' | 'uncertain' = 'correct'): ScreenContextInputsV2 {
    return {
        ...pending(),
        result: { kind: 'check', value: createHeroResponse(orientation) },
        uiState: { capture: CAPTURE },
    }
}

const nodesOf = (variant: Parameters<typeof visitVariantNodesV2>[0]): ScreenNodeV2[] => {
    const found: ScreenNodeV2[] = []
    visitVariantNodesV2(variant, '', ({ node }) => found.push(node))
    return found
}

describe('the pending check is witnessed by the actual held photo, never assumed', () => {
    const unreviewed = { ...createDemoManual(), reviewStatus: 'unreviewed' as const }
    it.each<[string, ScreenContextInputsV2, boolean]>([
        ['the actual held photo while its check runs', pending(), true],
        ['a check that already returned', answered(), false],
        ['the guide of the same step', pending({ kind: 'guide' }), false],
        ['an answer screen', pending({ kind: 'answer' }), false],
        ['no capture identity', pending({ captureId: null }), false],
        ['a capture the app no longer holds', pending({ captureId: 'cap-0' }), false],
        ['no held-capture state', pending({ uiState: { busy: CHECKING } }), false],
        ['an idle app', pending({ uiState: { capture: CAPTURE } }), false],
        ['another activity', pending({ uiState: { capture: CAPTURE, busy: { activity: 'second-opinion' } } }), false],
        ['a failure', pending({ failure: 'provider_error' }), false],
        ['no manual', pending({ session: null }), false],
        ['a step the manual does not have', pending({ stepId: 'step-9' }), false],
        ['an unreviewed manual', pending({ session: unreviewed }), false],
    ])('%s', (_name, inputs, expected) => {
        expect(pendingCheckV2(inputs)).toBe(expected)
        expect(documentMaterialV2(inputs).pendingCheck).toBe(expected)
        // Only a witnessed pending check names a capture before a result exists (everything else keeps its old meaning).
        if (inputs.result === null) expect(captureWitnessV2(inputs)).toBe(expected ? 'cap-1' : null)
    })
})

describe('what the pending check document is bound to and owes', () => {
    it('binds the actual manual, revision, step and capture, states only manual facts and offers no verdict or confirm', () => {
        const inputs = pending()
        const material = documentMaterialV2(inputs)
        expect(screenContextPartsV2(inputs).identity).toMatchObject({
            manualId: 'demo-divider',
            revision: 1,
            stepId: 'step-1',
            captureId: 'cap-1',
        })
        expect(material.decision).toBeNull()
        expect(material.facts.some((fact) => fact.basis === 'result')).toBe(false)
        expect(material.facts).toEqual(documentMaterialV2(answered()).facts.filter((fact) => fact.basis !== 'result'))
        expect(material.requirements).toMatchObject({
            capture: true,
            nodes: [],
            actions: [{ intent: 'navigate', target: 'guide' }],
            figure: null,
        })
        const key = (inputs: ScreenContextInputsV2): string => sha256Hex(screenContextJsonV2(inputs))
        const other = pending({
            captureId: 'cap-2',
            uiState: { capture: { ...CAPTURE, captureId: 'cap-2' }, busy: CHECKING },
        })
        expect(new Set([key(inputs), key(answered()), key(other)]).size).toBe(3)
    })

    it('is local-only: the wire never accepts a result screen without its result', () => {
        const parsed = modelScreensV2MetadataSchema.safeParse(screensV2GenerateRequest('req-1', pending(), sha256Hex))
        expect(parsed.success).toBe(false)
        expect(JSON.stringify(parsed.error?.issues)).toContain('Current result required')
    })

    it('lists no claim wording for a check that has not returned, and the checking words only with their witness', () => {
        const ready = allowedLiteralsV2(documentMaterialV2(pending()), 'ready')
        expect(ready).toEqual(expect.arrayContaining([BUSY_COPY_V2.checking.heading, BUSY_COPY_V2.checking.detail]))
        for (const claim of ['Looks right', 'Not quite right', 'Cannot tell yet']) expect(ready).not.toContain(claim)
        // Without the checking witness (an idle app holding a photo) nothing may say a check is running.
        const idle = allowedLiteralsV2(documentMaterialV2(pending({ uiState: { capture: CAPTURE } })), 'ready')
        expect(idle).not.toContain(BUSY_COPY_V2.checking.heading)
    })
})

describe('the deterministic pending document (off, steps, or no authored layout yet)', () => {
    const inputs = pending()
    const document = buildFallbackDocumentV2(inputs, deps)

    it('is complete, request-bound and shows the held photo in every variant', () => {
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        expect(document.bound.captureId).toBe('cap-1')
        expect(document.header.title).toEqual({ kind: 'literal', text: BUSY_COPY_V2.checking.heading })
        const spines = variantsOfV2(document).map(({ variant }) => photoSpineV2(variant))
        expect(spines.every((spine) => spine !== null && spine === spines[0])).toBe(true)
        expect(variantsOfV2(document).map(({ name }) => name)).toEqual([
            'ready',
            'busy',
            'pending',
            'error',
            'recovery',
        ])
    })

    it('claims no verdict, approval or success and offers no confirm, capture, check or ask anywhere', () => {
        for (const { variant } of variantsOfV2(document)) {
            const nodes = nodesOf(variant)
            expect(nodes.map((node) => node.type)).not.toContain('VerdictCard')
            const intents = [
                ...(variant.header.back ? [variant.header.back.intent] : []),
                ...variant.header.actions.map((action) => action.intent),
                ...nodes.flatMap(nodeIntentsV2),
            ]
            expect(
                intents.filter((offered) => ['confirm', 'capture', 'check', 'ask'].includes(offered.intent)),
            ).toEqual([])
        }
        expect(document.bar.primary.intent).toEqual({ intent: 'navigate', target: 'guide' })
        expect(JSON.stringify(document)).not.toMatch(/Looks right|Not quite right|Cannot tell yet|Next step/u)
    })

    it('keeps one photo spine from before the verdict to every actual decision', () => {
        for (const orientation of ['correct', 'reversed', 'uncertain'] as const) {
            const decided = buildFallbackDocumentV2(answered(orientation), deps)
            expect(photoSpineV2(decided)).toBe(photoSpineV2(document))
        }
    })

    it('is refused by the shared gates when a producer claims more than the witness earns', () => {
        const material = documentMaterialV2(inputs)
        const proposal = buildFallbackProposalV2(material)
        const issues = (change: (draft: ScreenProposalV2) => void): string[] => {
            const draft = structuredClone(proposal)
            change(draft)
            return semanticIssuesV2(draft, material)
        }
        expect(
            issues((draft) => {
                draft.bar.primary = {
                    ...draft.bar.primary,
                    label: 'Next step',
                    intent: { intent: 'confirm', target: 'step' },
                }
            }),
        ).toContain('bar.primary:intent_not_allowed')
        expect(
            issues((draft) => {
                draft.bar.primary = {
                    ...draft.bar.primary,
                    label: 'Retake photo',
                    intent: { intent: 'capture', target: 'retake' },
                }
            }),
        ).toContain('bar.primary:intent_not_allowed')
        // Not even a second check of a check that is still running.
        expect(
            issues((draft) => {
                draft.bar.primary = {
                    ...draft.bar.primary,
                    label: 'Check again',
                    intent: { intent: 'retry', target: 'check' },
                }
            }),
        ).toContain('bar.primary:intent_not_allowed')
        for (const claim of ['Looks right', 'Cannot tell yet']) {
            expect(
                issues((draft) => {
                    draft.header.title = { kind: 'literal', text: claim }
                }),
            ).toEqual(expect.arrayContaining(['header:title_not_listed']))
        }
        const withCard = issues((draft) => {
            if (draft.body.type !== 'Scroll' || draft.body.children[0]?.type !== 'Stack') throw new Error('spine')
            draft.body.children[0].children.push({
                type: 'VerdictCard',
                result: 'check',
                variant: 'banner',
                showReason: true,
                showRegions: true,
            })
        })
        expect(withCard.some((issue) => issue.endsWith(':no_such_result'))).toBe(true)
    })
})
