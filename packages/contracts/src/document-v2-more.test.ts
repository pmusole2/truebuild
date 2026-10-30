import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    DOCUMENT_V2_LIMITS,
    INTENTS_BY_KIND_V2,
    NO_STEP_FIGURE_COPY_V2,
    assembleDocumentV2,
    availableBoundKeysV2,
    captureWitnessV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    earnedStateIssuesV2,
    intentAllowedV2,
    nodeTextRefsV2,
    photoSpineV2,
    questionResultSchema,
    resultFactCardV2,
    screenContextJsonV2,
    screenDocumentV2Schema,
    screenStageV2,
    sourceMapV2,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ManualSession,
    type QuestionResult,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
    type ScreenVariantV2,
} from './index'
import { createHeroResponse } from './hero'
import { MODEL_METADATA_MAX_BYTES, modelScreensV2MetadataSchema, screensV2GenerateRequest } from './model'

// Contextual More: an optional reviewed step with the held photo, the retained check and a companion answer.

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }
const PAGE = 'demo-page-1'
const QUESTION = 'Does the groove face inward?'

const ui: ScreenUiStateV2 = {
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    sections: ['settings', 'how-it-works', 'about-this-check', 'tips'],
    language: { options: ['en', 'es'] },
    settings: { storage: true },
}

const answer = (extra: Partial<{ answer: string; missing: string[] }> = {}): QuestionResult =>
    questionResultSchema.parse({
        answer: extra.answer ?? 'The groove faces inward toward the divider.',
        sourceRefs: [{ pageId: PAGE, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
        missingEvidence: extra.missing ?? ['A closer photo would help.'],
    })

const global = (uiState: ScreenUiStateV2 = ui): ScreenContextInputsV2 => ({
    kind: 'more',
    session: null,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
    uiState,
})

type Held = 'none' | 'photo' | 'refuse' | 'pass' | 'answer' | 'both'
function contextual(held: Held = 'none', session: ManualSession = createDemoManual()): ScreenContextInputsV2 {
    const base: ScreenContextInputsV2 = {
        kind: 'more',
        session,
        stepId: 'step-1',
        captureId: held === 'none' ? null : 'cap-1',
        result: null,
        failure: null,
        uiState: held === 'none' ? { ...ui, capture: null } : ui,
    }
    switch (held) {
        case 'refuse':
            return { ...base, result: { kind: 'check', value: createHeroResponse('reversed') } }
        case 'pass':
            return { ...base, result: { kind: 'check', value: createHeroResponse('correct') } }
        case 'answer':
            return { ...base, result: { kind: 'question', question: QUESTION, value: answer() } }
        case 'both':
            return {
                ...base,
                result: { kind: 'check', value: createHeroResponse('reversed') },
                companionAnswer: { question: QUESTION, value: answer() },
            }
        default:
            return base
    }
}

const fallbackFor = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })
const nodesOf = (variant: ScreenVariantV2, prefix = ''): ScreenNodeV2[] => {
    const out: ScreenNodeV2[] = []
    visitVariantNodesV2(variant, prefix, ({ node }) => out.push(node))
    return out
}
const variantOf = (document: ScreenDocumentV2, name: string): ScreenVariantV2 =>
    variantsOfV2(document).find((entry) => entry.name === name)!.variant
const messages = (document: unknown): string[] => {
    const parsed = screenDocumentV2Schema.safeParse(document)
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}
const republish = (inputs: ScreenContextInputsV2, edit: (proposal: ScreenProposalV2) => ScreenProposalV2): string[] => {
    const material = documentMaterialV2(inputs)
    const document = assembleDocumentV2(
        material,
        edit(buildFallbackProposalV2(material)),
        { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
        deps,
    )
    return [...messages(document), ...verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)]
}
const mapNodes = (node: ScreenNodeV2, edit: (node: ScreenNodeV2) => ScreenNodeV2): ScreenNodeV2 => {
    const next = edit(node)
    return 'children' in next
        ? ({ ...next, children: next.children.map((child) => mapNodes(child, edit)) } as ScreenNodeV2)
        : next
}
const mapReady = (proposal: ScreenProposalV2, edit: (node: ScreenNodeV2) => ScreenNodeV2): ScreenProposalV2 => ({
    ...proposal,
    body: mapNodes(proposal.body, edit),
})

