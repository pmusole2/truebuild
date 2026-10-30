import {
    buildFallbackProposalV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
} from '@truebuild/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createDocumentFixtureGenerator } from '../../providers/document-fixtures'
import { DOCUMENT_INSTRUCTIONS, DOCUMENT_PROMPT_VERSION } from '../../providers/document-prompt'
import { decodeWireProposal, encodeWireProposal } from '../../providers/document-wire'
import type { VerifiedCallTelemetry } from '../../providers/meta-provider'
import { metaOutputSchemas } from '../../providers/meta-schemas'
import { demoSession, documentInputs, fullUi } from '../../test-support/document-inputs'
import { aiPolicyFromEnvironment } from '../ai-policy'
import type { BackgroundWork } from '../screens/service'
import { buildDocumentContext } from './context'
import { checkProposal } from './ground'
import { createDocumentService } from './service'

// Regression cases for the integration closures on the server side: what the gate accepts and refuses, the fixture
// truthfulness of a scripted provider, and the strict job snapshot. The contract side lives in
// packages/contracts/src/document-v2-integration.test.ts.

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
const NOTICE = { notice: true } as const
const ui = (patch: Partial<ScreenUiStateV2> = {}): ScreenUiStateV2 => ({
    ...fullUi,
    language: { options: ['en', 'es'] },
    settings: { storage: true },
    sections: ['how-it-works', 'settings', 'tips', 'about-this-check'],
    ...patch,
})
const contextOf = (kind: ScreenKindV2, patch: Partial<ScreenUiStateV2> = {}): ReturnType<typeof buildDocumentContext> =>
    buildDocumentContext(documentInputs(kind, demoSession(), ui(patch)))
const issuesOf = (context: ReturnType<typeof buildDocumentContext>, proposal?: ScreenProposalV2): string[] =>
    checkProposal(proposal ?? buildFallbackProposalV2(context.material), context)
const telemetry: VerifiedCallTelemetry = {
    stage: 'screens',
    model: 'muse-spark-1.3',
    effort: 'max',
    timeToProviderMs: 1,
    providerMs: 20,
    parseValidateMs: 2,
    totalMs: 30,
    paceWaitMs: 0,
    networkMs: 15,
    bodyMs: 5,
    usage: { inputTokens: 100, cachedTokens: 40, outputTokens: 50, reasoningTokens: 10 },
}

describe('the gate accepts the complete deterministic composition of every integration closure', () => {
    it.each([
        ['error with a notice', 'error', { failure: NOTICE }],
        ['recovery with a notice', 'recovery', { failure: NOTICE }],
        ['reading with a notice', 'reading', { failure: NOTICE }],
        ['quick check with its picture', 'quick-check', {}],
        ['camera that runs (busy and pending hold it)', 'camera', {}],
        ['more with the tips replay', 'more', {}],
        ['judge with the built-view toggle', 'judge', {}],
        ['compare with Close', 'compare', {}],
        ['home with its coach order', 'home', {}],
        ['questions with Close', 'questions', {}],
    ] as [string, ScreenKindV2, Partial<ScreenUiStateV2>][])('%s', (_name, kind, patch) => {
        expect(issuesOf(contextOf(kind, patch))).toEqual([])
    })
})

