import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    STATE_COPY_V2,
    VARIANT_STATES,
    assembleDocumentV2,
    buildFallbackDocumentV2,
    buildFallbackProposalV2,
    canonicalJson,
    carriedStateIssuesV2,
    createDemoManual,
    documentMaterialV2,
    isNonfactualVariantV2,
    recordedDocumentFactsV2,
    rebindGeneratedStatesV2,
    screenDocumentV2Schema,
    verifyDocumentAgainstInputsV2,
    type DocumentFacts,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
    type ScreenVariantV2,
    type VariantState,
} from './index'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2031-01-01T00:00:00.000Z') }

const lit = (text: string) => ({ kind: 'literal', text }) as const
const emptyLibrary: ScreenUiStateV2 = { library: { entries: [], soleManualId: null } }

function inputsOf(kind: 'home' | 'add' | 'pages', uiState: ScreenUiStateV2 = emptyLibrary): ScreenContextInputsV2 {
    return { kind, session: null, stepId: null, captureId: null, result: null, failure: null, uiState }
}
const pagesUi = (canRead: boolean): ScreenUiStateV2 => ({
    pages: { items: [{ pageId: 'p1', width: 10, height: 10 }], maxPages: 20, canRead, languageOptions: ['en'] },
})

const LIVE: DocumentFacts = {
    source: 'generated',
    evidence: 'live',
    fallbackReason: null,
    model: 'muse-wonder-1.0',
    effort: 'max',
    promptVersion: 9,
    generatedAt: '2026-10-30T05:00:00.000Z',
    timing: { timeToProviderMs: 3, providerMs: 800, parseValidateMs: 2, totalMs: 820 },
}

/** An "authored" donor: the same valid catalog the model writes, edited so its content is distinguishable. */
function authored(
    inputs: ScreenContextInputsV2,
    edit: (proposal: ScreenProposalV2) => ScreenProposalV2 = (proposal) => proposal,
    about: DocumentFacts = LIVE,
): ScreenDocumentV2 {
    const material = documentMaterialV2(inputs)
    return assembleDocumentV2(material, edit(buildFallbackProposalV2(material)), about, deps)
}
/** Swaps the order of the heading and the detail in the pending variant: valid, and visibly the donor's own writing. */
const reorderPending = (proposal: ScreenProposalV2): ScreenProposalV2 => {
    const pending = proposal.states.pending!
    const scroll = pending.body as Extract<ScreenNodeV2, { type: 'Scroll' }>
    const stack = scroll.children[0] as Extract<ScreenNodeV2, { type: 'Stack' }>
    const reordered: ScreenVariantV2 = {
        ...pending,
        body: { ...scroll, children: [{ ...stack, children: [...stack.children].reverse() }] },
    }
    return { ...proposal, states: { ...proposal.states, pending: reordered } }
}
const fallbackFor = (inputs: ScreenContextInputsV2, reason: 'busy' | 'disabled' = 'busy'): ScreenDocumentV2 =>
    buildFallbackDocumentV2(inputs, { ...deps, reason, evidence: 'local-deterministic' })
const parsed = (document: ScreenDocumentV2): boolean => screenDocumentV2Schema.safeParse(document).success
const originsOf = (document: ScreenDocumentV2, name: 'ready' | VariantState): Set<string> =>
    new Set(
        Object.entries(document.metadata.origins)
            .filter(([path]) => (name === 'ready' ? !path.startsWith('states.') : path.startsWith(`states.${name}.`)))
            .map(([, origin]) => origin),
    )

describe('a shell-filled state is a template, never a generated donor variant', () => {
    const inputs = inputsOf('home')
    const donor = authored(inputs, reorderPending, {
        ...LIVE,
        shellStates: ['busy', 'pending', 'empty', 'error', 'recovery'],
    })

    it('attributes the shell states to the shell and offers none of them to a fallback document', () => {
        expect(parsed(donor)).toBe(true)
        expect(originsOf(donor, 'ready')).toEqual(new Set(['generated']))
        expect(originsOf(donor, 'pending')).toEqual(new Set(['shell']))
        expect(rebindGeneratedStatesV2(inputs, fallbackFor(inputs), [donor], deps).carried).toEqual([])
    })
})