describe('global More stays global', () => {
    it('invents no manual, step, figure or question', () => {
        const material = documentMaterialV2(global())
        expect(material.stepBound).toBe(false)
        expect(material.step).toBeNull()
        expect(material.facts).toEqual([])
        expect(material.requirements).toMatchObject({ capture: false, figure: null, facts: [], sources: [] })
        expect(availableBoundKeysV2(material)).not.toContain('held-question')
        expect(availableBoundKeysV2(material)).not.toContain('step-title')
        expect(availableBoundKeysV2(material)).not.toContain('manual-title')
        expect(JSON.stringify(fallbackFor(global()))).not.toContain(NO_STEP_FIGURE_COPY_V2)
    })

    it('keeps its context key independent of any step state and offers no step action', () => {
        const withCapture = screenContextJsonV2(global())
        const without = screenContextJsonV2(global({ ...ui, capture: null }))
        expect(withCapture).toBe(without)
        expect(withCapture).not.toContain('companion')
        const material = documentMaterialV2(global())
        for (const candidate of [
            { intent: 'ask', target: 'about-step' },
            { intent: 'capture', target: 'take-photo' },
            { intent: 'capture', target: 'retake' },
            { intent: 'confirm', target: 'step' },
        ] as const) {
            expect(intentAllowedV2(candidate, material)).toBe(false)
        }
        expect(fallbackFor(global()).requirements.actions).toEqual([{ intent: 'navigate', target: 'back' }])
    })
})

describe('contextual More', () => {
    it('is step bound, states the step facts losslessly and validates', () => {
        const inputs = contextual('none')
        const material = documentMaterialV2(inputs)
        expect(material.stepBound).toBe(true)
        expect(material.facts.length).toBeGreaterThan(0)
        const document = fallbackFor(inputs)
        expect(messages(document)).toEqual([])
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        expect(document.bound).toMatchObject({ manualId: 'demo-divider', stepId: 'step-1', captureId: null })
        // Close is the primary; Ask is the secondary for a reviewed step; Home is never offered.
        expect(document.bar.primary.intent).toEqual({ intent: 'navigate', target: 'back' })
        expect(document.bar.primary.label).toBe('Close')
        expect(document.bar.secondary?.intent).toEqual({ intent: 'ask', target: 'about-step' })
        expect(JSON.stringify(document)).not.toContain('"navigate","target":"home"')
        expect(document.header.back?.intent).toEqual({ intent: 'navigate', target: 'back' })
    })

    it('shows the exact source figure of the step, with its own page and region', () => {
        const inputs = contextual('none')
        const document = fallbackFor(inputs)
        const { figure } = document.requirements
        expect(figure).not.toBeNull()
        const image = nodesOf(document as unknown as ScreenVariantV2).find(
            (node) => node.type === 'Image' && node.source.kind === 'source',
        )
        expect(image).toMatchObject({ source: { kind: 'source', index: figure } })
        const step = inputs.session!.reviewedSteps[0]!
        const cited = document.sources[figure!]!
        expect(step.sourceRefs.some((ref) => ref.pageId === cited.pageId)).toBe(true)
    })

    it('says so when the step has no picture, never an empty frame or an invented figure', () => {
        const session = createDemoManual()
        session.reviewedSteps[0]!.sourceRefs = []
        const inputs = contextual('none', session)
        const document = fallbackFor(inputs)
        expect(document.requirements.figure).toBeNull()
        expect(nodesOf(document as unknown as ScreenVariantV2).some((node) => node.type === 'Image')).toBe(false)
        expect(JSON.stringify(document.body)).toContain(NO_STEP_FIGURE_COPY_V2)
        expect(messages(document)).toEqual([])
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })

    it('keeps mandatory safety visible and everything else collapsed', () => {
        const document = fallbackFor(contextual('none'))
        const collapsed: string[] = []
        const visible: ScreenNodeV2[] = []
        visitVariantNodesV2(variantOf(document, 'ready'), '', ({ node, hidden }) => {
            if (node.type === 'Section' && node.collapsible && !node.initiallyOpen && node.title?.kind === 'literal')
                collapsed.push(node.title.text)
            if (!hidden) visible.push(node)
        })
        expect(collapsed).toEqual(expect.arrayContaining(['Privacy', 'Settings', 'How it works']))
        const stated = new Set(
            visible.flatMap((node) => nodeTextRefsV2(node)).flatMap((ref) => (ref.kind === 'fact' ? [ref.factId] : [])),
        )
        for (const factId of document.requirements.facts) expect(stated.has(factId)).toBe(true)
        // The global More keeps its privacy and settings open.
        const open = fallbackFor(global())
        let privacyOpen = false
        visitVariantNodesV2(variantOf(open, 'ready'), '', ({ node }) => {
            if (node.type === 'Section' && node.title?.kind === 'literal' && node.title.text === 'Privacy')
                privacyOpen = !node.collapsible || node.initiallyOpen
        })
        expect(privacyOpen).toBe(true)
    })

    it('binds the held photo only when its identity is in the key', () => {
        const held = contextual('photo')
        expect(captureWitnessV2(held)).toBe('cap-1')
        expect(documentMaterialV2(held).inputs.captureId).toBe('cap-1')
        expect(screenContextJsonV2(held)).toContain('"captureId":"cap-1"')
        const other = contextual('photo')
        other.uiState = { ...ui, capture: { ...ui.capture!, captureId: 'cap-2' } }
        expect(documentMaterialV2(other).inputs.captureId).toBeNull()
        expect(screenContextJsonV2(other)).not.toBe(screenContextJsonV2(held))
        // Volatile capture fields never change the key.
        const draft = contextual('photo')
        draft.uiState = { ...ui, capture: { ...ui.capture!, questionDraftPresent: true, reusable: false } }
        expect(screenContextJsonV2(draft)).toBe(screenContextJsonV2(held))
        const photo = fallbackFor(held)
        expect(
            nodesOf(photo as unknown as ScreenVariantV2).some(
                (node) => node.type === 'Image' && node.source.kind === 'capture',
            ),
        ).toBe(true)
        expect(messages(photo)).toEqual([])
    })
})

