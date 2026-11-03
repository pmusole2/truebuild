import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    DOCUMENT_V2_LIMITS,
    assembleDocumentV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    manualSessionSchema,
    questionResultSchema,
    screenDocumentV2Schema,
    structureOfV2,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
} from './index'
import { createHeroResponse } from './hero'

/**
 * F1: a classified step whose extraction could not read a printed safety note (`state: 'unknown'`) is a valid unreviewed
 * extraction. The document must still say, in every variant, that a safety note could not be read, without inventing the
 * note, citing a source for it or repeating the extraction's own reason. The id and the words are asserted literally:
 * they are the published contract, not a detail of one implementation.
 */

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }
const PAGE = 'demo-page-1'
const KNOWN = 'Keep fingers clear of the groove while the panel is lifted.'
const REASON = 'The warning box beside the diagram is cut off by the fold.'
const OTHER_REASON = 'The icon under the second warning is smudged beyond reading.'
const MARKER = 'state:safety-unreadable'
const COPY = 'A safety note could not be read. Add a clearer page before building.'

const known = (noteId: string, value: string = KNOWN): Record<string, unknown> => ({
    noteId,
    note: { state: 'known', value, sourceRefs: [{ pageId: PAGE, region: null }] },
})
const unreadable = (noteId: string, reason: string): Record<string, unknown> => ({
    noteId,
    note: { state: 'unknown', reason },
})

/**
 * A valid UNREVIEWED manual, so the raw extraction is its only basis. `first` and `second` are the explicit safety
 * classification of step 1 and step 2 (`undefined`: the step was never classified, the legacy shape).
 */
function extracted(first: readonly unknown[] | undefined, second?: readonly unknown[]): ManualSession {
    const draft = createDemoManual()
    const classify = (step: object, notes: readonly unknown[] | undefined): object =>
        notes === undefined ? step : { ...step, safetyNotes: notes }
    return manualSessionSchema.parse({
        ...draft,
        reviewStatus: 'unreviewed',
        reviewedSteps: [],
        rawExtraction: {
            parts: draft.parts,
            steps: draft.rawExtraction!.steps.map((step, at) => classify(step, at === 0 ? first : second)),
            unknowns: [],
        },
    })
}

/**
 * A REVIEWED manual whose original extraction (kept as raw evidence) still holds an unreadable note. The reviewed steps
 * are the basis of a reviewed manual, so stale raw evidence must not make a document say a note is unreadable.
 */
function reviewedWithStaleExtraction(): ManualSession {
    const reviewed = createDemoManual()
    Object.assign(reviewed.rawExtraction!.steps[0]!, { safetyNotes: [unreadable('n2', REASON)] })
    return manualSessionSchema.parse(reviewed)
}

const ui: ScreenUiStateV2 = {
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    camera: { mode: 'build-photo', permission: 'granted' },
    sections: ['settings', 'about-this-check', 'tips'],
}

/** Every screen kind that is bound to one step. */
const STEP_BOUND = ['guide', 'recovery', 'camera', 'questions', 'result', 'answer', 'more'] as const
/**
 * The step-bound screens a manual that has not been reviewed yet can show, checked as complete documents. The rest need
 * a reviewed manual (a camera, a held photo, a question) and are covered through the shared material above.
 */
const UNREVIEWED_SCREENS = ['guide', 'recovery', 'more'] as const

function inputsFor(
    kind: ScreenKindV2,
    session: ManualSession | null,
    stepId: string | null = 'step-1',
): ScreenContextInputsV2 {
    const photo = kind === 'questions' || kind === 'result' || kind === 'answer'
    return {
        kind,
        session,
        stepId,
        captureId: photo ? 'cap-1' : null,
        result:
            kind === 'result'
                ? { kind: 'check', value: createHeroResponse('reversed') }
                : kind === 'answer'
                  ? {
                        kind: 'question',
                        question: 'Which way?',
                        value: questionResultSchema.parse({
                            answer: 'The groove faces inward toward the divider.',
                            sourceRefs: [{ pageId: PAGE, region: null }],
                            missingEvidence: [],
                        }),
                    }
                  : null,
        failure: null,
        uiState: kind === 'more' ? { ...ui, capture: null } : ui,
    }
}

const build = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })
const messages = (document: unknown): string[] => {
    const parsed = screenDocumentV2Schema.safeParse(document)
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}
const markers = (facts: readonly { factId: string }[]): string[] =>
    facts.map((fact) => fact.factId).filter((factId) => factId.startsWith('state:'))

/** Fact ids a variant states without opening anything. */
function visibleFacts(document: ScreenDocumentV2, name: string): string[] {
    const { prefix, variant } = variantsOfV2(document).find((entry) => entry.name === name)!
    const visible: string[] = []
    visitVariantNodesV2(variant, prefix, ({ node, hidden }) => {
        if (!hidden && node.type === 'Text' && node.content.kind === 'fact') visible.push(node.content.factId)
    })
    return visible
}

