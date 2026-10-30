import {
    buildFallbackProposalV2,
    nodeFactIdsV2,
    visitVariantNodesV2,
    type ManualSession,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
} from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { DOCUMENT_INSTRUCTIONS } from '../../providers/document-prompt'
import { encodeWireProposal } from '../../providers/document-wire'
import { demoSession, documentInputs, fullUi } from '../../test-support/document-inputs'
import { aiPolicyFromEnvironment } from '../ai-policy'
import type { BackgroundWork } from '../screens/service'
import { buildDocumentContext } from './context'
import { checkProposal } from './ground'
import { createDocumentService } from './service'

// The server side of the quick check of a fully known manual: what the model is shown and owes, what the gate refuses,
// and that a model document which keeps the overview is published as it was written. Contract rules live in
// packages/contracts/src/document-v2-overview.test.ts.

const known: ScreenUiStateV2 = {
    ...fullUi,
    review: { currentQuestion: null, blockers: 0, canConfirm: true },
}
const contextOf = (ui: ScreenUiStateV2 = known): ReturnType<typeof buildDocumentContext> =>
    buildDocumentContext(documentInputs('quick-check', demoSession(), ui))

const without = (node: ScreenNodeV2, drop: (candidate: ScreenNodeV2) => boolean): ScreenNodeV2 =>
    'children' in node
        ? ({
              ...node,
              children: node.children.filter((child) => !drop(child)).map((child) => without(child, drop)),
          } as ScreenNodeV2)
        : node
const mapNodes = (node: ScreenNodeV2, change: (candidate: ScreenNodeV2) => ScreenNodeV2): ScreenNodeV2 => {
    const next = change(node)
    return 'children' in next
        ? ({ ...next, children: next.children.map((child) => mapNodes(child, change)) } as ScreenNodeV2)
        : next
}
const edited = (
    context: ReturnType<typeof buildDocumentContext>,
    edit: (body: ScreenNodeV2) => ScreenNodeV2,
): ScreenProposalV2 => {
    const proposal = buildFallbackProposalV2(context.material)
    return { ...proposal, body: edit(proposal.body) }
}