describe('retained check and companion answer in More', () => {
    it('shows photo before verdict and withholds the verdict in every waiting and failure variant', () => {
        const inputs = contextual('refuse')
        const document = fallbackFor(inputs)
        expect(document.requirements.capture).toBe(true)
        expect(messages(document)).toEqual([])
        for (const { name, variant } of variantsOfV2(document)) {
            const nodes = nodesOf(variant)
            expect(nodes.some((node) => node.type === 'Image' && node.source.kind === 'capture')).toBe(true)
            if (name === 'ready') {
                expect(nodes.some((node) => node.type === 'VerdictCard' && node.result === 'check')).toBe(true)
            } else {
                expect(nodes.some((node) => node.type === 'VerdictCard')).toBe(false)
                const facts = nodes
                    .flatMap((node) => nodeTextRefsV2(node))
                    .flatMap((ref) => (ref.kind === 'fact' ? [ref.factId] : []))
                expect(facts.filter((id) => id.startsWith('result:'))).toEqual([])
                // The manual's mandatory facts survive the waiting and failure states.
                for (const factId of document.requirements.facts.filter((id) => !id.startsWith('result:')))
                    expect(facts).toContain(factId)
            }
        }
    })

    it('states the refusal and the answer separately, each with its own facts, citations and missing evidence', () => {
        const inputs = contextual('both')
        const document = fallbackFor(inputs)
        expect(messages(document)).toEqual([])
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        const ids = document.facts.map((fact) => fact.factId)
        expect(ids).toEqual(expect.arrayContaining(['result:verdict', 'result:answer', 'result:answer-missing:0']))
        expect(ids.filter((id) => id.startsWith('result:'))).toEqual([
            'result:verdict',
            'result:answer',
            'result:answer-missing:0',
        ])
        expect(document.requirements.facts).toEqual(expect.arrayContaining(['result:verdict', 'result:answer']))
        const cards = nodesOf(variantOf(document, 'ready')).filter((node) => node.type === 'VerdictCard')
        expect(cards.map((card) => card.type === 'VerdictCard' && card.result)).toEqual(['check', 'question'])
        expect(document.requirements.sources.length).toBeGreaterThanOrEqual(2)
        // Neither implies a pass: no success tone, no confirm step.
        expect(JSON.stringify(document)).not.toContain('"tone":"success"')
        expect(document.bar.primary.intent.intent).toBe('navigate')
        expect(document.bar.secondary?.intent).toEqual({ intent: 'ask', target: 'about-step' })
        // The user's question is quoted through the app bound key, not as a fact.
        expect(JSON.stringify(document.body)).toContain('"key":"held-question"')
        expect(availableBoundKeysV2(documentMaterialV2(inputs))).toContain('held-question')
        expect(document.facts.some((fact) => fact.text.includes(QUESTION))).toBe(false)
    })

    it('credits each card with only the facts of its own result type', () => {
        expect(resultFactCardV2('result:verdict')).toBe('check')
        expect(resultFactCardV2('result:missing:3')).toBe('check')
        expect(resultFactCardV2('result:answer')).toBe('question')
        expect(resultFactCardV2('result:answer-missing:0')).toBe('question')
        expect(resultFactCardV2('safety:n0')).toBeNull()
        const inputs = contextual('both')
        // Two check cards cannot discharge the answer; a card that hides its reason discharges nothing.
        const twoChecks = republish(inputs, (proposal) =>
            mapReady(proposal, (node) => (node.type === 'VerdictCard' ? { ...node, result: 'check' } : node)),
        )
        expect(twoChecks.join(' ')).toMatch(/required fact is missing/i)
        const noReason = republish(inputs, (proposal) =>
            mapReady(proposal, (node) =>
                node.type === 'VerdictCard' && node.result === 'question' ? { ...node, showReason: false } : node,
            ),
        )
        expect(noReason.join(' ')).toMatch(/required fact is missing/i)
        const dropped = republish(inputs, (proposal) =>
            mapReady(proposal, (node) =>
                node.type === 'VerdictCard' && node.result === 'question' ? { ...node, result: 'check' } : node,
            ),
        )
        expect(dropped.length).toBeGreaterThan(0)
    })

    it('maps a card to the sources of its own facts only', () => {
        const document = fallbackFor(contextual('both'))
        const map = sourceMapV2(document)
        const ready = variantOf(document, 'ready')
        const indexOfCard = (kind: 'check' | 'question'): number[] => {
            let found: number[] = []
            visitVariantNodesV2(ready, '', ({ node, path }) => {
                if (node.type === 'VerdictCard' && node.result === kind) found = map[path] ?? []
            })
            return found
        }
        const own = (id: string): number[] => {
            const fact = document.facts.find((candidate) => candidate.factId === id)!
            return fact.sourceRefs.map((ref) =>
                document.sources.findIndex(
                    (source) =>
                        source.pageId === ref.pageId && JSON.stringify(source.region) === JSON.stringify(ref.region),
                ),
            )
        }
        expect(indexOfCard('check')).toEqual([...new Set(own('result:verdict'))].sort((a, b) => a - b))
        expect(indexOfCard('question')).toEqual([...new Set(own('result:answer'))].sort((a, b) => a - b))
    })

    it('treats a held answer alone as the primary result', () => {
        const inputs = contextual('answer')
        const document = fallbackFor(inputs)
        expect(messages(document)).toEqual([])
        expect(document.facts.map((fact) => fact.factId).filter((id) => id.startsWith('result:'))).toEqual([
            'result:answer',
            'result:answer-missing:0',
        ])
        expect(documentMaterialV2(inputs).requirements.capture).toBe(true)
    })

    it('changes the key with the companion answer and its question', () => {
        const base = screenContextJsonV2(contextual('refuse'))
        const both = screenContextJsonV2(contextual('both'))
        expect(both).not.toBe(base)
        const edited = contextual('both')
        edited.companionAnswer = { question: 'Another question?', value: answer() }
        expect(screenContextJsonV2(edited)).not.toBe(both)
        const changed = contextual('both')
        changed.companionAnswer = { question: QUESTION, value: answer({ answer: 'It faces outward.' }) }
        expect(screenContextJsonV2(changed)).not.toBe(both)
        const missing = contextual('both')
        missing.companionAnswer = { question: QUESTION, value: answer({ missing: [] }) }
        expect(screenContextJsonV2(missing)).not.toBe(both)
    })

    it('verifies against inputs that differ in the answer', () => {
        const document = fallbackFor(contextual('both'))
        const other = contextual('both')
        other.companionAnswer = { question: QUESTION, value: answer({ answer: 'It faces outward.' }) }
        expect(verifyDocumentAgainstInputsV2(document, other, sha256Hex)).toEqual(
            expect.arrayContaining(['facts_mismatch']),
        )
    })
})