describe('an authored state variant is carried onto a deterministic document with its original provenance', () => {
    const inputs = inputsOf('home')
    const donor = authored(inputs, reorderPending)
    const target = fallbackFor(inputs)
    const result = rebindGeneratedStatesV2(inputs, target, [donor], deps)

    it('replaces the deterministic variants with the donor’s own, bound to the target context', () => {
        expect(result.carried).toEqual(['busy', 'pending', 'empty', 'error', 'recovery'])
        expect(parsed(result.document)).toBe(true)
        expect(verifyDocumentAgainstInputsV2(result.document, inputs, sha256Hex)).toEqual([])
        expect(canonicalJson(result.document.states.pending)).toBe(canonicalJson(donor.states.pending))
        expect(canonicalJson(result.document.states.pending)).not.toBe(canonicalJson(target.states.pending))
        // Everything that identifies the context, and the ready screen, are the target’s.
        expect(result.document.bound).toEqual(target.bound)
        expect(canonicalJson([result.document.header, result.document.body, result.document.bar])).toBe(
            canonicalJson([target.header, target.body, target.bar]),
        )
        expect(result.document.requirements).toEqual(target.requirements)
        expect(result.document.screenId).not.toBe(target.screenId)
    })

    it('attributes each variant truthfully: carried states generated, the rest still fallback', () => {
        expect(result.document.metadata).toMatchObject({
            source: 'fallback',
            evidence: 'local-deterministic',
            fallbackReason: 'busy',
            generatedAt: target.metadata.generatedAt,
        })
        expect(originsOf(result.document, 'ready')).toEqual(new Set(['fallback']))
        for (const state of result.carried) expect(originsOf(result.document, state)).toEqual(new Set(['generated']))
        expect(result.document.metadata.carried?.pending).toEqual({
            fromScreenId: donor.screenId,
            evidence: 'live',
            model: 'muse-wonder-1.0',
            effort: 'max',
            generatedAt: '2026-10-30T05:00:00.000Z',
            promptVersion: 9,
            fixtureId: null,
        })
        expect(carriedStateIssuesV2(result.document, [donor])).toEqual([])
    })

    it('keeps a recording’s identity: model, effort, date and fixture id of the run that authored it', () => {
        const recorded = authored(
            inputs,
            reorderPending,
            recordedDocumentFactsV2({
                fixtureId: 'unit-test-only-home',
                model: 'muse-wonder-1.0',
                effort: 'max',
                recordedAt: '2026-10-30T06:06:51Z',
                promptVersion: 0,
                repaired: false,
            }),
        )
        const carried = rebindGeneratedStatesV2(inputs, target, [recorded], deps)
        expect(carried.document.metadata.carried?.pending).toEqual({
            fromScreenId: recorded.screenId,
            evidence: 'recorded-generation',
            model: 'muse-wonder-1.0',
            effort: 'max',
            generatedAt: '2026-10-30T06:06:51Z',
            promptVersion: 0,
            fixtureId: 'unit-test-only-home',
        })
        expect(parsed(carried.document)).toBe(true)
        expect(carriedStateIssuesV2(carried.document, [recorded])).toEqual([])
    })

    it('takes each state from the first donor that fits, in the order given', () => {
        const reordered = authored(inputs, reorderPending, { ...LIVE, generatedAt: '2026-10-30T01:00:00.000Z' })
        const plain = authored(inputs, (proposal) => proposal, { ...LIVE, generatedAt: '2026-10-30T02:00:00.000Z' })
        expect(reordered.screenId).not.toBe(plain.screenId)
        const first = rebindGeneratedStatesV2(inputs, target, [reordered, plain], deps)
        expect(first.document.metadata.carried?.pending?.generatedAt).toBe('2026-10-30T01:00:00.000Z')
        expect(canonicalJson(first.document.states.pending)).toBe(canonicalJson(reordered.states.pending))
        const second = rebindGeneratedStatesV2(inputs, target, [plain, reordered], deps)
        expect(second.document.metadata.carried?.pending?.generatedAt).toBe('2026-10-30T02:00:00.000Z')
        expect(canonicalJson(second.document.states.pending)).toBe(canonicalJson(plain.states.pending))
    })
})

