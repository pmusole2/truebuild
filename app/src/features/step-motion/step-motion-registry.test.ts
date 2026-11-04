import { describe, expect, it, vi } from 'vitest'
import { createDemoManual, paddedStepFigureBox, STEP_MOTION_PROMPT_VERSION } from '@truebuild/contracts'
import { motionRequestForStep, StepMotionRegistry, stepMotionCacheKey } from './step-motion-registry'
import type { KeyValueStorage } from '../capture/library'
import { RECORDED_STEP_MOTION_SCENES } from './__fixtures__/recorded-scenes'

function storage(): KeyValueStorage {
    const values = new Map<string, string>()
    return {
        getItem: async (key): Promise<string | null> => values.get(key) ?? null,
        setItem: async (key, value): Promise<void> => {
            values.set(key, value)
        },
        removeItem: async (key): Promise<void> => {
            values.delete(key)
        },
        getAllKeys: async (): Promise<string[]> => [...values.keys()],
    }
}

describe('step motion device registry', () => {
    it('reads the printed step text verbatim, ahead of review actions and the title, with orientation and connection as context', () => {
        const session = createDemoManual()
        const step = session.rawExtraction!.steps[0]!
        step.sourceText = '  Insert the bolt — 2× into the slot.\n'
        step.title = 'Insert the bolt'
        session.reviewedSteps[0]!.title = 'A rewritten direction'
        Reflect.set(session.reviewedSteps[0]!, 'actions', ['A rewritten action'])
        const request = motionRequestForStep(session, step.stepId, 'request-1')!
        expect(request.instructionText).toBe(step.sourceText)
        expect(request.actions).toEqual(['A rewritten action'])
        expect(request.orientation).toBe('Groove faces inward toward the divider.')
        expect(request.connection).toBe('Keep the panel free before seating the divider.')
    })

    it('falls back to review actions, reading both plain strings and action objects, when no printed text is kept', () => {
        const session = createDemoManual()
        const step = session.rawExtraction!.steps[0]!
        step.title = 'Stand the side panel upright'
        Reflect.set(session.reviewedSteps[0]!, 'actions', [
            'Turn the panel.',
            { actionId: 'press', instruction: 'Press it firmly.', sourceRefs: step.sourceRefs },
        ])
        const request = motionRequestForStep(session, step.stepId, 'request-1')!
        expect(request.instructionText).toBe('Turn the panel.\nPress it firmly.')
        expect(request.actions).toEqual(['Turn the panel.', 'Press it firmly.'])

        // A reviewed entry without actions keeps the raw step's own actions rather than dropping them.
        Reflect.deleteProperty(session.reviewedSteps[0]!, 'actions')
        Reflect.set(step, 'actions', [{ actionId: 'raw', instruction: 'Raw action.', sourceRefs: step.sourceRefs }])
        expect(motionRequestForStep(session, step.stepId, 'request-2')!.actions).toEqual(['Raw action.'])
    })

    it('falls back to the raw title, its own cited page, and language and prompt version separate cache entries', () => {
        const session = createDemoManual()
        const step = session.rawExtraction!.steps[0]!
        step.title = '  Lift the part.\nThen secure it.  '
        step.parts[0]!.quantity = { state: 'unknown', reason: 'Not printed' }
        session.reviewedSteps[0]!.title = 'A rewritten direction'
        const request = motionRequestForStep(session, step.stepId, 'request-1')!
        expect(request.instructionText).toBe(step.title)
        expect(request.sourceRefs).toEqual(step.sourceRefs)
        expect(request.page.pageId).toBe(step.sourceRefs[0]!.pageId)
        expect(request.actions).toEqual([])
        expect(request.parts[0]!.quantity).toBeNull()
        expect(request.figureBox).toBeNull()
        expect(stepMotionCacheKey(request)).not.toBe(stepMotionCacheKey({ ...request, readingLanguage: 'fr' }))
        expect(stepMotionCacheKey(request)).not.toBe(stepMotionCacheKey(request, STEP_MOTION_PROMPT_VERSION + 1))
    })

    it('crops a cited step region on its own page, padded by a tenth on each side, even after an earlier whole page', () => {
        const session = createDemoManual()
        session.pages.push({ ...session.pages[0]!, pageId: 'demo-page-2' })
        const step = session.rawExtraction!.steps[0]!
        step.sourceRefs = [{ pageId: 'demo-page-1', region: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 } }]
        const request = motionRequestForStep(session, step.stepId, 'request-1')!
        expect(request.page.pageId).toBe('demo-page-1')
        expect(request.figureBox).toEqual(paddedStepFigureBox([0.2, 0.3, 0.4, 0.2]))

        // The whole page comes first, but the region on the second page is the figure and so selects its page.
        step.sourceRefs = [
            { pageId: 'demo-page-1', region: null },
            { pageId: 'demo-page-2', region: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 } },
        ]
        const figured = motionRequestForStep(session, step.stepId, 'request-2')!
        expect(figured.page.pageId).toBe('demo-page-2')
        expect(figured.figureBox).toEqual(paddedStepFigureBox([0.2, 0.3, 0.4, 0.2]))
    })

    it('sends no crop for a whole-page citation, even when its page holds a piece figure', () => {
        const session = createDemoManual()
        session.pages.push({ ...session.pages[0]!, pageId: 'demo-page-2' })
        const figure = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }
        // Another step's cited region on the same page is not this step's crop: a whole-page citation stays whole.
        session.reviewedSteps[1]!.sourceRefs = [{ pageId: 'demo-page-1', region: figure }]
        const request = motionRequestForStep(session, 'step-1', 'request-1')!
        expect(request.page.pageId).toBe('demo-page-1')
        expect(request.figureBox).toBeNull()
    })

    it('skips a step whose cited page is not among the known pages, rather than sending a whole page it cannot verify', () => {
        const session = createDemoManual()
        const cited = session.rawExtraction!.steps[0]!.sourceRefs[0]!.pageId
        session.pages = session.pages.filter((page) => page.pageId !== cited)
        expect(motionRequestForStep(session, 'step-1', 'request-1')).toBeNull()
    })

    it('copies the manual page raw hash into the request, so the cache identity names the bytes it claims', () => {
        const session = createDemoManual()
        const request = motionRequestForStep(session, 'step-1', 'request-1')!
        expect(request.page.contentHash).toBe(session.pages[0]!.contentHash)
        const reuploaded = { ...session, pages: [{ ...session.pages[0]!, contentHash: 'c'.repeat(64) }] }
        const changed = motionRequestForStep(reuploaded, 'step-1', 'request-1')!
        expect(changed.page.contentHash).toBe('c'.repeat(64))
        expect(stepMotionCacheKey(changed)).not.toBe(stepMotionCacheKey(request))
        expect(stepMotionCacheKey({ ...request, requestId: 'other', cacheOnly: true })).toBe(
            stepMotionCacheKey(request),
        )
    })

    it('keys both caches by scene content, preserving only request and lookup identity', async () => {
        const request = motionRequestForStep(createDemoManual(), 'step-1', 'original')!
        const generate = vi.fn(async () => ({ scene: null }))
        const registry = new StepMotionRegistry(storage(), generate)
        await registry.load(request, {})
        await registry.load({ ...request, requestId: 'revisit', cacheOnly: true }, {})
        expect(generate).toHaveBeenCalledTimes(1)
        const edits = [
            { instructionText: 'Press the part.' },
            { actions: ['Press the part.'] },
            { parts: [] },
            { orientation: null },
            { connection: null },
            {
                sourceRefs: [{ pageId: request.page.pageId, region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }],
                figureBox: paddedStepFigureBox([0.1, 0.1, 0.5, 0.5]),
            },
            { page: { ...request.page, width: request.page.width + 1 } },
        ]
        for (const edit of edits) {
            const changed = { ...request, ...edit }
            expect(stepMotionCacheKey(changed)).not.toBe(stepMotionCacheKey(request))
        }
        const changed = { ...request, ...edits[0]! }
        await registry.load(changed, {})
        expect(generate).toHaveBeenCalledTimes(2)
    })

    it('coalesces requests and persists null or unknown outcomes before sending, so revisits never resend', async () => {
        const request = motionRequestForStep(createDemoManual(), 'step-1', 'request-1')!
        const disk = storage()
        const generate = vi.fn(async () => ({ scene: null }))
        const first = new StepMotionRegistry(disk, generate)
        await Promise.all([first.load(request, {}), first.load(request, {})])
        expect(generate).toHaveBeenCalledTimes(1)
        expect(await new StepMotionRegistry(disk, generate).load(request, {})).toBeNull()
        expect(generate).toHaveBeenCalledTimes(1)

        const failed = vi.fn(async () => {
            throw new Error('network outcome unknown')
        })
        const other = { ...request, readingLanguage: 'fr' as const }
        expect(await new StepMotionRegistry(disk, failed).load(other, {})).toBeNull()
        expect(await new StepMotionRegistry(disk, failed).load(other, {})).toBeNull()
        expect(failed).toHaveBeenCalledTimes(1)
    })

    it('does not send if storage cannot establish absence or persist the dispatch marker', async () => {
        const request = motionRequestForStep(createDemoManual(), 'step-1', 'request-1')!
        const generate = vi.fn(async () => ({ scene: null }))
        const broken = {
            ...storage(),
            setItem: async (): Promise<void> => {
                throw new Error('full')
            },
        }
        expect(await new StepMotionRegistry(broken, generate).load(request, {})).toBeNull()
        expect(generate).not.toHaveBeenCalled()
    })

    it('creates no durable marker while permission is undecided, including after a restart', async () => {
        const request = motionRequestForStep(createDemoManual(), 'step-1', 'request-1')!
        const disk = storage()
        const generate = vi.fn(async () => ({ scene: null }))
        let accepted = false
        const allowed = async (): Promise<boolean> => accepted
        await new StepMotionRegistry(disk, generate, allowed).load(request, {})
        expect(await disk.getAllKeys()).toHaveLength(0)
        const restored = new StepMotionRegistry(disk, generate, allowed)
        await restored.load(request, {})
        expect(generate).not.toHaveBeenCalled()
        accepted = true
        await restored.load(request, {})
        expect(generate).toHaveBeenCalledTimes(1)
    })

    it('allows a later visit after a known pre-dispatch refusal and restores a valid cached scene', async () => {
        const request = motionRequestForStep(createDemoManual(), 'step-1', 'request-1')!
        const disk = storage()
        const generate = vi.fn(async () => ({ status: 'not_sent' as const }))
        const registry = new StepMotionRegistry(disk, generate)
        await registry.load(request, {})
        expect(await disk.getAllKeys()).toHaveLength(0)
        await registry.load(request, {})
        expect(generate).toHaveBeenCalledTimes(2)
        const scene = { ...RECORDED_STEP_MOTION_SCENES.press, stepId: request.stepId }
        const ready = vi.fn(async () => ({ scene }))
        expect(await new StepMotionRegistry(disk, ready).load(request, {})).toEqual(scene)
        const noConsent = vi.fn(async (): Promise<boolean> => false)
        expect(await new StepMotionRegistry(disk, ready, noConsent).load(request, {})).toEqual(scene)
        expect(noConsent).not.toHaveBeenCalled()
        expect(ready).toHaveBeenCalledTimes(1)
    })
})
