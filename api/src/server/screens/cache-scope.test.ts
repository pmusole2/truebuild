import { createDemoManual, SCREEN_KINDS, type ManualSession, type ScreenKind } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { createScreenFixtureGenerator } from '../../providers/screen-fixtures'
import { aiPolicyFromEnvironment } from '../ai-policy'
import type { ScreenInputs } from './context'
import { createScreenService, type BackgroundWork, type ScreenFixtureGenerator } from './service'

// Model output is cached by the complete content a screen was grounded in and re-grounded for every requester. The
// composition source is the explicit synthetic fixture generator: no provider, key, network or recorded model output.
const work: BackgroundWork = {
    run: (_options, fn) => fn(),
    repair: (fn) => fn(),
    tryAcquire: () => () => {},
    acquire: async () => () => {},
}

function counted(): { generator: ScreenFixtureGenerator; calls: () => number } {
    const inner = createScreenFixtureGenerator()
    let calls = 0
    return {
        generator: (request, signal): Promise<unknown> => {
            calls += 1
            return inner(request, signal)
        },
        calls: () => calls,
    }
}

function serviceWith(generator: ScreenFixtureGenerator): ReturnType<typeof createScreenService> {
    return createScreenService({
        provider: null,
        fixtureGenerator: generator,
        policy: aiPolicyFromEnvironment(
            {},
            {
                checkTimeoutMs: 8_000,
                parseModel: 'muse-spark-1.3',
                verdictModel: 'muse-spark-1.3',
                secondOpinionModel: 'muse-wonder-1.0',
            },
        ),
        runtimeMode: 'fixture',
        work,
    })
}

const STEP_KINDS: ScreenKind[] = ['guide', 'result', 'questions', 'answer', 'recovery']

function inputsFor(kind: ScreenKind, manual: ManualSession, overrides: Partial<ScreenInputs> = {}): ScreenInputs {
    const needsStep = STEP_KINDS.includes(kind)
    const refs = [{ pageId: 'demo-page-1', region: null }]
    return {
        kind,
        session: ['home', 'add', 'pages', 'more', 'error'].includes(kind) ? null : manual,
        stepId: needsStep ? 'step-1' : null,
        captureId: kind === 'result' || kind === 'answer' ? 'capture-1' : null,
        result:
            kind === 'result'
                ? {
                      kind: 'check',
                      value: {
                          decision: 'refuse',
                          reason: 'The groove faces the wrong way.',
                          sourceRefs: refs,
                          observedRegion: null,
                          missingEvidence: [],
                      },
                  }
                : kind === 'answer'
                  ? {
                        kind: 'question',
                        question: 'Which way?',
                        value: { answer: 'Follow the cited diagram.', sourceRefs: refs, missingEvidence: [] },
                    }
                  : null,
        failure: kind === 'error' ? 'timeout' : null,
        uiState: {
            library: {
                entries: [
                    {
                        manualId: manual.manualId,
                        title: manual.title,
                        updatedAt: '2026-01-01T00:00:00.000Z',
                        stopStepId: null,
                        completed: 0,
                        total: 2,
                        firstPageId: 'demo-page-1',
                    },
                ],
                soleManualId: manual.manualId,
            },
            pages: {
                items: [{ pageId: 'demo-page-1', width: 1200, height: 900 }],
                maxPages: 20,
                canRead: true,
                languageOptions: [],
            },
            review: null,
            capture: { captureId: 'capture-1', reusable: true, target: null, questionDraftPresent: false },
            sections: ['settings', 'about-this-check'],
        },
        ...overrides,
    }
}

