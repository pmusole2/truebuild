import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    DOCUMENT_V2_LIMITS,
    SCREEN_KINDS_V2,
    VARIANT_STATES,
    captureWitnessV2,
    composeFallbackDocumentV2,
    componentPathsV2,
    createDemoManual,
    documentMaterialV2,
    intentAllowedV2,
    literalIssuesV2,
    manualSessionSchema,
    questionResultSchema,
    screenDocumentV2Schema,
    sourceIndexesOfRefsV2,
    sourceMapV2,
    structureOfV2,
    variantPolicyV2,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenUiStateV2,
} from './index'
import { createHeroResponse } from './hero'

// Regression cases for the independent review of the whole-screen v2 contracts (openai-whole-screen-v2-review.md).
// Each one failed against the reviewed source and must keep failing the unsafe input, never the guard.

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }
const SAFETY = 'Keep fingers clear of the groove while the panel is lifted.'
const PAGE = 'demo-page-1'

const ui: ScreenUiStateV2 = {
    library: {
        entries: [
            {
                manualId: 'demo-divider',
                title: 'Demo',
                updatedAt: '2026-01-01T00:00:00.000Z',
                stopStepId: 'step-1',
                completed: 0,
                total: 2,
                firstPageId: PAGE,
            },
        ],
        soleManualId: 'demo-divider',
    },
    pages: {
        items: [{ pageId: PAGE, width: 1200, height: 900 }],
        maxPages: 20,
        canRead: true,
        languageOptions: ['en'],
    },
    review: {
        currentQuestion: {
            questionId: 'q1',
            kind: 'orientation',
            stepId: 'step-1',
            stepOrder: 1,
            reason: 'Check this.',
            parts: [],
        },
        blockers: 0,
        canConfirm: true,
    },
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    sections: ['settings', 'about-this-check', 'tips'],
    camera: { mode: 'build-photo', permission: 'granted' },
    judge: { builtView: false },
}

function manual(safetyNotes: number | 'unclassified' = 1, refsPerNote = 1): ManualSession {
    const session = createDemoManual()
    const step = session.reviewedSteps[0]!
    if (safetyNotes === 'unclassified') {
        delete step.safetyNotes
    } else {
        step.safetyNotes = Array.from({ length: safetyNotes }, (_, note) => ({
            noteId: `n${note}`,
            note: {
                state: 'known' as const,
                value: note === 0 ? SAFETY : `Keep fingers clear near connection ${note}.`,
                sourceRefs: Array.from({ length: refsPerNote }, (_unused, ref) => ({
                    pageId: PAGE,
                    region:
                        refsPerNote === 1 && note === 0
                            ? null
                            : { x: (note % 100) / 200, y: (ref % 100) / 200, width: 0.004, height: 0.004 },
                })),
            },
        }))
    }
    return session
}

const STEP_KINDS = ['guide', 'result', 'questions', 'answer', 'recovery', 'camera']
function inputsFor(kind: ScreenKindV2, session: ManualSession = manual()): ScreenContextInputsV2 {
    const base: ScreenContextInputsV2 = {
        kind,
        session: ['home', 'add', 'pages', 'more', 'error', 'judge', 'compare'].includes(kind) ? null : session,
        stepId: STEP_KINDS.includes(kind) ? 'step-1' : null,
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
                    sourceRefs: [{ pageId: PAGE, region: null }],
                    missingEvidence: ['A closer photo would help.'],
                }),
            },
        }
    }
    return base
}

