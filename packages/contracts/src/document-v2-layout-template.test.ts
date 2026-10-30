import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    DOCUMENT_V2_LIMITS,
    LAYOUT_DECISIONS_V2,
    buildFallbackDocumentV2,
    canonicalJson,
    compileLayoutTemplateV2,
    componentPathsV2,
    createDemoManual,
    documentMaterialV2,
    layoutTemplateSha256V2,
    manualSessionSchema,
    parseLayoutTemplateV2,
    photoSpineV2,
    questionResultSchema,
    screenDocumentV2Schema,
    structureOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    variantsOfV2,
    type AnswerLayoutTemplateV2,
    type CheckingResultLayoutTemplateV2,
    type FactSetV2,
    type LayoutBranchV2,
    type LayoutTemplateV2,
    type ManualSession,
    type ResultLayoutTemplateV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
    type ScreenUiStateV2,
    type TemplateContainerV2,
    type TemplateLabelRefV2,
    type TemplateNodeV2,
    type TemplateVariantV2,
} from './index'
import { createHeroResponse } from './hero'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2030-01-01T00:00:00.000Z') }
const PAGE = 'demo-page-1'
const AUTHORED_AT = '2026-10-30T12:00:00.000Z'

// ---------------------------------------------------------------------------------------------------------------------
// Inputs: a held check or a held answer of a reviewed step, with the held photo.
// ---------------------------------------------------------------------------------------------------------------------

const ui: ScreenUiStateV2 = {
    capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
    camera: { mode: 'build-photo', permission: 'granted' },
    sections: ['settings', 'about-this-check', 'tips'],
}

/** A reviewed demo manual. By default its step was never classified (every direction is required, the legacy shape). */
function manual(safetyNotes: number | 'unclassified' = 'unclassified', refsPerNote = 1): ManualSession {
    const session = createDemoManual()
    const step = session.reviewedSteps[0]!
    if (safetyNotes === 'unclassified') return manualSessionSchema.parse(session)
    step.safetyNotes = Array.from({ length: safetyNotes }, (_, note) => ({
        noteId: `n${note}`,
        note: {
            state: 'known' as const,
            value: `Keep fingers clear near connection ${note}.`,
            sourceRefs: Array.from({ length: refsPerNote }, (_unused, ref) => ({
                pageId: PAGE,
                region: { x: (note % 100) / 200, y: (ref % 100) / 200, width: 0.004, height: 0.004 },
            })),
        },
    }))
    return manualSessionSchema.parse(session)
}

const ORIENTATION = { correct: 'pass', reversed: 'refuse', uncertain: 'cannot_verify' } as const

function checkInputs(
    orientation: keyof typeof ORIENTATION,
    session: ManualSession = manual(),
    missingEvidence?: string[],
): ScreenContextInputsV2 {
    const value = createHeroResponse(orientation)
    return {
        kind: 'result',
        session,
        stepId: 'step-1',
        captureId: 'cap-1',
        result: { kind: 'check', value: missingEvidence ? { ...value, missingEvidence } : value },
        failure: null,
        uiState: ui,
    }
}