const isMarker = (node: ScreenNodeV2): boolean =>
    node.type === 'Text' && node.content.kind === 'fact' && node.content.factId === MARKER
/** Rewrites every descendant once, children before their parent, so a replacement is never rewritten again. */
const rewrite = (node: ScreenNodeV2, change: (child: ScreenNodeV2) => ScreenNodeV2 | null): ScreenNodeV2 =>
    'children' in node
        ? ({
              ...node,
              children: node.children.flatMap((child) => {
                  const next = change(rewrite(child, change))
                  return next === null ? [] : [next]
              }),
          } as ScreenNodeV2)
        : node
const closed = (child: ScreenNodeV2): ScreenNodeV2 => ({
    type: 'Section',
    title: null,
    collapsible: true,
    initiallyOpen: false,
    children: [child],
})

/** The fallback proposal with one variant's body rewritten, re-assembled as the server would publish it. */
function republished(
    inputs: ScreenContextInputsV2,
    name: string,
    change: (child: ScreenNodeV2) => ScreenNodeV2 | null,
): ScreenDocumentV2 {
    const material = documentMaterialV2(inputs)
    const proposal = buildFallbackProposalV2(material)
    const edit = (body: ScreenNodeV2): ScreenNodeV2 => rewrite(body, change)
    const next: ScreenProposalV2 =
        name === 'ready'
            ? { ...proposal, body: edit(proposal.body) }
            : {
                  ...proposal,
                  states: {
                      ...proposal.states,
                      [name]: {
                          ...proposal.states[name as keyof ScreenProposalV2['states']]!,
                          body: edit(proposal.states[name as keyof ScreenProposalV2['states']]!.body),
                      },
                  },
              }
    return assembleDocumentV2(
        material,
        next,
        { source: 'fallback', evidence: 'local-deterministic', fallbackReason: 'disabled' },
        deps,
    )
}

