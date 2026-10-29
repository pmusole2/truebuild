import {
    createDemoManual,
    SCREEN_CATALOG_VERSION,
    SCREEN_KINDS,
    SCREEN_LIMITS,
    screenComponentPaths,
    screenDocumentSchema,
    screenNodeSchema,
    screenProposalSchema,
    type ManualSession,
    type ScreenKind,
    type ScreenNode,
    type ScreenProposal,
} from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { stepFixtures } from '../../test-support/step-fixtures'
import { composeDeterministic } from './compose'
import { buildContext, plain, type ScreenInputs } from './context'
import { finalize, groundProposal, intentAllowed, validateProposal, withRequiredContent } from './ground'
import { splitLossless } from './text'

function session(change?: (value: ManualSession) => void): ManualSession {
    const value = createDemoManual()
    change?.(value)
    return value
}

const realPartId = createDemoManual().reviewedSteps[0]!.parts[0]!.partId
const check = {
    decision: 'refuse' as const,
    reason: 'The groove faces the wrong way.',
    sourceRefs: [{ pageId: 'demo-page-1', region: null }],
    observedRegion: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
    missingEvidence: [],
    nextPartRegion: { partId: realPartId, region: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } },
}

function inputs(kind: ScreenKind, overrides: Partial<ScreenInputs> = {}): ScreenInputs {
    const manual = overrides.session === undefined ? session() : overrides.session
    const needsStep = ['guide', 'result', 'questions', 'answer', 'recovery'].includes(kind)
    return {
        kind,
        session: ['home', 'add', 'pages', 'more', 'error'].includes(kind) ? null : manual,
        stepId: needsStep ? 'step-1' : null,
        captureId: kind === 'result' || kind === 'answer' ? 'capture-1' : null,
        result:
            kind === 'result'
                ? { kind: 'check', value: check }
                : kind === 'answer'
                  ? {
                        kind: 'question',
                        question: 'Which way?',
                        value: {
                            answer: 'Follow the cited diagram.',
                            sourceRefs: [],
                            missingEvidence: ['A clearer view'],
                        },
                    }
                  : null,
        failure: kind === 'error' ? 'timeout' : null,
        ...overrides,
    }
}

const header = { type: 'ScreenHeader', title: 'Step 1', subtitle: null, trailing: null }
const bar = {
    primary: {
        type: 'PrimaryAction',
        label: 'Take photo',
        icon: 'camera',
        intent: { intent: 'capture', target: 'take-photo' },
    },
    secondary: null,
}
function proposal(body: unknown[], overrides: Record<string, unknown> = {}): ScreenProposal {
    return screenProposalSchema.parse({ header, body, bar, ...overrides })
}
const instruction = (text: string, citations: number[] = []): unknown => ({
    type: 'Instruction',
    text,
    emphasis: 'normal',
    citations,
})
const warning = (text: string): unknown => ({ type: 'Warning', text, tone: 'caution', citations: [] })

const STEP_TITLE = 'Stand the side panel upright'
const ORIENTATION = 'Groove faces inward toward the divider.'

/** The grounded body as plain data, with every nested block flattened for assertions. */
function flat(nodes: readonly ScreenNode[]): ScreenNode[] {
    return nodes.flatMap((node): ScreenNode[] =>
        node.type === 'Group' || node.type === 'DetailsDisclosure' ? [node, ...node.children] : [node],
    )
}
const texts = (nodes: readonly ScreenNode[], type: string): string[] =>
    flat(nodes).flatMap((node) => (node.type === type && 'text' in node ? [node.text] : []))

describe('deterministic composition', (): void => {
    it.each(['check', 'question'] as const)(
        'preserves operators in actual %s text and missing evidence',
        (kind): void => {
            const text = 'Keep the load < 5 kg.'
            const missing = 'The clearance must be > 5 mm.'
            const result: ScreenInputs['result'] =
                kind === 'check'
                    ? { kind, value: { ...check, reason: text, missingEvidence: [missing] } }
                    : {
                          kind,
                          question: 'How much?',
                          value: { answer: text, sourceRefs: check.sourceRefs, missingEvidence: [missing] },
                      }
            const context = buildContext(inputs(kind === 'check' ? 'result' : 'answer', { result }))
            const final = finalize(withRequiredContent(composeDeterministic(context), context).screen, context)
            const node = flat(final.body).find(
                (entry) => entry.type === (kind === 'check' ? 'ResultBanner' : 'AnswerCard'),
            )
            expect(node).toMatchObject({ text })
            expect(context.witnesses.find((entry) => entry.id === 'missing:0')?.text).toBe(missing)
            expect(screenNodeSchema.safeParse(node).success).toBe(true)
        },
    )
    it.each(SCREEN_KINDS)('composes a schema-valid %s screen from validated facts alone', (kind): void => {
        const context = buildContext(inputs(kind))
        const forced = withRequiredContent(composeDeterministic(context), context)
        expect(forced.complete).toBe(true)
        const final = finalize(forced.screen, context)
        const origins = Object.fromEntries(Object.keys(final.origins).map((path) => [path, 'fallback']))
        const document = {
            version: 1,
            kind,
            screenId: 'a'.repeat(64),
            bound: context.bound,
            metadata: {
                source: 'fallback',
                origins,
                evidence: 'live',
                stage: 'screen',
                model: null,
                effort: null,
                fallbackReason: 'disabled',
                repaired: false,
                cacheHit: false,
                catalogVersion: SCREEN_CATALOG_VERSION,
                promptVersion: 3,
                generatedAt: '2026-01-01T00:00:00.000Z',
                timing: { timeToProviderMs: null, providerMs: null, parseValidateMs: null, totalMs: null },
                usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null },
                droppedFacts: 0,
                forcedSafety: 0,
            },
            header: final.header,
            body: final.body,
            bar: final.bar,
            sources: final.sources,
            ...(final.manualFacts.length > 0 ? { manualFacts: final.manualFacts } : {}),
        }
        const parsed = screenDocumentSchema.safeParse(document)
        expect(parsed.success).toBe(true)
        expect(Object.keys(origins)).toEqual(screenComponentPaths(document as never))
    })

    it('cites the actual sources of each fact instead of an index and publishes the full original facts', (): void => {
        const context = buildContext(inputs('guide'))
        const final = finalize(withRequiredContent(composeDeterministic(context), context).screen, context)
        const lead = final.body.find((node) => node.type === 'Instruction')
        expect(lead).toMatchObject({ text: STEP_TITLE, citations: [0] })
        expect(final.sources).toEqual([{ pageId: 'demo-page-1', region: null }])
        const more = final.body.find((node) => node.type === 'DetailsDisclosure')
        expect(more).toBeUndefined()
        // The complete originals are the step's published manual facts, named by one fallback ManualDirections block.
        expect(final.manualFacts.map((fact) => [fact.factId, fact.placement])).toEqual([
            ['title', 'body'],
            ['orientation', 'body'],
            ['connection', 'body'],
            ['check:groove-inward', 'body'],
            ['correction:turn-panel', 'body'],
        ])
        expect(final.manualFacts.find((fact) => fact.factId === 'orientation')).toMatchObject({
            text: ORIENTATION,
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
        })
        expect(final.body.find((node) => node.type === 'ManualDirections')).toMatchObject({
            factIds: ['title', 'orientation', 'connection', 'check:groove-inward', 'correction:turn-panel'],
        })
    })

    it('splits a long fact losslessly into bounded blocks and never truncates it to an ellipsis', (): void => {
        const long =
            'Slide the panel in until the groove seats fully on the rail, then hold it in place with one hand while the other hand tightens each fixing a quarter turn at a time, and stop at once if the panel moves.'
        const chunks = splitLossless(long, SCREEN_LIMITS.instructionChars, SCREEN_LIMITS.instructionWords)
        expect(chunks.length).toBeGreaterThan(1)
        expect(chunks.join(' ')).toBe(long)
        for (const chunk of chunks) {
            expect(Array.from(chunk).length).toBeLessThanOrEqual(SCREEN_LIMITS.instructionChars)
            expect(chunk.split(' ').length).toBeLessThanOrEqual(SCREEN_LIMITS.instructionWords)
            expect(chunk).not.toContain('…')
        }
        const edited = session((value) => {
            value.reviewedSteps[0]!.orientation = {
                state: 'known',
                value: { partId: 'side-panel', description: long },
                sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            }
        })
        const context = buildContext(inputs('guide', { session: edited }))
        const final = finalize(withRequiredContent(composeDeterministic(context), context).screen, context)
        // A fact too long for one up-front instruction is published whole, never clipped or ellipsized.
        expect(final.manualFacts.find((fact) => fact.factId === 'orientation')?.text).toBe(long)
        expect(JSON.stringify(final)).not.toContain('…')
    })
})