function answerInputs(session: ManualSession = manual(), missingEvidence: string[] = []): ScreenContextInputsV2 {
    return {
        kind: 'answer',
        session,
        stepId: 'step-1',
        captureId: 'cap-1',
        result: {
            kind: 'question',
            question: 'Which way?',
            value: questionResultSchema.parse({
                answer: 'The groove faces inward toward the divider.',
                sourceRefs: [{ pageId: PAGE, region: null }],
                missingEvidence,
            }),
        },
        failure: null,
        uiState: ui,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// An independently authored record. Written the way a model would write it: its own structure, its own spacing, its own
// copy choices; nothing here is the fallback builder's output or any recorded sample.
// ---------------------------------------------------------------------------------------------------------------------

const lit = (text: string): TemplateLabelRefV2 => ({ kind: 'literal', text })
const state = (part: 'heading' | 'detail'): TemplateLabelRefV2 => ({ kind: 'state', part })
const factText = (strong = false): TemplateNodeV2 => ({
    type: 'FactText',
    role: strong ? 'label' : 'body',
    emphasis: strong ? 'strong' : 'normal',
    tone: 'neutral',
    align: 'start',
})
const cites = (chunk = 4): TemplateNodeV2 => ({ type: 'FactCitations', display: 'chip', label: null, chunk })
const text = (content: TemplateLabelRefV2, role: 'heading' | 'body' | 'caption' = 'body'): TemplateNodeV2 => ({
    type: 'Text',
    content,
    role,
    emphasis: 'normal',
    tone: 'neutral',
    align: 'start',
})
const stack = (children: TemplateNodeV2[], gap: 'xs' | 'sm' | 'md' = 'md'): TemplateContainerV2 => ({
    type: 'Stack',
    gap,
    align: 'stretch',
    children,
})
const scroll = (children: TemplateNodeV2[]): TemplateContainerV2 => ({ type: 'Scroll', axis: 'vertical', children })
const row = (children: TemplateNodeV2[]): TemplateContainerV2 => ({
    type: 'Row',
    gap: 'sm',
    align: 'center',
    justify: 'start',
    wrap: true,
    children,
})
const card = (children: TemplateNodeV2[]): TemplateContainerV2 => ({
    type: 'Card',
    surface: 'plain',
    tone: 'neutral',
    padding: 'sm',
    children,
})
const section = (title: string, children: TemplateNodeV2[], collapsed = false): TemplateContainerV2 => ({
    type: 'Section',
    title: lit(title),
    collapsible: collapsed,
    initiallyOpen: !collapsed,
    children,
})
const photo: TemplateNodeV2 = {
    type: 'Image',
    source: { kind: 'capture' },
    fit: 'cover',
    ratio: 'hero',
    caption: null,
}
/** A section over a fact set: its heading exists only when the set does; rows are grouped `size` at a time. */
const listing = (title: string, source: FactSetV2, size: number, collapsed = false): TemplateNodeV2 => ({
    type: 'WhenFacts',
    source,
    children: [
        section(
            title,
            [
                {
                    type: 'RepeatFacts',
                    source,
                    group: {
                        size,
                        container: { type: 'Stack', gap: 'xs', align: 'stretch' },
                    },
                    row: card([row([factText(source === 'safety'), cites(3)])]),
                },
            ],
            collapsed,
        ),
    ],
})
/** Result sources are cited by one row per result fact holding nothing but its citations. */
const resultCitations: TemplateNodeV2 = {
    type: 'RepeatFacts',
    source: 'verdict',
    group: null,
    row: row([cites(5)]),
}

const back = { label: 'Back', icon: 'chevronLeft', intent: { intent: 'navigate', target: 'back' } } as const
const ask = {
    type: 'SecondaryAction',
    label: 'Ask about this step',
    icon: 'help',
    intent: { intent: 'ask', target: 'about-step' },
} as const

const TITLES = { pass: 'Looks right', refuse: 'Not quite right', cannot_verify: 'Cannot tell yet' } as const

function readyVariant(decision: LayoutBranchV2, options: { reasons?: boolean } = {}): TemplateVariantV2 {
    const pass = decision === 'pass'
    const answer = decision === 'answer'
    return {
        header: {
            title: lit(answer ? 'Answer' : TITLES[decision as keyof typeof TITLES]),
            subtitle: null,
            back,
            actions: [],
        },
        body: scroll([
            stack([
                photo,
                {
                    type: 'ResultCard',
                    variant: answer ? 'card' : 'banner',
                    showReason: !options.reasons,
                    showRegions: true,
                },
                ...(options.reasons
                    ? [
                          {
                              type: 'RepeatFacts',
                              source: 'verdict',
                              group: null,
                              row: card([row([factText(true), cites(5)])]),
                          } as const,
                          listing('Details', 'missing', 10),
                      ]
                    : [resultCitations]),
                listing('Safety', 'safety', 6),
                listing('Directions', 'directions', 20),
                listing('More detail', 'details', 20, true),
            ]),
        ]),
        bar: {
            primary: answer
                ? {
                      type: 'PrimaryAction',
                      label: 'Back to the guide',
                      icon: 'chevronLeft',
                      intent: { intent: 'navigate', target: 'guide' },
                  }
                : pass
                  ? {
                        type: 'PrimaryAction',
                        label: 'Next step',
                        icon: 'arrowRight',
                        intent: { intent: 'confirm', target: 'step' },
                    }
                  : {
                        type: 'PrimaryAction',
                        label: 'Retake photo',
                        icon: 'camera',
                        intent: { intent: 'capture', target: 'retake' },
                    },
            secondary: answer ? { ...ask, label: 'Ask another' } : ask,
        },
    }
}

function waitingVariant(
    kind: 'busy' | 'pending' | 'error' | 'recovery',
    screen: 'result' | 'answer',
): TemplateVariantV2 {
    const waiting = kind === 'busy' || kind === 'pending'
    return {
        header: { title: state('heading'), subtitle: null, back: null, actions: [] },
        body: scroll([
            stack([
                photo,
                ...(waiting ? [{ type: 'Progress', binding: 'build', label: null } as const] : []),
                text(state('heading'), 'heading'),
                text(state('detail')),
                listing('Safety', 'safety', 6),
                listing('Directions', 'directions', 20),
            ]),
        ]),
        bar: {
            primary: waiting
                ? {
                      type: 'PrimaryAction',
                      label: 'Working…',
                      icon: null,
                      intent: { intent: 'navigate', target: 'guide' },
                  }
                : screen === 'answer'
                  ? {
                        type: 'PrimaryAction',
                        label: 'Home',
                        icon: 'chevronLeft',
                        intent: { intent: 'navigate', target: 'home' },
                    }
                  : {
                        type: 'PrimaryAction',
                        label: 'Try again',
                        icon: 'refresh',
                        intent: { intent: 'retry', target: 'last-action' },
                    },
            secondary:
                waiting || screen === 'answer'
                    ? null
                    : {
                          type: 'SecondaryAction',
                          label: 'Home',
                          icon: 'chevronLeft',
                          intent: { intent: 'navigate', target: 'home' },
                      },
        },
    }
}

const states = (screen: 'result' | 'answer'): ResultLayoutTemplateV2['states'] => ({
    busy: waitingVariant('busy', screen),
    pending: waitingVariant('pending', screen),
    error: waitingVariant('error', screen),
    recovery: waitingVariant('recovery', screen),
})

function resultTemplate(options: { reasons?: boolean } = {}): ResultLayoutTemplateV2 {
    return {
        version: 1,
        fixtureId: 'layout-result-sol-v1',
        kind: 'result',
        ready: {
            pass: readyVariant('pass', options),
            refuse: readyVariant('refuse', options),
            cannot_verify: readyVariant('cannot_verify', options),
        },
        states: states('result'),
    }
}

function answerTemplate(options: { reasons?: boolean } = {}): AnswerLayoutTemplateV2 {
    return {
        version: 1,
        fixtureId: 'layout-answer-sol-v1',
        kind: 'answer',
        ready: readyVariant('answer', options),
        states: states('answer'),
    }
}

const clone = <T>(value: T): T => structuredClone(value)

const authoring = (
    template: LayoutTemplateV2,
): { model: 'gpt-6.1-sol'; effort: 'ultra'; recordedAt: string; fixtureId: string } => ({
    model: 'gpt-6.1-sol',
    effort: 'ultra',
    recordedAt: AUTHORED_AT,
    fixtureId: template.fixtureId,
})
const provenanceOf = (
    template: LayoutTemplateV2,
): { authoring: ReturnType<typeof authoring>; templateSha256: string } => ({
    authoring: authoring(template),
    templateSha256: layoutTemplateSha256V2(template, sha256Hex),
})

function compile(
    inputs: ScreenContextInputsV2,
    template: LayoutTemplateV2,
    provenance: unknown = provenanceOf(template),
): ReturnType<typeof compileLayoutTemplateV2> {
    return compileLayoutTemplateV2({ inputs, template, provenance, deps })
}

function compiled(
    inputs: ScreenContextInputsV2,
    template: LayoutTemplateV2,
): Extract<ReturnType<typeof compile>, { ok: true }> {
    const result = compile(inputs, template)
    if (!result.ok) throw new Error(`not compiled: ${result.issues.join(',')}`)
    return result
}

function failed(inputs: ScreenContextInputsV2, template: unknown, provenance?: unknown): string[] {
    const result = compileLayoutTemplateV2({
        inputs,
        template,
        provenance: provenance ?? provenanceOf(template as LayoutTemplateV2),
        deps,
    })
    if (result.ok) throw new Error('unexpectedly compiled')
    return result.issues
}

const nodesOf = (
    document: ReturnType<typeof compiled>['document'],
    name: 'ready' | string = 'ready',
): ScreenNodeV2[] => {
    const found: ScreenNodeV2[] = []
    for (const entry of variantsOfV2(document)) {
        if (entry.name === name) visitVariantNodesV2(entry.variant, entry.prefix, ({ node }) => found.push(node))
    }
    return found
}
const factIdsStated = (nodes: ScreenNodeV2[]): string[] =>
    nodes.flatMap((node) => (node.type === 'Text' && node.content.kind === 'fact' ? [node.content.factId] : []))

// ---------------------------------------------------------------------------------------------------------------------

describe('a model-authored layout record compiles into the actual result', () => {
    it.each(LAYOUT_DECISIONS_V2)(
        'check %s: the branch and the actions come from the record, the data from the witness',
        (decision) => {
            const orientation = (Object.keys(ORIENTATION) as (keyof typeof ORIENTATION)[]).find(
                (key) => ORIENTATION[key] === decision,
            )!
            const inputs = checkInputs(orientation)
            const template = resultTemplate()
            const result = compiled(inputs, template)
            const material = documentMaterialV2(inputs)
            expect(material.decision).toBe(decision)
            expect(result.branch).toBe(decision)
            const { document } = result
            // The branch authored for this decision, nothing else.
            const authored = template.ready[decision]
            expect(document.header.title).toEqual(authored.header.title)
            expect(document.bar.primary).toEqual(authored.bar.primary)
            // The server tables are the exact current material, never the record's.
            expect(document.facts).toEqual(material.facts)
            expect(document.sources).toEqual(material.sources)
            expect(document.requirements).toEqual(material.requirements)
            expect(document.bound.captureId).toBe('cap-1')
            expect(document.bound.stepId).toBe('step-1')
            expect(document.bound.contextKey).toHaveLength(64)
            expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
            // The verdict card and the facts are the witnessed ones; the record contains none of them.
            expect(nodesOf(document).some((node) => node.type === 'VerdictCard' && node.result === 'check')).toBe(true)
            expect(factIdsStated(nodesOf(document))).toEqual(
                material.requirements.facts.filter((factId) => !factId.startsWith('result:')),
            )
            // The record holds no fact id, fact text, source index or photo identity: only slots.
            const raw = canonicalJson(template)
            expect(raw).not.toContain('factId')
            expect(raw).not.toContain('result:')
            expect(raw).not.toContain('cap-1')
            for (const fact of material.facts.filter((candidate) => candidate.text.length > 12)) {
                expect(raw).not.toContain(fact.text)
            }
        },
    )

    it('answer: one ready branch bound to the actual question, with its own card', () => {
        const inputs = answerInputs()
        const result = compiled(inputs, answerTemplate())
        expect(result.branch).toBe('answer')
        expect(nodesOf(result.document).some((node) => node.type === 'VerdictCard' && node.result === 'question')).toBe(
            true,
        )
        expect(verifyDocumentAgainstInputsV2(result.document, inputs, sha256Hex)).toEqual([])
    })

    it('is deterministic and never calls the clock, a provider or the fallback builder', () => {
        const inputs = checkInputs('reversed')
        const template = resultTemplate()
        const first = compiled(inputs, template)
        const second = compiled(inputs, template)
        expect(canonicalJson(first.document)).toBe(canonicalJson(second.document))
        expect(first.document.screenId).toBe(second.document.screenId)
        expect(first.templateSha256).toBe(layoutTemplateSha256V2(template, sha256Hex))
        // The same facts under a different layout is a different screen.
        const other = clone(template)
        other.ready.refuse.header.title = lit('Cannot tell yet')
        const changed = compile(inputs, other)
        expect(changed.ok && changed.document.screenId).not.toBe(first.document.screenId)
    })
})

describe('provenance: the record author is attested separately from any provider run', () => {
    it('publishes a generated synthetic fixture with the record author and no provider observation', () => {
        const inputs = checkInputs('reversed')
        const template = resultTemplate()
        const { document } = compiled(inputs, template)
        expect(document.metadata.source).toBe('generated')
        expect(document.metadata.evidence).toBe('synthetic-fixture')
        expect(document.metadata.authoring).toEqual(authoring(template))
        expect(document.metadata.generatedAt).toBe(AUTHORED_AT)
        expect(document.metadata.model).toBeNull()
        expect(document.metadata.effort).toBeNull()
        expect(document.metadata.fallbackReason).toBeNull()
        expect(Object.values(document.metadata.timing).every((value) => value === null || value === undefined)).toBe(
            true,
        )
        expect(Object.values(document.metadata.usage).every((value) => value === null)).toBe(true)
        expect(document.metadata.cacheHit).toBe(false)
        expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['generated']))
        // The deterministic fallback of the same inputs gets none of it.
        const fallback = buildFallbackDocumentV2(inputs, {
            ...deps,
            reason: 'disabled',
            evidence: 'local-deterministic',
        })
        expect(fallback.metadata.source).toBe('fallback')
        expect(new Set(Object.values(fallback.metadata.origins))).toEqual(new Set(['fallback']))
    })

    it('refuses a record whose hash, fixture identity or claimed author differs, and any caller-supplied source', () => {
        const inputs = checkInputs('reversed')
        const template = resultTemplate()
        const good = provenanceOf(template)
        expect(failed(inputs, template, { ...good, templateSha256: sha256Hex('another record') })).toContain(
            'provenance::hash_mismatch',
        )
        expect(
            failed(inputs, template, { ...good, authoring: { ...good.authoring, fixtureId: 'layout-other-v1' } }),
        ).toContain('provenance::fixture_mismatch')
        const claimed = [
            { ...good, source: 'generated' },
            { ...good, evidence: 'recorded-generation' },
            { ...good, model: 'muse-spark-1.3' },
            { ...good, authoring: { ...good.authoring, model: 'muse-spark-1.3' } },
            { ...good, authoring: { ...good.authoring, effort: 'high' } },
            { ...good, bound: { manualId: 'x' } },
        ]
        for (const provenance of claimed) {
            expect(failed(inputs, template, provenance).some((issue) => issue.startsWith('provenance:'))).toBe(true)
        }
        // A record whose bytes were edited after it was hashed is not the record that was attested.
        const edited = clone(template)
        edited.ready.pass.bar.primary.label = 'Next'
        expect(failed(inputs, edited, good)).toContain('provenance::hash_mismatch')
    })

    it('does not trust the record for identity, facts, sources or origins: none of them can even be expressed', () => {
        const inputs = checkInputs('reversed')
        const template = resultTemplate()
        for (const extra of [
            { facts: [] },
            { sources: [] },
            { bound: { manualId: 'x' } },
            { metadata: { source: 'generated' } },
            { screenId: 'a'.repeat(64) },
            { requirements: { facts: [] } },
        ]) {
            const issues = failed(
                inputs,
                { ...template, ...extra },
                provenanceOf({ ...template, ...extra } as LayoutTemplateV2),
            )
            expect(issues.some((issue) => issue.includes('unrecognized_keys'))).toBe(true)
        }
        // Not even a normalizable spelling: the parsed record must be byte-identical to the raw one.
        const padded = clone(template)
        padded.ready.pass.header.title = lit('  Looks right  ')
        expect(failed(inputs, padded, provenanceOf(template))).toContain('template::not_canonical')
    })
})

