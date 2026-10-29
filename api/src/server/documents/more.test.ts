import { createHash } from 'node:crypto'

import {
    composeProposalV2,
    questionResultSchema,
    type QuestionResult,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
} from '@truebuild/contracts'
import { createHeroResponse } from '@truebuild/contracts/hero'
import {
    screensV2GenerateRequest,
    screensV2ResultSchema,
    type ModelScreensV2Metadata,
} from '@truebuild/contracts/model'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { createDocumentFixtureGenerator } from '../../providers/document-fixtures'
import { encodeWireProposal, type WireProposal } from '../../providers/document-wire'
import type { ScreenGenerationInput, VerifiedCallTelemetry } from '../../providers/meta-provider'
import { demoSession, fullUi } from '../../test-support/document-inputs'
import { aiPolicyFromEnvironment } from '../ai-policy'
import { createRuntimeFromEnvironment } from '../model-runtime'
import type { BackgroundWork } from '../screens/service'
import { buildDocumentContext } from './context'
import { checkProposal } from './ground'
import { createDocumentService, precomputeItems, type DocumentService, type DocumentServiceOptions } from './service'

// Contextual More at the API: grounding, the provider view, the route's binding, stages and fallbacks.

afterEach(() => vi.restoreAllMocks())

const KEY = 'synthetic-local-test-value'
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const QUESTION = 'Does the groove face inward?'
const ui = { ...fullUi, language: { options: ['en'] }, settings: { storage: true as const } }

const policyFor = (env: Record<string, string> = {}): DocumentServiceOptions['policy'] =>
    aiPolicyFromEnvironment(env, {
        checkTimeoutMs: 8_000,
        parseModel: 'muse-spark-1.3',
        verdictModel: 'muse-spark-1.3',
        secondOpinionModel: 'muse-wonder-1.0',
    })
const work: BackgroundWork = {
    run: (_options, job) => job(),
    repair: (job) => job(),
    tryAcquire: () => () => {},
    acquire: async () => () => {},
}