describe('context identity', (): void => {
    it('changes the context key with any manual value, capture or result, so nothing is reused across them', (): void => {
        const base = buildContext(inputs('result')).bound
        const otherCapture = buildContext(inputs('result', { captureId: 'capture-2' })).bound
        const otherResult = buildContext(
            inputs('result', {
                result: { kind: 'check', value: { ...check, decision: 'cannot_verify', observedRegion: null } },
            }),
        ).bound
        const edited = buildContext(
            inputs('result', {
                session: session((value) => {
                    value.reviewedSteps[0]!.title = 'A different title'
                }),
            }),
        ).bound
        const keys = new Set([base, otherCapture, otherResult, edited].map((bound) => bound.contextKey))
        expect(keys.size).toBe(4)
        expect(buildContext(inputs('result')).bound).toEqual(base)
        expect(buildContext(inputs('guide')).bound.captureId).toBeNull()
    })

    it('hashes every input the provider receives: unrelated part names, page identity and fact sources', (): void => {
        const key = (change: (value: ManualSession) => void): string =>
            buildContext(inputs('guide', { session: session(change) })).bound.contextKey
        const base = buildContext(inputs('guide')).bound.contextKey
        const keys = new Set([
            base,
            // A part of the manual that is not in this step.
            key((value) => {
                value.parts[1] = {
                    ...value.parts[1]!,
                    name: { ...value.parts[1]!.name, value: 'Renamed shelf' } as never,
                }
            }),
            // Page identity: asset, content hash and dimensions of a cited page.
            key((value) => {
                value.pages[0] = { ...value.pages[0]!, contentHash: 'f'.repeat(64) }
            }),
            key((value) => {
                value.pages[0] = { ...value.pages[0]!, width: value.pages[0]!.width + 1 }
            }),
            // Which source a fact cites.
            key((value) => {
                value.reviewedSteps[0]!.orientation = {
                    ...value.reviewedSteps[0]!.orientation,
                    sourceRefs: [{ pageId: 'demo-page-1', region: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
                } as never
            }),
        ])
        expect(keys.size).toBe(5)
    })

    it('keeps the content key of identical facts across a new revision, so a prepared composition is reusable', (): void => {
        const later = session((value) => {
            value.revision = 2
        })
        const a = buildContext(inputs('guide'))
        const b = buildContext(inputs('guide', { session: later }))
        expect(a.bound.contextKey).not.toBe(b.bound.contextKey)
        expect(a.contentKey).toBe(b.contentKey)
    })
})

describe('grounding model proposals against actual manual values', (): void => {
    const context = buildContext(inputs('guide'))
    const step = context.step!
    const first = step.parts[0]!
    const name = context.partNames.get(first.partId)!
    const quantity = context.quantities.get(first.partId)

    it('rejects a structurally invalid proposal with machine issue codes only', (): void => {
        const result = validateProposal({ header: { type: 'ScreenHeader', title: 'Secret text <b>' } })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.issues.length).toBeGreaterThan(0)
            expect(result.issues.join(' ')).not.toContain('Secret')
        }
    })

    it('keeps a fact stated exactly, with its own sources, and drops any other factual text', (): void => {
        const grounded = groundProposal(
            proposal([instruction(STEP_TITLE), instruction('Insert 99 bolts now')]),
            context,
        )!
        expect(
            texts(
                grounded.screen.items.map((entry) => entry.node),
                'Instruction',
            ),
        ).toEqual([STEP_TITLE])
        expect(grounded.tally.droppedBlocks).toBe(1)
        expect(grounded.screen.items[0]!.node).toMatchObject({ citations: [0] })
    })

    it('drops a numberless contradiction and a known number moved onto the wrong part', (): void => {
        const arm = stepFixtures()[1]!
        const armContext = buildContext(inputs('guide', { session: arm.session, stepId: 'arm-step-1' }))
        const grounded = groundProposal(
            proposal([
                // Contradicts "Groove faces inward toward the divider." with no number at all.
                instruction('Groove faces outward away from the divider.'),
                instruction('Turn the panel outward'),
                // Right facts, shuffled into a false claim: the four bolts belong to the bracket, not the arm.
                instruction('Four bolts hold the arm to the post.'),
                // Exactly the manual's words survive.
                instruction('Four bolts hold the bracket to the post.'),
            ]),
            armContext,
        )!
        expect(
            texts(
                grounded.screen.items.map((entry) => entry.node),
                'Instruction',
            ),
        ).toEqual(['Four bolts hold the bracket to the post.'])
        expect(groundProposal(proposal([instruction('Turn the panel outward')]), context)).toBeNull()
    })

    it('drops a claim whose citation support is foreign or empty, and never takes a citation from the model', (): void => {
        const arm = stepFixtures()[1]!
        const armContext = buildContext(inputs('guide', { session: arm.session, stepId: 'arm-step-2' }))
        // The orientation fact cites only arm-page-2; source 0 is arm-page-1, which does not support it.
        const orientation = 'Arm extends away from the console.'
        const foreign = groundProposal(proposal([instruction(orientation, [0]), instruction(STEP_TITLE)]), armContext)
        expect(foreign).toBeNull()
        const own = groundProposal(proposal([instruction(orientation, [1])]), armContext)!
        expect(own.screen.items[0]!.node).toMatchObject({ citations: [1] })
        const unprompted = groundProposal(proposal([instruction(orientation)]), armContext)!
        expect(unprompted.screen.items[0]!.node).toMatchObject({ citations: [1] })
        // The manual title is not backed by any source, so it cannot be restated as a fact.
        expect(groundProposal(proposal([instruction('Demo data — simulated results')]), context)).toBeNull()
        // A fact with no resolvable support cannot be cited at all.
        expect(groundProposal(proposal([instruction(orientation, [9])]), armContext)).toBeNull()
    })

    it('checks part names and quantities against the manual and never against the model', (): void => {
        const wrongQuantity = (quantity ?? 1) + 5
        const grounded = groundProposal(
            proposal([
                {
                    type: 'PartList',
                    showQuantities: true,
                    items: [
                        { partId: first.partId, label: name, quantity: wrongQuantity },
                        { partId: first.partId, label: 'Invented gadget', quantity: 1 },
                        { partId: 'not-a-part', label: 'Nothing', quantity: 1 },
                    ],
                },
            ]),
            context,
        )!
        expect(grounded.screen.items[0]!.node).toMatchObject({
            type: 'PartList',
            items: [{ partId: first.partId, label: name, quantity: null }],
        })
        expect(grounded.tally.droppedItems).toBe(3)
        expect(grounded.screen.items[0]!.origin).toBe('fallback')
    })

    it('validates every text field: chip label, progress label, caption, answer caveat, header and bar', (): void => {
        const chip = (label: string, value: number): unknown => ({
            type: 'QuantityChip',
            partId: first.partId,
            label,
            quantity: value,
        })
        const grounded = groundProposal(
            proposal([
                chip('Panel x9 wrong', quantity ?? 1),
                chip(name, quantity ?? 1),
                { type: 'StepProgress', current: 1, total: context.stepCount, label: 'Almost there, 3 to go' },
                {
                    type: 'HeroFigure',
                    source: 'page',
                    refId: 'demo-page-1',
                    caption: 'Groove faces outward',
                    fit: 'contain',
                },
            ]),
            context,
        )!
        const nodes = grounded.screen.items.map((entry) => entry.node)
        expect(nodes.map((node) => node.type)).toEqual(['QuantityChip', 'StepProgress'])
        // The unsupported progress label is dropped, the true progress stays.
        expect(nodes[1]).toMatchObject({ type: 'StepProgress', label: null })
        const answer = buildContext(inputs('answer'))
        const result = groundProposal(
            proposal([{ type: 'AnswerCard', text: 'Anything', caveat: 'Probably fine, trust me', citations: [] }]),
            answer,
        )!
        const card = result.screen.items.find((entry) => entry.node.type === 'AnswerCard')!.node
        expect(card).toMatchObject({ text: 'Follow the cited diagram.', caveat: 'A clearer view' })
        // Header and bar wording is closed interface copy, not a place for claims.
        const swapped = groundProposal(
            proposal([instruction(STEP_TITLE)], {
                header: { ...header, title: 'Your build is perfect' },
                bar: {
                    primary: { ...bar.primary, label: 'Everything is correct' },
                    secondary: null,
                },
            }),
            context,
        )!
        expect(swapped.screen.header.title).toBe(`Step ${step.order}`)
        expect(swapped.screen.headerOrigin).toBe('fallback')
        expect(swapped.screen.bar.primary.label).toBe('Take photo')
        expect(swapped.screen.primaryOrigin).toBe('fallback')
    })

    it('returns null when nothing model-authored survives, so the caller falls back', (): void => {
        expect(groundProposal(proposal([instruction('Add 99 screws')]), context)).toBeNull()
    })

    it('replaces an action that does not belong on this screen, and never lets a result advance without a pass', (): void => {
        const refused = buildContext(inputs('result'))
        const advance = { intent: 'confirm', target: 'step' } as const
        expect(intentAllowed(advance, refused)).toBe(false)
        expect(
            intentAllowed(
                advance,
                buildContext(
                    inputs('result', {
                        result: { kind: 'check', value: { ...check, decision: 'pass', missingEvidence: [] } },
                    }),
                ),
            ),
        ).toBe(true)
        const grounded = groundProposal(
            proposal([instruction(ORIENTATION)], {
                bar: {
                    primary: { type: 'PrimaryAction', label: 'Next step', icon: null, intent: advance },
                    secondary: null,
                },
            }),
            refused,
        )!
        expect(grounded.screen.bar.primary.intent).not.toEqual(advance)
    })

    it('never offers a build action from facts that were only read, not yet reviewed', (): void => {
        const fresh = session((value) => {
            // No correction plan: only a reviewed plan is ever composed, so reviewing adds nothing to the content.
            value.reviewedSteps.forEach((entry) => (entry.correction = null))
            value.reviewStatus = 'unreviewed'
            value.rawExtraction = {
                parts: value.parts,
                steps: value.reviewedSteps.map((entry) => ({ ...entry, correction: null })),
                unknowns: [],
            }
            value.reviewedSteps = []
            value.parts = []
        })
        const read = buildContext(inputs('guide', { session: fresh }))
        expect(read.reviewed).toBe(false)
        expect(read.step?.title).toBe(STEP_TITLE)
        for (const to of [
            { intent: 'capture', target: 'take-photo' },
            { intent: 'check', target: 'current-step' },
            { intent: 'confirm', target: 'step' },
            { intent: 'ask', target: 'about-step' },
        ] as const) {
            expect(intentAllowed(to, read)).toBe(false)
        }
        const grounded = groundProposal(proposal([instruction(STEP_TITLE)]), read)!
        // The proposal's camera action is replaced by the deterministic one: a pointer back to Quick check.
        expect(grounded.screen.bar.primary.intent).toEqual({ intent: 'navigate', target: 'quick-check' })
        // The same facts once reviewed have the same content key: the prepared proposal is reused, not regenerated.
        const reviewed = buildContext(
            inputs('guide', {
                session: session((value) => value.reviewedSteps.forEach((entry) => (entry.correction = null))),
            }),
        )
        expect(read.contentKey).toBe(reviewed.contentKey)
        expect(read.bound.contextKey).not.toBe(reviewed.bound.contextKey)
    })
})