const compose = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    composeFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })
const clone = (document: ScreenDocumentV2): ScreenDocumentV2 => structuredClone(document)
const messages = (document: unknown): string[] => {
    const parsed = screenDocumentV2Schema.safeParse(document)
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe('withheld results cannot be opened from a collapsed disclosure', () => {
    it.each(['result', 'answer'] as const)(
        'rejects hidden %s text and cards in every waiting or failure state',
        (kind) => {
            const base = compose(inputsFor(kind))
            const result = base.facts.find((fact) => fact.basis === 'result')!
            for (const name of ['busy', 'pending', 'error', 'recovery'] as const) {
                const nodes: ScreenNodeV2[] = [
                    {
                        type: 'Text',
                        content: { kind: 'fact', factId: result.factId },
                        role: 'body',
                        emphasis: 'normal',
                        tone: 'neutral',
                        align: 'start',
                    },
                    {
                        type: 'VerdictCard',
                        result: kind === 'result' ? 'check' : 'question',
                        variant: 'card',
                        showReason: true,
                        showRegions: false,
                    },
                ]
                for (const node of nodes) {
                    const document = clone(base)
                    const variant = document.states[name]!
                    if (!('children' in variant.body)) throw new Error('fixture needs a body container')
                    variant.body.children.push({
                        type: 'Section',
                        title: null,
                        collapsible: true,
                        initiallyOpen: false,
                        children: [node],
                    })
                    document.metadata.sourceMap = sourceMapV2(document)
                    document.metadata.origins = Object.fromEntries(
                        componentPathsV2(document).map((path) => [path, document.metadata.source]),
                    )
                    expect(messages(document)).toContain(
                        node.type === 'Text'
                            ? `The ${name} variant states the held result before it is revealed`
                            : `The ${name} variant claims a camera it cannot have`,
                    )
                }
            }
        },
    )
})

/**
 * Moves every node matching `pick` out of the ready body into one unopened (collapsed) section: present, but not visible.
 * Overlays are tooltip coach marks only (a sheet is not a published overlay), so this is how a node ends up hidden.
 */
function intoSheet(document: ScreenDocumentV2, pick: (node: ScreenNodeV2) => boolean): ScreenDocumentV2 {
    const next = clone(document)
    const moved: ScreenNodeV2[] = []
    const strip = (node: ScreenNodeV2): ScreenNodeV2 => {
        if (!('children' in node)) return node
        return {
            ...node,
            children: node.children.flatMap((child) => {
                if (pick(child)) {
                    moved.push(child)
                    return []
                }
                return [strip(child)]
            }),
        } as ScreenNodeV2
    }
    next.body = strip(next.body)
    if (moved.length === 0) throw new Error('nothing to move')
    next.body = {
        type: 'Scroll',
        axis: 'vertical',
        children: [
            next.body,
            { type: 'Section', title: null, collapsible: true, initiallyOpen: false, children: moved },
        ],
    }
    return next
}

describe('nothing hidden discharges a visible requirement (finding 2)', () => {
    it('rejects a guide whose only safety text sits in an unopened sheet', () => {
        const document = compose(inputsFor('guide'))
        const hidden = intoSheet(
            document,
            (node) => node.type === 'Text' && node.content.kind === 'fact' && node.content.factId.startsWith('safety:'),
        )
        expect(messages(hidden)).toContain('A required fact is missing from the ready variant')
    })

    it('rejects required citations, actions and native nodes that exist only in an overlay', () => {
        const guide = compose(inputsFor('guide'))
        expect(messages(intoSheet(guide, (node) => ['Citation', 'ManualPage', 'Image'].includes(node.type)))).toContain(
            'A required citation is missing',
        )
        const camera = compose(inputsFor('camera'))
        expect(messages(intoSheet(camera, (node) => node.type === 'CameraView'))).toContain(
            'A required CameraView is missing',
        )
        const next = clone(guide)
        const hiddenAction: ScreenNodeV2 = { ...next.bar.primary, type: 'SecondaryAction' }
        next.body = {
            type: 'Scroll',
            axis: 'vertical',
            children: [
                next.body,
                { type: 'Section', title: null, collapsible: true, initiallyOpen: false, children: [hiddenAction] },
            ],
        }
        next.bar = { primary: { ...next.bar.primary, intent: { intent: 'navigate', target: 'home' } }, secondary: null }
        expect(messages(next)).toContain('A required action is missing')
    })

    it('reports every overlay node as hidden', () => {
        const document = compose(inputsFor('guide'))
        const seen: boolean[] = []
        for (const { prefix, variant } of variantsOfV2(document)) {
            visitVariantNodesV2(variant, prefix, (entry) => {
                if (entry.path.includes('overlays.')) seen.push(entry.hidden)
            })
        }
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every(Boolean)).toBe(true)
    })
})

