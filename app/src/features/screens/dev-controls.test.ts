import type { ScreensResult } from '@truebuild/contracts'
import { describe, expect, it, vi } from 'vitest'
import { parseDevScenario, withDevScenario } from './dev-controls'
import type { ScreenClient } from './screen-store'

const ok: ScreensResult = {
    status: 'ok',
    requestId: 'r',
    mode: 'fixture',
    value: { document: null, progress: null, documents: [] },
}
const generate = (kind: 'home' | 'guide'): never =>
    ({ op: 'generate', kind, session: null, stepId: null, captureId: null, result: null, failure: null }) as never

describe('development scenario controls', () => {
    it('is absent unless asked for, and ignores anything malformed', () => {
        expect(parseDevScenario(undefined, undefined)).toBeNull()
        expect(parseDevScenario('abc', 'nonsense, ,')).toBeNull()
        expect(parseDevScenario('-5', '')).toBeNull()
        expect(parseDevScenario('999999', undefined)).toBeNull()
    })

    it('reads a delay and a list of kinds, or all', () => {
        expect(parseDevScenario('12000', undefined)).toEqual({ delayMs: 12000, failKinds: new Set() })
        expect(parseDevScenario(undefined, 'guide, result')?.failKinds).toEqual(new Set(['guide', 'result']))
        expect(parseDevScenario(undefined, 'all')?.failKinds.size).toBe(13)
    })

    it('returns the same client when there is no scenario', () => {
        const client: ScreenClient = { screens: vi.fn(async () => ok) }
        expect(withDevScenario(client, null)).toBe(client)
    })

    it('fails only the listed generate calls and passes everything else through untouched', async () => {
        const inner = vi.fn(async () => ok)
        const wrapped = withDevScenario({ screens: inner }, parseDevScenario(undefined, 'guide'))
        expect(await wrapped.screens(generate('guide'), { requestId: 'r' })).toMatchObject({ status: 'unavailable' })
        expect(inner).not.toHaveBeenCalled()
        expect(await wrapped.screens(generate('home'), { requestId: 'r' })).toMatchObject({ status: 'ok' })
        expect(
            await wrapped.screens(
                { op: 'cancel', binding: { kind: 'manual', manualId: 'm', revision: 1 } },
                { requestId: 'r' },
            ),
        ).toMatchObject({ status: 'ok' })
        expect(inner).toHaveBeenCalledTimes(2)
    })

    it('holds a generate call for the delay and stops holding when the caller gives up', async () => {
        vi.useFakeTimers()
        const inner = vi.fn(async () => ok)
        const wrapped = withDevScenario({ screens: inner }, parseDevScenario('5000', undefined))
        const controller = new AbortController()
        const pending = wrapped.screens(generate('home'), { requestId: 'r', signal: controller.signal })
        await vi.advanceTimersByTimeAsync(4_999)
        expect(inner).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(2)
        await pending
        expect(inner).toHaveBeenCalledTimes(1)
        const second = wrapped.screens(generate('home'), { requestId: 'r', signal: controller.signal })
        controller.abort()
        await second
        vi.useRealTimers()
    })
})