describe('the actual validated result always wins over model text', (): void => {
    it.each(['Group', 'DetailsDisclosure'] as const)(
        'replaces nested answer and verdict placeholders in %s without leaving contradicting text',
        (container): void => {
            for (const kind of ['result', 'answer'] as const) {
                const context = buildContext(inputs(kind))
                const wrong =
                    kind === 'result'
                        ? { type: 'ResultBanner', verdict: 'refuse', text: 'Turn the groove outward.', citations: [] }
                        : { type: 'AnswerCard', text: 'Turn the groove outward.', caveat: null, citations: [] }
                const nested =
                    container === 'Group'
                        ? { type: container, layout: 'stack', children: [wrong, instruction(ORIENTATION)] }
                        : {
                              type: container,
                              label: 'More',
                              initiallyOpen: false,
                              children: [wrong, instruction(ORIENTATION)],
                          }
                const grounded = groundProposal(proposal([nested]), context)!
                const final = finalize(grounded.screen, context)
                const actual = kind === 'result' ? check.reason : 'Follow the cited diagram.'
                expect(texts(final.body, wrong.type)).toEqual([actual])
                expect(JSON.stringify(final.body)).not.toContain('Turn the groove outward.')
                expect(final.body[0]).toMatchObject({ type: wrong.type, text: actual })
                expect(final.origins['body.0']).toBe('fallback')
            }
        },
    )

    it('does not treat opposite signed directions as the same cited fact', (): void => {
        const manual = session((value) => {
            if (value.reviewedSteps[0]!.orientation.state === 'known') {
                value.reviewedSteps[0]!.orientation.value.description = 'Rotate the panel -90 degrees.'
            }
        })
        const context = buildContext(inputs('guide', { session: manual }))
        const grounded = groundProposal(
            proposal([instruction(STEP_TITLE), instruction('Rotate the panel +90 degrees.')]),
            context,
        )!
        const final = finalize(grounded.screen, context)
        expect(texts(final.body, 'Instruction')).not.toContain('Rotate the panel +90 degrees.')
        expect(grounded.tally.droppedBlocks).toBeGreaterThan(0)
    })

    it('replaces a contradicting or merely differently worded verdict and keeps the model-chosen position', (): void => {
        const refused = buildContext(inputs('result'))
        const bannerOf = (text: string): unknown => ({ type: 'ResultBanner', verdict: 'refuse', text, citations: [] })
        const wrong = groundProposal(
            proposal([instruction(ORIENTATION), bannerOf('Everything looks perfect, no changes needed')]),
            refused,
        )!
        const bodies = wrong.screen.items.map((entry) => entry.node)
        // Same verdict enum, wrong reason: the actual reason is written, at the slot the model chose (second).
        expect(bodies.map((node) => node.type)).toEqual(['Instruction', 'ResultBanner'])
        expect(bodies[1]).toMatchObject({ verdict: 'refuse', text: check.reason })
        expect(wrong.screen.items[1]!.origin).toBe('fallback')
        expect(wrong.tally.forcedRequired).toBe(1)
        // A pass banner on a refusal is dropped and the real refusal is inserted.
        const contradicts = groundProposal(
            proposal([
                instruction(ORIENTATION),
                { type: 'ResultBanner', verdict: 'pass', text: 'Looks good', citations: [] },
            ]),
            refused,
        )!
        const kinds = contradicts.screen.items.map((entry) => entry.node)
        expect(kinds.some((node) => node.type === 'ResultBanner' && node.verdict === 'pass')).toBe(false)
        expect(kinds[0]).toMatchObject({ type: 'ResultBanner', verdict: 'refuse', text: check.reason })
        // Writing exactly the actual text counts as the model's own block.
        const same = groundProposal(proposal([bannerOf(check.reason), instruction(ORIENTATION)]), refused)!
        expect(same.screen.items[0]!.origin).toBe('generated')
        expect(same.tally.forcedRequired).toBe(0)
    })

    it('writes a long actual answer in full across bounded cards and never trusts a different model answer', (): void => {
        const long = `${'The groove must face the divider. '.repeat(20)}Check it twice.`
        const answer = buildContext(
            inputs('answer', {
                result: {
                    kind: 'question',
                    question: 'Which way?',
                    value: { answer: long, sourceRefs: [{ pageId: 'demo-page-1', region: null }], missingEvidence: [] },
                },
            }),
        )
        const grounded = groundProposal(
            proposal([{ type: 'AnswerCard', text: 'Use 99 screws.', caveat: null, citations: [] }]),
            answer,
        )!
        const cards = grounded.screen.items.flatMap((entry) => (entry.node.type === 'AnswerCard' ? [entry.node] : []))
        expect(cards.length).toBeGreaterThan(1)
        expect(cards.map((card) => card.text).join(' ')).toBe(long.trim().replace(/\s+/gu, ' '))
        for (const card of cards) expect(Array.from(card.text).length).toBeLessThanOrEqual(SCREEN_LIMITS.answer)
        expect(cards[0]!.citations).toEqual([0])
    })

    it('puts the answer on an answer screen from the actual answer when the model omits it', (): void => {
        const answer = buildContext(inputs('answer'))
        const grounded = groundProposal(proposal([instruction(ORIENTATION)]), answer)!
        expect(grounded.screen.items[0]!.node).toMatchObject({ type: 'AnswerCard', text: 'Follow the cited diagram.' })
    })
})

