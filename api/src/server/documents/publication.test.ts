import { describe, expect, it, vi } from 'vitest'
import { createDocumentFixtureGenerator } from '../../providers/document-fixtures'
import { demoSession, documentInputs, fullUi } from '../../test-support/document-inputs'
import { aiPolicyFromEnvironment } from '../ai-policy'
import type { BackgroundWork } from '../screens/service'
import { createDocumentService } from './service'

const work: BackgroundWork = {
    run: (_options, job) => job(),
    repair: (job) => job(),
    tryAcquire: () => () => {},
    acquire: async () => () => {},
}
const policy = aiPolicyFromEnvironment(
    {},
    {
        checkTimeoutMs: 8_000,
        parseModel: 'muse-spark-1.3',
        verdictModel: 'muse-spark-1.3',
        secondOpinionModel: 'muse-wonder-1.0',
    },
)

describe('document publication custody', () => {
    it('does not turn a missing live provider into synthetic evidence or run an injected fixture', async () => {
        const fixture = vi.fn(createDocumentFixtureGenerator())
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: fixture,
            runtimeMode: 'meta',
            policy,
            work,
        })
        const document = await service.generate(documentInputs('home'))
        expect(document.metadata).toMatchObject({
            source: 'fallback',
            evidence: 'live',
            fallbackReason: 'unconfigured',
            model: null,
            effort: null,
        })
        expect(document.metadata.timing.totalMs).toBeNull()
        expect(fixture).not.toHaveBeenCalled()
    })

    it('an older same-revision group cannot read or cancel the replacement group', () => {
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: createDocumentFixtureGenerator(),
            runtimeMode: 'fixture',
            policy,
            work,
        })
        const session = demoSession()
        const common = { session, uiState: fullUi, focusKey: null, completedStepIds: undefined }
        const previous = service.precompute(common)
        const current = service.precompute({ ...common, requestedKinds: ['guide'] })
        expect(current.contextKey).not.toBe(previous.contextKey)
        expect(service.progress(session.manualId, session.revision, ['guide:step-1'], previous.contextKey)).toEqual({
            progress: null,
            documents: [],
        })
        expect(service.cancel(session.manualId, session.revision, previous.contextKey)).toBeNull()
        const untouched = service.progress(session.manualId, session.revision, [], current.contextKey).progress
        expect(untouched?.contextKey).toBe(current.contextKey)
        expect(untouched?.items.some((item) => item.state === 'cancelled')).toBe(false)
        expect(
            service
                .cancel(session.manualId, session.revision, current.contextKey)
                ?.items.some((item) => item.state === 'cancelled'),
        ).toBe(true)
    })
})