describe('quick check of a fully known manual on the server', () => {
    it('accepts the complete deterministic composition and tells the model what the ready screen owes', () => {
        const context = contextOf()
        expect(checkProposal(buildFallbackProposalV2(context.material), context)).toEqual([])
        const document = context.view.dynamic.document as {
            overview: boolean
            readyFacts: string[]
            requirements: { facts: string[] }
        }
        expect(document.overview).toBe(true)
        expect(document.requirements.facts).toEqual([])
        expect(document.readyFacts).toEqual(['overview:step:step-1', 'overview:step:step-2'])
        expect(DOCUMENT_INSTRUCTIONS).toContain('readyFacts')
        expect(DOCUMENT_INSTRUCTIONS).toContain('document.overview')
    })

    it('shows no overview while a question is pending or the review cannot be confirmed', () => {
        for (const review of [
            fullUi.review,
            { currentQuestion: null, blockers: 1, canConfirm: false },
        ] as ScreenUiStateV2['review'][]) {
            const context = contextOf({ ...fullUi, review })
            const document = context.view.dynamic.document as { overview: boolean; readyFacts: string[] }
            expect(document.overview).toBe(false)
            expect(document.readyFacts).toEqual([])
            expect(context.material.facts).toEqual([])
        }
    })

    it('refuses a model document that leaves a step out, hides the steps, or drops the picture', () => {
        const context = contextOf()
        const dropStep = edited(context, (body) =>
            without(
                body,
                (node) =>
                    node.type === 'Text' && node.content.kind === 'fact' && node.content.factId.endsWith('step-2'),
            ),
        )
        expect(checkProposal(dropStep, context).join()).toMatch(/required_fact_is_missing/u)
        const hidden = edited(context, (body) =>
            mapNodes(body, (node) =>
                node.type === 'Section' && node.title?.kind === 'literal' && node.title.text === 'Steps'
                    ? { ...node, collapsible: true, initiallyOpen: false }
                    : node,
            ),
        )
        expect(checkProposal(hidden, context).join()).toMatch(/required_fact_is_missing/u)
        const noPicture = edited(context, (body) => without(body, (node) => node.type === 'Image'))
        expect(checkProposal(noPicture, context).join()).toMatch(/source_picture/u)
    })

    it('refuses invented parts, step claims written as literals, and overview steps in a waiting variant', () => {
        const context = contextOf()
        const part = edited(context, (body) =>
            mapNodes(body, (node) => (node.type === 'PieceTile' ? { ...node, partId: 'ghost-part' } : node)),
        )
        expect(checkProposal(part, context).join()).toContain('unknown_part')
        const prose = edited(context, (body) =>
            mapNodes(body, (node) =>
                node.type === 'Section' ? { ...node, title: { kind: 'literal', text: 'Twelve steps found' } } : node,
            ),
        )
        expect(checkProposal(prose, context).join()).toMatch(/literal_not_listed|literal_digits/u)
        const proposal = buildFallbackProposalV2(context.material)
        const busy = proposal.states.busy!
        const leaked: ScreenProposalV2 = {
            ...proposal,
            states: {
                ...proposal.states,
                busy: {
                    ...busy,
                    body: {
                        type: 'Stack',
                        gap: 'md',
                        align: 'stretch',
                        children: [
                            busy.body,
                            {
                                type: 'Text',
                                content: { kind: 'fact', factId: 'overview:step:step-1' },
                                role: 'body',
                                emphasis: 'normal',
                                tone: 'neutral',
                                align: 'start',
                            },
                        ],
                    },
                },
            },
        }
        // The overview is earned by the ready screen only: a waiting variant that states a step is refused.
        expect(checkProposal(buildFallbackProposalV2(context.material), context)).toEqual([])
        expect(checkProposal(leaked, context).join()).toContain('states_the_manual_overview')
        visitVariantNodesV2(proposal.states.pending!, 'states.pending.', ({ node }) =>
            expect(nodeFactIdsV2(node).filter((id) => id.startsWith('overview:'))).toEqual([]),
        )
    })

    it('publishes a model document that keeps the overview exactly as the model wrote it', async () => {
        const policy = aiPolicyFromEnvironment(
            {},
            {
                checkTimeoutMs: 8_000,
                parseModel: 'muse-spark-1.3',
                verdictModel: 'muse-spark-1.3',
                secondOpinionModel: 'muse-wonder-1.0',
            },
        )
        const work: BackgroundWork = {
            run: (_options, job) => job(),
            repair: (job) => job(),
            tryAcquire: () => () => {},
            acquire: async () => () => {},
        }
        const inputs = documentInputs('quick-check', demoSession(), known)
        const context = buildDocumentContext(inputs)
        const service = createDocumentService({
            provider: {
                generateDocument: async () => ({
                    value: encodeWireProposal(buildFallbackProposalV2(context.material)),
                    telemetry: {
                        stage: 'screens',
                        model: 'muse-spark-1.3',
                        effort: 'max',
                        timeToProviderMs: 1,
                        providerMs: 2,
                        parseValidateMs: 1,
                        totalMs: 4,
                        paceWaitMs: 0,
                        networkMs: 1,
                        bodyMs: 1,
                        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 },
                    },
                }),
            },
            policy,
            runtimeMode: 'meta',
            work,
        })
        const document = await service.generate(inputs)
        expect(document.metadata.source).toBe('generated')
        expect(document.facts.filter((fact) => fact.basis === 'overview').map((fact) => fact.text)).toEqual([
            'Stand the side panel upright',
            'Seat the divider in the groove',
        ])
    })
})

// ---------------------------------------------------------------------------------------------------------------------
// What the gate owes the overview besides the steps: citations, the manual title, every known part, and a waiting
// variant that claims nothing. Contract rules (and the client verifier) are exercised in the contracts package.
// ---------------------------------------------------------------------------------------------------------------------

const twoPages = (): ManualSession => {
    const session = demoSession()
    session.pages.push({ ...session.pages[0]!, pageId: 'demo-page-2', assetId: 'demo-asset-2' })
    session.reviewedSteps[1]!.sourceRefs = [{ pageId: 'demo-page-2', region: null }]
    return session
}
const withParts = (count: number): ManualSession => {
    const session = demoSession()
    for (let at = 0; at < count; at += 1) {
        session.parts.push({
            partId: `extra-${at}`,
            name: { state: 'known', value: `Extra ${at}`, sourceRefs: [{ pageId: 'demo-page-1', region: null }] },
        } as never)
    }
    return session
}
const contextFor = (
    session: ManualSession,
    review: ScreenUiStateV2['review'] = known.review,
): ReturnType<typeof buildDocumentContext> =>
    buildDocumentContext(documentInputs('quick-check', session, { ...fullUi, review }))