describe('required manual facts: safety notes and conservatively retained directions', (): void => {
    const NOTE = 'Keep children away from the moving mechanism.'
    const here = (pageId = 'demo-page-1'): { pageId: string; region: null }[] => [{ pageId, region: null }]
    const known = (value: string, pageId = 'demo-page-1'): never =>
        ({ state: 'known', value, sourceRefs: here(pageId) }) as never
    const twoPages = (value: ManualSession): void => {
        value.pages.push({ ...value.pages[0]!, pageId: 'demo-page-2', assetId: 'demo-asset-2' })
    }
    /** A step whose safety text was extracted into typed notes (an explicit classification). */
    const classified = (notes: string[], pages = ['demo-page-1']): ManualSession =>
        session((value) => {
            twoPages(value)
            value.reviewedSteps[0]!.safetyNotes = notes.map((text, index) => ({
                noteId: `n${index}`,
                note: known(text, pages[index % pages.length]),
            }))
        })
    /** A legacy step: no safety classification at all, and a hazard worded without any keyword a list would know. */
    const legacy = session((value) => {
        value.reviewedSteps[0]!.visibleChecks.push({ checkId: 'kids', description: known(NOTE) })
    })
    const directions = (...factIds: string[]): unknown => ({ type: 'ManualDirections', factIds, emphasis: 'strong' })
    const idsOf = (grounded: { screen: { facts: { fact: { factId: string }; placement: string }[] } }): string[] =>
        grounded.screen.facts.map((slot) => `${slot.fact.factId}:${slot.placement}`)

    it('keeps an unclassified imperative hazard that no keyword would catch, complete and with its own sources', (): void => {
        const context = buildContext(inputs('guide', { session: legacy }))
        const omitted = groundProposal(proposal([instruction(STEP_TITLE)]), context)!
        const fact = omitted.screen.facts.find((slot) => slot.fact.factId === 'check:kids')!
        expect(fact).toMatchObject({ placement: 'remainder', origin: 'fallback' })
        expect(fact.fact).toMatchObject({ basis: 'unclassified-step', text: NOTE, sourceRefs: here() })
        // Every known direction of the unclassified step is required, not only the one that looks like a warning.
        expect(idsOf(omitted)).toEqual([
            'title:remainder',
            'orientation:remainder',
            'connection:remainder',
            'check:groove-inward:remainder',
            'check:kids:remainder',
            'correction:turn-panel:remainder',
        ])
        expect(omitted.tally.forcedSafety).toBe(6)
        expect(finalize(omitted.screen, context).manualFacts.map((entry) => entry.text)).toContain(NOTE)
    })

    it('publishes all 25 relevant warnings outside the body bound, in a document that stays valid', (): void => {
        const notes = Array.from({ length: 25 }, (_unused, index) => `Warning ${index}: do not skip step ${index}.`)
        const context = buildContext(inputs('guide', { session: classified(notes) }))
        const crowded = proposal(Array.from({ length: 14 }, () => instruction(ORIENTATION)))
        const grounded = groundProposal(crowded, context)!
        expect(grounded.complete).toBe(true)
        expect(grounded.screen.facts.filter((slot) => slot.fact.kind === 'safety')).toHaveLength(25)
        expect(grounded.screen.items.length).toBeLessThanOrEqual(SCREEN_LIMITS.bodyNodes)
        const final = finalize(grounded.screen, context)
        expect(final.manualFacts.map((entry) => entry.text)).toEqual(notes)
        // Another 25 can never push the body into a shell: the facts are not body nodes.
        const fallback = withRequiredContent(composeDeterministic(context), context)
        expect(fallback.complete).toBe(true)
        expect(fallback.screen.facts.filter((slot) => slot.fact.kind === 'safety')).toHaveLength(25)
        expect(fallback.screen.items.filter((entry) => entry.node.type === 'ManualDirections')).toHaveLength(1)
    })

    it('requires only the typed notes once a step is classified, and offers its directions without forcing them', (): void => {
        const context = buildContext(inputs('guide', { session: classified([NOTE]) }))
        const bare = groundProposal(proposal([instruction(STEP_TITLE)]), context)!
        expect(idsOf(bare)).toEqual(['safety:n0:remainder'])
        expect(bare.screen.facts[0]!.fact.basis).toBe('safety-note')
        // The model may name a direction too; it is then published and placed, and is not required.
        const named = groundProposal(proposal([directions('orientation', 'safety:n0')]), context)!
        expect(idsOf(named)).toEqual(['safety:n0:body', 'orientation:body'])
        expect(named.tally.forcedSafety).toBe(0)
        expect(named.screen.facts.map((slot) => slot.origin)).toEqual(['generated', 'generated'])
    })

    it('lets the model order and include facts, and counts anything the server had to add as fallback', (): void => {
        const context = buildContext(inputs('guide', { session: legacy }))
        const partial = groundProposal(
            proposal([directions('check:kids', 'orientation', 'ghost', 'orientation')]),
            context,
        )!
        expect(partial.screen.items[0]).toMatchObject({
            node: { type: 'ManualDirections', factIds: ['check:kids', 'orientation'] },
            origin: 'fallback',
        })
        // Order chosen by the model; the rest still arrive in the mandatory section, never lost.
        expect(idsOf(partial)).toEqual([
            'title:remainder',
            'orientation:body',
            'connection:remainder',
            'check:groove-inward:remainder',
            'check:kids:body',
            'correction:turn-panel:remainder',
        ])
        expect(partial.tally.droppedItems).toBe(2)
        const exact = groundProposal(proposal([directions('check:kids', 'orientation')]), context)!
        expect(exact.screen.items[0]!.origin).toBe('generated')
        expect(exact.screen.facts.filter((slot) => slot.placement === 'body').map((slot) => slot.origin)).toEqual([
            'generated',
            'generated',
        ])
        // A fact is shown once: a later block cannot name it again.
        const twice = groundProposal(
            proposal([directions('orientation'), directions('orientation', 'connection')]),
            context,
        )!
        expect(twice.screen.items.map((entry) => (entry.node as { factIds?: string[] }).factIds)).toEqual([
            ['orientation'],
            ['connection'],
        ])
    })

    it('puts a fact in the remainder when its directions block was trimmed, so overflow never hides it', (): void => {
        // The actual verdict is written in full, so it takes more body slots than the model's one placeholder and the
        // optional blocks at the end give way, including a directions block.
        const longReason = `${'The groove faces the wrong way and the panel must be turned around. '.repeat(6)}`.trim()
        const context = buildContext(
            inputs('result', {
                session: legacy,
                result: { kind: 'check', value: { ...check, reason: longReason } },
            }),
        )
        const crowded = proposal([
            { type: 'ResultBanner', verdict: 'refuse', text: 'Not right.', citations: [] },
            ...Array.from({ length: 12 }, () => instruction(ORIENTATION)),
            directions('check:kids'),
        ])
        const grounded = groundProposal(crowded, context)!
        expect(grounded.screen.items.some((entry) => entry.node.type === 'ManualDirections')).toBe(false)
        expect(grounded.tally.droppedBlocks).toBeGreaterThan(0)
        expect(grounded.screen.facts.find((slot) => slot.fact.factId === 'check:kids')?.placement).toBe('remainder')
        expect(grounded.complete).toBe(true)
    })

    it('keeps every fact with the actual sources of that fact, not whichever source happens to be first', (): void => {
        const notes = ['Warning: lift with two people.', 'Never stand the panel on a wet floor.']
        const context = buildContext(inputs('guide', { session: classified(notes, ['demo-page-1', 'demo-page-2']) }))
        const final = finalize(groundProposal(proposal([instruction(STEP_TITLE)]), context)!.screen, context)
        expect(final.manualFacts.map((fact) => fact.sourceRefs[0]!.pageId)).toEqual(['demo-page-1', 'demo-page-2'])
        const region = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }
        const figure = session((value) => {
            value.reviewedSteps[0]!.safetyNotes = [
                {
                    noteId: 'n0',
                    note: { state: 'known', value: NOTE, sourceRefs: [{ pageId: 'demo-page-1', region }] } as never,
                },
            ]
        })
        const regional = buildContext(inputs('guide', { session: figure }))
        const published = finalize(groundProposal(proposal([instruction(STEP_TITLE)]), regional)!.screen, regional)
        expect(published.manualFacts[0]!.sourceRefs).toEqual([{ pageId: 'demo-page-1', region }])
    })

    it('publishes a long note whole, with its operators, trailing condition and negation, never an ellipsis', (): void => {
        const long =
            'Warning: keep both hands on the panel while it is lifted onto the rail and do not let go of either side when the load is < 5 kg, because the panel can fall and injure a foot unless a second person is holding the far end. Rotate it -90 degrees only.'
        const context = buildContext(inputs('guide', { session: classified([long]) }))
        const final = finalize(groundProposal(proposal([instruction(STEP_TITLE)]), context)!.screen, context)
        expect(final.manualFacts[0]!.text).toBe(long)
        expect(JSON.stringify(final.body)).not.toContain('…')
        expect(Array.from(long).length).toBeGreaterThan(SCREEN_LIMITS.text)
    })

    it('never lets a composed block restate manual text whose words the plain-text rule would have altered', (): void => {
        const operator = 'Keep the load < 5 kg.'
        const context = buildContext(inputs('guide', { session: classified([operator]) }))
        // Without the operator the sentence says something different, so it is not a restatable unit.
        const grounded = groundProposal(proposal([warning('Keep the load 5 kg.'), instruction(STEP_TITLE)]), context)!
        expect(
            texts(
                grounded.screen.items.map((entry) => entry.node),
                'Warning',
            ),
        ).toEqual([])
        expect(finalize(grounded.screen, context).manualFacts[0]!.text).toBe(operator)
    })

    it('applies to the deterministic fallback and to a shell too, so a failed generation never hides a hazard', (): void => {
        const context = buildContext(inputs('guide', { session: classified([NOTE]) }))
        const forced = withRequiredContent(composeDeterministic(context), context)
        // The typed note first, then the step's other directions: one fallback block names all of them.
        expect(forced.screen.facts.map((slot) => [slot.fact.factId, slot.placement, slot.origin])).toEqual(
            ['safety:n0', 'orientation', 'connection', 'check:groove-inward', 'correction:turn-panel'].map((id) => [
                id,
                'body',
                'fallback',
            ]),
        )
    })

    it('does not publish the facts of a screen that is not bound to a step, and never an unreadable note as a fact', (): void => {
        expect(buildContext(inputs('home')).manualFacts).toEqual([])
        const draft = createDemoManual()
        const raw = {
            ...draft,
            reviewStatus: 'unreviewed' as const,
            reviewedSteps: [],
            rawExtraction: {
                parts: draft.parts,
                steps: [
                    {
                        ...draft.reviewedSteps[0]!,
                        correction: null,
                        safetyNotes: [{ noteId: 'u', note: { state: 'unknown' as const, reason: 'Cut off.' } }],
                    },
                ],
                unknowns: [],
            },
        }
        const context = buildContext(inputs('guide', { session: raw as ManualSession }))
        expect(context.manualFacts.map((fact) => fact.text)).not.toContain('Cut off.')
        expect(context.manualFacts.some((fact) => fact.kind === 'safety')).toBe(false)
    })
})