describe('lineage: every compiled component names its raw record path and repetition', () => {
    it('covers every component, with exact repeat lineage for facts and citation chunks', () => {
        const inputs = checkInputs('reversed', manual(3, 7))
        const template = resultTemplate()
        const { document, lineage } = compiled(inputs, template)
        expect(Object.keys(lineage).sort()).toEqual(componentPathsV2(document).sort())
        expect(lineage.header!.template).toBe('ready.refuse.header')
        expect(lineage['bar.primary']!.template).toBe('ready.refuse.bar.primary')
        expect(lineage['states.busy.header']!.template).toBe('states.busy.header')
        expect(lineage['states.error.bar.secondary']!.template).toBe('states.error.bar.secondary')
        const material = documentMaterialV2(inputs)
        const safetyIds = material.facts.filter((fact) => fact.kind === 'safety').map((fact) => fact.factId)
        expect(safetyIds).toHaveLength(3)
        // Every safety text node came from the model's own safety row, in order, by the fact it was compiled for.
        const safetyRows = Object.entries(lineage).filter(
            ([path, entry]) =>
                !path.startsWith('states.') && entry.repeat?.set === 'safety' && entry.repeat.role === 'row',
        )
        const texts = safetyRows.filter(([path]) => {
            const node = nodesOf(document).find((candidate) => candidate === lookup(document, path))
            return node?.type === 'Text'
        })
        expect(texts.map(([, entry]) => entry.repeat!.factId)).toEqual(safetyIds)
        expect(texts.map(([, entry]) => entry.repeat!.index)).toEqual([0, 1, 2])
        // Seven references on one page are seven distinct regions: ceil(7/3) = 3 citation chunks per safety fact.
        const chunks = safetyRows.filter(([path]) => lookup(document, path)?.type === 'Citation')
        expect(chunks).toHaveLength(9)
        expect(chunks.map(([, entry]) => entry.repeat!.citation)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2])
        // The wrapper of a group is the model's own container, with no fact of its own.
        const groups = Object.entries(lineage)
            .filter(
                ([path, entry]) =>
                    !path.startsWith('states.') && entry.repeat?.role === 'group' && entry.repeat.set === 'safety',
            )
            .map(([, entry]) => entry)
        expect(groups).toHaveLength(1)
        expect(groups[0]).toEqual({
            template: 'ready.refuse.body.children.0.children.3.children.0.children.0.group.container',
            repeat: { set: 'safety', role: 'group', group: 0, index: null, factId: null, citation: null },
        })
    })
})

