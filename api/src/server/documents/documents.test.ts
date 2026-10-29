import {
    SCREEN_KINDS_V2,
    composeProposalV2,
    screenDocumentV2Schema,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenKindV2,
} from '@truebuild/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    createDocumentFixtureGenerator,
    INVALID_QUESTIONS_MANUAL,
    REPAIR_ONCE_MANUAL,
} from '../../providers/document-fixtures'
import { DOCUMENT_PROMPT_VERSION } from '../../providers/document-prompt'
import { decodeWireProposal, encodeWireProposal, type WireProposal } from '../../providers/document-wire'
import {
    MetaProviderError,
    type ScreenGenerationInput,
    type VerifiedCallTelemetry,
} from '../../providers/meta-provider'
import { metaOutputSchemas } from '../../providers/meta-schemas'
import { documentInputs, demoSession, fullUi, SAFETY_NOTE } from '../../test-support/document-inputs'
import { aiPolicyFromEnvironment } from '../ai-policy'
import type { BackgroundWork } from '../screens/service'
import { buildDocumentContext, type DocumentContext } from './context'
import { checkProposal, evaluateWire, semanticIssues } from './ground'
import { createDocumentService, precomputeItems, type DocumentService, type DocumentServiceOptions } from './service'

afterEach(() => vi.restoreAllMocks())

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

function fixtureService(
    env: Record<string, string> = {},
    extra: Partial<DocumentServiceOptions> = {},
): { service: DocumentService; calls: { kind: string; attempt: number }[] } {
    const generator = createDocumentFixtureGenerator()
    const calls: { kind: string; attempt: number }[] = []
    const service = createDocumentService({
        provider: null,
        fixtureGenerator: async (request, signal) => {
            calls.push({ kind: request.kind, attempt: request.attempt })
            return generator(request, signal)
        },
        policy: policyFor(env),
        runtimeMode: 'fixture',
        work,
        ...extra,
    })
    return { service, calls }
}