describe('More intents', () => {
    it('offers ask, capture and confirm only with their witnesses', () => {
        const allowed = (held: Held, candidate: Parameters<typeof intentAllowedV2>[0]): boolean =>
            intentAllowedV2(candidate, documentMaterialV2(contextual(held)))
        const ask = { intent: 'ask', target: 'about-step' } as const
        const retake = { intent: 'capture', target: 'retake' } as const
        const take = { intent: 'capture', target: 'take-photo' } as const
        const next = { intent: 'confirm', target: 'step' } as const
        expect(allowed('none', ask)).toBe(true)
        expect(allowed('none', take)).toBe(true)
        expect(allowed('none', retake)).toBe(false)
        expect(allowed('photo', retake)).toBe(true)
        expect(allowed('refuse', next)).toBe(false)
        expect(allowed('answer', next)).toBe(false)
        expect(allowed('both', next)).toBe(false)
        expect(allowed('pass', next)).toBe(true)
        expect(intentAllowedV2({ intent: 'ask', target: 'about-part' }, documentMaterialV2(contextual('none')))).toBe(
            false,
        )
        expect(
            intentAllowedV2({ intent: 'capture', target: 'choose-pages' }, documentMaterialV2(contextual('none'))),
        ).toBe(false)
        const unreviewed = createDemoManual()
        unreviewed.reviewStatus = 'unreviewed'
        expect(intentAllowedV2(ask, documentMaterialV2(contextual('none', unreviewed)))).toBe(false)
        expect(INTENTS_BY_KIND_V2.more).toEqual(expect.arrayContaining(['ask', 'capture', 'confirm']))
    })

    it('never advances a step from a refusal, an answer or a global More', () => {
        for (const held of ['refuse', 'answer', 'both'] as const) {
            const document = fallbackFor(contextual(held))
            for (const { variant } of variantsOfV2(document)) {
                const intents = JSON.stringify(variant)
                expect(intents).not.toContain('"target":"step"')
            }
        }
    })
})