describe('labels and intents of the new closures', () => {
    it('accepts Back and Close on navigate/back and refuses Close on Home', () => {
        const context = contextOf('more')
        const proposal = buildFallbackProposalV2(context.material)
        expect(proposal.bar.primary).toMatchObject({ label: 'Close', intent: { intent: 'navigate', target: 'back' } })
        const asBack: ScreenProposalV2 = {
            ...proposal,
            bar: { ...proposal.bar, primary: { ...proposal.bar.primary, label: 'Back' } },
        }
        expect(issuesOf(context, asBack)).toEqual([])
        const mislabelled: ScreenProposalV2 = {
            ...proposal,
            bar: {
                ...proposal.bar,
                primary: { ...proposal.bar.primary, intent: { intent: 'navigate', target: 'home' } },
            },
        }
        // Close names closing, not Home: the registry keeps the two apart, and the required back is then missing.
        expect(issuesOf(context, mislabelled).join()).toMatch(/label_not_listed|required_action_is_missing/u)
    })

    it('lists Show tips again for the replay and refuses the replay without the tips section', () => {
        const context = contextOf('more')
        const proposal = buildFallbackProposalV2(context.material)
        expect(JSON.stringify(proposal.body)).toContain('Show tips again')
        const without = contextOf('more', { sections: ['settings'] })
        const replay = buildFallbackProposalV2(context.material)
        expect(issuesOf(without, replay).join()).toContain('intent_not_allowed')
    })

    it('lists Saving… as the busy bar wording', () => {
        const context = contextOf('camera', { busy: { activity: 'saving' } })
        const proposal = buildFallbackProposalV2(context.material)
        expect(proposal.states.busy!.bar.primary.label).toBe('Saving…')
        expect(issuesOf(context)).toEqual([])
    })
})

describe('what the gate refuses', () => {
    it('refuses the operation notice without the witness', () => {
        const context = contextOf('recovery')
        const noticed = buildFallbackProposalV2(contextOf('recovery', { failure: NOTICE }).material)
        const codes = issuesOf(context, noticed).join()
        expect(codes).toMatch(/bound_unavailable|operation_notice/u)
    })

    it('refuses a tooltip that is not a coach mark and a sheet, at the wire', () => {
        const context = contextOf('home')
        const wire = encodeWireProposal(buildFallbackProposalV2(context.material))
        const sheet = { ...wire, overlays: [{ kind: 'sheet', anchor: null, content: wire.overlays[0]!.content }] }
        expect(decodeWireProposal(sheet).ok).toBe(false)
        const notCoach = { ...wire, overlays: [{ ...wire.overlays[0]!, content: wire.body }] }
        expect(decodeWireProposal(notCoach).ok).toBe(false)
    })

    it('refuses an unimplemented toggle or text-field binding at the wire', () => {
        const context = contextOf('judge')
        const wire = encodeWireProposal(buildFallbackProposalV2(context.material))
        const tips = {
            ...wire,
            nodes: wire.nodes.map((node) => (node.type === 'Toggle' ? { ...node, binding: 'tips' } : node)),
        }
        expect(decodeWireProposal(tips).ok).toBe(false)
        const asked = contextOf('questions')
        const askedWire = encodeWireProposal(buildFallbackProposalV2(asked.material))
        const field = {
            ...askedWire,
            nodes: askedWire.nodes.map((node) =>
                node.type === 'TextField' ? { ...node, binding: 'fact-answer' } : node,
            ),
        }
        expect(decodeWireProposal(field).ok).toBe(false)
    })

    it('refuses a camera that is not held where the ready screen holds it', () => {
        const context = contextOf('camera')
        const proposal = buildFallbackProposalV2(context.material)
        const busy = proposal.states.busy!
        const without = (node: ScreenNodeV2): ScreenNodeV2 =>
            'children' in node
                ? ({
                      ...node,
                      children: node.children.filter((child) => child.type !== 'CameraView').map(without),
                  } as ScreenNodeV2)
                : node
        const dropped: ScreenProposalV2 = {
            ...proposal,
            states: { ...proposal.states, busy: { ...busy, body: without(busy.body) } },
        }
        expect(issuesOf(context, dropped).join()).toMatch(/camera/iu)
    })

    it('shows the model the new witnesses and a prompt version that keys the cache', () => {
        // 10: the generic waiting wording of the closed copy changed, and that copy is part of the supplied view.
        expect(DOCUMENT_PROMPT_VERSION).toBeGreaterThanOrEqual(10)
        for (const phrase of ['requirements.figure', 'requirements.notice', 'navigate / back', 'SAME CameraView']) {
            expect(DOCUMENT_INSTRUCTIONS).toContain(phrase)
        }
        const quick = contextOf('quick-check')
        expect(quick.view.dynamic).toMatchObject({ document: { requirements: { notice: false } } })
        expect(contextOf('error', { failure: NOTICE }).view.dynamic).toMatchObject({
            document: { requirements: { notice: true }, boundKeys: expect.arrayContaining(['operation-notice']) },
        })
        expect(metaOutputSchemas.document).toBeDefined()
    })
})