const answer = (): QuestionResult =>
    questionResultSchema.parse({
        answer: 'The groove faces inward toward the divider.',
        sourceRefs: [{ pageId: 'demo-page-1', region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
        missingEvidence: ['A closer photo would help.'],
    })
type Held = 'none' | 'photo' | 'refuse' | 'pass' | 'answer' | 'both'
function more(held: Held = 'none', manualId?: string): ScreenContextInputsV2 {
    const base: ScreenContextInputsV2 = {
        kind: 'more',
        session: demoSession(manualId === undefined ? {} : { manualId }),
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
const globalMore: ScreenContextInputsV2 = {
    kind: 'more',
    session: null,
    stepId: null,
    captureId: null,
    result: null,
    failure: null,
    uiState: ui,
}
const HELD: Held[] = ['none', 'photo', 'refuse', 'pass', 'answer', 'both']

const telemetry = (stage: ScreenGenerationInput['stage']): VerifiedCallTelemetry => ({
    stage,
    model: stage === 'screens' ? 'muse-spark-1.3' : 'muse-wonder-1.0',
    effort: 'max',
    timeToProviderMs: 1,
    providerMs: 20,
    parseValidateMs: 2,
    totalMs: 30,
    paceWaitMs: 0,
    networkMs: 15,
    bodyMs: 5,
    usage: { inputTokens: 100, cachedTokens: 40, outputTokens: 50, reasoningTokens: 10 },
})
function live(
    script: unknown[],
    env: Record<string, string> = {},
): { service: DocumentService; inputs: ScreenGenerationInput[] } {
    const inputs: ScreenGenerationInput[] = []
    const service = createDocumentService({
        provider: {
            generateDocument: async (input) => {
                inputs.push(input)
                return { value: script[inputs.length - 1], telemetry: telemetry(input.stage) }
            },
        },
        policy: policyFor(env),
        runtimeMode: 'meta',
        work,
    })
    return { service, inputs }
}
const wireFor = (
    inputs: ScreenContextInputsV2,
    edit?: (proposal: ScreenProposalV2) => ScreenProposalV2,
): WireProposal => {
    const proposal = composeProposalV2(buildDocumentContext(inputs).material)
    return encodeWireProposal(edit ? edit(proposal) : proposal)
}
const dropCard = (proposal: ScreenProposalV2, result: 'check' | 'question'): ScreenProposalV2 => {
    const walk = (node: ScreenNodeV2): ScreenNodeV2 =>
        'children' in node
            ? ({
                  ...node,
                  children: node.children
                      .filter((child) => !(child.type === 'VerdictCard' && child.result === result))
                      .map(walk),
              } as ScreenNodeV2)
            : node
    return { ...proposal, body: walk(proposal.body) }
}

describe('the gate and the grounding', () => {
    it.each(HELD)('accepts the complete deterministic More with %s held', (held) => {
        const context = buildDocumentContext(more(held))
        expect(checkProposal(composeProposalV2(context.material), context)).toEqual([])
        expect(context.stage).toBe('screens')
    })

    it('rejects what a global More or a refusal cannot offer or state', () => {
        const withNode = (inputs: ScreenContextInputsV2, node: ScreenNodeV2): string => {
            const context = buildDocumentContext(inputs)
            const proposal = composeProposalV2(context.material)
            const body = proposal.body
            if (body.type !== 'Scroll' || body.children[0]?.type !== 'Stack') throw new Error('unexpected composition')
            const stack = body.children[0]
            const next = {
                ...proposal,
                body: { ...body, children: [{ ...stack, children: [...stack.children, node] }] },
            }
            return checkProposal(next as ScreenProposalV2, context).join(' ')
        }
        const quote: ScreenNodeV2 = {
            type: 'Text',
            content: { kind: 'bound', key: 'held-question' },
            role: 'body',
            emphasis: 'normal',
            tone: 'neutral',
            align: 'start',
        }
        expect(withNode(globalMore, quote)).toContain('bound_unavailable')
        expect(withNode(more('refuse'), quote)).toContain('bound_unavailable')
        expect(withNode(more('answer'), quote)).not.toContain('bound_unavailable')
        const action = (intent: unknown): ScreenNodeV2 =>
            ({ type: 'SecondaryAction', label: 'Ask about this step', icon: null, intent }) as ScreenNodeV2
        expect(withNode(globalMore, action({ intent: 'ask', target: 'about-step' }))).toContain('intent_not_allowed')
        const next = {
            type: 'SecondaryAction',
            label: 'Next step',
            icon: null,
            intent: { intent: 'confirm', target: 'step' },
        } as ScreenNodeV2
        for (const held of ['refuse', 'answer', 'both'] as const) {
            expect(withNode(more(held), next), held).toContain('intent_not_allowed')
        }
        const card: ScreenNodeV2 = {
            type: 'VerdictCard',
            result: 'question',
            variant: 'card',
            showReason: true,
            showRegions: false,
        }
        expect(withNode(more('refuse'), card)).toContain('no_such_result')
        expect(withNode(more('both'), card)).not.toContain('no_such_result')
    })

    it('shows the provider the question, the decision and no photo or manual it should not have', () => {
        const both = buildDocumentContext(more('both'))
        const view = both.view.dynamic.document as Record<string, unknown>
        expect(view).toMatchObject({
            kind: 'more',
            result: { kind: 'check', decision: 'refuse' },
            companionAnswer: { question: QUESTION },
            captureId: 'cap-1',
        })
        expect(view.boundKeys).toContain('held-question')
        expect(JSON.stringify(view)).not.toMatch(/base64|data:image/u)
        expect(both.view.stable.manual).toMatchObject({ steps: expect.any(Number) })
        const global = buildDocumentContext(globalMore)
        expect(global.view.stable.manual).toBeNull()
        expect(global.view.dynamic.document).toMatchObject({ result: null, companionAnswer: null, step: null })
        expect(buildDocumentContext(more('refuse')).view.dynamic.document).toMatchObject({ companionAnswer: null })
    })
})

describe('the service', () => {
    it('composes a model More with both results on the screen stage and credits only what the call observed', async () => {
        const inputs = more('both')
        const { service, inputs: seen } = live([wireFor(inputs)])
        const document = await service.generate(inputs)
        expect(seen).toHaveLength(1)
        expect(seen[0]).toMatchObject({ stage: 'screens' })
        expect(document.metadata).toMatchObject({
            source: 'generated',
            evidence: 'live',
            stage: 'screen',
            model: 'muse-spark-1.3',
        })
        expect(document.facts.map((fact) => fact.factId)).toEqual(
            expect.arrayContaining(['result:verdict', 'result:answer', 'result:answer-missing:0']),
        )
    })

    it('repairs once, then falls back to the complete document with the refusal and the answer', async () => {
        const inputs = more('both')
        const lost = wireFor(inputs, (proposal) => dropCard(proposal, 'question'))
        const { service, inputs: seen } = live([lost, lost])
        const document = await service.generate(inputs)
        expect(seen).toHaveLength(2)
        expect(document.metadata).toMatchObject({ source: 'fallback', fallbackReason: 'repair_failed' })
        const cards = JSON.stringify(document.body)
        expect(cards).toContain('"result":"check"')
        expect(cards).toContain('"result":"question"')
        expect(document.requirements.facts).toEqual(expect.arrayContaining(['result:verdict', 'result:answer']))
    })

    it('accepts a repaired model More that restores the answer card', async () => {
        const inputs = more('both')
        const { service, inputs: seen } = live([
            wireFor(inputs, (proposal) => dropCard(proposal, 'question')),
            wireFor(inputs),
        ])
        const document = await service.generate(inputs)
        expect(seen).toHaveLength(2)
        expect(document.metadata).toMatchObject({ source: 'generated', repaired: true })
    })

    it('never calls a provider when generation is off, and never prepares a More in a precompute', async () => {
        const { service, inputs: seen } = live([wireFor(more('refuse'))], { GENERATIVE_UI: 'off' })
        const document = await service.generate(more('refuse'))
        expect(seen).toHaveLength(0)
        expect(document.metadata).toMatchObject({ source: 'fallback', fallbackReason: 'disabled' })
        const items = precomputeItems({
            session: demoSession(),
            focusKey: null,
            uiState: ui,
            completedStepIds: undefined,
        })
        expect(items.map((item) => item.kind)).not.toContain('more')
    })

    it.each(['a', 'b'])('keeps the held photo spine under either fixture arrangement (manual %s)', async (manualId) => {
        const generator = createDocumentFixtureGenerator()
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: generator,
            policy: policyFor(),
            runtimeMode: 'fixture',
            work,
        })
        for (const inputs of [more('both', manualId), more('refuse', manualId), more('answer', manualId)]) {
            const document = await service.generate(inputs)
            expect(document.metadata, inputs.result?.kind).toMatchObject({
                source: 'generated',
                evidence: 'synthetic-fixture',
            })
            expect(document.metadata.fallbackReason).toBeNull()
        }
    })
})

describe('POST /api/screens/v2', () => {
    function app(): ReturnType<typeof createApp> {
        vi.spyOn(console, 'info').mockImplementation((): void => {})
        return createApp({
            runtime: createRuntimeFromEnvironment({ PROVIDER_MODE: 'fixture', API_SHARED_SECRET: KEY }),
            onDuration: () => {},
        })
    }
    const send = (target: ReturnType<typeof createApp>, metadata: unknown): Promise<Response> => {
        const body = new FormData()
        body.set('metadata', JSON.stringify(metadata))
        return Promise.resolve(
            target.request('/api/screens/v2', { method: 'POST', headers: { 'x-truebuild-key': KEY }, body }),
        )
    }
    const request = (inputs: ScreenContextInputsV2): ModelScreensV2Metadata =>
        screensV2GenerateRequest('r1', inputs, sha256Hex)

    it('generates global and contextual More documents bound to their exact state', async () => {
        const target = app()
        for (const inputs of [globalMore, ...HELD.map((held) => more(held))]) {
            const response = await send(target, request(inputs))
            expect(response.status).toBe(200)
            const body = screensV2ResultSchema.parse(await response.json())
            if (body.status !== 'ok') throw new Error('unavailable')
            expect(body.value.document).toMatchObject({
                kind: 'more',
                bound: {
                    stepId: inputs.stepId,
                    captureId: inputs.result === null ? inputs.captureId : inputs.captureId,
                },
                metadata: { source: 'generated', evidence: 'synthetic-fixture', model: null },
            })
        }
    })

    it('refuses a context key computed without the companion answer, and an inconsistent held state', async () => {
        const target = app()
        const both = request(more('both'))
        expect((await send(target, { ...both, contextKey: request(more('refuse')).contextKey })).status).toBe(400)
        const other = { ...both, companionAnswer: { question: 'Another?', value: answer() } }
        expect((await send(target, other)).status).toBe(400)
        expect((await send(target, { ...both, companionAnswer: null, contextKey: both.contextKey })).status).toBe(400)
        expect((await send(target, { ...request(more('answer')), companionAnswer: both.companionAnswer })).status).toBe(
            400,
        )
        expect((await send(target, { ...request(more('none')), companionAnswer: both.companionAnswer })).status).toBe(
            400,
        )
        const unknownPage = more('refuse')
        unknownPage.result = {
            kind: 'check',
            value: { ...createHeroResponse('reversed'), sourceRefs: [{ pageId: 'no-such-page', region: null }] },
        }
        expect((await send(target, request(unknownPage))).status).toBe(400)
        expect((await send(target, { ...request(globalMore), stepId: 'step-1' })).status).toBe(400)
        expect((await send(target, { ...request(globalMore), session: demoSession() })).status).toBe(400)
    })
})
