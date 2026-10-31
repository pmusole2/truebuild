import { createHash } from 'node:crypto'

import {
    buildFallbackProposalV2,
    manualSessionSchema,
    photoSpineV2,
    variantsOfV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenVariantV2,
} from '@truebuild/contracts'
import { screensV2GenerateRequest } from '@truebuild/contracts/model'
import { describe, expect, it } from 'vitest'

import { ModelApiClient } from '../../../../app/src/api/model-client'
import {
    createDocumentFixtureGenerator,
    fixtureArrangement,
    INVALID_QUESTIONS_MANUAL,
} from '../../providers/document-fixtures'
import { DOCUMENT_INSTRUCTIONS, DOCUMENT_PROMPT_VERSION } from '../../providers/document-prompt'
import { encodeWireProposal } from '../../providers/document-wire'
import { demoSession, documentInputs } from '../../test-support/document-inputs'
import { createNativeFixtureApp } from '../../test-support/native-fixture-app'
import { stepFixtures } from '../../test-support/step-fixtures'
import { buildDocumentContext } from './context'
import { evaluateWire } from './ground'

// The Ask sheet owes its held photo first, at one spine across its variants. Its Answer uses the same layout spine,
// while the app's separate Answer surface still earns its own native image-load witness.

const STATES = ['busy', 'pending', 'empty', 'error', 'recovery'] as const
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

type Body = Pick<ScreenVariantV2, 'body'>
const stackOf = (variant: Body): Extract<ScreenNodeV2, { type: 'Stack' }> => {
    const stack = variant.body.type === 'Scroll' ? variant.body.children[0] : undefined
    if (stack?.type !== 'Stack') throw new Error('A body is a Scroll holding one Stack')
    return stack
}
const variantOf = (draft: ScreenProposalV2, name: 'ready' | (typeof STATES)[number]): Body =>
    name === 'ready' ? draft : draft.states[name]!

describe('the raw provider gate holds a Question to its photo', () => {
    const context = buildDocumentContext(documentInputs('questions'))
    const proposal = buildFallbackProposalV2(context.material)
    const evaluate = (edit: (draft: ScreenProposalV2) => void): ReturnType<typeof evaluateWire> => {
        const draft = structuredClone(proposal)
        edit(draft)
        return evaluateWire(encodeWireProposal(draft), context)
    }

    it('requires the photo and accepts the complete proposal', () => {
        expect(context.material.requirements.capture).toBe(true)
        expect(evaluate(() => undefined)).toMatchObject({ ok: true })
    })

    it.each(['ready', ...STATES] as const)('rejects a %s variant without the held photo', (name) => {
        const result = evaluate((draft) => {
            const stack = stackOf(variantOf(draft, name))
            stack.children = stack.children.filter(
                (child) => !(child.type === 'Image' && child.source.kind === 'capture'),
            )
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.issues).toContain(`contract:the_held_photo_is_missing_from_the_${name}_variant`)
    })

    it.each(STATES)('rejects a %s variant that moves the held photo', (name) => {
        const result = evaluate((draft) => {
            stackOf(variantOf(draft, name)).children.unshift({ type: 'Spacer', size: 'sm' })
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.issues).toContain(`contract:the_${name}_variant_moves_the_held_photo`)
    })
})

describe.each(['stacked', 'cards'] as const)('the %s fixture arrangement of a held Question', (arrangement) => {
    // A manual id the fixture generator arranges the requested way (the choice is the generator's own, not copied here).
    const manualId = Array.from({ length: 64 }, (_unused, at) => `arranged-${at}`).find(
        (id) => fixtureArrangement(id) === arrangement,
    )!

    async function composed(kind: 'questions' | 'answer'): Promise<ScreenProposalV2> {
        const context = buildDocumentContext(documentInputs(kind, demoSession({ manualId })))
        const wire = await createDocumentFixtureGenerator()(
            { kind, manualId, revision: 1, stepId: 'step-1', attempt: 1, context },
            new AbortController().signal,
        )
        const evaluated = evaluateWire(wire, context)
        if (!evaluated.ok) throw new Error(`The fixture composed a rejected ${kind}: ${evaluated.issues.join()}`)
        return evaluated.proposal
    }

    it('is accepted by the gate and keeps its photo at the spine of its Answer in every variant', async () => {
        const spine = photoSpineV2(await composed('answer'))
        expect(spine).not.toBeNull()
        const question = await composed('questions')
        expect(variantsOfV2(question).map(({ name }) => name)).toEqual(['ready', ...STATES])
        for (const { name, variant } of variantsOfV2(question)) expect(photoSpineV2(variant), name).toBe(spine)
    })
})

describe('the real native fixture app serves a held Question that keeps its photo', () => {
    it.each(stepFixtures().map((fixture) => [fixture.name, fixture.session] as const))(
        'every step of %s, verified by the real client',
        async (_name, base) => {
            const app = createNativeFixtureApp({ stepDelayMs: 0 })
            const client = new ModelApiClient({
                baseUrl: 'http://127.0.0.1:3101',
                secret: 'truebuild-fixture-demo',
                fetch: async (url, init): Promise<Response> => app.fetch(new Request(url, init)),
            })
            // The session the native parser returns: every step declares its safety notes.
            const session = manualSessionSchema.parse({
                ...base,
                reviewedSteps: base.reviewedSteps.map((step) => ({ ...step, safetyNotes: step.safetyNotes ?? [] })),
            })
            for (const step of session.reviewedSteps) {
                const inputs: ScreenContextInputsV2 = {
                    kind: 'questions',
                    session,
                    stepId: step.stepId,
                    captureId: 'cap-1',
                    result: null,
                    failure: null,
                    uiState: {
                        capture: { captureId: 'cap-1', reusable: true, target: null, questionDraftPresent: false },
                    },
                }
                const requestId = `question-photo-${step.stepId}`
                const response = await client.screensV2(screensV2GenerateRequest(requestId, inputs, digest), {
                    requestId,
                })
                if (response.status !== 'ok' || response.value.document === null) {
                    throw new Error(`${step.stepId}: ${response.status}`)
                }
                const { document } = response.value
                // One manual's Questions are forced invalid on purpose, so the complete deterministic document serves it.
                expect(document.metadata.source).toBe(
                    session.manualId === INVALID_QUESTIONS_MANUAL ? 'fallback' : 'generated',
                )
                expect(document.requirements.capture).toBe(true)
                const spines = variantsOfV2(document).map(({ variant }) => photoSpineV2(variant))
                expect(spines[0]).not.toBeNull()
                expect(new Set(spines).size).toBe(1)
            }
        },
        30_000,
    )
})

describe('the document prompt', () => {
    it('is versioned past the Question layouts it used to accept and states the held Question rule', () => {
        expect(DOCUMENT_PROMPT_VERSION).toBeGreaterThanOrEqual(19)
        expect(DOCUMENT_INSTRUCTIONS).toContain('A held Question')
    })
})