const telemetry = (stage: 'screens' | 'step-pages' = 'step-pages'): VerifiedCallTelemetry => ({
    stage,
    model: 'muse-wonder-1.0',
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

/** A live provider stub: each call returns the next scripted value (or throws the scripted error). */
function liveService(
    script: (unknown | Error)[],
    env: Record<string, string> = {},
): { service: DocumentService; inputs: ScreenGenerationInput[] } {
    const inputs: ScreenGenerationInput[] = []
    const service = createDocumentService({
        provider: {
            generateDocument: async (input) => {
                inputs.push(input)
                const next = script[inputs.length - 1]
                if (next instanceof Error) throw next
                return { value: next, telemetry: telemetry(input.stage) }
            },
        },
        policy: policyFor(env),
        runtimeMode: 'meta',
        work,
    })
    return { service, inputs }
}

const contextFor = (
    kind: ScreenKindV2,
    ...rest: Parameters<typeof documentInputs> extends [unknown, ...infer R] ? R : never
): DocumentContext => buildDocumentContext(documentInputs(kind, ...rest))
const goodWire = (
    kind: ScreenKindV2,
    ...rest: Parameters<typeof documentInputs> extends [unknown, ...infer R] ? R : never
): WireProposal => encodeWireProposal(composeProposalV2(contextFor(kind, ...rest).material))

/** Applies `edit` to every node of the proposal (ready variant and every state variant). */
function editNodes(proposal: ScreenProposalV2, edit: (node: ScreenNodeV2) => ScreenNodeV2): ScreenProposalV2 {
    const walk = (node: ScreenNodeV2): ScreenNodeV2 => {
        const next = edit(node)
        return 'children' in next ? ({ ...next, children: next.children.map(walk) } as ScreenNodeV2) : next
    }
    const variant = <V extends { body: ScreenNodeV2; overlays: { content: ScreenNodeV2 }[] }>(source: V): V => ({
        ...source,
        body: walk(source.body),
        overlays: source.overlays.map((overlay) => ({ ...overlay, content: walk(overlay.content) })),
    })
    const states = Object.fromEntries(
        Object.entries(proposal.states).map(([name, state]) => [name, state === null ? null : variant(state)]),
    ) as ScreenProposalV2['states']
    return { ...variant(proposal), states }
}
const dropFact = (proposal: ScreenProposalV2, factId: string): ScreenProposalV2 => {
    const drop = (node: ScreenNodeV2): ScreenNodeV2 =>
        'children' in node
            ? ({
                  ...node,
                  children: node.children
                      .filter(
                          (child) =>
                              !(
                                  child.type === 'Text' &&
                                  child.content.kind === 'fact' &&
                                  child.content.factId === factId
                              ),
                      )
                      .map(drop),
              } as ScreenNodeV2)
            : node
    return editNodes(proposal, (node) => drop(node))
}

describe('the deterministic composition satisfies the server gate', () => {
    it.each(SCREEN_KINDS_V2)('%s: every rule of the gate accepts the complete fallback proposal', (kind) => {
        const context = contextFor(kind)
        expect(checkProposal(composeProposalV2(context.material), context)).toEqual([])
    })

    it('hands the provider the facts, requirements, allowed intents and labels, and no photo', () => {
        const view = contextFor('guide').view.dynamic.document as Record<string, unknown>
        expect(view).toMatchObject({
            kind: 'guide',
            requiredStates: ['busy', 'pending', 'error', 'recovery'],
            requirements: { facts: expect.arrayContaining(['safety:n1']) },
        })
        expect(JSON.stringify(view)).toContain(SAFETY_NOTE)
        expect(Object.keys(view)).toEqual(
            expect.arrayContaining(['allowedIntents', 'allowedLabels', 'coachCopy', 'boundKeys']),
        )
        expect(contextFor('guide').stage).toBe('step-pages')
        // The verdict itself is the Spark API's; composing its screen is noncritical (Wonder), questions stay latency-sensitive.
        expect(contextFor('result').stage).toBe('step-pages')
        expect(contextFor('answer').stage).toBe('step-pages')
        expect(contextFor('questions').stage).toBe('screens')
        expect(contextFor('more').stage).toBe('screens')
    })
})

describe('mandatory omission and unsafe composition are rejected, never patched', () => {
    const guide = contextFor('guide')
    const proposal = composeProposalV2(guide.material)

    it('rejects an omitted safety fact, then reports only a machine rule', () => {
        const issues = checkProposal(dropFact(proposal, 'safety:n1'), guide)
        expect(issues.join()).toContain('contract:a_required_fact_is_missing_from_the_ready_variant')
        expect(issues.join()).not.toContain(SAFETY_NOTE)
        const evaluated = evaluateWire(encodeWireProposal(dropFact(proposal, 'safety:n1')), guide)
        expect(evaluated.ok).toBe(false)
    })

    it('rejects literal digits, an unlisted label, wrong coach copy and a foreign part', () => {
        const withLiteral = editNodes(proposal, (node) =>
            node.type === 'Text' && node.role === 'heading'
                ? { ...node, content: { kind: 'literal', text: 'Use 4 screws' } }
                : node,
        )
        expect(semanticIssues(withLiteral, guide).some((issue) => issue.endsWith(':literal_digits'))).toBe(true)
        const label = {
            ...proposal,
            bar: { ...proposal.bar, primary: { ...proposal.bar.primary, label: 'Do the thing' } },
        }
        expect(semanticIssues(label, guide).some((issue) => issue === 'bar.primary:label_not_listed')).toBe(true)
        const coach = {
            ...proposal,
            overlays: proposal.overlays.map((overlay) =>
                overlay.content.type === 'CoachMark'
                    ? { ...overlay, content: { ...overlay.content, body: 'Skip the safety notes.' } }
                    : overlay,
            ),
        }
        expect(semanticIssues(coach, guide).some((issue) => issue.endsWith(':coach_copy_not_listed'))).toBe(true)
        const part = editNodes(proposal, (node) => (node.type === 'PieceTile' ? { ...node, partId: 'nope' } : node))
        expect(semanticIssues(part, guide).some((issue) => issue.endsWith(':unknown_part'))).toBe(true)
        const anchor = {
            ...proposal,
            overlays: proposal.overlays.map((overlay) => ({ ...overlay, anchor: 'home-add' as const })),
        }
        expect(semanticIssues(anchor, guide).some((issue) => issue.endsWith(':tooltip_anchor'))).toBe(true)
    })

    it('rejects unavailable bindings and nodes that do not belong to the kind', () => {
        const found = semanticIssues(
            editNodes(proposal, (node) =>
                node.type === 'Progress'
                    ? {
                          type: 'Text',
                          content: { kind: 'bound', key: 'review-reason' },
                          role: 'body',
                          emphasis: 'normal',
                          tone: 'neutral',
                          align: 'start',
                      }
                    : node,
            ),
            guide,
        )
        expect(found.some((issue) => issue.endsWith(':bound_unavailable'))).toBe(true)
        const verdict = editNodes(proposal, (node) =>
            node.type === 'Progress'
                ? { type: 'VerdictCard', result: 'check', variant: 'card', showReason: true, showRegions: true }
                : node,
        )
        expect(semanticIssues(verdict, guide).some((issue) => issue.endsWith(':no_such_result'))).toBe(true)
        const camera = editNodes(proposal, (node) =>
            node.type === 'Progress'
                ? { type: 'CameraView', mode: 'build-photo', cue: 'Hold steady', pill: null, tipTarget: null }
                : node,
        )
        expect(semanticIssues(camera, guide).some((issue) => issue.endsWith(':camera_mismatch'))).toBe(true)
    })

    it('a verdict screen keeps its claim title closed and never softens a refusal', () => {
        const result = contextFor('result')
        const base = composeProposalV2(result.material)
        const softened = {
            ...base,
            header: { ...base.header, title: { kind: 'literal' as const, text: 'Looks right' } },
        }
        expect(result.material.decision).toBe('refuse')
        expect(semanticIssues(softened, result)).toContain('header:title_not_listed')
        // Without a VerdictCard the held result is not stated: the contract refuses the document.
        const without = editNodes(base, (node) => (node.type === 'VerdictCard' ? { type: 'Spacer', size: 'md' } : node))
        expect(checkProposal(without, result).join()).toContain('a_required_verdictcard_is_missing')
    })

    it('an unreviewed manual never gets a build action from a model', () => {
        const manual = demoSession()
        manual.reviewStatus = 'unreviewed'
        const context = buildDocumentContext({ ...documentInputs('guide', manual), session: manual })
        const base = composeProposalV2(context.material)
        const offering = {
            ...base,
            bar: {
                ...base.bar,
                primary: {
                    ...base.bar.primary,
                    label: 'Take photo',
                    intent: { intent: 'capture' as const, target: 'take-photo' as const },
                },
            },
        }
        expect(semanticIssues(offering, context)).toContain('bar.primary:intent_not_allowed')
    })
})

describe('the wire table is rebuilt exactly, or rejected', () => {
    const wire = goodWire('guide')

    it('round-trips every kind losslessly', () => {
        for (const kind of SCREEN_KINDS_V2) {
            const proposal = composeProposalV2(contextFor(kind).material)
            const decoded = decodeWireProposal(JSON.parse(JSON.stringify(encodeWireProposal(proposal))))
            expect(decoded.ok, kind).toBe(true)
            if (decoded.ok) expect(decoded.proposal).toEqual(proposal)
        }
    })

    it('rejects orphans, duplicates, unknown ids, shared nodes and unknown properties with machine codes only', () => {
        const orphan = { ...wire, nodes: [...wire.nodes, { type: 'Divider', id: 'zzz', inset: false }] }
        expect(decodeWireProposal(orphan)).toEqual({ ok: false, issues: expect.arrayContaining(['nodes:orphan_node']) })
        const duplicate = { ...wire, nodes: [...wire.nodes, wire.nodes[0]!] }
        expect(JSON.stringify(decodeWireProposal(duplicate))).toContain('duplicate_id')
        const unknown = { ...wire, body: 'missing' }
        expect(JSON.stringify(decodeWireProposal(unknown))).toContain('body:unknown_node')
        const container = wire.nodes.find((node) => node.children && node.children.length > 0)!
        const shared = {
            ...wire,
            nodes: wire.nodes.map((node) =>
                node.id === container.id ? { ...node, children: [node.children![0]!, node.children![0]!] } : node,
            ),
        }
        expect(JSON.stringify(decodeWireProposal(shared))).toContain('node_used_twice')
        const styled = {
            ...wire,
            nodes: wire.nodes.map((node, index) => (index === 0 ? { ...node, style: { color: 'red' } } : node)),
        }
        expect(decodeWireProposal(styled).ok).toBe(false)
        expect(decodeWireProposal({ nodes: [] }).ok).toBe(false)
        expect(decodeWireProposal('not json').ok).toBe(false)
    })

    it('a self-referencing container cannot form a cycle', () => {
        const nodes = [{ type: 'Stack', id: 'a', gap: 'sm', align: 'start', children: ['a'] }]
        const decoded = decodeWireProposal({ ...wire, nodes, body: 'a', overlays: [], states: [] })
        expect(decoded.ok).toBe(false)
    })

    it('the provider schema is finite: no references, an object root, bounded depth, strict', () => {
        const schema = metaOutputSchemas.document
        const text = JSON.stringify(schema)
        expect(text).not.toContain('$ref')
        expect(text).not.toContain('"oneOf"')
        expect(schema).toMatchObject({ type: 'object', additionalProperties: false })
        expect(Object.keys((schema as { properties: object }).properties).sort()).toEqual(
            ['bar', 'body', 'header', 'nodes', 'overlays', 'states'].sort(),
        )
    })
})

describe('service: synthetic fixture documents', () => {
    it('are generated documents that claim no model, timing or usage, with every component generated', async () => {
        const { service, calls } = fixtureService()
        const document = await service.generate(documentInputs('guide'))
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(document.metadata).toMatchObject({
            source: 'generated',
            evidence: 'synthetic-fixture',
            model: null,
            effort: null,
            fallbackReason: null,
            repaired: false,
            promptVersion: DOCUMENT_PROMPT_VERSION,
            timing: { providerMs: null, totalMs: null },
            usage: { inputTokens: null, outputTokens: null },
        })
        expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['generated']))
        expect(calls).toEqual([{ kind: 'guide', attempt: 1 }])
    })

    it('generate every kind (not all fallback) and differ between two manuals', async () => {
        const { service } = fixtureService()
        for (const kind of SCREEN_KINDS_V2) {
            const document = await service.generate(documentInputs(kind))
            expect(document.metadata.source, kind).toBe('generated')
        }
        // Two different manuals (different facts): identical facts are deliberately one cached composition.
        const other = demoSession({ manualId: 'divider-b' })
        other.reviewedSteps[0]!.title = 'Seat the shelf'
        const a = await service.generate(documentInputs('guide', demoSession({ manualId: 'divider-a' })))
        const b = await service.generate(documentInputs('guide', other))
        expect(JSON.stringify(a.body)).not.toBe(JSON.stringify(b.body))
        // Both still state the mandatory safety fact: arrangement differs, the witnesses do not.
        expect(a.requirements.facts).toEqual(b.requirements.facts)
    })

    it('forced invalid output is repaired once, then the complete deterministic document is returned', async () => {
        const { service, calls } = fixtureService()
        const document = await service.generate(
            documentInputs('questions', demoSession({ manualId: INVALID_QUESTIONS_MANUAL })),
        )
        expect(calls.map((call) => call.attempt)).toEqual([1, 2])
        expect(document.metadata).toMatchObject({ source: 'fallback', fallbackReason: 'repair_failed', repaired: true })
        expect(document.metadata.rejectedIssues).toBeGreaterThan(0)
        expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['fallback']))
        expect(document.states.busy).not.toBeNull()
    })

    it('a document that omits its safety fact is rejected, repaired once, and the repaired one is generated', async () => {
        const { service, calls } = fixtureService()
        const document = await service.generate(documentInputs('guide', demoSession({ manualId: REPAIR_ONCE_MANUAL })))
        expect(calls.map((call) => call.attempt)).toEqual([1, 2])
        expect(document.metadata).toMatchObject({ source: 'generated', repaired: true })
        expect(document.metadata.rejectedIssues).toBeGreaterThan(0)
        expect(document.requirements.facts).toContain('safety:n1')
    })

    it('serves an identical request from the cache, and a later revision with identical facts keeps its own identity', async () => {
        const { service, calls } = fixtureService()
        const first = await service.generate(documentInputs('guide'))
        const second = await service.generate(documentInputs('guide'))
        expect(second.metadata.cacheHit).toBe(true)
        expect(second.header).toEqual(first.header)
        expect(second.body).toEqual(first.body)
        expect(calls).toHaveLength(1)
        const later = await service.generate(documentInputs('guide', demoSession({ revision: 2 })))
        expect(later.metadata.cacheHit).toBe(true)
        expect(later.bound.revision).toBe(2)
        expect(later.bound.contextKey).not.toBe(first.bound.contextKey)
        expect(calls).toHaveLength(1)
        // A changed fact is different content and is composed again.
        const edited = demoSession({ revision: 2 })
        edited.reviewedSteps[0]!.safetyNotes![0]!.note = {
            state: 'known',
            value: 'Wear gloves while lifting the panel.',
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
        }
        const changed = await service.generate(documentInputs('guide', edited))
        expect(changed.metadata.cacheHit).toBe(false)
        expect(calls).toHaveLength(2)
    })

    it('reports an older revision as stale once a newer one is seen, without composing', async () => {
        const { service, calls } = fixtureService()
        await service.generate(documentInputs('guide', demoSession({ revision: 3 })))
        const stale = await service.generate(documentInputs('guide', demoSession({ revision: 2 })))
        expect(stale.metadata).toMatchObject({ source: 'fallback', fallbackReason: 'stale' })
        expect(calls).toHaveLength(1)
    })

    it('honours generation off and steps-only with complete deterministic documents', async () => {
        const off = fixtureService({ GENERATIVE_UI: 'off' })
        const document = await off.service.generate(documentInputs('guide'))
        expect(document.metadata).toMatchObject({ source: 'fallback', fallbackReason: 'disabled' })
        expect(document.states.pending).not.toBeNull()
        expect(off.calls).toHaveLength(0)
        const steps = fixtureService({ GENERATIVE_UI: 'steps' })
        expect((await steps.service.generate(documentInputs('home'))).metadata.fallbackReason).toBe('disabled')
        expect((await steps.service.generate(documentInputs('guide'))).metadata.source).toBe('generated')
    })

    it('is unconfigured, not a silent fixture, when neither a provider nor a fixture exists', async () => {
        const meta = createDocumentService({ provider: null, policy: policyFor(), runtimeMode: 'meta', work })
        expect((await meta.generate(documentInputs('guide'))).metadata).toMatchObject({
            source: 'fallback',
            fallbackReason: 'unconfigured',
        })
        const fixture = createDocumentService({ provider: null, policy: policyFor(), runtimeMode: 'fixture', work })
        expect((await fixture.generate(documentInputs('guide'))).metadata.fallbackReason).toBe('fixture')
    })
})