describe('every selected variant keeps its own safety, citations and recovery (finding 8)', () => {
    const stripCitations = (node: ScreenNodeV2): ScreenNodeV2 =>
        !('children' in node)
            ? node
            : ({
                  ...node,
                  children: node.children.filter((child) => child.type !== 'Citation').map(stripCitations),
              } as ScreenNodeV2)

    it.each(VARIANT_STATES)('rejects a %s variant that lost its required citations', (state) => {
        const document = clone(compose(inputsFor('guide')))
        const variant = document.states[state]
        if (variant === null) return
        variant.body = stripCitations(variant.body)
        expect(messages(document)).toContain(`A required citation is missing from the ${state} variant`)
    })

    it('requires a retry or navigate action in error and recovery, and none in busy or pending', () => {
        const base = compose(inputsFor('guide'))
        for (const state of ['error', 'recovery'] as const) {
            const next = clone(base)
            const variant = next.states[state]!
            variant.bar = {
                primary: { ...variant.bar.primary, intent: { intent: 'capture', target: 'take-photo' } },
                secondary: null,
            }
            variant.header = { ...variant.header, back: null, actions: [] }
            expect(messages(next)).toContain(`The ${state} variant offers no way to recover`)
        }
        expect(messages(base)).toEqual([])
    })

    it('does not require the camera in an error state but never lets one claim it', () => {
        const camera = compose(inputsFor('camera'))
        expect(messages(camera)).toEqual([])
        expect(camera.states.error!.body).not.toMatchObject({ type: 'CameraView' })
        const next = clone(camera)
        next.states.error!.body = {
            type: 'Stack',
            gap: 'md',
            align: 'stretch',
            children: [
                { type: 'CameraView', mode: 'build-photo', cue: 'Hold steady', pill: null, tipTarget: null },
                next.states.error!.body,
            ],
        }
        expect(messages(next)).toContain('The error variant claims a camera it cannot have')
    })

    it('has a policy for every variant of every kind', () => {
        for (const kind of SCREEN_KINDS_V2) {
            const requirements = documentMaterialV2(inputsFor(kind)).requirements
            const ready = variantPolicyV2(kind, 'ready', requirements)
            expect(ready.actions).toEqual(requirements.actions)
            expect(ready.nodes).toEqual(requirements.nodes)
            for (const state of VARIANT_STATES) {
                const policy = variantPolicyV2(kind, state, requirements)
                // VARIANT_STATES contains only non-ready states. A photo-first result is withheld in every one.
                const waiting = state === 'busy' || state === 'pending'
                const withheld = waiting || requirements.capture
                expect(policy.facts).toEqual(
                    withheld ? requirements.facts.filter((id) => !id.startsWith('result:')) : requirements.facts,
                )
                if (!waiting) expect(policy.sources).toEqual(requirements.sources)
                expect(policy.recover).toBe(state === 'error' || state === 'recovery')
            }
        }
    })
})

describe('published source map and references are exact (finding 6)', () => {
    it('rejects an empty, partial or altered source map', () => {
        const document = compose(inputsFor('guide'))
        expect(Object.keys(sourceMapV2(document)).length).toBeGreaterThan(0)
        expect(messages({ ...document, metadata: { ...document.metadata, sourceMap: {} } })).toContain(
            'Source map must equal the recomputed map',
        )
        const [path] = Object.keys(document.metadata.sourceMap)
        const altered = { ...document.metadata.sourceMap, [path!]: [] }
        expect(messages({ ...document, metadata: { ...document.metadata, sourceMap: altered } })).toContain(
            'Source map must equal the recomputed map',
        )
        expect(messages(document)).toEqual([])
    })

    it('rejects an unknown fact in any header, ready or state', () => {
        const ready = clone(compose(inputsFor('guide')))
        ready.header = { ...ready.header, title: { kind: 'fact', factId: 'unknown-fact' } }
        expect(messages(ready)).toContain('A node states an unknown fact')
        const state = clone(compose(inputsFor('guide')))
        state.states.busy!.header = { ...state.states.busy!.header, subtitle: { kind: 'fact', factId: 'nope' } }
        expect(messages(state)).toContain('A node states an unknown fact')
    })

    it('maps a header that states a fact to that fact sources', () => {
        const document = clone(compose(inputsFor('guide')))
        const safety = document.facts.find((fact) => fact.kind === 'safety')!
        document.header = { ...document.header, subtitle: { kind: 'fact', factId: safety.factId } }
        expect(sourceMapV2(document).header).toBeDefined()
    })
})