describe('stages', () => {
    it('composes result and answer with the noncritical stage, More with the screen stage', () => {
        expect(screenStageV2('result')).toBe('step-page')
        expect(screenStageV2('answer')).toBe('step-page')
        expect(screenStageV2('more')).toBe('screen')
        expect(screenStageV2('questions')).toBe('screen')
        expect(screenStageV2('guide')).toBe('step-page')
    })
})

describe('request schema', () => {
    const request = (inputs: ScreenContextInputsV2): ReturnType<typeof screensV2GenerateRequest> =>
        screensV2GenerateRequest('r1', inputs, sha256Hex)
    const parses = (value: unknown): boolean => modelScreensV2MetadataSchema.safeParse(value).success
    it('accepts global and contextual More with their held state', () => {
        for (const inputs of [
            global(),
            contextual('none'),
            contextual('photo'),
            contextual('refuse'),
            contextual('answer'),
            contextual('both'),
        ]) {
            expect(modelScreensV2MetadataSchema.safeParse(request(inputs)).error?.issues ?? []).toEqual([])
        }
        const sent = request(contextual('both'))
        expect(sent.companionAnswer).toMatchObject({ question: QUESTION })
        expect(request(contextual('refuse')).companionAnswer).toBeUndefined()
    })

    it('rejects a manual without its step, a held state without a step, and a companion without a check', () => {
        expect(parses({ ...request(contextual('none')), stepId: null })).toBe(false)
        expect(parses({ ...request(global()), captureId: 'cap-1' })).toBe(false)
        expect(parses({ ...request(global()), result: { kind: 'check', value: createHeroResponse('reversed') } })).toBe(
            false,
        )
        expect(
            parses({ ...request(contextual('answer')), companionAnswer: { question: QUESTION, value: answer() } }),
        ).toBe(false)
        expect(
            parses({ ...request(contextual('none')), companionAnswer: { question: QUESTION, value: answer() } }),
        ).toBe(false)
        expect(parses({ ...request(contextual('refuse')), captureId: null })).toBe(false)
        expect(parses({ ...request(contextual('both')), companionAnswer: { question: '', value: answer() } })).toBe(
            false,
        )
        // A held photo without a result must be the photo the app state holds.
        expect(parses({ ...request(contextual('photo')), captureId: 'cap-9' })).toBe(false)
        expect(parses({ ...request(contextual('none')), stepId: 'missing-step' })).toBe(false)
    })

    it('rejects a companion answer on any other kind, and a source the manual does not have', () => {
        const result = { ...request(contextual('both')) }
        expect(parses({ ...result, kind: 'result', stepId: 'step-1' })).toBe(false)
        const strange = contextual('refuse')
        strange.result = {
            kind: 'check',
            value: { ...createHeroResponse('reversed'), sourceRefs: [{ pageId: 'no-such-page', region: null }] },
        }
        expect(parses(request(strange))).toBe(false)
        const answerStrange = contextual('both')
        answerStrange.companionAnswer = {
            question: QUESTION,
            value: { ...answer(), sourceRefs: [{ pageId: 'no-such-page', region: null }] },
        }
        expect(parses(request(answerStrange))).toBe(false)
    })

    it('sizes the largest valid request and document under the shared ceilings', () => {
        const session = createDemoManual()
        const step = session.reviewedSteps[0]!
        step.safetyNotes = Array.from({ length: 100 }, (_unused, note) => ({
            noteId: `n${note}`,
            note: {
                state: 'known' as const,
                value: `Keep fingers clear near connection ${note}.`.padEnd(500, '.'),
                sourceRefs: Array.from({ length: 100 }, (_ref, ref) => ({
                    pageId: PAGE,
                    region: { x: (note % 100) / 200, y: (ref % 100) / 200, width: 0.004, height: 0.004 },
                })),
            },
        }))
        const refs = Array.from({ length: 100 }, (_unused, at) => ({
            pageId: PAGE,
            region: { x: at / 200, y: 0.1, width: 0.004, height: 0.004 },
        }))
        const missing = Array.from({ length: 100 }, (_unused, at) => `Missing evidence ${at}`.padEnd(500, '.'))
        const check = {
            ...createHeroResponse('reversed'),
            reason: 'r'.repeat(500),
            sourceRefs: refs,
            missingEvidence: missing,
        }
        const inputs: ScreenContextInputsV2 = {
            ...contextual('both', session),
            result: { kind: 'check', value: check },
            companionAnswer: {
                question: 'q'.repeat(500),
                value: answer({ answer: 'a'.repeat(2_000), missing }),
            },
        }
        inputs.companionAnswer!.value = { ...inputs.companionAnswer!.value, sourceRefs: refs }
        const sent = screensV2GenerateRequest('r1', inputs, sha256Hex)
        expect(modelScreensV2MetadataSchema.safeParse(sent).error?.issues ?? []).toEqual([])
        expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(MODEL_METADATA_MAX_BYTES)
        const document = fallbackFor(inputs)
        expect(messages(document)).toEqual([])
        expect(document.facts.length).toBeLessThanOrEqual(DOCUMENT_V2_LIMITS.facts)
        expect(Buffer.byteLength(JSON.stringify(document))).toBeLessThan(16 * 1024 * 1024)
    })
})