describe('service: a live provider', () => {
    it('records only what the call observed and credits the model its response named', async () => {
        const { service, inputs } = liveService([goodWire('guide')])
        const document = await service.generate(documentInputs('guide'))
        expect(document.metadata).toMatchObject({
            source: 'generated',
            evidence: 'live',
            model: 'muse-wonder-1.0',
            effort: 'max',
            repaired: false,
            rejectedIssues: null,
            timing: { providerMs: 20, networkMs: 15, bodyMs: 5 },
            usage: { inputTokens: 100, cachedTokens: 40, outputTokens: 50, reasoningTokens: 10 },
        })
        expect(inputs).toHaveLength(1)
        expect(inputs[0]).toMatchObject({ stage: 'step-pages' })
        expect(inputs[0]!.repairIssues).toBeUndefined()
        // Latency-sensitive screens use the screens stage (Spark policy), never the Wonder stage; the held result's
        // screen is composed after the Spark verdict was published, so it takes the noncritical Wonder stage.
        const camera = liveService([goodWire('questions')])
        await camera.service.generate(documentInputs('questions'))
        expect(camera.inputs[0]).toMatchObject({ stage: 'screens' })
        const result = liveService([goodWire('result')])
        await result.service.generate(documentInputs('result'))
        expect(result.inputs[0]).toMatchObject({ stage: 'step-pages' })
    })

    it('repairs once with machine codes only, summing both attempts and never the rejected text', async () => {
        const rejected = dropFact(composeProposalV2(contextFor('guide').material), 'safety:n1')
        const { service, inputs } = liveService([encodeWireProposal(rejected), goodWire('guide')])
        const document = await service.generate(documentInputs('guide'))
        expect(document.metadata).toMatchObject({
            source: 'generated',
            repaired: true,
            usage: { inputTokens: 200, outputTokens: 100 },
        })
        expect(inputs).toHaveLength(2)
        const issues = inputs[1]!.repairIssues!
        expect(issues.length).toBeGreaterThan(0)
        expect(JSON.stringify(issues)).not.toContain(SAFETY_NOTE)
    })

    it('replaces the document when the repair still omits a witness and never appends anything to it', async () => {
        const rejected = encodeWireProposal(dropFact(composeProposalV2(contextFor('guide').material), 'safety:n1'))
        const { service, inputs } = liveService([rejected, rejected])
        const document = await service.generate(documentInputs('guide'))
        expect(inputs).toHaveLength(2)
        expect(document.metadata).toMatchObject({ source: 'fallback', fallbackReason: 'repair_failed', repaired: true })
        expect(document.metadata.model).toBe('muse-wonder-1.0')
        expect(new Set(Object.values(document.metadata.origins))).toEqual(new Set(['fallback']))
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
    })

    it('repairs a completed but malformed answer, and never an incomplete or timed-out one', async () => {
        const malformed = new MetaProviderError('invalid_output', 'malformed')
        const repaired = liveService([malformed, goodWire('guide')])
        expect((await repaired.service.generate(documentInputs('guide'))).metadata).toMatchObject({
            source: 'generated',
            repaired: true,
        })
        const incomplete = liveService([new MetaProviderError('invalid_output', 'incomplete'), goodWire('guide')])
        expect((await incomplete.service.generate(documentInputs('guide'))).metadata).toMatchObject({
            source: 'fallback',
            fallbackReason: 'invalid_output',
        })
        expect(incomplete.inputs).toHaveLength(1)
        const slow = liveService([new MetaProviderError('timeout'), goodWire('guide')])
        expect((await slow.service.generate(documentInputs('guide'))).metadata).toMatchObject({
            source: 'fallback',
            fallbackReason: 'timeout',
        })
        expect(slow.inputs).toHaveLength(1)
    })
})

