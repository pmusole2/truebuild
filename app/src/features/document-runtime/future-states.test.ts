import { describe, expect, it, vi } from 'vitest'
import { createDemoManual, type ScreenContextInputsV2 } from '@truebuild/contracts'
import type { ModelApiClient } from '../../api/model-client'
import { documentUnavailable } from '../../api/document-client'
import { DocumentStore } from './store'
import { futureDocumentStates } from './future-states'

const inputs: ScreenContextInputsV2 = {
    kind: 'guide',
    session: createDemoManual(),
    stepId: 'step-1',
    captureId: null,
    result: null,
    failure: null,
}
describe('preparing generated busy states', () => {
    it('prepares known guide activities without inventing another manual, fact, result or photo', () => {
        const states = futureDocumentStates(inputs)
        expect(states.map((item) => item.uiState?.busy?.activity)).toEqual(['checking', 'second-opinion'])
        for (const state of states) {
            expect(state.session).toBe(inputs.session)
            expect(state.stepId).toBe(inputs.stepId)
            expect(state.captureId).toBeNull()
            expect(state.result).toBeNull()
        }
        expect(futureDocumentStates(states[0]!)).toEqual([])
        expect(futureDocumentStates({ ...inputs, kind: 'completion' })).toEqual([])
    })
    it('starts every step activity at parse-time precompute, with off mode making no dispatch', async () => {
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) =>
            documentUnavailable(metadata.requestId, 'unconfigured'),
        )
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'future' })
        try {
            store.precompute(inputs.session!, null)
            await vi.waitFor(() =>
                expect(
                    screensV2.mock.calls.filter(([metadata]) => metadata.op === 'generate' && metadata.kind === 'guide')
                        .length,
                ).toBe(inputs.session!.reviewedSteps.length * 2),
            )
            const requests = screensV2.mock.calls.flatMap(([metadata]) =>
                metadata.op === 'generate' ? [metadata] : [],
            )
            expect(requests.every((request) => request.captureId === null && request.result === null)).toBe(true)
            expect(new Set(requests.map((request) => request.stepId)).size).toBe(inputs.session!.reviewedSteps.length)
            const offClient = vi.fn<ModelApiClient['screensV2']>()
            const off = new DocumentStore({ client: { screensV2: offClient }, mode: 'off', id: (): string => 'off' })
            off.precompute(inputs.session!, null)
            expect(offClient).not.toHaveBeenCalled()
            off.dispose()
        } finally {
            store.dispose()
        }
    })
})