describe('R3 a scripted provider under the fixture runtime is a truthful synthetic example', () => {
    const scripted = (calls: { n: number }): NonNullable<Parameters<typeof createDocumentService>[0]['provider']> => ({
        generateDocument: async (): Promise<{ value: unknown; telemetry: VerifiedCallTelemetry }> => {
            calls.n += 1
            const good = encodeWireProposal(
                buildFallbackProposalV2(buildDocumentContext(documentInputs('home')).material),
            )
            return { value: good, telemetry }
        },
    })

    it('publishes generated, synthetic-fixture and claims no model, effort, timing or usage', async () => {
        const calls = { n: 0 }
        const service = createDocumentService({
            provider: scripted(calls),
            policy,
            runtimeMode: 'fixture',
            work,
        })
        const document = await service.generate(documentInputs('home'))
        expect(calls.n).toBe(1)
        expect(document.metadata).toMatchObject({
            source: 'generated',
            evidence: 'synthetic-fixture',
            fallbackReason: null,
            model: null,
            effort: null,
            timing: { timeToProviderMs: null, providerMs: null, parseValidateMs: null, totalMs: null },
            usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null },
        })
    })

    it('keeps a live runtime honest about what it observed', async () => {
        const calls = { n: 0 }
        const service = createDocumentService({ provider: scripted(calls), policy, runtimeMode: 'meta', work })
        const document = await service.generate(documentInputs('home'))
        expect(document.metadata).toMatchObject({ source: 'generated', evidence: 'live', model: 'muse-spark-1.3' })
        expect(document.metadata.usage.outputTokens).toBe(50)
    })

    it('never runs the fixture generator in the live runtime, even beside an injected provider', async () => {
        const fixture = vi.fn(createDocumentFixtureGenerator())
        const calls = { n: 0 }
        const service = createDocumentService({
            provider: scripted(calls),
            fixtureGenerator: fixture,
            policy,
            runtimeMode: 'meta',
            work,
        })
        await service.generate(documentInputs('home'))
        expect(fixture).not.toHaveBeenCalled()
        expect(calls.n).toBe(1)
    })
})

describe('R2 the job is read with the snapshot it was started with', () => {
    it('fails closed when the live UI changed on the poll, and reads with the original snapshot', () => {
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: createDocumentFixtureGenerator(),
            runtimeMode: 'fixture',
            policy,
            work,
        })
        const session = demoSession()
        const snapshot = { session, uiState: fullUi, focusKey: null, completedStepIds: undefined }
        const started = service.precompute(snapshot)
        expect(service.jobContextKey(snapshot)).toBe(started.contextKey)
        const drifted = { ...snapshot, uiState: { ...fullUi, busy: { activity: 'working' as const } } }
        // The key follows the kind-used state, so a busy flag the guides read is a different job: it is refused.
        expect(service.jobContextKey(drifted)).not.toBe(started.contextKey)
        expect(
            service.progress(session.manualId, session.revision, ['guide:step-1'], service.jobContextKey(drifted)),
        ).toEqual({
            progress: null,
            documents: [],
        })
        expect(service.cancel(session.manualId, session.revision, service.jobContextKey(drifted))).toBeNull()
        const original = service.progress(session.manualId, session.revision, [], service.jobContextKey(snapshot))
        expect(original.progress?.contextKey).toBe(started.contextKey)
        expect(original.progress?.items.some((item) => item.state === 'cancelled')).toBe(false)
    })
})