describe('a deterministic template is never relabelled generated', () => {
    const inputs = inputsOf('home')
    const target = fallbackFor(inputs)

    it('carries nothing from a fallback document, a local one, or the target itself, and returns the target as is', () => {
        for (const donors of [[], [target], [fallbackFor(inputs, 'disabled')]]) {
            const result = rebindGeneratedStatesV2(inputs, target, donors, deps)
            expect(result.document).toBe(target)
            expect(result.carried).toEqual([])
        }
    })

    it('treats a server fallback after a failed model call as deterministic, even though it names the model that failed', () => {
        // Evidence `live` and an observed model make this document look authored. Its variants are still builder output.
        const failed = buildFallbackDocumentV2(
            inputs,
            { ...deps, reason: 'repair_failed', evidence: 'live' },
            { model: 'muse-wonder-1.0', effort: 'max', repaired: true, rejectedIssues: 2 },
        )
        expect(failed.metadata).toMatchObject({ source: 'fallback', evidence: 'live', model: 'muse-wonder-1.0' })
        expect(parsed(failed)).toBe(true)
        const result = rebindGeneratedStatesV2(inputs, target, [failed], deps)
        expect(result.document).toBe(target)
        expect(result.carried).toEqual([])
    })

    it('leaves a generated target alone: authored content is never partly replaced', () => {
        const generated = authored(inputs)
        const result = rebindGeneratedStatesV2(inputs, generated, [authored(inputs, reorderPending)], deps)
        expect(result.document).toBe(generated)
        expect(result.carried).toEqual([])
    })

    it('does not touch a target that was not built for these inputs', () => {
        const other = fallbackFor(inputsOf('home', { library: { entries: [], soleManualId: 'elsewhere' } }))
        const result = rebindGeneratedStatesV2(inputs, other, [authored(inputs, reorderPending)], deps)
        expect(result.document).toBe(other)
        expect(result.carried).toEqual([])
    })

    it.each(VARIANT_STATES.filter((state) => state !== 'confirming'))(
        'the schema refuses generated origins on a fallback document without provenance: %s',
        (state) => {
            const forged = structuredClone(target)
            for (const path of Object.keys(forged.metadata.origins)) {
                if (path.startsWith(`states.${state}.`)) forged.metadata.origins[path] = 'generated'
            }
            expect(forged.states[state], `fixture must carry ${state}`).not.toBeNull()
            expect(parsed(forged)).toBe(false)
        },
    )
})

describe('the schema checks carried provenance like generated provenance', () => {
    const inputs = inputsOf('home')
    const donor = authored(inputs, reorderPending)
    const hybrid = rebindGeneratedStatesV2(inputs, fallbackFor(inputs), [donor], deps).document
    const edit = (
        change: (metadata: { carried: Record<string, Record<string, unknown>> }) => void,
    ): ScreenDocumentV2 => {
        const copy = structuredClone(hybrid) as unknown as {
            metadata: { carried: Record<string, Record<string, unknown>> }
        }
        change(copy.metadata)
        return copy as unknown as ScreenDocumentV2
    }

    it('accepts what the rebind produced', () => {
        expect(parsed(hybrid)).toBe(true)
    })

    type Carried = { carried: Record<string, Record<string, unknown>> }
    const pending = (m: Carried): Record<string, unknown> => m.carried.pending!
    it.each<[string, (m: Carried) => void]>([
        [
            'a live variant that names no model',
            (m): void => {
                pending(m).model = null
            },
        ],
        [
            'a synthetic variant that names a model',
            (m): void => {
                pending(m).evidence = 'synthetic-fixture'
            },
        ],
        [
            'a recorded variant without a fixture id',
            (m): void => {
                pending(m).evidence = 'recorded-generation'
            },
        ],
        [
            'a fixture id on a live variant',
            (m): void => {
                pending(m).fixtureId = 'recorded-home-first-launch-v1'
            },
        ],
        [
            'a deterministic evidence label',
            (m): void => {
                pending(m).evidence = 'local-deterministic'
            },
        ],
        [
            'a state the document does not carry',
            (m): void => {
                m.carried.confirming = { ...pending(m) }
            },
        ],
        [
            'the ready screen',
            (m): void => {
                m.carried.ready = { ...pending(m) }
            },
        ],
        [
            'an unknown provenance field',
            (m): void => {
                pending(m).timing = { totalMs: 5 }
            },
        ],
    ])('rejects %s', (_label, change) => {
        expect(parsed(edit(change))).toBe(false)
    })

    it('rejects carried states on a document that is itself generated', () => {
        const generated = structuredClone(donor) as unknown as { metadata: Record<string, unknown> }
        generated.metadata.carried = structuredClone(hybrid.metadata.carried)
        expect(parsed(generated as unknown as ScreenDocumentV2)).toBe(false)
    })

    it('rejects a carried state whose components are not attributed generated', () => {
        const copy = structuredClone(hybrid)
        copy.metadata.origins['states.pending.body'] = 'fallback'
        expect(parsed(copy)).toBe(false)
    })
})

