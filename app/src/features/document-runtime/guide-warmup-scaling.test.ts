import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as contracts from '@truebuild/contracts'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    screenDocumentV2Schema,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
} from '@truebuild/contracts'
import type { ScreensV2Result } from '@truebuild/contracts/model'
import { inputsFromDocumentMetadata } from '../../api/document-client'
import type { ModelApiClient } from '../../api/model-client'
import { sha256Hex } from '../documents/sha256'
import { DocumentStore, localDocument } from './store'

// This suite deliberately exercises the shipped offline recordings.
beforeEach(() => vi.stubEnv('EXPO_PUBLIC_RELEASE_FIXTURE', '1'))
afterEach(() => vi.unstubAllEnvs())
function fixture(inputs: ScreenContextInputsV2): ScreenDocumentV2 {
    const material = documentMaterialV2(inputs)
    return screenDocumentV2Schema.parse(
        assembleDocumentV2(
            material,
            buildFallbackProposalV2(material),
            { source: 'generated', evidence: 'synthetic-fixture', fallbackReason: null },
            { sha256Hex, now: (): Date => new Date('2026-01-01T00:00:00Z') },
        ),
    )
}
function ok(document: ScreenDocumentV2, requestId: string): ScreensV2Result {
    return { status: 'ok', requestId, mode: 'fixture', value: { document, documents: [], progress: null } }
}
function home(index: number): ScreenContextInputsV2 {
    return {
        kind: 'home',
        session: null,
        stepId: null,
        captureId: null,
        result: null,
        failure: null,
        uiState: {
            library: {
                entries: [
                    {
                        manualId: `manual-${index}`,
                        title: 'Saved manual',
                        updatedAt: '2026-01-01T00:00:00Z',
                        stopStepId: null,
                        completed: 0,
                        total: 1,
                        firstPageId: null,
                    },
                ],
                soleManualId: `manual-${index}`,
            },
        },
    }
}

describe('focused Guide warm-ups under a bounded cache', () => {
    it('avoids donor rebinding for undisplayed work and restores the genuine carried preview on foreground adoption', async () => {
        const donorInputs: ScreenContextInputsV2 = {
            kind: 'home',
            session: null,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: { library: { entries: [], soleManualId: null } },
        }
        const target: ScreenContextInputsV2 = {
            ...donorInputs,
            uiState: { ...donorInputs.uiState, busy: { activity: 'working' } },
        }
        const screensV2 = vi.fn<ModelApiClient['screensV2']>((metadata) =>
            metadata.uiState?.busy == null
                ? Promise.resolve(ok(fixture(inputsFromDocumentMetadata(metadata)), metadata.requestId))
                : new Promise(() => undefined),
        )
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'donor',
            recordings: (): null => null,
        })
        const rebind = vi.spyOn(contracts, 'rebindGeneratedStatesV2')
        try {
            store.request(donorInputs)
            await vi.waitFor(() => expect(store.peek(donorInputs)?.document.metadata.source).toBe('generated'))
            const donor = store.peek(donorInputs)!.document
            rebind.mockClear()
            store.warmup([target])
            expect(store.peek(target)).toBeDefined()
            expect(rebind).not.toHaveBeenCalled()
            expect(store.peek(target)?.document.metadata.carried ?? {}).toEqual({})
            const preview = store.preview(target)
            expect(preview.document.metadata.carried?.pending?.fromScreenId).toBe(donor.screenId)
            const adopted = store.request(target)
            expect(adopted.document.metadata.carried?.pending?.fromScreenId).toBe(donor.screenId)
            expect(adopted.document.metadata.source).toBe('fallback')
            expect(adopted.status).toBe('pending')
            expect(store.readyAt(target)).toBeNull()
            expect(rebind).toHaveBeenCalledTimes(2)
            expect(screensV2).toHaveBeenCalledTimes(2)
        } finally {
            store.dispose()
        }
    })

    it('reapplies the byte limit when foreground adoption adds genuine carried states', async () => {
        const donor = home(42)
        const target: ScreenContextInputsV2 = { ...donor, uiState: { ...donor.uiState, busy: { activity: 'working' } } }
        const now = (): number => Date.parse('2026-01-01T00:00:00Z')
        const budget = [fixture(donor), localDocument(target, 'busy', now)].reduce(
            (sum, document) => sum + new TextEncoder().encode(JSON.stringify(document)).byteLength,
            0,
        )
        const screensV2 = vi.fn<ModelApiClient['screensV2']>((metadata) =>
            metadata.uiState?.busy == null
                ? Promise.resolve(ok(fixture(inputsFromDocumentMetadata(metadata)), metadata.requestId))
                : new Promise(() => undefined),
        )
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'adopt',
            recordings: (): null => null,
            maxDocumentBytes: budget,
            now,
        })
        try {
            store.request(donor)
            await vi.waitFor(() => expect(store.peek(donor)?.document.metadata.source).toBe('generated'))
            const donorId = store.peek(donor)!.document.screenId
            store.warmup([target])
            expect(store.peek(target)).toBeDefined()
            expect(store.getCacheUsage().documentBytes).toBe(budget)
            const adopted = store.request(target)
            expect(adopted.document.metadata.carried?.pending?.fromScreenId).toBe(donorId)
            expect(store.peek(target)).toBe(adopted)
            expect(store.getCacheUsage().documentBytes).toBeLessThanOrEqual(budget)
            expect(screensV2).toHaveBeenCalledTimes(2)
        } finally {
            store.dispose()
        }
    })

    it('prefetches only the focused Guide and the next one when a manual opens', async () => {
        const demo = createDemoManual()
        const last = demo.reviewedSteps.at(-1)!
        const session = {
            ...demo,
            reviewedSteps: [...demo.reviewedSteps, { ...last, stepId: 'step-3', order: last.order + 1 }],
        }
        const [, current, next] = session.reviewedSteps
        const screensV2 = vi.fn<ModelApiClient['screensV2']>((metadata) =>
            Promise.resolve(ok(fixture(inputsFromDocumentMetadata(metadata)), metadata.requestId)),
        )
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'full',
            id: (): string => 'flow',
            recordings: (): null => null,
        })
        const guideSteps = (): string[] =>
            screensV2.mock.calls
                .map(([metadata]) => inputsFromDocumentMetadata(metadata))
                .filter((inputs) => inputs.kind === 'guide')
                .map((inputs) => inputs.stepId!)
        try {
            store.prepareFlow(session, `guide:${current!.stepId}`)
            await vi.waitFor(() =>
                expect(guideSteps()).toEqual(expect.arrayContaining([current!.stepId, next!.stepId])),
            )
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect([...new Set(guideSteps())].sort()).toEqual([current!.stepId, next!.stepId].sort())
        } finally {
            store.dispose()
        }
    })
})