function lookup(document: ReturnType<typeof compiled>['document'], path: string): ScreenNodeV2 | undefined {
    let found: ScreenNodeV2 | undefined
    for (const entry of variantsOfV2(document)) {
        visitVariantNodesV2(entry.variant, entry.prefix, (visit) => {
            if (visit.path === path) found = visit.node
        })
    }
    return found
}

describe('fact sets: zero, one and many', () => {
    it('states every missing-evidence entry of the actual result, and none when there is none', () => {
        const withReasons = resultTemplate({ reasons: true })
        const none = compiled(checkInputs('uncertain', manual(), []), withReasons).document
        expect(factIdsStated(nodesOf(none)).filter((id) => id.startsWith('result:'))).toEqual(['result:verdict'])
        // No missing evidence: no heading over nothing.
        expect(JSON.stringify(none.body)).not.toContain('"Details"')

        const many = compiled(
            checkInputs('uncertain', manual(), ['Bottom edge', 'Left groove', 'Label']),
            withReasons,
        ).document
        expect(factIdsStated(nodesOf(many)).filter((id) => id.startsWith('result:'))).toEqual([
            'result:verdict',
            'result:missing:0',
            'result:missing:1',
            'result:missing:2',
        ])
        expect(JSON.stringify(many.body)).toContain('"Details"')
        // Waiting variants never state the held result, whatever the record's sets would select.
        for (const name of ['busy', 'pending', 'error', 'recovery'] as const) {
            expect(factIdsStated(nodesOf(many, name)).some((id) => id.startsWith('result:'))).toBe(false)
        }
    })

    it('answers: the answer and its missing evidence are the answer namespace', () => {
        const document = compiled(answerInputs(manual(), ['The far side']), answerTemplate({ reasons: true })).document
        expect(factIdsStated(nodesOf(document)).filter((id) => id.startsWith('result:'))).toEqual([
            'result:answer',
            'result:answer-missing:0',
        ])
    })

    it('shows the safety section only with safety facts, and states them all in every variant', () => {
        const none = compiled(checkInputs('refuse'.length ? 'reversed' : 'reversed'), resultTemplate()).document
        expect(JSON.stringify(none)).not.toContain('"Safety"')
        const inputs = checkInputs('reversed', manual(4))
        const document = compiled(inputs, resultTemplate()).document
        expect(JSON.stringify(document.body)).toContain('"Safety"')
        const safety = document.facts.filter((fact) => fact.kind === 'safety').map((fact) => fact.factId)
        expect(safety).toHaveLength(4)
        for (const entry of variantsOfV2(document)) {
            const stated = factIdsStated(nodesOf(document, entry.name))
            for (const id of safety) expect(stated, `${entry.name}`).toContain(id)
        }
    })
})

