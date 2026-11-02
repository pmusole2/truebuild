import { createHash } from 'node:crypto'

import { describe, expect, expectTypeOf, it } from 'vitest'

import {
    BUSY_ACTIVITIES_V2,
    BUSY_COPY_V2,
    CONFIRM_LABELS_V2,
    EMPTY_COPY_V2,
    NODE_TYPES_V2,
    SCREEN_KINDS_V2,
    STATE_COPY_V2,
    VARIANT_STATES,
    assembleDocumentV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    canonicalJson,
    createDemoManual,
    documentMaterialV2,
    questionResultSchema,
    requiredStatesV2,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    visitVariantNodesV2,
    variantsOfV2,
    type FallbackObservedV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenUiStateV2,
    type ScreenVariantV2,
} from './index'
import { createHeroResponse } from './hero'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }

const ui: ScreenUiStateV2 = {
    library: { entries: [], soleManualId: null },
    pages: { items: [], maxPages: 20, canRead: false, languageOptions: ['en'] },
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    sections: ['settings', 'about-this-check', 'tips'],
    camera: { mode: 'build-photo', permission: 'granted' },
    judge: { builtView: false },
}

function inputsFor(kind: ScreenKindV2): ScreenContextInputsV2 {
    const sessionless = ['home', 'add', 'pages', 'more', 'error', 'judge', 'compare'].includes(kind)
    const stepBound = ['guide', 'result', 'questions', 'answer', 'recovery', 'camera'].includes(kind)
    const base: ScreenContextInputsV2 = {
        kind,
        session: sessionless ? null : createDemoManual(),
        stepId: stepBound ? 'step-1' : null,
        captureId: ['result', 'answer', 'questions'].includes(kind) ? 'cap-1' : null,
        result: null,
        failure: kind === 'error' ? 'timeout' : null,
        uiState: ui,
    }
    if (kind === 'result') return { ...base, result: { kind: 'check', value: createHeroResponse('reversed') } }
    if (kind === 'answer') {
        return {
            ...base,
            result: {
                kind: 'question',
                question: 'Which way?',
                value: questionResultSchema.parse({
                    answer: 'The groove faces inward toward the divider.',
                    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                    missingEvidence: [],
                }),
            },
        }
    }
    return base
}