describe('remaining block grounding', (): void => {
    const context = buildContext(inputs('guide'))
    const step = context.step!
    const part = step.parts[0]!
    const name = context.partNames.get(part.partId)!
    const quantity = context.quantities.get(part.partId)
    const cited = [...context.citedPageIds][0]!

    it('accepts figures only for real pages of this step, this capture or real parts', (): void => {
        const figure = (source: string, refId: string): unknown => ({
            type: 'HeroFigure',
            source,
            refId,
            caption: null,
            fit: 'contain',
        })
        const grounded = groundProposal(
            proposal([
                figure('page', cited),
                figure('page', 'some-other-page'),
                figure('part', part.partId),
                figure('part', 'ghost'),
                figure('capture', 'capture-1'),
            ]),
            context,
        )!
        expect(grounded.screen.items).toHaveLength(2)
        expect(grounded.tally.droppedBlocks).toBe(3)
    })

    it('resolves a part figure to the manual page and region where that part is named, as server-owned content', (): void => {
        const region = { x: 0.6, y: 0.1, width: 0.2, height: 0.2 }
        const named = session((value) => {
            const target = value.parts.find((candidate) => candidate.partId === part.partId)!
            if (target.name.state === 'known') target.name.sourceRefs = [{ pageId: 'demo-page-1', region }]
        })
        const partContext = buildContext(inputs('guide', { session: named }))
        const figure = (partId: string, sourceRefIndex?: number): unknown => ({
            type: 'HeroFigure',
            source: 'part',
            refId: partId,
            caption: null,
            fit: 'contain',
            ...(sourceRefIndex === undefined ? {} : { sourceRefIndex }),
        })
        const grounded = groundProposal(proposal([figure(part.partId)]), partContext)!
        // The published figure is a real manual page region the app can draw; it is not the model's claim.
        expect(grounded.screen.items[0]!.node).toMatchObject({
            type: 'HeroFigure',
            source: 'page',
            refId: 'demo-page-1',
            region,
        })
        expect(grounded.screen.items[0]!.origin).toBe('fallback')
        // The model cannot steer a part figure to another region of the page.
        const steered = groundProposal(proposal([figure(part.partId, 0)]), partContext)!
        expect(steered.screen.items[0]!.node).toMatchObject({ region })
        expect(steered.tally.droppedItems).toBe(1)
        // A part whose name the manual does not state has no figure of its own to show.
        const unnamed = session((value) => {
            const target = value.parts.find((candidate) => candidate.partId === part.partId)!
            target.name = { state: 'unknown', reason: 'Not legible.' } as never
        })
        const missing = buildContext(inputs('guide', { session: unnamed }))
        expect(
            groundProposal(proposal([figure(part.partId), instruction(STEP_TITLE)]), missing)!.screen.items,
        ).toHaveLength(1)
    })

    it('lets the model emphasize an existing manual figure region by index, and never accepts geometry from it', (): void => {
        const region = { x: 0.1, y: 0.2, width: 0.3, height: 0.3 }
        const regional = session((value) => {
            value.reviewedSteps[0]!.sourceRefs = [
                { pageId: 'demo-page-1', region },
                { pageId: 'demo-page-1', region: null },
            ]
        })
        const regionContext = buildContext(inputs('guide', { session: regional }))
        expect(regionContext.sources.map((ref) => ref.region)).toEqual([region, null])
        const figure = (index: number | null): unknown => ({
            type: 'HeroFigure',
            source: 'page',
            refId: 'demo-page-1',
            caption: null,
            fit: 'contain',
            sourceRefIndex: index,
        })
        const emphasized = groundProposal(proposal([figure(0)]), regionContext)!
        expect(emphasized.screen.items[0]!.node).toMatchObject({ type: 'HeroFigure', region })
        const none = groundProposal(proposal([figure(1)]), regionContext)!
        expect(none.screen.items[0]!.node).toMatchObject({ region: null })
        expect(none.tally.droppedItems).toBe(1)
        // An index beyond the supplied sources selects nothing; the figure itself stays.
        expect(groundProposal(proposal([figure(7)]), regionContext)!.screen.items[0]!.node).toMatchObject({
            region: null,
        })
        // A proposal that writes the box itself is not even valid.
        const forged = { ...(figure(0) as object), region }
        expect(validateProposal({ header, body: [forged], bar }).ok).toBe(false)
    })

    it('shows the provider the real page, source and figure identities and only those', (): void => {
        const view = context.view.dynamic.screen as {
            sources: { index: number; pageId: string }[]
            figures: { pageIds: string[]; partIds: string[] }
        }
        expect(view.sources).toEqual([{ index: 0, pageId: 'demo-page-1', region: null }])
        expect(view.figures).toMatchObject({ pageIds: ['demo-page-1'], partIds: ['side-panel'] })
        const arm = buildContext(inputs('guide', { session: stepFixtures()[1]!.session, stepId: 'arm-step-2' }))
        const armView = arm.view.dynamic.screen as { sources: { pageId: string }[]; figures: { pageIds: string[] } }
        expect(armView.sources.map((source) => source.pageId)).toEqual(['arm-page-1', 'arm-page-2'])
        expect(armView.figures.pageIds).toEqual(['arm-page-1', 'arm-page-2'])
        // Only a page the step cites resolves as a figure; the other manual's page does not.
        const stranger = groundProposal(
            proposal([
                { type: 'HeroFigure', source: 'page', refId: 'demo-page-1', caption: null, fit: 'cover' },
                { type: 'HeroFigure', source: 'page', refId: 'arm-page-2', caption: null, fit: 'cover' },
            ]),
            arm,
        )!
        expect(stranger.screen.items.map((entry) => (entry.node as { refId: string }).refId)).toEqual(['arm-page-2'])
    })

    it('keeps step progress and quantity chips only when they equal the manual', (): void => {
        const progress = (current: number, total: number): unknown => ({
            type: 'StepProgress',
            current,
            total,
            label: null,
        })
        const chip = (value: number): unknown => ({
            type: 'QuantityChip',
            partId: part.partId,
            label: name.slice(0, 24),
            quantity: value,
        })
        const grounded = groundProposal(
            proposal([
                progress(context.stepIndex + 1, context.stepCount),
                progress(9, 9),
                chip((quantity ?? 1) + 1),
                instruction(STEP_TITLE),
            ]),
            context,
        )!
        expect(grounded.screen.items.map((entry) => entry.node.type)).toEqual(['StepProgress', 'Instruction'])
        if (quantity !== undefined) {
            expect(groundProposal(proposal([chip(quantity)]), context)?.screen.items[0]?.node).toMatchObject({
                type: 'QuantityChip',
                quantity,
            })
        }
    })

    it('drops choices with a disallowed action, and replaces a label that does not describe its action', (): void => {
        const choices = (target: string, label: string): unknown => ({
            type: 'ChoiceList',
            prompt: null,
            options: [
                { label, intent: { intent: 'ask', target } },
                { label: 'Take photo', intent: { intent: 'capture', target: 'take-photo' } },
            ],
        })
        const kept = groundProposal(proposal([choices('about-step', 'Ask about this step')]), context)!
        expect(kept.screen.items[0]!.node.type).toBe('ChoiceList')
        expect(kept.screen.items[0]!.origin).toBe('generated')
        const relabelled = groundProposal(proposal([choices('about-step', 'Ask about 77 things')]), context)!
        expect(relabelled.screen.items[0]!.node).toMatchObject({
            options: [{ label: 'Ask about this step' }, { label: 'Take photo' }],
        })
        expect(relabelled.screen.items[0]!.origin).toBe('fallback')
        expect(groundProposal(proposal([choices('about-step', 'Ask')].slice(0, 0)), context)).toBeNull()
    })

    it('accepts a tip only with the catalogue wording for its target', (): void => {
        const tip = (text: string): unknown => ({ type: 'Tip', targetId: 'guide-hero', heading: 'The diagram', text })
        const real = groundProposal(
            proposal([tip('Compare the diagram with what you are building.'), instruction(STEP_TITLE)]),
            context,
        )!
        expect(real.screen.items.map((entry) => entry.node.type)).toEqual(['Tip', 'Instruction'])
        const claim = groundProposal(proposal([tip('Rotate the panel so the groove faces outward.')]), context)
        expect(claim).toBeNull()
    })

    it('states completion only with a witness covering every reviewed step', (): void => {
        const all = createDemoManual().reviewedSteps.map((entry) => entry.stepId)
        const done = buildContext(inputs('completion', { completedStepIds: all }))
        const partial = buildContext(inputs('completion', { completedStepIds: [all[0]!] }))
        const missing = buildContext(inputs('completion'))
        expect(done.completion).toBe('witnessed')
        expect(partial.completion).toBe('unwitnessed')
        expect(missing.completion).toBe('unwitnessed')
        expect(new Set([done, partial, missing].map((entry) => entry.bound.contextKey)).size).toBe(2)
        const finished = `You finished all ${done.stepCount} steps.`
        expect(groundProposal(proposal([instruction(finished)]), done)).not.toBeNull()
        // A reviewed but untouched manual is never described as finished.
        expect(groundProposal(proposal([instruction(finished)]), missing)).toBeNull()
        const neutral = finalize(withRequiredContent(composeDeterministic(missing), missing).screen, missing)
        expect(neutral.header.title).toBe('Your build')
        expect(texts(neutral.body, 'Instruction').join(' ')).not.toMatch(/finished|done/iu)
        expect(finalize(withRequiredContent(composeDeterministic(done), done).screen, done).header.title).toBe(
            'All steps done',
        )
    })

    it('replaces a header or title that is not the screen wording or a manual title', (): void => {
        const grounded = groundProposal(
            proposal([instruction(STEP_TITLE)], { header: { ...header, title: 'Step 41 of 99' } }),
            context,
        )!
        expect(grounded.screen.header.title).toBe(`Step ${step.order}`)
        expect(grounded.tally.replacedComponents).toBe(1)
    })

    it('keeps the complete original fact reachable when only one sentence of it is shown', (): void => {
        const two = session((value) => {
            value.reviewedSteps[0]!.orientation = {
                state: 'known',
                value: { partId: 'side-panel', description: 'Groove faces inward. Check it before you continue.' },
                sourceRefs: [{ pageId: 'demo-page-1', region: null }],
            }
        })
        const twoContext = buildContext(inputs('guide', { session: two }))
        const grounded = groundProposal(proposal([instruction('Groove faces inward.')]), twoContext)!
        // The sentence is stated in the body; the complete original is published as the step's manual fact.
        expect(
            flat(grounded.screen.items.map((entry) => entry.node)).some((node) => node.type === 'DetailsDisclosure'),
        ).toBe(false)
        const original = grounded.screen.facts.find((slot) => slot.fact.factId === 'orientation')!
        expect(original).toMatchObject({ placement: 'remainder', origin: 'fallback' })
        expect(original.fact.text).toBe('Groove faces inward. Check it before you continue.')
    })

    it('marks only what the model composed and the server accepted unchanged as generated', (): void => {
        const grounded = groundProposal(
            proposal(
                [
                    instruction(STEP_TITLE),
                    {
                        type: 'ChoiceList',
                        prompt: null,
                        options: [
                            { label: 'Weird', intent: { intent: 'ask', target: 'about-step' } },
                            { label: 'Take photo', intent: { intent: 'capture', target: 'take-photo' } },
                        ],
                    },
                ],
                { header: { ...header, title: 'Nonsense' } },
            ),
            context,
        )!
        const final = finalize(grounded.screen, context)
        expect(final.origins).toEqual({
            header: 'fallback',
            'body.0': 'generated',
            'body.1': 'fallback',
            'bar.primary': 'generated',
            'facts.0': 'fallback',
            'facts.1': 'fallback',
            'facts.2': 'fallback',
            'facts.3': 'fallback',
            'facts.4': 'fallback',
        })
        expect(final.source).toBe('generated')
        // Nothing the model composed survived unchanged: the document is not generated at all.
        const onlyReplaced = groundProposal(
            proposal(
                [
                    {
                        type: 'ChoiceList',
                        prompt: null,
                        options: [
                            { label: 'Weird', intent: { intent: 'ask', target: 'about-step' } },
                            { label: 'Odd', intent: { intent: 'capture', target: 'take-photo' } },
                        ],
                    },
                ],
                {
                    header: { ...header, title: 'Nonsense' },
                    bar: { primary: { ...bar.primary, label: 'Weird' }, secondary: null },
                },
            ),
            context,
        )!
        expect(finalize(onlyReplaced.screen, context).source).toBe('fallback')
    })
})