describe('the complete source registry precedes any limit (finding 4)', () => {
    function withManySources(count: number): ManualSession {
        const session = manual(1)
        const step = session.reviewedSteps[0]!
        step.sourceRefs = Array.from({ length: count }, (_, index) => ({
            pageId: PAGE,
            region: { x: (index % 90) / 100, y: Math.floor(index / 90) / 100, width: 0.005, height: 0.005 },
        }))
        step.safetyNotes = [
            {
                noteId: 'late',
                note: {
                    state: 'known',
                    value: 'Keep fingers clear.',
                    sourceRefs: [{ pageId: PAGE, region: { x: 0.9, y: 0.9, width: 0.05, height: 0.05 } }],
                },
            },
        ]
        return session
    }

    it('keeps a 65th distinct source and the safety citation that depends on it', () => {
        const session = withManySources(65)
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        const material = documentMaterialV2(inputsFor('guide', session))
        const safety = material.facts.find((fact) => fact.kind === 'safety')!
        const indexes = sourceIndexesOfRefsV2(material.sources, safety.sourceRefs)
        expect(indexes.length).toBe(safety.sourceRefs.length)
        expect(indexes.every((index) => material.requirements.sources.includes(index))).toBe(true)
        expect(material.sourcePrecision).toBe('region')
        expect(messages(compose(inputsFor('guide', session)))).toEqual([])
    })

    it('uses page-level sources, still complete, when exact regions exceed the cap', () => {
        const session = manual(4, 100)
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        const material = documentMaterialV2(inputsFor('guide', session))
        expect(material.sourcePrecision).toBe('page')
        expect(material.sources.every((source) => source.region === null)).toBe(true)
        const safety = material.facts.find((fact) => fact.kind === 'safety')!
        const indexes = sourceIndexesOfRefsV2(material.sources, safety.sourceRefs)
        expect(indexes.length).toBeGreaterThan(0)
        expect(indexes.every((index) => material.requirements.sources.includes(index))).toBe(true)
        expect(messages(compose(inputsFor('guide', session)))).toEqual([])
    })
})

describe('the complete deterministic document is valid for every valid manual (finding 3)', () => {
    const perVariantNodes = (document: ScreenDocumentV2): number[] =>
        variantsOfV2(document).map(({ prefix, variant }) => {
            let count = 0
            visitVariantNodesV2(variant, prefix, () => (count += 1))
            return count
        })

    it.each([
        ['33 safety notes', manual(33)],
        ['100 safety notes, one region each', manual(100)],
        ['100 safety notes with 100 distinct regions each', manual(100, 100)],
        ['an unclassified step', manual('unclassified')],
    ])('composes %s into a valid document with every fact in every variant', (_name, session) => {
        expect(manualSessionSchema.safeParse(session).success).toBe(true)
        for (const kind of ['guide', 'camera', 'recovery'] as const) {
            const document = compose(inputsFor(kind, session))
            expect(messages(document)).toEqual([])
            const required = document.requirements.facts.length
            expect(required).toBeGreaterThan(0)
            expect(Math.max(...perVariantNodes(document))).toBeLessThanOrEqual(DOCUMENT_V2_LIMITS.nodes)
            expect(structureOfV2(document).nodes).toBeLessThanOrEqual(DOCUMENT_V2_LIMITS.documentNodes)
        }
    })

    it('covers the largest valid step: 100 safety notes and 100 missing-evidence entries on a result', () => {
        const session = manual(100, 100)
        const inputs = inputsFor('result', session)
        const withMissing: ScreenContextInputsV2 = {
            ...inputs,
            result: {
                kind: 'check',
                value: {
                    ...createHeroResponse('reversed'),
                    missingEvidence: Array.from({ length: 100 }, (_, index) => `Evidence ${index} is not visible.`),
                },
            },
        }
        const document = compose(withMissing)
        expect(messages(document)).toEqual([])
        expect(document.facts.length).toBeLessThanOrEqual(DOCUMENT_V2_LIMITS.facts)
    })
})

