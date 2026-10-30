import { createHash } from 'node:crypto'

import {
    CONFIRM_LABELS_V2,
    buildFallbackProposalV2,
    manualDisplayTitleV2,
    type ScreenKindV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
} from '@truebuild/contracts'
import { modelScreensV2MetadataSchema, screensV2GenerateRequest } from '@truebuild/contracts/model'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { createDocumentFixtureGenerator } from '../../providers/document-fixtures'
import { createRuntimeFromEnvironment } from '../model-runtime'
import { demoSession, documentInputs, fullUi } from '../../test-support/document-inputs'
import { aiPolicyFromEnvironment } from '../ai-policy'
import type { BackgroundWork } from '../screens/service'
import { buildDocumentContext } from './context'
import { checkProposal } from './ground'
import { createDocumentService, precomputeItems, type DocumentServiceOptions, type PrecomputeRequest } from './service'

// Regression cases for the six authored-UX closures (server side): the gate that every model document passes and the
// precompute allowlist. The contract side lives in packages/contracts/src/document-v2-closures.test.ts.

afterEach(() => vi.restoreAllMocks())

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
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

describe('the gate accepts the complete deterministic composition of every new closure', () => {
    it.each([
        ['reading with the cancellation witness', 'reading', { reading: { cancellation: 'confirm-before-stop' } }],
        ['reading without it', 'reading', {}],
        ['every busy activity (second opinion)', 'result', { busy: { activity: 'second-opinion' } }],
        ['question waiting', 'answer', { busy: { activity: 'question-waiting' } }],
        ['more with language and settings', 'more', {}],
        ['pages with the privacy line', 'pages', {}],
        ['quick check with header More', 'quick-check', {}],
        ['completion with header More', 'completion', {}],
    ] as [string, ScreenKindV2, Partial<ScreenUiStateV2>][])('%s', (_name, kind, patch) => {
        expect(issuesOf(contextOf(kind, patch))).toEqual([])
    })
})

describe('1 reading confirmation labels belong to the confirming variant only', () => {
    const witness = { reading: { cancellation: 'confirm-before-stop' } } as const

    it('accepts Keep/Stop in confirming and rejects them anywhere else or on another intent', () => {
        const context = contextOf('reading', witness)
        const proposal = buildFallbackProposalV2(context.material)
        expect(proposal.states.confirming?.bar.primary.label).toBe(CONFIRM_LABELS_V2.keep)
        const swapped: ScreenProposalV2 = {
            ...proposal,
            states: {
                ...proposal.states,
                confirming: {
                    ...proposal.states.confirming!,
                    bar: {
                        primary: { ...proposal.states.confirming!.bar.primary, label: CONFIRM_LABELS_V2.stop },
                        secondary: proposal.states.confirming!.bar.secondary,
                    },
                },
            },
        }
        expect(issuesOf(context, swapped).join()).toContain('label_not_listed')
        const ready: ScreenProposalV2 = {
            ...proposal,
            bar: { ...proposal.bar, secondary: { ...proposal.states.confirming!.bar.secondary! } },
        }
        expect(issuesOf(context, ready).length).toBeGreaterThan(0)
    })

    it('rejects Keep without the witness', () => {
        const context = contextOf('reading')
        const proposal = buildFallbackProposalV2(context.material)
        const forged: ScreenProposalV2 = {
            ...proposal,
            bar: {
                ...proposal.bar,
                secondary: {
                    type: 'SecondaryAction',
                    label: CONFIRM_LABELS_V2.keep,
                    icon: null,
                    intent: { intent: 'navigate', target: 'reading' },
                },
            },
        }
        expect(issuesOf(context, forged).join()).toContain('intent_not_allowed')
    })

    it('shows the model the confirming variant as required', () => {
        const dynamic = contextOf('reading', witness).view.dynamic as { document: { requiredStates: string[] } }
        expect(dynamic.document.requiredStates).toContain('confirming')
        const none = contextOf('reading').view.dynamic as { document: { requiredStates: string[] } }
        expect(none.document.requiredStates).not.toContain('confirming')
    })
})