describe('whole-screen blocks bind to live app data by reference only', (): void => {
    const library = {
        entries: [
            {
                manualId: 'm1',
                title: 'Shelf',
                updatedAt: '2026-01-01T00:00:00.000Z',
                stopStepId: null,
                completed: 1,
                total: 4,
                firstPageId: 'p1',
            },
            {
                manualId: 'm2',
                title: 'Arm',
                updatedAt: '2026-01-02T00:00:00.000Z',
                stopStepId: 's2',
                completed: 0,
                total: 2,
                firstPageId: null,
            },
        ],
        soleManualId: null,
    }
    const question = {
        questionId: 'step-1:orientation',
        kind: 'orientation' as const,
        stepId: 'step-1',
        stepOrder: 1,
        reason: 'The page does not show the groove.',
        parts: [{ partId: 'side-panel', label: 'Side panel' }],
    }
    const capture = { captureId: 'capture-1', reusable: true, target: null, questionDraftPresent: false }
    const only = (grounded: ReturnType<typeof groundProposal>): ScreenNode[] =>
        grounded!.screen.items.map((entry) => entry.node)

    it('lists only library manuals the app holds, drops unknown ids, and needs the library state at all', (): void => {
        const home = buildContext(inputs('home', { uiState: { library } }))
        const listed = (manualIds: string[]): unknown => ({
            type: 'ManualLibrary',
            entries: { manualIds },
            layout: 'rows',
            showProgress: true,
            emptyText: null,
        })
        const partial = groundProposal(proposal([listed(['m2', 'ghost', 'm2'])]), home)!
        expect(only(partial)[0]).toMatchObject({ entries: { manualIds: ['m2'] } })
        expect(partial.screen.items[0]!.origin).toBe('fallback')
        expect(partial.tally.droppedItems).toBe(2)
        expect(groundProposal(proposal([listed(['ghost'])]), home)).toBeNull()
        const recent = {
            type: 'ManualLibrary',
            entries: 'recent',
            layout: 'cards',
            showProgress: false,
            emptyText: 'Invented words',
        }
        const replaced = groundProposal(proposal([recent]), home)!
        expect(only(replaced)[0]).toMatchObject({ emptyText: 'No manuals yet.' })
        expect(replaced.screen.items[0]!.origin).toBe('fallback')
        // Without library state, or on another screen kind, there is nothing to bind: the block is dropped.
        expect(groundProposal(proposal([recent]), buildContext(inputs('home')))).toBeNull()
        expect(groundProposal(proposal([recent]), buildContext(inputs('pages', { uiState: { library } })))).toBeNull()
    })

    it('shows the session pages and keeps its action to an allowed intent', (): void => {
        const pages = {
            items: [{ pageId: 'p1', width: 10, height: 10 }],
            maxPages: 8,
            canRead: true,
            languageOptions: [],
        }
        const context = buildContext(inputs('pages', { uiState: { pages } }))
        const gallery = (action: unknown): unknown => ({
            type: 'PageGallery',
            pages: 'session',
            layout: 'grid',
            showNumbers: true,
            action,
        })
        expect(
            only(groundProposal(proposal([gallery({ intent: 'capture', target: 'add-page' })]), context))[0],
        ).toMatchObject({ type: 'PageGallery' })
        expect(groundProposal(proposal([gallery({ intent: 'check', target: 'current-step' })]), context)).toBeNull()
        expect(groundProposal(proposal([gallery(null)]), buildContext(inputs('pages')))).toBeNull()
    })

    it('binds the fact prompt and editor to the one current question and ignores any wording that is not closed copy', (): void => {
        const quick = buildContext(
            inputs('quick-check', {
                uiState: { review: { currentQuestion: question, blockers: 0, canConfirm: false } },
            }),
        )
        const prompt = (text: string, detail: string | null): unknown => ({
            type: 'FactPrompt',
            questionRef: 'current',
            prompt: text,
            detail,
            citations: [],
        })
        const editor = (kind: 'orientation' | 'checks', label = 'Orientation'): unknown => ({
            type: 'FactEditor',
            questionRef: 'current',
            kind,
            label,
            saveLabel: 'Save',
            cancelLabel: 'Cancel',
        })
        const ok = groundProposal(
            proposal([
                prompt('Which way does this part face?', 'The page does not show the groove.'),
                editor('orientation'),
            ]),
            quick,
        )!
        expect(only(ok)[0]).toMatchObject({
            prompt: 'Which way does this part face?',
            detail: 'The page does not show the groove.',
        })
        expect(ok.screen.items.map((entry) => entry.origin)).toEqual(['generated', 'generated'])
        // Invented detail text and invented labels are replaced; a mismatched editor kind is dropped.
        const bad = groundProposal(
            proposal([
                prompt('Is it upside down?', 'Probably flipped'),
                editor('orientation', 'Whatever'),
                editor('checks'),
            ]),
            quick,
        )!
        expect(only(bad)[0]).toMatchObject({ prompt: 'Which way does this part face?', detail: null })
        expect(only(bad)[1]).toMatchObject({ label: 'Orientation' })
        expect(only(bad)).toHaveLength(2)
        expect(bad.screen.items.map((entry) => entry.origin)).toEqual(['fallback', 'fallback'])
        expect(groundProposal(proposal([editor('orientation')]), buildContext(inputs('quick-check')))).toBeNull()
    })

    it('offers the question composer only for a reviewed step with a held capture', (): void => {
        const composer = (partScope: 'step-parts' | 'none'): unknown => ({
            type: 'QuestionComposer',
            captureRef: 'current',
            prompt: null,
            partScope,
            submitLabel: 'Ask',
        })
        const held = buildContext(inputs('questions', { uiState: { capture } }))
        expect(only(groundProposal(proposal([composer('step-parts')]), held))[0]).toMatchObject({
            type: 'QuestionComposer',
        })
        expect(groundProposal(proposal([composer('none')]), buildContext(inputs('questions')))).toBeNull()
        const unreviewed = session((value) => {
            value.reviewStatus = 'unreviewed'
        })
        expect(
            groundProposal(
                proposal([composer('none')]),
                buildContext(inputs('questions', { session: unreviewed, uiState: { capture } })),
            ),
        ).toBeNull()
    })

    it('cites manual pages only by supplied source index, and keeps camera and link wording closed', (): void => {
        const guide = buildContext(inputs('guide'))
        const details = (sources: number[], label = 'Manual pages'): unknown => ({
            type: 'SourceDetails',
            label,
            sources,
            fit: 'contain',
            initiallyOpen: false,
        })
        const kept = groundProposal(proposal([details([0, 9, 0], 'Look here')]), guide)!
        expect(only(kept)[0]).toMatchObject({ sources: [0], label: 'Manual pages' })
        expect(kept.screen.items[0]!.origin).toBe('fallback')
        expect(groundProposal(proposal([details([7])]), guide)).toBeNull()
        const camera = (cue: string): unknown => ({
            type: 'CameraGuidance',
            cue,
            pill: null,
            tipTarget: 'camera-shutter',
        })
        expect(only(groundProposal(proposal([camera('Keep the whole step in view')]), guide))[0]).toMatchObject({
            cue: 'Keep the whole step in view',
        })
        expect(groundProposal(proposal([camera('Photograph the label at 3 cm')]), guide)!.screen.items[0]!.origin).toBe(
            'fallback',
        )
        expect(
            groundProposal(proposal([camera('Keep the whole step in view')]), buildContext(inputs('home'))),
        ).toBeNull()
        const link = (label: string, intent: unknown): unknown => ({
            type: 'ActionLink',
            label,
            icon: null,
            intent,
            emphasis: 'quiet',
        })
        expect(
            only(
                groundProposal(
                    proposal([link('See the manual', { intent: 'open-details', target: 'sources' })]),
                    guide,
                ),
            )[0],
        ).toMatchObject({ label: 'See the manual' })
        expect(
            groundProposal(
                proposal([link('Go on', { intent: 'confirm', target: 'step' }), instruction(STEP_TITLE)]),
                buildContext(inputs('result')),
            )!.tally.droppedBlocks,
        ).toBe(1)
    })

    it('composes a deterministic fallback from the live state the request carried, and nothing when it carried none', (): void => {
        const kinds = (context: ReturnType<typeof buildContext>): string[] =>
            composeDeterministic(context).items.map((entry) => entry.node.type)
        expect(kinds(buildContext(inputs('home', { uiState: { library } })))).toContain('ManualLibrary')
        expect(kinds(buildContext(inputs('home')))).not.toContain('ManualLibrary')
        const quick = buildContext(
            inputs('quick-check', {
                uiState: { review: { currentQuestion: question, blockers: 0, canConfirm: false } },
            }),
        )
        expect(kinds(quick)).toEqual(expect.arrayContaining(['FactPrompt', 'FactEditor']))
        expect(kinds(buildContext(inputs('questions', { uiState: { capture } })))).toContain('QuestionComposer')
        expect(kinds(buildContext(inputs('guide')))).toEqual(
            expect.arrayContaining(['ManualDirections', 'CameraGuidance']),
        )
        expect(kinds(buildContext(inputs('result')))).toContain('SourceDetails')
    })
})

describe('plain text', (): void => {
    it('strips what the plain-text rule rejects and never returns an empty string', (): void => {
        expect(plain('See <b>https://x.test/y</b> now`', 60)).toBe('See now')
        expect(plain('go xhttps://evil.test or www.evil.test ok', 60)).toBe('go or ok')
        expect(plain('<>', 10)).toBe('—')
        expect(Array.from(plain('a'.repeat(100), 10))).toHaveLength(10)
    })
})