describe('sources: the registry is recomputed from the exact current material', () => {
    it('keeps distinct regions of one page as distinct citations', () => {
        const inputs = checkInputs('reversed', manual(3, 2))
        const { document } = compiled(inputs, resultTemplate())
        expect(document.sources.filter((source) => source.pageId === PAGE).length).toBeGreaterThan(3)
        const cited = new Set(nodesOf(document).flatMap((node) => (node.type === 'Citation' ? node.sources : [])))
        for (const index of document.requirements.sources) expect(cited.has(index)).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })

    it('coarsens to page-level sources past the cap and still cites every required reference', () => {
        const inputs = checkInputs('reversed', manual(4, 100))
        const material = documentMaterialV2(inputs)
        expect(material.sourcePrecision).toBe('page')
        const { document } = compiled(inputs, resultTemplate())
        expect(document.sources.every((source) => source.region === null)).toBe(true)
        const cited = new Set(nodesOf(document).flatMap((node) => (node.type === 'Citation' ? node.sources : [])))
        for (const index of document.requirements.sources) expect(cited.has(index)).toBe(true)
    })

    it('bounds a fact with no source to zero citations', () => {
        const base = checkInputs('reversed')
        const inputs: ScreenContextInputsV2 = {
            ...base,
            result: { kind: 'check', value: { ...createHeroResponse('reversed'), sourceRefs: [] } },
        }
        const material = documentMaterialV2(inputs)
        expect(material.facts.find((fact) => fact.factId === 'result:verdict')!.sourceRefs).toEqual([])
        const result = compiled(inputs, resultTemplate())
        const verdictRows = Object.entries(result.lineage).filter(
            ([path, entry]) => !path.startsWith('states.') && entry.repeat?.set === 'verdict',
        )
        // The row exists (it is the record's own), but it holds no citation: nothing is invented to fill it.
        expect(verdictRows.map(([path]) => lookup(result.document, path)?.type)).toEqual(['Row'])
    })
})

describe('the guards of the compiled document are never loosened', () => {
    it.each([
        ['100 safety notes, one region each', 1],
        ['100 safety notes with 100 regions each (page-level sources)', 100],
    ])('fits the largest valid step: %s and 100 missing-evidence entries', (_name, regions) => {
        const missing = Array.from({ length: 100 }, (_, index) => `Evidence ${index} is not visible.`)
        const inputs = checkInputs('reversed', manual(100, regions), missing)
        const { document } = compiled(inputs, resultTemplate({ reasons: true }))
        expect(structureOfV2(document).variantNodes).toBeLessThanOrEqual(DOCUMENT_V2_LIMITS.nodes)
        expect(structureOfV2(document).nodes).toBeLessThanOrEqual(DOCUMENT_V2_LIMITS.documentNodes)
        expect(document.facts).toEqual(documentMaterialV2(inputs).facts)
        // Every one of the 100 notes and 100 missing entries is stated, none dropped by the grouping.
        const stated = factIdsStated(nodesOf(document))
        expect(stated.filter((id) => id.startsWith('result:missing:'))).toHaveLength(100)
        expect(
            stated.filter((id) => document.facts.some((fact) => fact.factId === id && fact.kind === 'safety')),
        ).toHaveLength(100)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })

    it('rejects an expansion past the children, node or depth guard by its raw path, without producing a document', () => {
        // 100 rows ungrouped in one parent: more than 64 children.
        const flat = resultTemplate()
        const listed = flat.ready.refuse.body as unknown as { children: [{ children: TemplateNodeV2[] }] }
        listed.children[0].children.splice(4, 1, {
            type: 'RepeatFacts',
            source: 'safety',
            group: null,
            row: card([row([factText(), cites(1)])]),
        })
        const issues = failed(checkInputs('reversed', manual(70)), flat)
        expect(issues.some((issue) => issue.startsWith('expansion:children:ready.refuse.body'))).toBe(true)

        // Grouping bounds the same fact set.
        const grouped = clone(flat)
        const group = (grouped.ready.refuse.body as unknown as { children: [{ children: TemplateNodeV2[] }] })
            .children[0].children[4] as unknown as { group: unknown }
        group.group = { size: 8, container: { type: 'Stack', gap: 'xs', align: 'stretch' } }
        expect(compile(checkInputs('reversed', manual(70)), grouped).ok).toBe(true)
    })

    it('stops a record whose rows would exceed the per-variant node guard, naming the raw path', () => {
        const heavy = resultTemplate()
        const stackOf = (heavy.ready.refuse.body as unknown as { children: [{ children: TemplateNodeV2[] }] })
            .children[0].children
        const safety = stackOf[3] as unknown as { children: [{ children: [{ row: TemplateContainerV2 }] }] }
        safety.children[0].children[0].row = card(
            Array.from({ length: 12 }, () => ({ type: 'Spacer', size: 'xs' }) as const),
        )
        const issues = failed(checkInputs('reversed', manual(100)), heavy)
        expect(issues.some((issue) => issue.startsWith('expansion:nodes:ready.refuse.body'))).toBe(true)
    })

    it('refuses a record that nests deeper than the guards before any schema runs', () => {
        let nested: unknown = { type: 'Spacer', size: 'md' }
        for (let level = 0; level < 100_000; level += 1) nested = { type: 'Stack', children: [nested] }
        expect(failed(checkInputs('reversed'), nested, provenanceOf(resultTemplate()))).toEqual(['template::too_deep'])
        const deep = resultTemplate()
        let tower: TemplateContainerV2 = { type: 'Stack', gap: 'none', align: 'start', children: [] }
        for (let level = 0; level < DOCUMENT_V2_LIMITS.depth + 2; level += 1) {
            tower = { type: 'Stack', gap: 'none', align: 'start', children: [tower] }
        }
        deep.ready.refuse.body = tower
        expect(failed(checkInputs('reversed'), deep).some((issue) => issue.endsWith(':too_deep'))).toBe(true)
    })
})