const waiting =
    (name: 'busy' | 'pending' | 'error' | 'recovery', extra: ScreenNodeV2) =>
    (context: ReturnType<typeof buildDocumentContext>): ScreenProposalV2 => {
        const proposal = buildFallbackProposalV2(context.material)
        const variant = proposal.states[name]!
        return {
            ...proposal,
            states: {
                ...proposal.states,
                [name]: {
                    ...variant,
                    body: { type: 'Stack', gap: 'md', align: 'stretch', children: [variant.body, extra] },
                },
            },
        }
    }

describe('the gate holds the overview to its citations, title and parts', () => {
    it('refuses a ready screen that leaves out the citations of the steps it states', () => {
        const context = contextFor(twoPages())
        expect(checkProposal(buildFallbackProposalV2(context.material), context)).toEqual([])
        const bare = edited(context, (body) => without(body, (node) => node.type === 'Citation'))
        expect(checkProposal(bare, context).join()).toMatch(/required_citation_is_missing/u)
    })

    it('refuses a ready screen that leaves out the manual title or any known part', () => {
        const context = contextFor(withParts(3))
        const untitled = edited(context, (body) =>
            without(
                body,
                (node) => node.type === 'Text' && node.content.kind === 'bound' && node.content.key === 'manual-title',
            ),
        )
        expect(checkProposal(untitled, context).join()).toMatch(/manual_title_is_missing/u)
        const noParts = edited(context, (body) => without(body, (node) => node.type === 'PieceTile'))
        expect(checkProposal(noParts, context).join()).toMatch(/required_part_is_missing/u)
        const lastOnly = edited(context, (body) =>
            without(body, (node) => node.type === 'PieceTile' && node.partId === 'extra-2'),
        )
        expect(checkProposal(lastOnly, context).join()).toMatch(/required_part_is_missing/u)
    })

    it('tells the model every part it owes, and that a part is never dropped', () => {
        const context = contextFor(withParts(3))
        const document = context.view.dynamic.document as { requirements: { parts: string[] } }
        expect(document.requirements.parts).toEqual(['side-panel', 'divider', 'extra-0', 'extra-1', 'extra-2'])
        expect(DOCUMENT_INSTRUCTIONS).toContain('requirements.parts')
    })

    it.each([
        ['a piece tile', { type: 'PieceTile', partId: 'side-panel', showQuantity: false, size: 'sm' } as ScreenNodeV2],
        [
            'the source picture',
            {
                type: 'Image',
                source: { kind: 'source', index: 0 },
                fit: 'contain',
                ratio: 'hero',
                caption: null,
            } as ScreenNodeV2,
        ],
        [
            'a collapsed step',
            {
                type: 'Section',
                title: null,
                collapsible: true,
                initiallyOpen: false,
                children: [
                    {
                        type: 'Text',
                        content: { kind: 'fact', factId: 'overview:step:step-1' },
                        role: 'body',
                        emphasis: 'normal',
                        tone: 'neutral',
                        align: 'start',
                    },
                ],
            } as ScreenNodeV2,
        ],
    ])('refuses a pending variant that shows %s', (_name, node) => {
        const context = contextFor(demoSession())
        expect(checkProposal(waiting('pending', node)(context), context).join()).toMatch(/states_the_manual_overview/u)
    })
})

describe('the gate accepts every part of a large manual, and the deterministic screen the app can earn', () => {
    it('accepts the complete composition of a manual with 49 known parts and refuses one without the last', () => {
        const context = contextFor(withParts(47))
        const document = context.view.dynamic.document as { requirements: { parts: string[] } }
        expect(document.requirements.parts).toHaveLength(49)
        expect(checkProposal(buildFallbackProposalV2(context.material), context)).toEqual([])
        const short = edited(context, (body) =>
            without(body, (node) => node.type === 'PieceTile' && node.partId === 'extra-46'),
        )
        expect(checkProposal(short, context).join()).toMatch(/required_part_is_missing/u)
    })

    it.each([
        ['it cannot be confirmed yet', { currentQuestion: null, blockers: 1, canConfirm: false }],
        ['the app holds no review state', null],
        ['a question is asked and the manual cannot be confirmed yet', { ...fullUi.review!, canConfirm: false }],
    ] as [string, ScreenUiStateV2['review']][])(
        'accepts the deterministic composition, in every variant, when %s',
        (_name, review) => {
            const context = contextFor(demoSession(), review)
            expect(checkProposal(buildFallbackProposalV2(context.material), context)).toEqual([])
        },
    )
})