describe('3 bound text is available only where the app can resolve it', () => {
    const withBound = (context: ReturnType<typeof buildDocumentContext>, key: string): string[] => {
        const proposal = buildFallbackProposalV2(context.material)
        const body = proposal.body
        const added: ScreenProposalV2 = {
            ...proposal,
            body: {
                type: 'Stack',
                gap: 'md',
                align: 'stretch',
                children: [
                    body,
                    {
                        type: 'Text',
                        content: { kind: 'bound', key: key as 'privacy-read' },
                        role: 'body',
                        emphasis: 'normal',
                        tone: 'neutral',
                        align: 'start',
                    },
                ],
            },
        }
        return issuesOf(context, added)
    }

    it('rejects privacy, storage and help keys outside their screens', () => {
        expect(withBound(contextOf('guide'), 'privacy-camera').join()).toContain('bound_unavailable')
        expect(withBound(contextOf('guide'), 'help-scan').join()).toContain('bound_unavailable')
        expect(withBound(contextOf('home'), 'privacy-stay').join()).toContain('bound_unavailable')
        expect(withBound(contextOf('more', { settings: null }), 'storage-summary').join()).toContain(
            'bound_unavailable',
        )
        expect(withBound(contextOf('more', { sections: ['settings'] }), 'help-ask').join()).toContain(
            'bound_unavailable',
        )
    })

    it('accepts them where the app resolves them', () => {
        expect(withBound(contextOf('guide'), 'privacy-check')).toEqual([])
        expect(withBound(contextOf('pages'), 'privacy-stay')).toEqual([])
        expect(withBound(contextOf('more'), 'storage-note')).toEqual([])
    })

    it('refuses the language Choice on More when the app offers no language', () => {
        const context = contextOf('more', { language: null })
        // The fallback builder omits it; a model that adds it anyway is rejected.
        const proposal = buildFallbackProposalV2(context.material)
        const choice = {
            type: 'Choice' as const,
            prompt: null,
            options: { mode: 'bound' as const, binding: 'language' as const },
        }
        const forged: ScreenProposalV2 = {
            ...proposal,
            body: { type: 'Stack', gap: 'md', align: 'stretch', children: [proposal.body, choice] },
        }
        expect(issuesOf(context, forged).join()).toContain('binding_unavailable')
    })
})

describe('4 a pending result never wears the verdict', () => {
    it('rejects a claim title in a state variant and a pending variant without the photo', () => {
        const context = contextOf('result')
        const proposal = buildFallbackProposalV2(context.material)
        const pending = proposal.states.pending!
        const claim: ScreenProposalV2 = {
            ...proposal,
            states: {
                ...proposal.states,
                pending: {
                    ...pending,
                    header: { ...pending.header, title: { kind: 'literal', text: 'Not quite right' } },
                },
            },
        }
        expect(issuesOf(context, claim).length).toBeGreaterThan(0)
    })
})

describe('6 the model sees a stable descriptive manual title', () => {
    it('replaces Untitled by the manual-derived description in the grounded view', () => {
        const session = demoSession()
        session.title = 'Untitled manual'
        const context = buildDocumentContext(documentInputs('guide', session, ui()))
        const stable = context.view.stable as { manual: { title: string } }
        expect(stable.manual.title).toBe(manualDisplayTitleV2(session))
        expect(stable.manual.title).not.toMatch(/untitled/iu)
    })
})