describe('slots, branches and states fail closed', () => {
    it('refuses slots outside a repeat row, result slots and state copy where they do not belong, nested repeats and actions in the body', () => {
        const inputs = checkInputs('reversed')
        const base = resultTemplate()
        const tamper = (edit: (template: ResultLayoutTemplateV2) => void): string[] => {
            const template = clone(base)
            edit(template)
            return parseLayoutTemplateV2(template).ok
                ? []
                : (parseLayoutTemplateV2(template) as { issues: string[] }).issues
        }
        const stackOf = (variant: TemplateVariantV2): TemplateNodeV2[] =>
            (variant.body as unknown as { children: [{ children: TemplateNodeV2[] }] }).children[0].children
        expect(
            tamper((t) => stackOf(t.ready.pass).push(factText())).some((issue) => issue.endsWith(':slot_outside_row')),
        ).toBe(true)
        expect(
            tamper((t) =>
                stackOf(t.states.busy).push({
                    type: 'ResultCard',
                    variant: 'card',
                    showReason: true,
                    showRegions: true,
                }),
            ).some((issue) => issue.endsWith(':result_slot_in_state')),
        ).toBe(true)
        expect(
            tamper((t) => stackOf(t.states.busy).push(listing('Details', 'verdict', 4))).some((issue) =>
                issue.endsWith(':result_slot_in_state'),
            ),
        ).toBe(true)
        expect(
            tamper((t) => stackOf(t.ready.pass).push(text(state('heading')))).some((issue) =>
                issue.endsWith(':state_copy_in_ready'),
            ),
        ).toBe(true)
        expect(
            tamper((t) => (t.ready.pass.header.title = state('heading'))).some((issue) =>
                issue.endsWith(':state_copy_in_ready'),
            ),
        ).toBe(true)
        expect(
            tamper((t) =>
                stackOf(t.ready.pass).push({
                    type: 'RepeatFacts',
                    source: 'directions',
                    group: null,
                    row: card([{ type: 'RepeatFacts', source: 'details', group: null, row: card([factText()]) }]),
                }),
            ).some((issue) => issue.endsWith(':not_in_row')),
        ).toBe(true)
        expect(
            tamper((t) =>
                stackOf(t.ready.pass).push({
                    type: 'RepeatFacts',
                    source: 'directions',
                    group: null,
                    row: card([photo]),
                }),
            ).some((issue) => issue.endsWith(':not_in_row')),
        ).toBe(true)
        // Cross-type nodes: an action in the body, a fixed fact or source, a page or part picture, a placeholder.
        const body = (node: unknown): string[] => {
            const template = clone(base) as unknown as { ready: { pass: { body: { children: unknown[] } } } }
            template.ready.pass.body.children.push(node)
            return parseLayoutTemplateV2(template).ok ? [] : ['rejected']
        }
        expect(
            body({ type: 'PrimaryAction', label: 'Go', icon: null, intent: { intent: 'navigate', target: 'home' } }),
        ).toEqual(['rejected'])
        expect(body({ type: 'Citation', sources: [0], label: null, display: 'chip' })).toEqual(['rejected'])
        expect(
            body({
                type: 'Text',
                content: { kind: 'fact', factId: 'result:verdict' },
                role: 'body',
                emphasis: 'normal',
                tone: 'neutral',
                align: 'start',
            }),
        ).toEqual(['rejected'])
        expect(
            body({ type: 'Image', source: { kind: 'page', pageId: PAGE }, fit: 'cover', ratio: 'hero', caption: null }),
        ).toEqual(['rejected'])
        expect(
            body({ type: 'Image', source: { kind: 'source', index: 0 }, fit: 'cover', ratio: 'hero', caption: null }),
        ).toEqual(['rejected'])
        expect(
            body({ type: 'VerdictCard', result: 'check', variant: 'card', showReason: true, showRegions: true }),
        ).toEqual(['rejected'])
        expect(
            body({
                type: 'Text',
                content: { kind: 'literal', text: 'Hello {{factId}}' },
                role: 'body',
                emphasis: 'normal',
                tone: 'neutral',
                align: 'start',
            }),
        ).toEqual(['rejected'])
        expect(
            body({
                type: 'Text',
                content: { kind: 'literal', text: 'See https://example.test' },
                role: 'body',
                emphasis: 'normal',
                tone: 'neutral',
                align: 'start',
            }),
        ).toEqual(['rejected'])
        expect(body({ type: 'Stack', gap: 'md', align: 'start', style: 'color:red', children: [] })).toEqual([
            'rejected',
        ])
        expect(failed(inputs, { ...base, extra: 1 }).length).toBeGreaterThan(0)
        // A chunk of zero or more indexes than a citation holds.
        expect(
            body({
                type: 'RepeatFacts',
                source: 'directions',
                group: null,
                row: row([{ type: 'FactCitations', display: 'chip', label: null, chunk: 21 }]),
            }),
        ).toEqual(['rejected'])
        expect(
            body({
                type: 'RepeatFacts',
                source: 'directions',
                group: { size: 0, container: { type: 'Stack', gap: 'md', align: 'start' } },
                row: row([factText()]),
            }),
        ).toEqual(['rejected'])
    })

    it('chooses the branch only from the actual witnesses and fails closed without them', () => {
        const template = resultTemplate()
        // No held result: no verdict is invented.
        expect(failed({ ...checkInputs('reversed'), result: null, captureId: null }, template)).toContain(
            'inputs::no_result',
        )
        // A record for the other screen, or an unsupported screen.
        expect(failed(answerInputs(), template)).toContain('template::kind_mismatch')
        expect(failed({ ...checkInputs('reversed'), kind: 'guide', result: null }, template)).toContain(
            'inputs::kind_unsupported',
        )
        // Pass and refuse differ only by the actual decision, whatever else the context carries.
        const noisy = { ...checkInputs('correct'), uiState: { ...ui, busy: { activity: 'checking' as const } } }
        expect(compiled(noisy, template).branch).toBe('pass')
    })

    it('names the busy activity from the witness and the state copy of the other variants', () => {
        const inputs = {
            ...checkInputs('reversed'),
            uiState: { ...ui, busy: { activity: 'second-opinion' as const } },
        }
        const { document } = compiled(inputs, resultTemplate())
        expect(document.states.busy!.header.title).toEqual({ kind: 'literal', text: 'Taking a closer look…' })
        expect(document.states.pending!.header.title).toEqual({ kind: 'literal', text: 'Working on it' })
        expect(document.states.error!.header.title).toEqual({ kind: 'literal', text: 'Something went wrong' })
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })

    it('does not hide the verdict while an optional overlay or segmentation is still outstanding', () => {
        const inputs = {
            ...checkInputs('reversed'),
            uiState: { ...ui, overlay: { status: 'pending' } } as unknown as ScreenUiStateV2,
        }
        const { document, branch } = compiled(inputs, resultTemplate())
        expect(branch).toBe('refuse')
        expect(nodesOf(document).some((node) => node.type === 'VerdictCard')).toBe(true)
    })
})

