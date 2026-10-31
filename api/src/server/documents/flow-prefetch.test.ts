import { describe, expect, it, vi } from 'vitest'
import {
    buildFallbackProposalV2,
    createDemoManual,
    type ManualSession,
    type ScreenContextInputsV2,
} from '@truebuild/contracts'
import { encodeWireProposal } from '../../providers/document-wire'
import { aiPolicyFromEnvironment } from '../ai-policy'
import { createDocumentService } from './service'
import { inputsFromDocumentMetadata } from '../../../../app/src/api/document-client'
import type { ModelApiClient } from '../../../../app/src/api/model-client'
import { reviewedSession } from '../../../../app/src/features/capture/reviewed-session'
import { DocumentStore } from '../../../../app/src/features/document-runtime/store'

describe('parse-time destination preparation', () => {
    it('reuses privately prepared Confirm Guides without another generation and invalidates edited facts', async () => {
        const demo = createDemoManual()
        const raw: ManualSession = {
            ...demo,
            reviewStatus: 'unreviewed',
            reviewedSteps: demo.rawExtraction!.steps,
        }
        const confirmed = reviewedSession(raw)!
        const generated: string[] = []
        const service = createDocumentService({
            provider: null,
            runtimeMode: 'fixture',
            fixtureGenerator: async ({ kind, stepId, context }) => {
                generated.push(`${kind}:${stepId ?? ''}`)
                return encodeWireProposal(buildFallbackProposalV2(context.material))
            },
            policy: aiPolicyFromEnvironment(
                {},
                {
                    checkTimeoutMs: 8_000,
                    parseModel: 'muse-spark-1.3',
                    verdictModel: 'muse-spark-1.3',
                    secondOpinionModel: 'muse-wonder-1.0',
                },
            ),
            work: {
                run: (_options, job) => job(),
                repair: (job) => job(),
                tryAcquire: () => (): void => {},
                acquire: async () => (): void => {},
            },
        })
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) => {
            expect(metadata.op).toBe('generate')
            return {
                status: 'ok',
                requestId: metadata.requestId,
                mode: 'fixture',
                value: {
                    document: await service.generate(inputsFromDocumentMetadata(metadata)),
                    documents: [],
                    progress: null,
                },
            }
        })
        const guide: ScreenContextInputsV2 = {
            kind: 'guide',
            session: confirmed,
            stepId: 'step-1',
            captureId: null,
            result: null,
            failure: null,
        }
        const quick: ScreenContextInputsV2 = {
            ...guide,
            kind: 'quick-check',
            session: raw,
            stepId: null,
            uiState: { review: { currentQuestion: null, blockers: 0, canConfirm: true } },
        }
        let id = 0
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => String(id++),
            warmupConcurrency: 4,
        })
        try {
            store.prepareFlow(raw, 'guide:step-1', quick)
            await vi.waitFor(() => expect(store.peek(guide)?.status).toBe('ready'))
            await vi.waitFor(() => expect(generated).toHaveLength(4))
            expect(generated).toEqual(['quick-check:', 'guide:step-1', 'camera:step-1', 'guide:step-2'])
            const prepared = store.peek(guide)!.document
            expect(store.peek({ ...guide, session: raw })).toBeUndefined()
            store.noteShown(prepared, true, guide)
            expect(store.shownGuide(raw, 'step-1')).toBeNull()
            expect(store.shownGuide(confirmed, 'step-1')).toBeNull()

            store.observeSession(confirmed)
            store.prepareFlow(confirmed, 'guide:step-1')
            expect(store.request(guide).document).toBe(prepared)
            store.noteShown(prepared, true)
            expect(store.shownGuide(confirmed, 'step-1')?.screenId).toBe(prepared.screenId)
            expect(
                service.resolveStepScreen(confirmed, 'step-1', store.shownGuide(confirmed, 'step-1')!),
            ).toMatchObject({
                screenId: prepared.screenId,
            })
            expect(generated.filter((key) => key === 'guide:step-1')).toHaveLength(1)
            const busy = { ...guide, uiState: { busy: { activity: 'checking' as const } } }
            const activityPage = await service.generate(busy)
            expect(activityPage.metadata.cacheHit).toBe(true)
            expect(activityPage.bound.contextKey).not.toBe(prepared.bound.contextKey)
            expect(JSON.stringify(activityPage.states.busy)).toContain('Checking')
            expect(generated.filter((key) => key === 'guide:step-1')).toHaveLength(1)

            const editedRaw: ManualSession = {
                ...raw,
                reviewedSteps: raw.reviewedSteps.map((step) =>
                    step.stepId === 'step-1' ? { ...step, title: 'Changed direction from the manual' } : step,
                ),
            }
            store.observeSession(editedRaw)
            expect(store.peek(guide)).toBeUndefined()
            const edited = reviewedSession(editedRaw)!
            store.observeSession(edited)
            const changed = { ...guide, session: edited }
            expect(store.request(changed).status).toBe('pending')
            await vi.waitFor(() => expect(store.peek(changed)?.status).toBe('ready'))
            expect(generated.filter((key) => key === 'guide:step-1')).toHaveLength(2)
            store.invalidateManual(edited.manualId, edited.revision + 1)
            expect(store.request(changed).issue).toBe('stale')
        } finally {
            store.dispose()
        }
    })
})