describe('photo-first failure policy', () => {
    const resultInputs = (decision: 'correct' | 'reversed'): ScreenContextInputsV2 => ({
        kind: 'result',
        session: createDemoManual(),
        stepId: 'step-1',
        captureId: 'cap-1',
        result: { kind: 'check', value: createHeroResponse(decision) },
        failure: null,
        uiState: ui,
    })
    const withFact = (document: ScreenDocumentV2, state: 'error' | 'recovery'): ScreenDocumentV2 => {
        const next = structuredClone(document)
        const variant = next.states[state]!
        const body = variant.body
        if (body.type === 'Scroll' && body.children[0]?.type === 'Stack') {
            body.children[0].children.push({
                type: 'Text',
                content: { kind: 'fact', factId: 'result:verdict' },
                role: 'body',
                emphasis: 'normal',
                tone: 'neutral',
                align: 'start',
            })
        }
        return next
    }

    it('shows the held photo and no verdict in every failure variant of a result', () => {
        const document = fallbackFor(resultInputs('reversed'))
        for (const state of ['error', 'recovery'] as const) {
            const variant = variantOf(document, state)
            const nodes = nodesOf(variant)
            expect(nodes.some((node) => node.type === 'Image' && node.source.kind === 'capture')).toBe(true)
            expect(nodes.some((node) => node.type === 'VerdictCard')).toBe(false)
            expect(
                nodes.flatMap(nodeTextRefsV2).filter((ref) => ref.kind === 'fact' && ref.factId.startsWith('result:')),
            ).toEqual([])
            // The manual's mandatory facts survive.
            const manual = document.requirements.facts.filter((id) => !id.startsWith('result:'))
            expect(manual.length).toBeGreaterThan(0)
            for (const factId of manual) expect(JSON.stringify(variant)).toContain(factId)
        }
        expect(messages(document)).toEqual([])
    })

    it('rejects a failure variant that states the held result', () => {
        const document = fallbackFor(resultInputs('reversed'))
        for (const state of ['error', 'recovery'] as const) {
            expect(messages(withFact(document, state)).join()).toMatch(/before it is revealed/)
        }
    })

    it('rejects a success tone before the verdict is revealed and earned', () => {
        const inputs = resultInputs('reversed')
        const material = documentMaterialV2(inputs)
        const document = fallbackFor(inputs)
        const tone = (state: 'busy' | 'error' | 'ready'): ScreenDocumentV2 => {
            const next = structuredClone(document)
            const variant = state === 'ready' ? next : next.states[state]!
            const body = variant.body
            if (body.type === 'Scroll' && body.children[0]?.type === 'Stack') {
                body.children[0].children.unshift({
                    type: 'Badge',
                    label: { kind: 'literal', text: 'Photo' },
                    tone: 'success',
                })
            }
            return next
        }
        for (const state of ['busy', 'error', 'ready'] as const) {
            expect(earnedStateIssuesV2(tone(state), material).some((issue) => issue.endsWith('tone_unearned'))).toBe(
                true,
            )
        }
        // A held pass earns it in the revealed screen only.
        const pass = documentMaterialV2(resultInputs('correct'))
        const passed = fallbackFor(resultInputs('correct'))
        const ready = structuredClone(passed)
        if (ready.body.type === 'Scroll' && ready.body.children[0]?.type === 'Stack') {
            ready.body.children[0].children.unshift({
                type: 'Badge',
                label: { kind: 'literal', text: 'Photo' },
                tone: 'success',
            })
        }
        expect(earnedStateIssuesV2(ready, pass).filter((issue) => issue.endsWith('tone_unearned'))).toEqual([])
    })
})