describe('screen output reuse across kinds', (): void => {
    it.each(SCREEN_KINDS)(
        'serves a repeated %s request from the cache without another composition',
        async (kind): Promise<void> => {
            const { generator, calls } = counted()
            const service = serviceWith(generator)
            const manual = createDemoManual()
            const first = await service.generate(inputsFor(kind, manual))
            const before = calls()
            const again = await service.generate(inputsFor(kind, manual))
            // Every kind composes from the fixture, so every kind is cached: the second request is identical in identity
            // and is flagged as served from the cache rather than recomposed.
            expect(first.metadata.source).toBe('generated')
            expect(calls()).toBe(before)
            expect(again.bound).toEqual(first.bound)
            expect(again.metadata.cacheHit).toBe(true)
        },
    )

    it('reuses a composition for another session of identical content, bound to that session and nothing else', async (): Promise<void> => {
        const { generator, calls } = counted()
        const service = serviceWith(generator)
        const first = createDemoManual()
        const second = createDemoManual()
        second.manualId = 'another-session-same-content'
        const a = await service.generate(inputsFor('guide', first))
        const b = await service.generate(inputsFor('guide', second))
        expect(a.metadata.source).toBe('generated')
        expect(calls()).toBe(1)
        expect(b.metadata.cacheHit).toBe(true)
        expect(b.bound.manualId).toBe('another-session-same-content')
        expect(b.bound.contextKey).not.toBe(a.bound.contextKey)
        expect(b.screenId).not.toBe(a.screenId)
        expect(JSON.stringify(b)).not.toContain(first.manualId)
    })

    it('recomposes when anything the screen is grounded in changes, and only then', async (): Promise<void> => {
        const { generator, calls } = counted()
        const service = serviceWith(generator)
        const manual = createDemoManual()
        await service.generate(inputsFor('guide', manual))
        expect(calls()).toBe(1)
        // Another step's facts are not this screen's context: the first step's page is still valid for it.
        const laterEdit = structuredClone(manual)
        laterEdit.reviewedSteps[1]!.title = 'A completely different later step'
        const reused = await service.generate(inputsFor('guide', laterEdit))
        expect(calls()).toBe(1)
        expect(reused.metadata.cacheHit).toBe(true)
        expect(JSON.stringify(reused)).not.toContain('completely different later step')
        // Its own facts are: a changed value is never served another value's composition.
        const ownEdit = structuredClone(manual)
        ownEdit.reviewedSteps[0]!.orientation = {
            state: 'known',
            value: { partId: 'side-panel', description: 'Groove faces outward away from the divider.' },
            sourceRefs: [{ pageId: 'demo-page-1', region: null }],
        }
        const changed = await service.generate(inputsFor('guide', ownEdit))
        expect(calls()).toBe(2)
        expect(changed.metadata.cacheHit).toBe(false)
        // A different captured photo is a different result context.
        await service.generate(inputsFor('result', manual))
        const result = calls()
        await service.generate(inputsFor('result', manual, { captureId: 'capture-2' }))
        expect(calls()).toBe(result + 1)
        // A different step of the same manual is a different screen.
        await service.generate({ ...inputsFor('guide', manual), stepId: 'step-2' })
        expect(calls()).toBe(result + 2)
    })

    it('re-grounds a reviewed composition for an unreviewed session so it never gains a build action', async (): Promise<void> => {
        const { generator, calls } = counted()
        const service = serviceWith(generator)
        const reviewed = createDemoManual()
        const unreviewed = structuredClone(reviewed)
        unreviewed.manualId = 'fresh-parse'
        unreviewed.reviewStatus = 'unreviewed'
        // The raw extraction reads exactly what the reviewed steps say, so the content is identical.
        unreviewed.rawExtraction = {
            parts: reviewed.parts,
            steps: structuredClone(reviewed.reviewedSteps),
            unknowns: [],
        }
        const built = await service.generate(inputsFor('guide', reviewed))
        expect(built.bar.primary.intent).toMatchObject({ intent: 'capture' })
        const prepared = await service.generate(inputsFor('guide', unreviewed))
        if (calls() === 1) expect(prepared.metadata.cacheHit).toBe(true)
        // Unreviewed facts never open a camera or a check, whatever the cached composition asked for.
        expect(prepared.bar.primary.intent).toEqual({ intent: 'navigate', target: 'quick-check' })
        expect(prepared.bar.secondary).toBeNull()
    })
})
