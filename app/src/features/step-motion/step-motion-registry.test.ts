import { describe, expect, it, vi } from 'vitest'
import { createDemoManual, STEP_MOTION_PROMPT_VERSION } from '@truebuild/contracts'
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
    it('uses the raw parse text verbatim and its own cited page; language and prompt version separate cache entries', () => {
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