describe('service: precompute, progress and cancel', () => {
    it('prepares the noncritical screens with the Wonder stage, first pages first, and never fakes completion', async () => {
        const stages: string[] = []
        const started: string[] = []
        const generator = createDocumentFixtureGenerator()
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: async (request, signal) => {
                stages.push(request.context.stage)
                started.push(`${request.kind}:${request.stepId ?? ''}`)
                return generator(request, signal)
            },
            policy: policyFor(),
            runtimeMode: 'fixture',
            work,
        })
        const session = demoSession()
        const progress = service.precompute({
            session,
            focusKey: 'guide:step-1',
            uiState: fullUi,
            completedStepIds: undefined,
        })
        expect(progress.items.map((item) => item.key)).toEqual([
            'reading',
            'guide:step-1',
            'guide:step-2',
            'completion',
            'judge',
            'compare',
            'home',
        ])
        await vi.waitFor(() => {
            const read = service.progress(session.manualId, session.revision, ['guide:step-1'])
            expect(read.documents).toHaveLength(1)
        })
        // The step after the first is deliberately slower: a partial result is observable before everything is ready.
        const partial = service.progress(session.manualId, session.revision, ['guide:step-1', 'guide:step-2'])
        expect(partial.progress!.items.find((item) => item.key === 'guide:step-2')!.state).not.toBe('ready')
        expect(partial.documents.map((document) => document.bound.stepId)).not.toContain('step-2')
        await vi.waitFor(
            () => {
                const read = service.progress(session.manualId, session.revision, [])
                expect(read.progress!.items.every((item) => item.state === 'ready')).toBe(true)
            },
            { timeout: 4_000 },
        )
        const all = service.progress(session.manualId, session.revision, [
            'home',
            'reading',
            'completion',
            'judge',
            'compare',
            'guide:step-2',
        ])
        expect(all.documents.map((document) => document.kind).sort()).toEqual(
            ['completion', 'compare', 'guide', 'home', 'judge', 'reading'].sort(),
        )
        expect(all.documents.every((document) => document.metadata.stage === 'step-page')).toBe(true)
        expect(new Set(stages)).toEqual(new Set(['step-pages']))
        // The focused step is prepared first, before the manual's other screens.
        expect(started[0]).toBe('guide:step-1')
    })

    it('cancels queued work and keeps a stale revision from publishing', async () => {
        const { service } = fixtureService({}, { precomputeConcurrency: 1 })
        const session = demoSession()
        service.precompute({ session, focusKey: null, uiState: fullUi, completedStepIds: undefined })
        const cancelled = service.cancel(session.manualId, session.revision)
        expect(cancelled!.items.some((item) => item.state === 'cancelled')).toBe(true)
        const later = demoSession({ revision: 2 })
        service.precompute({ session: later, focusKey: null, uiState: fullUi, completedStepIds: undefined })
        // The older revision's job is gone, and the revision it belonged to is stale for any new work.
        expect(service.progress(session.manualId, session.revision, []).progress).toBeNull()
        expect(service.observe(session.manualId, session.revision)).toBe(false)
    })

    it('lists only what the supplied state and review make real', () => {
        const unreviewed = demoSession()
        unreviewed.reviewStatus = 'unreviewed'
        unreviewed.rawExtraction = { parts: unreviewed.parts, steps: unreviewed.reviewedSteps, unknowns: [] }
        const keys = precomputeItems({
            session: unreviewed,
            focusKey: null,
            uiState: null,
            completedStepIds: undefined,
        }).map((item) => item.key)
        expect(keys).toEqual(['reading', 'guide:step-1', 'guide:step-2'])
    })
})