describe('the held photo keeps one spine', () => {
    const resultInputs = (kind: 'result' | 'answer'): ScreenContextInputsV2 => ({
        kind,
        session: createDemoManual(),
        stepId: 'step-1',
        captureId: 'cap-1',
        result:
            kind === 'result'
                ? { kind: 'check', value: createHeroResponse('reversed') }
                : { kind: 'question', question: QUESTION, value: answer() },
        failure: null,
        uiState: ui,
    })
    const cases: [string, ScreenContextInputsV2][] = [
        ['result', resultInputs('result')],
        ['answer', resultInputs('answer')],
        ['more with a refusal', contextual('refuse')],
        ['more with an answer', contextual('answer')],
        ['more with both', contextual('both')],
        [
            'more without a figure',
            ((): ScreenContextInputsV2 => {
                const session = createDemoManual()
                session.reviewedSteps[0]!.sourceRefs = []
                return contextual('refuse', session)
            })(),
        ],
    ]

    it.each(cases)(
        '%s: ready, busy, pending, error and recovery share the photo ancestors, types and indexes',
        (_name, inputs) => {
            const document = fallbackFor(inputs)
            const ready = photoSpineV2(document)
            expect(ready).not.toBeNull()
            for (const state of ['busy', 'pending', 'error', 'recovery'] as const) {
                expect(photoSpineV2(document.states[state]!), state).toBe(ready)
            }
            expect(messages(document)).toEqual([])
        },
    )

    it('puts the More photo beside the manual figure (Row index 1) in every variant', () => {
        const document = fallbackFor(contextual('refuse'))
        expect(photoSpineV2(document)).toMatch(/Row\.1$/u)
        expect(photoSpineV2(document.states.pending!)).toMatch(/Row\.1$/u)
        // The figure stays visible while waiting; the verdict is withheld.
        expect(
            nodesOf(document.states.pending!).some((node) => node.type === 'Image' && node.source.kind === 'source'),
        ).toBe(true)
    })

    it('rejects a variant that moves the photo, in the gate and for a request-bound client', () => {
        const inputs = contextual('refuse')
        const document = fallbackFor(inputs)
        for (const state of ['busy', 'pending', 'error', 'recovery'] as const) {
            const moved = structuredClone(document)
            const variant = moved.states[state]!
            const body = variant.body
            if (body.type === 'Scroll' && body.children[0]?.type === 'Stack') {
                // Lead with a spacer: the photo keeps existing but its child index changes.
                body.children[0].children.unshift({ type: 'Spacer', size: 'sm' })
            }
            expect(messages(moved).join(), state).toMatch(/moves the held photo/)
        }
        const resultMoved = structuredClone(fallbackFor(resultInputs('result')))
        const body = resultMoved.states.busy!.body
        if (body.type === 'Scroll' && body.children[0]?.type === 'Stack')
            body.children[0].children.unshift({ type: 'Spacer', size: 'sm' })
        expect(messages(resultMoved).join()).toMatch(/moves the held photo/)
    })
})