describe('5 precompute requestedKinds and the generative-UI mode', () => {
    const work: BackgroundWork = {
        run: (_options, job) => job(),
        repair: (job) => job(),
        tryAcquire: () => () => {},
        acquire: async () => () => {},
    }
    const policyFor = (env: Record<string, string> = {}): DocumentServiceOptions['policy'] =>
        aiPolicyFromEnvironment(env, {
            checkTimeoutMs: 8_000,
            parseModel: 'muse-spark-1.3',
            verdictModel: 'muse-spark-1.3',
            secondOpinionModel: 'muse-wonder-1.0',
        })
    function serviceFor(env: Record<string, string>): {
        service: ReturnType<typeof createDocumentService>
        kinds: string[]
    } {
        const generator = createDocumentFixtureGenerator()
        const kinds: string[] = []
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: async (request, signal) => {
                kinds.push(request.kind)
                return generator(request, signal)
            },
            policy: policyFor(env),
            runtimeMode: 'fixture',
            work,
        })
        return { service, kinds }
    }
    const raw = (): ReturnType<typeof demoSession> => {
        const session = demoSession()
        session.reviewStatus = 'unreviewed'
        session.rawExtraction = { parts: session.parts, steps: session.reviewedSteps, unknowns: [] }
        return session
    }
    const request = (session = raw(), requestedKinds?: PrecomputeRequest['requestedKinds']): PrecomputeRequest => ({
        session,
        focusKey: null,
        uiState: fullUi,
        completedStepIds: undefined,
        ...(requestedKinds === undefined ? {} : { requestedKinds }),
    })

    it('prepares only the requested kinds (default: all)', () => {
        const session = demoSession()
        expect(precomputeItems(request(session)).map((item) => item.kind)).toEqual([
            'reading',
            'guide',
            'guide',
            'completion',
            'judge',
            'compare',
            'home',
        ])
        expect(precomputeItems(request(session, ['guide'])).map((item) => item.key)).toEqual([
            'guide:step-1',
            'guide:step-2',
        ])
        expect(precomputeItems(request(session, ['home', 'completion'])).map((item) => item.key)).toEqual([
            'completion',
            'home',
        ])
        expect(precomputeItems(request(raw(), ['guide'])).map((item) => item.key)).toEqual([
            'guide:step-1',
            'guide:step-2',
        ])
    })

    it('full mode honors the allowlist; progress lists exactly the prepared keys', async () => {
        const { service, kinds } = serviceFor({ GENERATIVE_UI: 'full' })
        const progress = service.precompute(request(raw(), ['guide']))
        expect(progress.items.map((item) => item.key)).toEqual(['guide:step-1', 'guide:step-2'])
        await vi.waitFor(() => expect(kinds.length).toBe(2), { timeout: 4_000 })
        expect(new Set(kinds)).toEqual(new Set(['guide']))
    })

    it('steps mode prepares guides only whatever was requested; off prepares nothing', async () => {
        const steps = serviceFor({ GENERATIVE_UI: 'steps' })
        expect(steps.service.precompute(request(demoSession())).items.map((item) => item.key)).toEqual([
            'guide:step-1',
            'guide:step-2',
        ])
        const asked = serviceFor({ GENERATIVE_UI: 'steps' })
        expect(asked.service.precompute(request(demoSession(), ['reading', 'home'])).items).toEqual([])
        const off = serviceFor({ GENERATIVE_UI: 'off' })
        expect(off.service.precompute(request(demoSession(), ['guide'])).items).toEqual([])
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(off.kinds).toEqual([])
        expect(asked.kinds).toEqual([])
    })

    it('a different allowlist is a different job (never reuses another list)', () => {
        const { service } = serviceFor({ GENERATIVE_UI: 'full' })
        const session = demoSession()
        const all = service.precompute(request(session))
        const guides = service.precompute(request(session, ['guide']))
        expect(all.contextKey).not.toBe(guides.contextKey)
    })
})

describe('POST /api/screens/v2 requestedKinds', () => {
    const KEY = 'synthetic-local-test-value'
    function app(env: Record<string, string> = {}): ReturnType<typeof createApp> {
        vi.spyOn(console, 'info').mockImplementation((): void => {})
        const runtime = createRuntimeFromEnvironment({ PROVIDER_MODE: 'fixture', API_SHARED_SECRET: KEY, ...env })
        return createApp({ runtime, onDuration: () => {} })
    }
    const post = (instance: ReturnType<typeof createApp>, metadata: unknown): Promise<Response> => {
        const body = new FormData()
        body.set('metadata', JSON.stringify(metadata))
        return Promise.resolve(
            instance.request('/api/screens/v2', { method: 'POST', headers: { 'x-truebuild-key': KEY }, body }),
        )
    }
    const precompute = (extra: Record<string, unknown>): Record<string, unknown> => {
        const session = demoSession()
        session.reviewStatus = 'unreviewed'
        session.reviewedSteps = []
        const base = screensV2GenerateRequest(
            'job-raw',
            { ...documentInputs('home'), session, kind: 'home' },
            sha256Hex,
        )
        return {
            ...base,
            op: 'precompute',
            kind: null,
            stepId: null,
            captureId: null,
            contextKey: null,
            focusKey: null,
            uiState: fullUi,
            ...extra,
        }
    }

    it('prepares only the raw guides of an unreviewed manual when asked', async () => {
        const instance = app()
        const body = await (await post(instance, precompute({ requestedKinds: ['guide'] }))).json()
        expect(body, JSON.stringify(body)).toMatchObject({ status: 'ok' })
        expect(body.value.progress.items.map((item: { key: string }) => item.key)).toEqual([
            'guide:step-1',
            'guide:step-2',
        ])
        expect(modelScreensV2MetadataSchema.safeParse(precompute({ requestedKinds: ['guide'] })).success).toBe(true)
    })

    it('refuses an unknown or empty allowlist before any work', async () => {
        const instance = app()
        expect((await post(instance, precompute({ requestedKinds: ['more'] }))).status).toBe(400)
        expect((await post(instance, precompute({ requestedKinds: [] }))).status).toBe(400)
    })
})