describe('carried states are auditable against the documents that authored them', () => {
    const inputs = inputsOf('home')
    const donor = authored(inputs, reorderPending)
    const hybrid = rebindGeneratedStatesV2(inputs, fallbackFor(inputs), [donor], deps).document

    it('reports a donor that is missing, not generated, or whose variant or provenance differs', () => {
        expect(carriedStateIssuesV2(hybrid, [])).toContain('carried:pending:donor_missing')
        expect(carriedStateIssuesV2(hybrid, [fallbackFor(inputs)])).toContain('carried:pending:donor_missing')
        const shellDonor = authored(inputs, reorderPending, { ...LIVE, shellStates: ['pending'] })
        const claimedShell = structuredClone(hybrid)
        claimedShell.metadata.carried!.pending!.fromScreenId = shellDonor.screenId
        expect(carriedStateIssuesV2(claimedShell, [shellDonor])).toContain('carried:pending:donor_missing')
        const tampered = structuredClone(hybrid)
        tampered.states.pending = structuredClone(fallbackFor(inputs).states.pending)
        expect(carriedStateIssuesV2(tampered, [donor])).toContain('carried:pending:variant_differs')
        const reprovenanced = structuredClone(hybrid)
        reprovenanced.metadata.carried!.pending!.model = 'muse-spark-1.3'
        expect(carriedStateIssuesV2(reprovenanced, [donor])).toContain('carried:pending:provenance_differs')
    })

    it('reports nothing for a document that carries nothing', () => {
        expect(carriedStateIssuesV2(fallbackFor(inputs), [donor])).toEqual([])
    })
})

describe('a donor is judged on what it is now, every time it is used', () => {
    const inputs = inputsOf('home')
    const target = fallbackFor(inputs)
    type Change = (donor: ScreenDocumentV2) => void

    // The same object is used once while it is a valid generated document, then changed in place.
    it.each<[string, Change, boolean]>([
        [
            'becomes a deterministic document after a failed call, with valid fallback origins',
            (donor): void => {
                donor.metadata = {
                    ...donor.metadata,
                    source: 'fallback',
                    fallbackReason: 'repair_failed',
                    origins: Object.fromEntries(Object.keys(donor.metadata.origins).map((path) => [path, 'fallback'])),
                }
            },
            true,
        ],
        [
            'stops passing the published schema',
            (donor): void => {
                ;(donor as { version: number }).version = 3
            },
            false,
        ],
    ])('stops donating once it %s', (_label, change, stillValid) => {
        const donor = authored(inputs, reorderPending)
        expect(rebindGeneratedStatesV2(inputs, target, [donor], deps).carried).toContain('pending')

        change(donor)
        expect(parsed(donor), 'the changed donor is the kind of document the case names').toBe(stillValid)
        const again = rebindGeneratedStatesV2(inputs, target, [donor], deps)
        expect(again.carried).toEqual([])
        expect(again.document).toBe(target)
        // Rebind and audit never disagree about the same donor.
        expect(carriedStateIssuesV2(again.document, [donor])).toEqual([])
    })

    it.each<[string, Change, (document: ScreenDocumentV2) => void]>([
        [
            'a variant it was changed to hold',
            (donor): void => {
                donor.states.pending = structuredClone(authored(inputs).states.pending)
            },
            (document): void => {
                expect(canonicalJson(document.states.pending)).toBe(canonicalJson(authored(inputs).states.pending))
            },
        ],
        [
            'the provenance it was changed to name',
            (donor): void => {
                donor.metadata = { ...donor.metadata, model: 'muse-spark-1.3', generatedAt: '2026-10-30T06:00:00.000Z' }
            },
            (document): void => {
                expect(document.metadata.carried?.pending).toMatchObject({
                    model: 'muse-spark-1.3',
                    generatedAt: '2026-10-30T06:00:00.000Z',
                })
            },
        ],
    ])('carries %s, never what it held when it was first used', (_label, change, expectation) => {
        const donor = authored(inputs, reorderPending)
        const first = rebindGeneratedStatesV2(inputs, target, [donor], deps)
        expect(first.carried).toContain('pending')
        const handedOut = canonicalJson(first.document)

        change(donor)
        expect(parsed(donor)).toBe(true)
        const again = rebindGeneratedStatesV2(inputs, target, [donor], deps)
        expect(again.carried).toContain('pending')
        expectation(again.document)
        expect(carriedStateIssuesV2(again.document, [donor])).toEqual([])
        // A document already handed out is a value: editing its donor afterwards cannot rewrite it.
        expect(canonicalJson(first.document)).toBe(handedOut)
    })
})