describe('the direct v2 fallback builder', () => {
    it('offers adding a page when reading is not earned, rather than an unearned Read manual action', () => {
        const inputs = inputsFor('pages')
        inputs.uiState = { ...inputs.uiState, pages: { ...ui.pages!, canRead: false } }
        const proposal = buildFallbackProposalV2(documentMaterialV2(inputs))
        expect(proposal.bar.primary.intent).toEqual({ intent: 'capture', target: 'add-page' })
        expect(proposal.bar.primary.label).toBe('Add page')
        expect(proposal.bar.secondary).toBeNull()
    })
    it.each(SCREEN_KINDS_V2)('%s: a pure, catalog-only proposal with every required state variant', (kind): void => {
        const material = documentMaterialV2(inputsFor(kind))
        const proposal = buildFallbackProposalV2(material)
        // Pure: the same material builds the same bytes (nothing time-, random- or order-dependent).
        expect(canonicalJson(buildFallbackProposalV2(documentMaterialV2(inputsFor(kind))))).toBe(
            canonicalJson(proposal),
        )
        expect(screenProposalV2Schema.safeParse(proposal).success).toBe(true)
        // It speaks the v2 catalog directly: a legacy v1 adapter would surface v1 node types here.
        const known = new Set<string>(NODE_TYPES_V2)
        for (const { prefix, variant } of variantsOfV2({ ...proposal })) {
            visitVariantNodesV2(variant, prefix, ({ node, path }) => {
                expect(known.has(node.type), `${path}: ${node.type}`).toBe(true)
            })
        }
        for (const state of requiredStatesV2(kind, material.requirements)) {
            expect(proposal.states[state], `${kind} ${state}`).not.toBeNull()
        }
        if (kind === 'reading') {
            const withNotice = inputsFor(kind)
            withNotice.uiState = { ...withNotice.uiState, failure: { notice: true } }
            const failure = buildFallbackProposalV2(documentMaterialV2(withNotice)).states.error!
            let bodyHeadings = 0
            let bodyLines = 0
            visitVariantNodesV2(failure, '', ({ node }) => {
                if (node.type === 'Text') {
                    if (node.role === 'heading') bodyHeadings++
                    else bodyLines++
                }
            })
            expect(failure.header.title).toEqual({ kind: 'literal', text: 'Something went wrong' })
            expect(bodyHeadings).toBe(0)
            expect(bodyLines).toBe(1)
            expect(JSON.stringify(failure.body)).toContain('operation-notice')
            expect(failure.bar.primary.label).toBe('Try again')
        }
    })

    it.each(SCREEN_KINDS_V2)(
        '%s: a complete document that claims no model work and attributes nothing to a model',
        (kind) => {
            const document = buildFallbackDocumentV2(inputsFor(kind), {
                ...deps,
                reason: 'disabled',
                evidence: 'local-deterministic',
            })
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
            expect(document.metadata).toMatchObject({
                source: 'fallback',
                evidence: 'local-deterministic',
                fallbackReason: 'disabled',
                model: null,
                effort: null,
                repaired: false,
                cacheHit: false,
            })
            expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['fallback']))
            expect(document.metadata.generatedAt).toBe('2026-02-03T04:05:06.000Z')
        },
    )

    it('passes through only what a failed model call really observed, and still never claims generated content', () => {
        const document = buildFallbackDocumentV2(
            inputsFor('guide'),
            { ...deps, reason: 'repair_failed', evidence: 'live' },
            {
                model: 'muse-wonder-1.0',
                effort: 'max',
                repaired: true,
                rejectedIssues: 3,
                generatedAt: '2026-02-03T04:00:00.000Z',
                timing: { timeToProviderMs: 4, providerMs: 900, parseValidateMs: 2, totalMs: 920 },
                usage: { inputTokens: 100, cachedTokens: null, outputTokens: 50, reasoningTokens: 10 },
            },
        )
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(document.metadata).toMatchObject({
            source: 'fallback',
            fallbackReason: 'repair_failed',
            model: 'muse-wonder-1.0',
            effort: 'max',
            repaired: true,
            rejectedIssues: 3,
            generatedAt: '2026-02-03T04:00:00.000Z',
        })
        expect(document.metadata.timing.providerMs).toBe(900)
        expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['fallback']))
    })

    // Only `rebindGeneratedStatesV2`, reading a real generated document, may attribute a variant to one. A caller of this
    // builder reports what a failed call observed; it cannot make its own template generated by saying so.
    const provenance = {
        fromScreenId: 'f'.repeat(64),
        evidence: 'live',
        model: 'muse-wonder-1.0',
        effort: 'max',
        generatedAt: '2026-02-03T04:00:00.000Z',
        promptVersion: 9,
        fixtureId: null,
    }
    it.each<[string, Record<string, unknown>]>([
        ['carried provenance naming a donor that does not exist', { carried: { pending: provenance } }],
        ['the identity of a recording that never happened', { fixtureId: 'forged-recording-id' }],
        [
            'a claim of origin and evidence',
            { source: 'generated', evidence: 'recorded-generation', fallbackReason: null },
        ],
    ])('reads observations only, never %s', (_label, forged) => {
        const observed = { model: 'muse-wonder-1.0', effort: 'max', repaired: true } as const
        const of = (extra: Record<string, unknown>): ScreenDocumentV2 => {
            const told = { ...observed, ...extra } as FallbackObservedV2
            return buildFallbackDocumentV2(
                inputsFor('guide'),
                { ...deps, reason: 'repair_failed', evidence: 'live' },
                told,
            )
        }
        const honest = of({})
        const document = of(forged)
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(document.metadata).toMatchObject({
            source: 'fallback',
            evidence: 'live',
            fallbackReason: 'repair_failed',
            model: 'muse-wonder-1.0',
            effort: 'max',
            repaired: true,
        })
        expect(document.metadata.carried).toBeUndefined()
        expect(document.metadata.fixtureId).toBeUndefined()
        expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['fallback']))
        // The forged claim changed nothing: this is the document the honest call builds, down to its identity.
        expect(canonicalJson(document)).toBe(canonicalJson(honest))
    })

    it('has no way to even write them in the type of what it is told', () => {
        expectTypeOf<FallbackObservedV2>().not.toHaveProperty('carried')
        expectTypeOf<FallbackObservedV2>().not.toHaveProperty('fixtureId')
        expectTypeOf<FallbackObservedV2>().not.toHaveProperty('source')
        expectTypeOf<FallbackObservedV2>().toHaveProperty('model')
    })
})