describe('an unreadable safety note stays visible in the document (F1)', () => {
    const session = extracted([known('n1'), unreadable('n2', REASON), unreadable('n3', OTHER_REASON)])

    it.each(STEP_BOUND)(
        '%s: states ONE fixed, source-free explanation beside the known note, and no raw reason',
        (kind) => {
            const material = documentMaterialV2(inputsFor(kind, session))
            const safety = material.facts.filter((fact) => fact.kind === 'safety')
            expect(safety).toEqual([
                { factId: MARKER, kind: 'safety', basis: 'unresolved-safety', text: COPY, sourceRefs: [] },
                {
                    factId: 'safety:n1',
                    kind: 'safety',
                    basis: 'safety-note',
                    text: KNOWN,
                    sourceRefs: [{ pageId: PAGE, region: null }],
                },
            ])
            // Required like a known safety note, so it is never an optional detail.
            expect(material.requirements.facts).toEqual(expect.arrayContaining([MARKER, 'safety:n1']))
            expect(markers(material.facts)).toEqual([MARKER])
            // The extraction's own reasons are not the manual's words and are not shown: only the fixed sentence is.
            expect(JSON.stringify(material.facts)).not.toContain('cut off')
            expect(JSON.stringify(material.facts)).not.toContain('smudged')
            expect(material.facts.filter((fact) => fact.basis === 'safety-note').map((fact) => fact.factId)).toEqual([
                'safety:n1',
            ])
        },
    )

    it('is stated even when no note could be read at all, once however many were unreadable', () => {
        const only = extracted(Array.from({ length: 100 }, (_unused, at) => unreadable(`n${at}`, `${REASON} ${at}`)))
        for (const kind of STEP_BOUND) {
            const material = documentMaterialV2(inputsFor(kind, only))
            expect(markers(material.facts)).toEqual([MARKER])
            expect(material.facts.filter((fact) => fact.kind === 'safety')).toHaveLength(1)
            expect(material.requirements.facts).toContain(MARKER)
        }
    })

    it.each(UNREVIEWED_SCREENS)(
        '%s: the complete fallback states it visibly in the ready screen and in every state variant, cited to nothing',
        (kind) => {
            const inputs = inputsFor(kind, session)
            const controlInputs = inputsFor(kind, extracted([known('n1')]))
            const control = build(controlInputs)
            const document = build(inputs)
            expect(messages(document)).toEqual([])
            // The marker adds no client issue of its own: whatever the same screen already reports without it (a retry
            // an unreviewed recovery cannot earn, say) is all that is reported with it.
            expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual(
                verifyDocumentAgainstInputsV2(control, controlInputs, sha256Hex),
            )
            const names = variantsOfV2(document).map((entry) => entry.name)
            expect(names).toEqual(expect.arrayContaining(['ready', 'busy', 'pending', 'error', 'recovery']))
            for (const name of names) {
                expect(visibleFacts(document, name), name).toEqual(expect.arrayContaining([MARKER, 'safety:n1']))
            }
            expect(document.facts.find((fact) => fact.factId === MARKER)).toMatchObject({ text: COPY, sourceRefs: [] })
            // Nothing is cited, invented or repeated for it: the same tables the note alone would have produced.
            expect(document.facts.filter((fact) => fact.factId !== MARKER)).toEqual(control.facts)
            expect(document.sources).toEqual(control.sources)
            expect(document.requirements.sources).toEqual(control.requirements.sources)
            expect(JSON.stringify(document)).not.toContain('cut off')
            expect(JSON.stringify(document)).not.toContain('smudged')
        },
    )

    it.each(UNREVIEWED_SCREENS)('%s: a document that omits or hides it in any variant is rejected', (kind) => {
        const inputs = inputsFor(kind, session)
        const names = variantsOfV2(build(inputs)).map((entry) => entry.name)
        for (const name of names) {
            const missing = `A required fact is missing from the ${name} variant`
            const omitted = republished(inputs, name, (child) => (isMarker(child) ? null : child))
            expect(messages(omitted), `omitted from ${name}`).toEqual([missing])
            const hidden = republished(inputs, name, (child) => (isMarker(child) ? closed(child) : child))
            expect(messages(hidden), `hidden in ${name}`).toEqual([missing])
        }
        // Control: the very same rewrite of a variant that does not carry the marker changes nothing.
        expect(messages(republished(inputs, 'ready', (child) => child))).toEqual([])
    })

    it('is required by the client from its own inputs, in both directions', () => {
        const withNote = inputsFor('guide', session)
        const without = inputsFor('guide', extracted([known('n1')]))
        // A server that dropped the unreadable note (the old behaviour) is caught by a client that holds it.
        expect(verifyDocumentAgainstInputsV2(build(without), withNote, sha256Hex)).toEqual(
            expect.arrayContaining(['facts_mismatch', 'requirements_mismatch']),
        )
        // And a marker the client's manual does not earn is refused.
        expect(verifyDocumentAgainstInputsV2(build(withNote), without, sha256Hex)).toEqual(
            expect.arrayContaining(['facts_mismatch', 'requirements_mismatch']),
        )
    })

    it.each([
        ['an explicit empty classification', extracted([])],
        ['only readable notes', extracted([known('n1')])],
        ['a legacy step that was never classified', extracted(undefined)],
        ['an unreadable note on a different step', extracted([known('n1')], [unreadable('n9', REASON)])],
        ['a reviewed manual whose original extraction had an unreadable note', reviewedWithStaleExtraction()],
    ])('adds no marker for %s', (_name, subject) => {
        for (const kind of STEP_BOUND) {
            const material = documentMaterialV2(inputsFor(kind, subject))
            expect(markers(material.facts), kind).toEqual([])
            expect(
                material.facts.filter((fact) => fact.basis === 'unresolved-safety'),
                kind,
            ).toEqual([])
            expect(material.requirements.facts, kind).not.toContain(MARKER)
        }
    })

    it('keeps legacy unclassified detail mandatory outside Guide and Guide checks separate', () => {
        const inputs = inputsFor('guide', extracted(undefined))
        const guide = documentMaterialV2(inputs)
        expect(guide.requirements.facts).toEqual(['title'])
        expect(
            guide.facts
                .filter((fact) => fact.kind === 'orientation' || fact.kind === 'connection' || fact.kind === 'check')
                .every((fact) => fact.basis === 'direction'),
        ).toBe(true)
        const material = documentMaterialV2({ ...inputs, kind: 'camera' })
        const required = material.facts.filter((fact) => material.requirements.facts.includes(fact.factId))
        expect(required.map((fact) => [fact.factId, fact.basis])).toEqual([
            ['title', 'unclassified-step'],
            ['orientation', 'unclassified-step'],
            ['connection', 'unclassified-step'],
            ['check:groove-inward', 'unclassified-step'],
            ['correction:turn-panel', 'unclassified-step'],
        ])
    })

    // Even with the step's id in hand, a screen that is not bound to the step states none of its safety.
    it.each(['quick-check', 'home', 'pages', 'completion'] as const)(
        '%s is not bound to a step, so it states no step safety',
        (kind) => {
            const material = documentMaterialV2({ ...inputsFor(kind, session), uiState: null })
            expect(material.stepBound).toBe(false)
            expect(markers(material.facts)).toEqual([])
        },
    )

    it('states no step safety on a page photo camera or a More that has no step', () => {
        const manualPhoto = documentMaterialV2({
            ...inputsFor('camera', session),
            uiState: { camera: { mode: 'manual-page', permission: 'granted' } },
        })
        expect(manualPhoto.stepBound).toBe(false)
        expect(markers(manualPhoto.facts)).toEqual([])
        const global = documentMaterialV2({ ...inputsFor('more', session, null), uiState: null })
        expect(global.stepBound).toBe(false)
        expect(markers(global.facts)).toEqual([])
    })

    it('still rejects an unreadable safety note in a reviewed manual: reviewing and building stay blocked', () => {
        const value = createDemoManual() as unknown as { reviewedSteps: Record<string, unknown>[] }
        value.reviewedSteps[0]!.safetyNotes = [unreadable('n2', REASON)]
        const parsed = manualSessionSchema.safeParse(value)
        expect(parsed.success).toBe(false)
        expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
            'Reviewed manual has unresolved critical facts or review',
        )
    })
})