describe('the existing gates are not weakened', () => {
    const bad = (edit: (template: ResultLayoutTemplateV2) => void, inputs = checkInputs('reversed')): string[] => {
        const template = clone(resultTemplate())
        edit(template)
        return failed(inputs, template)
    }
    const stackOf = (variant: TemplateVariantV2): TemplateNodeV2[] =>
        (variant.body as unknown as { children: [{ children: TemplateNodeV2[] }] }).children[0].children

    it('rejects a record that omits the photo, a mandatory fact, the verdict card or a required action', () => {
        expect(
            bad((t) => stackOf(t.ready.refuse).splice(0, 1)).some((i) => i.includes('photo') || i.includes('capture')),
        ).toBe(true)
        expect(bad((t) => stackOf(t.states.error).splice(0, 1)).length).toBeGreaterThan(0)
        expect(bad((t) => stackOf(t.ready.refuse).splice(4, 1)).some((i) => i.includes('required_fact'))).toBe(true)
        expect(bad((t) => stackOf(t.ready.refuse).splice(1, 1)).some((i) => i.includes('required_verdictcard'))).toBe(
            true,
        )
        expect(
            bad((t) => (t.ready.refuse.bar.primary.intent = { intent: 'navigate', target: 'home' })).some((i) =>
                i.includes('required_action'),
            ),
        ).toBe(true)
    })

    it('rejects a record that drops a safety fact, or moves the held photo in a waiting variant', () => {
        const safe = checkInputs('reversed', manual(2))
        expect(compile(safe, resultTemplate()).ok).toBe(true)
        expect(bad((t) => stackOf(t.ready.refuse).splice(3, 1), safe).some((i) => i.includes('required_fact'))).toBe(
            true,
        )
        expect(
            bad((t) => stackOf(t.states.busy).unshift(text(lit('Photo')))).some((i) =>
                i.includes('moves_the_held_photo'),
            ),
        ).toBe(true)
    })

    it('rejects a claim the held result does not earn, unlisted copy and a success tone before its verdict', () => {
        // Pass wording over a refusal.
        expect(
            bad((t) => (t.ready.refuse.header.title = lit('Looks right'))).some((i) => i.endsWith('title_not_listed')),
        ).toBe(true)
        // Prose is not interface copy, with or without digits.
        expect(
            bad((t) => stackOf(t.ready.refuse).push(text(lit('Your build is perfect')))).some((i) =>
                i.endsWith('literal_not_listed'),
            ),
        ).toBe(true)
        // A next-step action over a refusal.
        expect(
            bad((t) => (t.ready.refuse.bar.primary = t.ready.pass.bar.primary)).some(
                (i) => i.endsWith('intent_not_allowed') || i.includes('required_action'),
            ),
        ).toBe(true)
        // Success styling before the verdict is revealed, or at all for a refusal.
        expect(
            bad((t) => stackOf(t.states.busy).push({ type: 'Icon', name: 'check', tone: 'success', size: 'md' })).some(
                (i) => i.endsWith('icon_unearned') || i.endsWith('tone_unearned'),
            ),
        ).toBe(true)
        // The verdict card may not wait in a waiting variant.
        expect(
            bad((t) =>
                stackOf(t.states.pending).push({
                    type: 'ResultCard',
                    variant: 'card',
                    showReason: true,
                    showRegions: true,
                }),
            ).length,
        ).toBeGreaterThan(0)
    })

    it('rejects a stale or mismatched binding', () => {
        const inputs = checkInputs('reversed')
        const { document } = compiled(inputs, resultTemplate())
        // Compiled for another photo, step or result, the same document no longer verifies.
        expect(verifyDocumentAgainstInputsV2(document, { ...inputs, captureId: 'cap-2' }, sha256Hex)).toContain(
            'bound_mismatch',
        )
        expect(verifyDocumentAgainstInputsV2(document, checkInputs('correct'), sha256Hex).length).toBeGreaterThan(0)
        // A held result that is not a check cannot be compiled by a result record.
        expect(failed({ ...answerInputs(), kind: 'result' }, resultTemplate())).toContain('inputs::result_mismatch')
    })
})