describe('assembly owns only what the server owns', () => {
    it('derives screenId from exactly identity, source, proposal, tables and requirements (no metadata)', () => {
        const inputs = inputsFor('guide')
        const material = documentMaterialV2(inputs)
        const proposal = buildFallbackProposalV2(material)
        const document = assembleDocumentV2(
            material,
            proposal,
            { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
            deps,
        )
        const again = assembleDocumentV2(
            material,
            proposal,
            { source: 'fallback', evidence: 'live', fallbackReason: 'timeout', model: 'muse-spark-1.3' },
            { ...deps, now: () => new Date('2030-01-01T00:00:00.000Z') },
        )
        // Provenance and timing never change identity: a cached document keeps its screenId.
        expect(again.screenId).toBe(document.screenId)
        expect(document.screenId).toBe(
            sha256Hex(
                canonicalJson({
                    bound: document.bound,
                    kind: 'guide',
                    source: 'fallback',
                    proposal,
                    facts: material.facts,
                    sources: material.sources,
                    requirements: material.requirements,
                }),
            ),
        )
    })
})

describe('state wording is stable', () => {
    // The wording of the waiting and failure screens is part of the product. These strings are pinned on purpose: changing
    // one is a deliberate edit of this test, never a side effect of changing the builder or the model prompt.
    it('keeps the registry wording of every state exactly', () => {
        expect(STATE_COPY_V2).toEqual({
            busy: { heading: 'Working on it', detail: 'One moment, please.' },
            pending: { heading: 'Working on it', detail: 'One moment, please.' },
            empty: { heading: 'Nothing here yet', detail: 'Add something to get started.' },
            error: { heading: 'Something went wrong', detail: 'Try again in a moment.' },
            recovery: { heading: 'Let us get you back on track', detail: 'Try again, or go back home.' },
            confirming: { heading: 'Stop reading?', detail: 'Reading will stop and you will go back to your pages.' },
        })
        expect(BUSY_COPY_V2).toEqual({
            working: { heading: 'Working on it', detail: 'One moment, please.' },
            reading: { heading: 'Reading your manual', detail: 'This can take a minute.' },
            checking: { heading: 'Checking your photo…', detail: 'This only takes a moment.' },
            'second-opinion': { heading: 'Taking a closer look…', detail: 'A closer look can take a little longer.' },
            asking: { heading: 'Asking…', detail: 'This only takes a moment.' },
            'question-waiting': { heading: 'Still thinking…', detail: 'Thanks for waiting.' },
            saving: { heading: 'Saving…', detail: 'This only takes a moment.' },
        })
        expect(EMPTY_COPY_V2).toEqual({
            home: { heading: 'No manuals yet', detail: 'Add a manual to start building.' },
            add: { heading: 'No pages yet', detail: 'Take a photo of the first page.' },
            pages: { heading: 'No pages yet', detail: 'Add a page to begin.' },
            questions: { heading: 'No photo yet', detail: 'Take a photo of your work first.' },
            compare: { heading: 'Nothing to compare yet', detail: 'Add two manuals to compare them.' },
        })
        expect(CONFIRM_LABELS_V2).toEqual({ keep: 'Keep reading', stop: 'Stop reading' })
    })

    const literals = (variant: ScreenVariantV2): string[] => {
        const texts: string[] = []
        visitVariantNodesV2(variant, '', ({ node }) => {
            if (node.type === 'Text' && node.content.kind === 'literal') texts.push(node.content.text)
        })
        return texts
    }

    it.each(SCREEN_KINDS_V2)(
        '%s: every state variant states its registry heading and detail, never other wording',
        (kind) => {
            const material = documentMaterialV2(inputsFor(kind))
            const proposal = buildFallbackProposalV2(material)
            // The witnessed Question still has its photo in empty, so it uses question prompts, not no-photo wording.
            const emptyCopy =
                kind === 'questions' && material.requirements.capture
                    ? { heading: 'Ask anything about this step.', detail: 'Which part is your question about?' }
                    : (EMPTY_COPY_V2[kind] ?? STATE_COPY_V2.empty)
            for (const state of VARIANT_STATES) {
                const variant = proposal.states[state]
                if (variant === null) continue
                const copy = state === 'empty' ? emptyCopy : STATE_COPY_V2[state]
                const readingFailure = kind === 'reading' && (state === 'error' || state === 'recovery')
                const stated = readingFailure
                    ? [variant.header.title.kind === 'literal' ? variant.header.title.text : '', ...literals(variant)]
                    : literals(variant)
                expect(stated, `${kind}/${state}`).toEqual(expect.arrayContaining([copy.heading, copy.detail]))
            }
        },
    )

    it('a Question with no held photo keeps the registry no-photo wording in its empty variant', () => {
        const material = documentMaterialV2({
            ...inputsFor('questions'),
            captureId: null,
            uiState: { ...ui, capture: null },
        })
        expect(material.requirements.capture).toBe(false)
        const { heading, detail } = EMPTY_COPY_V2.questions!
        expect(literals(buildFallbackProposalV2(material).states.empty!)).toEqual(
            expect.arrayContaining([heading, detail]),
        )
    })

    it.each(BUSY_ACTIVITIES_V2)(
        'a busy screen names the %s activity in its header and body, in the registry words',
        (activity) => {
            const inputs = { ...inputsFor('guide'), uiState: { ...ui, busy: { activity } } }
            const busy = buildFallbackProposalV2(documentMaterialV2(inputs)).states.busy!
            expect(busy.header.title).toEqual({ kind: 'literal', text: BUSY_COPY_V2[activity].heading })
            expect(literals(busy)).toEqual(
                expect.arrayContaining([BUSY_COPY_V2[activity].heading, BUSY_COPY_V2[activity].detail]),
            )
        },
    )
})