describe('the unreadable-safety explanation respects the schema maxima', () => {
    const ref = { pageId: PAGE, region: null }
    const knownFact = (value: string): Record<string, unknown> => ({ state: 'known', value, sourceRefs: [ref] })

    /** The widest valid classified step: every list at its maximum, 99 readable notes and one that could not be read. */
    function widest(): ManualSession {
        const draft = createDemoManual()
        const [first, ...rest] = draft.rawExtraction!.steps
        return manualSessionSchema.parse({
            ...draft,
            reviewStatus: 'unreviewed',
            reviewedSteps: [],
            rawExtraction: {
                parts: draft.parts,
                steps: [
                    {
                        ...first!,
                        alternatives: [
                            {
                                alternativeId: 'a',
                                title: 'Use tape',
                                description: 'Hold it with tape.',
                                sourceRefs: [ref],
                            },
                            {
                                alternativeId: 'b',
                                title: 'Use clamp',
                                description: 'Hold it with a clamp.',
                                sourceRefs: [ref],
                            },
                        ],
                        selectedAlternativeId: 'b',
                        visibleChecks: Array.from({ length: 100 }, (_unused, at) => ({
                            checkId: `c${at}`,
                            description: knownFact(`Check ${at} is visible.`),
                        })),
                        correction: {
                            reviewed: false,
                            actions: Array.from({ length: 100 }, (_unused, at) => ({
                                actionId: `a${at}`,
                                instruction: `Turn the panel ${at}.`,
                                sourceRefs: [ref],
                            })),
                        },
                        safetyNotes: [
                            ...Array.from({ length: 99 }, (_unused, at) => known(`k${at}`, `Keep clear ${at}.`)),
                            unreadable('u1', REASON),
                        ],
                    },
                    ...rest,
                ],
                unknowns: [],
            },
        })
    }

    it('holds exactly one marker beside 99 readable notes and every direction, in a valid document', () => {
        const inputs = inputsFor('guide', widest())
        const material = documentMaterialV2(inputs)
        // 1 marker + 99 notes + title, selected alternative, orientation, connection and 100 checks; unreviewed fixes stay hidden.
        expect(material.facts).toHaveLength(204)
        expect(material.facts.some((fact) => fact.factId.startsWith('correction:'))).toBe(false)
        expect(markers(material.facts)).toEqual([MARKER])
        const document = build(inputs)
        expect(messages(document)).toEqual([])
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        expect(structureOfV2(document).variantNodes).toBeLessThanOrEqual(DOCUMENT_V2_LIMITS.nodes)
        expect(structureOfV2(document).nodes).toBeLessThanOrEqual(DOCUMENT_V2_LIMITS.documentNodes)
        for (const { name } of variantsOfV2(document)) expect(visibleFacts(document, name)).toContain(MARKER)
    })

    it('still fits the fact ceiling beside a held check and its companion answer at their maxima', () => {
        const missing = Array.from({ length: 100 }, (_unused, at) => `Evidence ${at} is not visible.`)
        const inputs: ScreenContextInputsV2 = {
            ...inputsFor('more', widest()),
            result: { kind: 'check', value: { ...createHeroResponse('reversed'), missingEvidence: missing } },
            captureId: 'cap-1',
            uiState: ui,
            companionAnswer: {
                question: 'Which way?',
                value: questionResultSchema.parse({
                    answer: 'The groove faces inward toward the divider.',
                    sourceRefs: [ref],
                    missingEvidence: missing,
                }),
            },
        }
        const document = build(inputs)
        expect(document.facts.length).toBeLessThanOrEqual(DOCUMENT_V2_LIMITS.facts)
        expect(document.facts).toHaveLength(303 + 202)
        expect(messages(document)).toEqual([])
        for (const { name } of variantsOfV2(document)) expect(visibleFacts(document, name), name).toContain(MARKER)
    })
})