describe('only safe, nonfactual variants are carried, and only where they fit this exact context', () => {
    it('never carries a variant that states a manual fact or cites a source', () => {
        const manual = createDemoManual()
        manual.reviewedSteps[0]!.safetyNotes = [
            {
                noteId: 'n1',
                note: {
                    state: 'known',
                    value: 'Keep fingers clear of the groove while the panel is lifted.',
                    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
                },
            },
        ]
        const guide: ScreenContextInputsV2 = {
            kind: 'guide',
            session: manual,
            stepId: 'step-1',
            captureId: null,
            result: null,
            failure: null,
            uiState: { capture: null },
        }
        const donor = authored(guide)
        // The waiting variants of this guide restate its mandatory safety note: they are this step's, not a template.
        expect(donor.requirements.facts.length).toBeGreaterThan(0)
        expect(isNonfactualVariantV2(donor.states.pending!)).toBe(false)
        expect(isNonfactualVariantV2(donor.states.busy!)).toBe(false)
        const result = rebindGeneratedStatesV2(guide, fallbackFor(guide), [donor], deps)
        expect(result.carried).not.toContain('pending')
        expect(result.carried).not.toContain('busy')
        expect(result.document).toSatisfy(parsed)
    })

    const variantWith = (node: ScreenNodeV2): ScreenVariantV2 => ({
        header: { title: lit('Your manuals'), subtitle: null, back: null, actions: [] },
        body: { type: 'Scroll', axis: 'vertical', children: [node] },
        bar: {
            primary: {
                type: 'PrimaryAction',
                label: 'Home',
                icon: null,
                intent: { intent: 'navigate', target: 'home' },
            },
            secondary: null,
        },
        overlays: [],
    })
    type TextContent = Extract<ScreenNodeV2, { type: 'Text' }>['content']
    const text = (content: TextContent): ScreenNodeV2 => ({
        type: 'Text',
        content,
        role: 'body',
        emphasis: 'normal',
        tone: 'neutral',
        align: 'start',
    })
    const cases: [string, ScreenNodeV2, boolean][] = [
        ['a literal text', text(lit('Preparing this screen')), true],
        ['a bound text', text({ kind: 'bound', key: 'pages-summary' }), true],
        ['a fact text', text({ kind: 'fact', factId: 'title' }), false],
        ['a citation', { type: 'Citation', sources: [0], label: null, display: 'chip' }, false],
        [
            'a manual page',
            { type: 'ManualPage', sources: [0], fit: 'contain', label: null, initiallyOpen: false },
            false,
        ],
        [
            'the held photo',
            { type: 'Image', source: { kind: 'capture' }, fit: 'cover', ratio: 'hero', caption: null },
            true,
        ],
        [
            'a source figure',
            { type: 'Image', source: { kind: 'source', index: 0 }, fit: 'cover', ratio: 'hero', caption: null },
            false,
        ],
        [
            'a page figure',
            { type: 'Image', source: { kind: 'page', pageId: 'p1' }, fit: 'cover', ratio: 'hero', caption: null },
            false,
        ],
        ['a part tile', { type: 'PieceTile', partId: 'a', showQuantity: false, size: 'sm' }, false],
        [
            'a verdict card',
            { type: 'VerdictCard', result: 'check', variant: 'card', showReason: true, showRegions: false },
            false,
        ],
        [
            'a camera view',
            { type: 'CameraView', mode: 'build-photo', cue: 'Hold steady', pill: null, tipTarget: null },
            false,
        ],
        [
            'a fact editor',
            { type: 'FactEditor', kind: 'orientation', label: 'a', saveLabel: 'Save', cancelLabel: 'Cancel' },
            false,
        ],
        ['the recent manuals', { type: 'ManualList', entries: 'recent', layout: 'cards', showProgress: true }, true],
        [
            'named manuals',
            { type: 'ManualList', entries: { manualIds: ['m1'] }, layout: 'cards', showProgress: true },
            false,
        ],
        ['a judge panel', { type: 'JudgePanel', panel: 'about-check' }, false],
        ['a compare view', { type: 'CompareColumns', subject: 'manuals' }, false],
        ['a progress bar', { type: 'Progress', binding: 'build', label: null }, true],
        [
            'a section titled by a fact',
            {
                type: 'Section',
                title: { kind: 'fact', factId: 'x' },
                collapsible: false,
                initiallyOpen: true,
                children: [],
            },
            false,
        ],
    ]
    it.each(cases)('%s', (_label, node, expected) => {
        expect(isNonfactualVariantV2(variantWith(node))).toBe(expected)
    })

    it('does not carry a variant that is a fact in its header', () => {
        const variant = variantWith(text(lit('Preparing this screen')))
        expect(
            isNonfactualVariantV2({ ...variant, header: { ...variant.header, title: { kind: 'fact', factId: 'x' } } }),
        ).toBe(false)
    })

    it('fails closed on a busy variant written for another activity', () => {
        // The busy header must name the activity the app is really doing; a donor written for another activity cannot be it.
        const idle = inputsOf('add', { ...pagesUi(true), busy: null })
        const saving = inputsOf('add', { ...pagesUi(true), busy: { activity: 'saving' } })
        const result = rebindGeneratedStatesV2(saving, fallbackFor(saving), [authored(idle)], deps)
        expect(result.carried).not.toContain('busy')
        expect(result.carried).toContain('pending')
        expect(parsed(result.document)).toBe(true)
        expect(verifyDocumentAgainstInputsV2(result.document, saving, sha256Hex)).toEqual([])
    })

    it('fails closed on an action the target context does not allow', () => {
        // Confirming the reading needs pages that can be read: the donor's waiting bar points at it, the target cannot.
        const readable = inputsOf('pages', pagesUi(true))
        const unreadable = inputsOf('pages', pagesUi(false))
        const result = rebindGeneratedStatesV2(unreadable, fallbackFor(unreadable), [authored(readable)], deps)
        expect(result.carried).not.toContain('pending')
        expect(result.carried).not.toContain('busy')
        expect(result.carried).toContain('error')
    })

    it('fails closed on a kind-specific template, and carries a generic one into any kind', () => {
        const home = inputsOf('home')
        const add = inputsOf('add', pagesUi(true))
        // Home loading copy belongs to Home, not the Add screen.
        const specific = rebindGeneratedStatesV2(add, fallbackFor(add), [authored(home)], deps)
        expect(specific.carried).not.toContain('pending')
        // A generic template (its title is the state’s own listed heading) is valid wherever that heading is listed.
        const generic = authored(home, (proposal) => {
            const pending = proposal.states.pending!
            return {
                ...proposal,
                states: {
                    ...proposal.states,
                    pending: {
                        ...variantWith(text(lit(STATE_COPY_V2.pending.heading))),
                        header: { ...pending.header, title: lit(STATE_COPY_V2.pending.heading) },
                    },
                },
            }
        })
        const carried = rebindGeneratedStatesV2(add, fallbackFor(add), [generic], deps)
        expect(carried.carried).toContain('pending')
        expect(carried.document.metadata.carried?.pending?.fromScreenId).toBe(generic.screenId)
        expect(parsed(carried.document)).toBe(true)
        expect(verifyDocumentAgainstInputsV2(carried.document, add, sha256Hex)).toEqual([])
    })

    it('honours a requested subset of states', () => {
        const inputs = inputsOf('home')
        const result = rebindGeneratedStatesV2(inputs, fallbackFor(inputs), [authored(inputs, reorderPending)], deps, {
            states: ['pending'],
        })
        expect(result.carried).toEqual(['pending'])
        expect(result.document.metadata.carried).toEqual({ pending: expect.any(Object) })
    })
})