describe('the cancelled reading notice on Pages', () => {
    const pages = (uiState: ScreenUiStateV2): ScreenContextInputsV2 => ({
        kind: 'pages',
        session: null,
        stepId: null,
        captureId: null,
        result: null,
        failure: null,
        uiState: {
            ...uiState,
            pages: {
                items: [{ pageId: 'p1', width: 1200, height: 900 }],
                maxPages: 20,
                canRead: true,
                languageOptions: ['en'],
            },
        },
    })
    const noticeCount = (variant: ScreenVariantV2): number =>
        nodesOf(variant).filter(
            (node) => node.type === 'Text' && node.content.kind === 'bound' && node.content.key === 'operation-notice',
        ).length

    it('states the notice once, in the ready screen only, for the actual cancellation witness', () => {
        const inputs = pages({ cancelled: { reading: true } })
        const document = fallbackFor(inputs)
        expect(document.requirements.notice).toBe(true)
        expect(availableBoundKeysV2(documentMaterialV2(inputs))).toContain('operation-notice')
        expect(noticeCount(variantOf(document, 'ready'))).toBe(1)
        for (const { name, variant } of variantsOfV2(document))
            if (name !== 'ready') expect(noticeCount(variant), name).toBe(0)
        expect(messages(document)).toEqual([])
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })

    it('changes the key with the witness and leaves every other Pages key as it was', () => {
        const plain = screenContextJsonV2(pages({}))
        expect(screenContextJsonV2(pages({ cancelled: null }))).toBe(plain)
        expect(screenContextJsonV2(pages({ cancelled: { reading: true } }))).not.toBe(plain)
        // The generic problem witness stays exact: it does nothing on Pages.
        expect(screenContextJsonV2(pages({ failure: { notice: true } }))).toBe(plain)
        expect(fallbackFor(pages({ failure: { notice: true } })).requirements.notice).toBe(false)
    })

    it('does not offer the notice without its witness, on any other kind, or twice', () => {
        const without = fallbackFor(pages({}))
        expect(without.requirements.notice).toBe(false)
        expect(availableBoundKeysV2(documentMaterialV2(pages({})))).not.toContain('operation-notice')
        for (const kind of ['guide', 'home', 'add', 'quick-check', 'more'] as const) {
            const material = documentMaterialV2({ ...global(), kind, uiState: { cancelled: { reading: true } } })
            expect(material.requirements.notice, kind).toBe(false)
        }
        const inputs = pages({ cancelled: { reading: true } })
        const twice = structuredClone(fallbackFor(inputs))
        const ready = twice.body
        if (ready.type === 'Scroll' && ready.children[0]?.type === 'Stack') {
            ready.children[0].children.push(structuredClone(ready.children[0].children[1]!))
        }
        expect(messages(twice).join()).toMatch(/exactly once/)
        // Stated without a witness it is refused too.
        const forged = structuredClone(fallbackFor(inputs))
        forged.requirements.notice = false
        expect(messages(forged).join()).toMatch(/operation notice it does not hold/)
        const busy = structuredClone(fallbackFor(inputs))
        const waiting = busy.states.busy!.body
        if (waiting.type === 'Scroll' && waiting.children[0]?.type === 'Stack') {
            waiting.children[0].children.push({
                type: 'Text',
                content: { kind: 'bound', key: 'operation-notice' },
                role: 'body',
                emphasis: 'normal',
                tone: 'caution',
                align: 'start',
            })
        }
        expect(messages(busy).join()).toMatch(/operation notice it does not hold/)
    })
})

describe('limits', () => {
    it('allows the manual facts plus a check and a companion answer', () => {
        expect(DOCUMENT_V2_LIMITS.facts).toBeGreaterThanOrEqual(304 + 101 + 101)
    })
})

// An optional variant is still a public document boundary, even when no current route selects it.
describe('optional empty state on a held result', () => {
    it.each(['result', 'answer', 'more'] as const)(
        '%s cannot omit the photo and reveal a result fact as Text',
        (kind) => {
            const inputs = contextual('both')
            inputs.kind = kind
            if (kind !== 'more') {
                inputs.companionAnswer = null
                if (kind === 'answer') inputs.result = { kind: 'question', question: QUESTION, value: answer() }
            }
            const issues = republish(inputs, (proposal) => ({
                ...proposal,
                states: {
                    ...proposal.states,
                    empty: {
                        header: {
                            ...proposal.header,
                            title: { kind: 'literal', text: 'Nothing here yet' },
                            subtitle: null,
                        },
                        body: mapNodes(proposal.body, (node) => {
                            if (node.type === 'VerdictCard')
                                return {
                                    type: 'Text',
                                    content: {
                                        kind: 'fact',
                                        factId: node.result === 'check' ? 'result:verdict' : 'result:answer',
                                    },
                                    role: 'body',
                                    tone: 'neutral',
                                    emphasis: 'normal',
                                    align: 'start',
                                }
                            return 'children' in node
                                ? ({
                                      ...node,
                                      children: node.children.filter(
                                          (child) => !(child.type === 'Image' && child.source.kind === 'capture'),
                                      ),
                                  } as ScreenNodeV2)
                                : node
                        }),
                        bar: proposal.bar,
                        overlays: [],
                    },
                },
            }))
            expect(issues.join()).toMatch(/held photo|held result before it is revealed/)
        },
    )
})
