import {
    buildFallbackProposalV2,
    createDemoManual,
    manualSessionSchema,
    variantsOfV2,
    type ManualSession,
    type ScreenNodeV2,
    type ScreenProposalV2,
} from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { DOCUMENT_INSTRUCTIONS, DOCUMENT_PROMPT_VERSION } from '../../providers/document-prompt'
import { encodeWireProposal } from '../../providers/document-wire'
import { SAFETY_NOTE, documentInputs } from '../../test-support/document-inputs'
import { buildDocumentContext } from './context'
import { evaluateProposal, evaluateWire } from './ground'

const REASON = 'The warning box beside the diagram is cut off by the fold.'
const MARKER = 'state:safety-unreadable'
const COPY = 'A safety note could not be read. Add a clearer page before building.'

/** A valid unreviewed manual: the raw extraction is its only basis, and step 1 carries `notes` as its classification. */
function extracted(notes: unknown[]): ManualSession {
    const draft = createDemoManual()
    return manualSessionSchema.parse({
        ...draft,
        reviewStatus: 'unreviewed',
        reviewedSteps: [],
        rawExtraction: {
            parts: draft.parts,
            steps: draft.rawExtraction!.steps.map((step, at) => (at === 0 ? { ...step, safetyNotes: notes } : step)),
            unknowns: [],
        },
    })
}
const readable = {
    noteId: 'n1',
    note: { state: 'known', value: SAFETY_NOTE, sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
}
const unreadable = { noteId: 'n2', note: { state: 'unknown', reason: REASON } }

const closed = (node: ScreenNodeV2): ScreenNodeV2 => ({
    type: 'Section',
    title: { kind: 'literal', text: 'More detail' },
    collapsible: true,
    initiallyOpen: false,
    children: [node],
})
const spacer = (): ScreenNodeV2 => ({ type: 'Spacer', size: 'sm' })

function editFact(
    proposal: ScreenProposalV2,
    factId: string,
    edit: (node: ScreenNodeV2) => ScreenNodeV2,
): ScreenProposalV2 {
    const walk = (node: ScreenNodeV2): ScreenNodeV2 => {
        if (node.type === 'Text' && node.content.kind === 'fact' && node.content.factId === factId) return edit(node)
        return 'children' in node ? { ...node, children: node.children.map(walk) } : node
    }
    return { ...proposal, body: walk(proposal.body) }
}

describe('an unreadable safety note at the provider and cache gates (F1)', () => {
    const withNote = buildDocumentContext(documentInputs('guide', extracted([readable, unreadable])))
    const withoutNote = buildDocumentContext(documentInputs('guide', extracted([readable])))

    it('shows the provider the fixed statement with no source and no raw reason, and says what its basis means', () => {
        const view = withNote.view.dynamic.document as {
            facts: { id: string; kind: string; basis: string; text: string; sources: number[] }[]
            readyFacts: string[]
            requirements: { facts: string[] }
        }
        expect(view.facts.filter((fact) => fact.kind === 'safety')).toEqual([
            { id: MARKER, kind: 'safety', basis: 'unresolved-safety', text: COPY, sources: [] },
            expect.objectContaining({ id: 'safety:n1', basis: 'safety-note', text: SAFETY_NOTE }),
        ])
        expect(view.requirements.facts).toEqual(expect.arrayContaining([MARKER, 'safety:n1']))
        expect(view.readyFacts).toEqual(expect.arrayContaining([MARKER, 'safety:n1']))
        expect(JSON.stringify(withNote.view)).not.toContain('cut off')
        // The instructions define the derived basis, and the changed instructions are a new prompt (they key the cache).
        expect(DOCUMENT_INSTRUCTIONS).toContain('unresolved-safety')
        expect(DOCUMENT_INSTRUCTIONS).toContain(MARKER)
        expect(DOCUMENT_PROMPT_VERSION).toBeGreaterThanOrEqual(13)
    })

    it('accepts a raw proposal that states it and rejects one that omits or hides it in any variant', () => {
        const complete = buildFallbackProposalV2(withNote.material)
        expect(evaluateWire(encodeWireProposal(complete), withNote)).toMatchObject({ ok: true })
        for (const { name } of variantsOfV2(complete)) {
            for (const edit of [closed, spacer]) {
                const variant = name === 'ready' ? complete : complete.states[name]!
                const changed = editFact({ ...complete, ...variant }, MARKER, edit)
                const proposal =
                    name === 'ready'
                        ? { ...complete, body: changed.body }
                        : { ...complete, states: { ...complete.states, [name]: { ...variant, body: changed.body } } }
                const evaluated = evaluateWire(encodeWireProposal(proposal), withNote)
                expect(evaluated.ok, name).toBe(false)
                if (!evaluated.ok) {
                    expect(evaluated.issues, name).toContain(
                        `contract:a_required_fact_is_missing_from_the_${name}_variant`,
                    )
                }
            }
        }
    })

    it('never serves a cached proposal composed for a context with a different unreadable-note state', () => {
        // The grounded content (the cache key's content part) changes when a note becomes unreadable.
        expect(withNote.contentKey).not.toBe(withoutNote.contentKey)
        // A proposal composed without the explanation is refused for the context that needs it...
        const old = evaluateProposal(buildFallbackProposalV2(withoutNote.material), withNote)
        expect(old.ok).toBe(false)
        if (!old.ok) expect(old.issues).toContain('contract:a_required_fact_is_missing_from_the_ready_variant')
        // ...and one that states it is refused where the manual has no such note, so it cannot invent one.
        expect(evaluateProposal(buildFallbackProposalV2(withNote.material), withoutNote).ok).toBe(false)
        expect(evaluateProposal(buildFallbackProposalV2(withNote.material), withNote).ok).toBe(true)
    })
})