describe('confirming a step needs a held pass (finding 7)', () => {
    it('allows confirm step only with a held pass, in every kind', () => {
        for (const kind of SCREEN_KINDS_V2) {
            const material = documentMaterialV2(inputsFor(kind))
            const allowed = intentAllowedV2({ intent: 'confirm', target: 'step' }, material)
            expect(allowed, kind).toBe(false)
        }
        const pass = documentMaterialV2({
            ...inputsFor('result'),
            result: { kind: 'check', value: createHeroResponse('correct') },
        })
        expect(pass.decision).toBe('pass')
        expect(intentAllowedV2({ intent: 'confirm', target: 'step' }, pass)).toBe(true)
    })

    it('ties manual-fact and reading confirmation to their own witnesses', () => {
        const withUi = (patch: Partial<ScreenUiStateV2>, kind: ScreenKindV2): ReturnType<typeof documentMaterialV2> =>
            documentMaterialV2({ ...inputsFor(kind), uiState: { ...ui, ...patch } })
        expect(
            intentAllowedV2(
                { intent: 'confirm', target: 'facts' },
                withUi({ review: { ...ui.review!, canConfirm: false } }, 'quick-check'),
            ),
        ).toBe(false)
        expect(intentAllowedV2({ intent: 'confirm', target: 'facts' }, withUi({}, 'quick-check'))).toBe(true)
        expect(
            intentAllowedV2(
                { intent: 'confirm', target: 'reading' },
                withUi({ pages: { ...ui.pages!, canRead: false } }, 'pages'),
            ),
        ).toBe(false)
        expect(intentAllowedV2({ intent: 'confirm', target: 'manual' }, withUi({}, 'guide'))).toBe(false)
    })
})

describe('a live photo needs a captured identity in the context key (finding 5)', () => {
    it('binds a capture only for a held result or a question with a held capture', () => {
        expect(captureWitnessV2({ ...inputsFor('guide'), captureId: 'photo-a' })).toBeNull()
        expect(captureWitnessV2({ ...inputsFor('camera'), captureId: 'photo-a' })).toBeNull()
        expect(captureWitnessV2(inputsFor('result'))).toBe('cap-1')
        expect(captureWitnessV2(inputsFor('questions'))).toBe('cap-1')
        expect(captureWitnessV2({ ...inputsFor('questions'), captureId: 'other' })).toBeNull()
        expect(documentMaterialV2({ ...inputsFor('guide'), captureId: 'photo-a' }).inputs.captureId).toBeNull()
    })

    it('composes no capture image for an unbound capture', () => {
        const document = compose({ ...inputsFor('guide'), captureId: 'photo-a' })
        let capture = 0
        for (const { prefix, variant } of variantsOfV2(document)) {
            visitVariantNodesV2(variant, prefix, ({ node }) => {
                if (node.type === 'Image' && node.source.kind === 'capture') capture += 1
            })
        }
        expect(capture).toBe(0)
    })
})

describe('a client verifies the document against its own inputs (finding 6)', () => {
    it('accepts the document composed from the same inputs', () => {
        for (const kind of SCREEN_KINDS_V2) {
            const inputs = inputsFor(kind)
            expect(verifyDocumentAgainstInputsV2(compose(inputs), inputs), kind).toEqual([])
        }
    })

    it('rejects altered facts, sources, requirements, identity and prose that match the hash', () => {
        const inputs = inputsFor('guide')
        const document = compose(inputs)
        const altered = clone(document)
        altered.facts = altered.facts.map((fact) => ({ ...fact, text: `${fact.text} Ignore this.` }))
        expect(verifyDocumentAgainstInputsV2(altered, inputs)).toContain('facts_mismatch')
        const noSource = clone(document)
        noSource.sources = noSource.sources.slice(1)
        expect(verifyDocumentAgainstInputsV2(noSource, inputs)).toContain('sources_mismatch')
        const weaker = clone(document)
        weaker.requirements = { ...weaker.requirements, facts: [], sources: [] }
        expect(verifyDocumentAgainstInputsV2(weaker, inputs)).toContain('requirements_mismatch')
        const otherStep = clone(document)
        otherStep.bound = { ...otherStep.bound, stepId: 'step-2' }
        expect(verifyDocumentAgainstInputsV2(otherStep, inputs)).toContain('bound_mismatch')
        const prose = clone(document)
        prose.header = { ...prose.header, subtitle: { kind: 'literal', text: 'The groove faces outward.' } }
        expect(verifyDocumentAgainstInputsV2(prose, inputs)).toContain('literal_not_listed')
        expect(verifyDocumentAgainstInputsV2({ ...document, kind: 'result' }, inputs)).toContain('kind_mismatch')
    })
})