describe('a version 2 record also owns the held photo before its check returns', () => {
    const pendingInputs = (patch: Partial<ScreenContextInputsV2> = {}): ScreenContextInputsV2 => ({
        ...checkInputs('correct'),
        result: null,
        uiState: { ...ui, busy: { activity: 'checking' } },
        ...patch,
    })
    /** Authored like the others: its own order and copy choices, the photo first, state copy of the checking activity. */
    const checkingVariant = (): TemplateVariantV2 => ({
        header: { title: state('heading'), subtitle: null, back, actions: [] },
        body: scroll([
            stack([
                photo,
                text(state('heading'), 'heading'),
                text(state('detail')),
                listing('Safety', 'safety', 6),
                listing('Directions', 'directions', 20),
                listing('More detail', 'details', 20, true),
            ]),
        ]),
        bar: {
            primary: {
                type: 'PrimaryAction',
                label: 'Back to the guide',
                icon: 'chevronLeft',
                intent: { intent: 'navigate', target: 'guide' },
            },
            secondary: null,
        },
    })
    const recordV2 = (): CheckingResultLayoutTemplateV2 => {
        const base = resultTemplate()
        return { ...base, version: 2, ready: { ...base.ready, checking: checkingVariant() } }
    }
    const stackOf = (variant: TemplateVariantV2): TemplateNodeV2[] => {
        const root = variant.body.children[0]
        if (root?.type !== 'Stack') throw new Error('Expected the authored stack')
        return root.children
    }

    it('parses version 2 and leaves version 1 as it was', () => {
        expect(parseLayoutTemplateV2(recordV2())).toMatchObject({ ok: true })
        expect(parseLayoutTemplateV2(resultTemplate())).toMatchObject({ ok: true })
        // Each version has exactly its own shape: no checking branch in version 1, and none missing from version 2.
        const stray = { ...resultTemplate(), ready: { ...resultTemplate().ready, checking: checkingVariant() } }
        expect(parseLayoutTemplateV2(stray)).toMatchObject({ ok: false })
        const { checking: _checking, ...withoutChecking } = recordV2().ready
        expect(parseLayoutTemplateV2({ ...recordV2(), ready: withoutChecking })).toMatchObject({ ok: false })
        expect(parseLayoutTemplateV2({ ...answerTemplate(), version: 2 })).toMatchObject({ ok: false })
    })

    it('keeps result slots out of the checking branch and state copy out of the verdict branches', () => {
        const withCard = recordV2()
        stackOf(withCard.ready.checking).push({
            type: 'ResultCard',
            variant: 'card',
            showReason: true,
            showRegions: true,
        })
        const verdictRows = recordV2()
        stackOf(verdictRows.ready.checking).push(resultCitations)
        const stateCopy = recordV2()
        stackOf(stateCopy.ready.pass).push(text(state('detail')))
        const issues = (record: unknown): string[] => {
            const parsed = parseLayoutTemplateV2(record)
            return parsed.ok ? [] : parsed.issues
        }
        const at = stackOf(recordV2().ready.checking).length
        expect(issues(withCard)).toContain(
            `template:ready.checking.body.children.0.children.${at}:result_slot_in_state`,
        )
        expect(issues(verdictRows)).toContain(
            `template:ready.checking.body.children.0.children.${at}:result_slot_in_state`,
        )
        expect(
            issues(stateCopy).some(
                (issue) => issue.startsWith('template:ready.pass.') && issue.endsWith(':state_copy_in_ready'),
            ),
        ).toBe(true)
    })

    it('compiles the held photo before the verdict from the record, as generated synthetic authoring', () => {
        const inputs = pendingInputs()
        const result = compiled(inputs, recordV2())
        expect(result.branch).toBe('checking')
        expect(result.document.metadata).toMatchObject({
            source: 'generated',
            evidence: 'synthetic-fixture',
            model: null,
            effort: null,
            authoring: authoring(recordV2()),
        })
        expect(result.document.bound).toMatchObject({ manualId: 'demo-divider', stepId: 'step-1', captureId: 'cap-1' })
        expect(result.document.header.title).toEqual({ kind: 'literal', text: 'Checking your photo…' })
        expect(result.lineage.header?.template).toBe('ready.checking.header')
        expect(verifyDocumentAgainstInputsV2(result.document, inputs, sha256Hex)).toEqual([])
        for (const { variant, prefix } of variantsOfV2(result.document)) {
            const found: ScreenNodeV2[] = []
            visitVariantNodesV2(variant, prefix, ({ node }) => found.push(node))
            expect(found.some((node) => node.type === 'VerdictCard')).toBe(false)
            expect(found.some((node) => node.type === 'Image' && node.source.kind === 'capture')).toBe(true)
        }
        // The deterministic fallback of the same inputs stays separate, and stays fallback.
        expect(
            buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' }).metadata
                .source,
        ).toBe('fallback')
    })

    it.each(LAYOUT_DECISIONS_V2)(
        'keeps one photo spine from before the verdict to the actual %s result',
        (decision) => {
            const orientation = (Object.keys(ORIENTATION) as (keyof typeof ORIENTATION)[]).find(
                (key) => ORIENTATION[key] === decision,
            )!
            const before = compiled(pendingInputs(), recordV2())
            const after = compiled(checkInputs(orientation), recordV2())
            expect(after.branch).toBe(decision)
            const spines = (document: typeof before.document): (string | null)[] =>
                variantsOfV2(document).map(({ variant }) => photoSpineV2(variant))
            expect(spines(before.document).every((spine) => spine !== null)).toBe(true)
            expect(new Set([...spines(before.document), ...spines(after.document)]).size).toBe(1)
            expect(after.document.bound.captureId).toBe(before.document.bound.captureId)
        },
    )

    it('fails closed: a version 1 record cannot own it, and nothing unwitnessed compiles', () => {
        expect(failed(pendingInputs(), resultTemplate())).toEqual(['inputs::pending_unsupported'])
        for (const inputs of [
            pendingInputs({ uiState: ui }),
            pendingInputs({ captureId: 'cap-9' }),
            pendingInputs({ uiState: { ...ui, busy: { activity: 'second-opinion' } } }),
            pendingInputs({ failure: 'provider_error' }),
        ]) {
            expect(failed(inputs, recordV2())).toContain('inputs::no_result')
        }
        // A real result still picks its own decision branch, and an answer record has no checking branch.
        expect(compiled(checkInputs('reversed'), recordV2()).branch).toBe('refuse')
        expect(failed(pendingInputs({ kind: 'answer' }), answerTemplate())).toContain('inputs::no_result')
    })

    it('holds the checking branch to the shared claims gates', () => {
        const bad = (change: (record: CheckingResultLayoutTemplateV2) => void): string[] => {
            const record = recordV2()
            change(record)
            return failed(pendingInputs(), record)
        }
        expect(
            bad((record) => {
                record.ready.checking.bar.primary = readyVariant('pass').bar.primary
            }).some((issue) => issue.endsWith('intent_not_allowed')),
        ).toBe(true)
        expect(
            bad((record) => {
                record.ready.checking.header.title = lit('Looks right')
            }).some((issue) => issue.endsWith('literal_not_listed') || issue.endsWith('title_not_listed')),
        ).toBe(true)
        expect(
            bad((record) => {
                stackOf(record.ready.checking).push({ type: 'Icon', name: 'check', tone: 'success', size: 'md' })
            }).some((issue) => issue.endsWith('icon_unearned') || issue.endsWith('tone_unearned')),
        ).toBe(true)
        expect(
            bad((record) => {
                stackOf(record.ready.checking).shift()
            }).some((issue) => issue.includes('held_photo')),
        ).toBe(true)
    })
})