describe('service: the page a check names', () => {
    it('resolves an issued guide to the facts it showed, and refuses another identity', async () => {
        const { service } = fixtureService()
        const session = demoSession()
        const document = await service.generate(documentInputs('guide', session))
        const screen = { screenId: document.screenId, contextKey: document.bound.contextKey }
        const resolved = service.resolveStepScreen(session, 'step-1', screen)
        expect(resolved).toMatchObject({ kind: 'guide', screenId: document.screenId })
        expect((resolved as { facts: { id: string }[] }).facts.map((fact) => fact.id)).toContain('safety:n1')
        expect(service.resolveStepScreen(session, 'step-2', screen)).toBe('mismatch')
        expect(service.resolveStepScreen({ ...session, revision: 9 }, 'step-1', screen)).toBe('mismatch')
        expect(service.resolveStepScreen(session, 'step-1', { ...screen, contextKey: 'f'.repeat(64) })).toBe('mismatch')
        expect(
            service.resolveStepScreen(session, 'step-1', { screenId: 'a'.repeat(64), contextKey: screen.contextKey }),
        ).toBeNull()
        // A changed manual no longer states what the page showed: that fact is dropped from the report.
        const edited = demoSession()
        edited.reviewedSteps[0]!.safetyNotes![0]!.note = {
            state: 'known',
            value: 'Other.',
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
        }
        const after = service.resolveStepScreen(edited, 'step-1', screen) as { facts: { id: string }[] }
        expect(after.facts.map((fact) => fact.id)).not.toContain('safety:n1')
    })
})