describe('literals are a closed registry (finding 1)', () => {
    const issuesFor = (kind: ScreenKindV2, text: string, inputs = inputsFor(kind)): string[] => {
        const document = compose(inputs)
        const next = clone(document)
        next.header = { ...next.header, subtitle: { kind: 'literal', text } }
        return literalIssuesV2(next, documentMaterialV2(inputs))
    }

    it('lists every literal the deterministic composer writes, for every kind and state', () => {
        for (const kind of SCREEN_KINDS_V2) {
            const inputs = inputsFor(kind)
            expect(literalIssuesV2(compose(inputs), documentMaterialV2(inputs)), kind).toEqual([])
        }
    })

    it.each(['The groove faces outward.', 'This step is complete.', 'Everything is correct', 'Verified by the manual'])(
        'rejects factual prose without digits: %s',
        (text) => {
            expect(issuesFor('guide', text)).not.toEqual([])
        },
    )

    it('lists claim wording only when the held result or witnessed completion earns it, in any position', () => {
        expect(issuesFor('result', 'Looks right')).not.toEqual([])
        expect(issuesFor('guide', 'Looks right')).not.toEqual([])
        expect(issuesFor('completion', 'All steps done')).not.toEqual([])
        const pass: ScreenContextInputsV2 = {
            ...inputsFor('result'),
            result: { kind: 'check', value: createHeroResponse('correct') },
        }
        expect(issuesFor('result', 'Looks right', pass)).toEqual([])
    })
})

describe('the question and answer screens use the held photo (UI recovery integration)', () => {
    const nodesOf = (document: ScreenDocumentV2): ScreenNodeV2[] => {
        const found: ScreenNodeV2[] = []
        visitVariantNodesV2(document, '', ({ node }) => found.push(node))
        return found
    }
    const choices = (document: ScreenDocumentV2): ScreenNodeV2[] =>
        nodesOf(document).filter((node) => node.type === 'Choice')

    it('offers the part target Choice with the held photo, preselecting nothing', () => {
        const inputs = inputsFor('questions')
        const document = compose(inputs)
        expect(documentMaterialV2(inputs).partIds.length).toBeGreaterThan(0)
        expect(choices(document)).toEqual([
            {
                type: 'Choice',
                prompt: { kind: 'literal', text: 'Which part is your question about?' },
                options: { mode: 'bound', binding: 'part-target' },
            },
        ])
        const types = nodesOf(document).map((node) => node.type)
        expect(types.indexOf('Image')).toBeLessThan(types.indexOf('Choice'))
        expect(types.indexOf('Choice')).toBeLessThan(types.indexOf('TextField'))
        expect(messages(document)).toEqual([])
    })

    it('offers no target without a held photo or without named parts', () => {
        const noCapture = { ...inputsFor('questions'), uiState: { ...ui, capture: null }, captureId: null }
        expect(choices(compose(noCapture))).toEqual([])
        const partless = manual()
        partless.reviewedSteps[0]!.parts = []
        expect(choices(compose(inputsFor('questions', partless)))).toEqual([])
    })

    it('shows the held photo on the answer and result screens, and on no other', () => {
        const withCapture = (kind: ScreenKindV2): number =>
            nodesOf(compose(inputsFor(kind))).filter((node) => node.type === 'Image' && node.source.kind === 'capture')
                .length
        expect(withCapture('answer')).toBe(1)
        expect(withCapture('result')).toBe(1)
        for (const kind of ['guide', 'camera', 'recovery', 'completion'] as const) expect(withCapture(kind)).toBe(0)
    })
})
