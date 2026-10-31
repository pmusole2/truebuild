import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as contracts from '@truebuild/contracts'
import {
    assembleDocumentV2,
    buildFallbackProposalV2,
    createDemoManual,
    documentMaterialV2,
    manualSessionSchema,
    screenDocumentV2Schema,
    type ManualSession,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
} from '@truebuild/contracts'
import type { ScreensV2Result } from '@truebuild/contracts/model'
import { documentUnavailable, inputsFromDocumentMetadata } from '../../api/document-client'
import type { ModelApiClient } from '../../api/model-client'
import { sha256Hex } from '../documents/sha256'
import { DOCUMENT_CACHE_MAX_BYTES, DOCUMENT_CACHE_MAX_ENTRIES, DocumentStore, localDocument } from './store'
import { futureDocumentStates } from './future-states'

// This suite deliberately exercises the shipped offline recordings.
beforeEach(() => vi.stubEnv('EXPO_PUBLIC_RELEASE_FIXTURE', '1'))
afterEach(() => vi.unstubAllEnvs())

function manual(count = 4): ManualSession {
    const original = createDemoManual()
    return manualSessionSchema.parse({
        ...original,
        reviewedSteps: Array.from({ length: count }, (_, index) => ({
            ...original.reviewedSteps[0]!,
            stepId: `step-${index + 1}`,
            order: index + 1,
        })),
    })
}
function guide(session: ManualSession, stepId: string): ScreenContextInputsV2 {
    return { kind: 'guide', session, stepId, captureId: null, result: null, failure: null }
}
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
    it('puts a resumed full-mode step first without skipping the rest of the manual', async () => {
        const session = manual()
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(async (metadata) =>
            documentUnavailable(metadata.requestId, 'unconfigured'),
        )
        const store = new DocumentStore({ client: { screensV2 }, mode: 'full', id: (): string => 'focus' })
        try {
            store.precompute(session, 'guide:step-4')
            await vi.waitFor(() => expect(screensV2.mock.calls.filter(([m]) => m.op === 'generate')).toHaveLength(16))
            const calls = screensV2.mock.calls.flatMap(([m]) => (m.op === 'generate' ? [m] : []))
            expect(calls.slice(0, 4).map((m) => `${m.stepId}:${m.uiState?.busy?.activity}`)).toEqual([
                'step-4:checking',
                'step-4:second-opinion',
                'step-4:asking',
                'step-4:question-waiting',
            ])
            expect(new Set(calls.map((m) => m.stepId)).size).toBe(4)
            expect(screensV2.mock.calls.filter(([m]) => m.op === 'precompute')).toHaveLength(1)
        } finally {
            store.dispose()
        }
    })

    it.each(['full', 'steps'] as const)(
        'promotes a changed focus ahead of queued %s work without duplicating flights',
        async (mode) => {
            const session = manual()
            const releases: (() => void)[] = []
            const screensV2 = vi.fn<ModelApiClient['screensV2']>((metadata) => {
                if (metadata.op !== 'generate')
                    return Promise.resolve(documentUnavailable(metadata.requestId, 'unconfigured'))
                return new Promise((resolve) =>
                    releases.push(() => resolve(documentUnavailable(metadata.requestId, 'timeout'))),
                )
            })
            const store = new DocumentStore({ client: { screensV2 }, mode, id: (): string => 'focus' })
            try {
                store.precompute(session, 'guide:step-4')
                expect(screensV2.mock.calls.filter(([m]) => m.op === 'generate')).toHaveLength(2)
                store.precompute(session, 'guide:step-2')
                expect(screensV2.mock.calls.filter(([m]) => m.op === 'generate')).toHaveLength(2)
                releases[0]!()
                await vi.waitFor(() =>
                    expect(screensV2.mock.calls.filter(([m]) => m.op === 'generate')).toHaveLength(3),
                )
                const calls = screensV2.mock.calls.flatMap(([m]) => (m.op === 'generate' ? [m] : []))
                expect(calls[2]?.stepId).toBe('step-2')
                expect(new Set(calls.map((m) => m.contextKey)).size).toBe(calls.length)
                expect(screensV2.mock.calls.filter(([m]) => m.op === 'precompute')).toHaveLength(
                    mode === 'full' ? 1 : 0,
                )
                const expected = mode === 'full' ? 16 : 20
                for (let index = 1; index < expected; index++) {
                    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index))
                    releases[index]!()
                }
                await vi.waitFor(() =>
                    expect(
                        screensV2.mock.calls
                            .flatMap(([metadata]) => (metadata.op === 'generate' ? [metadata] : []))
                            .every((metadata) => store.peek(inputsFromDocumentMetadata(metadata))?.status === 'ready'),
                    ).toBe(true),
                )
                const drained = screensV2.mock.calls.flatMap(([m]) => (m.op === 'generate' ? [m] : []))
                expect(drained).toHaveLength(expected)
                expect(new Set(drained.map((metadata) => metadata.contextKey)).size).toBe(expected)
            } finally {
                store.dispose()
            }
        },
    )

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

    it('keeps a foreground request ahead of speculative family entries within the byte limit', () => {
        const session = manual(2)
        const focused = guide(session, 'step-1')
        const family = [focused, ...futureDocumentStates(focused)]
        const budget = family.reduce(
            (sum, context) => sum + new TextEncoder().encode(JSON.stringify(fixture(context))).byteLength,
            64,
        )
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(() => new Promise(() => undefined))
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'steps',
            id: (): string => 'foreground',
            recordings: (context): ScreenDocumentV2 | null => (context.stepId === 'step-1' ? fixture(context) : null),
            maxDocumentBytes: budget,
        })
        try {
            store.precompute(session, 'guide:step-1')
            expect(screensV2).not.toHaveBeenCalled()
            const target = guide(session, 'step-2')
            const entry = store.request(target)
            expect(store.peek(target)).toBe(entry)
            expect(entry.status).toBe('pending')
            expect(screensV2).toHaveBeenCalledTimes(1)
            expect(store.getCacheUsage().documentBytes).toBeLessThanOrEqual(budget)
            expect(family.filter((context) => store.peek(context) !== undefined).length).toBeLessThan(family.length)
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

    it('retains only the current Guide family through entry pressure and still obeys the unchanged hard cap', () => {
        const session = manual(110)
        const focused = guide(session, 'step-1')
        const family = [focused, ...futureDocumentStates(focused)]
        const recordings = vi.fn(fixture)
        const screensV2 = vi.fn<ModelApiClient['screensV2']>()
        const store = new DocumentStore({ client: { screensV2 }, mode: 'steps', id: (): string => 'cache', recordings })
        try {
            store.precompute(session, 'guide:step-1')
            for (const context of family) expect(store.peek(context)?.document.metadata.source).toBe('generated')
            expect(store.getCacheUsage().entries).toBe(DOCUMENT_CACHE_MAX_ENTRIES)
            expect(store.getCacheUsage().documentBytes).toBeLessThanOrEqual(DOCUMENT_CACHE_MAX_BYTES)
            // A schema-valid 110-step manual fills this cache: every base/activity context still gets prepared.
            expect(recordings).toHaveBeenCalledTimes(550)
            expect(screensV2).not.toHaveBeenCalled()
            const before = recordings.mock.calls.length
            store.precompute(session, 'guide:step-1')
            expect(recordings).toHaveBeenCalledTimes(before)
            store.precompute(session, 'guide:step-2')
            const next = guide(session, 'step-2')
            for (const context of [next, ...futureDocumentStates(next)])
                expect(store.peek(context)?.document.metadata.source).toBe('generated')
            expect(recordings).toHaveBeenCalledTimes(before + 5)
            store.warmup(Array.from({ length: DOCUMENT_CACHE_MAX_ENTRIES + 8 }, (_, index) => home(1_000 + index)))
            for (const context of family) expect(store.peek(context)).toBeUndefined()
            for (const context of [next, ...futureDocumentStates(next)])
                expect(store.peek(context)?.document.metadata.source).toBe('generated')
            expect(store.getCacheUsage().entries).toBe(DOCUMENT_CACHE_MAX_ENTRIES)
        } finally {
            store.dispose()
        }
    }, 30_000)

    it('keeps the active family ahead of other warm-ups under a byte budget, but never exceeds that budget', () => {
        const session = manual(2)
        const focused = guide(session, 'step-1')
        const family = [focused, ...futureDocumentStates(focused)]
        const size = (context: ScreenContextInputsV2): number =>
            new TextEncoder().encode(JSON.stringify(fixture(context))).byteLength
        const budget = family.reduce((sum, context) => sum + size(context), 0) + Math.max(...family.map(size))
        const screensV2 = vi.fn<ModelApiClient['screensV2']>()
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'steps',
            id: (): string => 'bytes',
            recordings: fixture,
            maxDocumentBytes: budget,
        })
        const tooSmall = new DocumentStore({
            client: { screensV2 },
            mode: 'steps',
            id: (): string => 'bytes',
            recordings: fixture,
            maxDocumentBytes: size(focused) + 64,
        })
        try {
            store.precompute(session, 'guide:step-1')
            for (const context of family) expect(store.peek(context)?.document.metadata.source).toBe('generated')
            expect(store.getCacheUsage().documentBytes).toBeLessThanOrEqual(budget)
            tooSmall.precompute(session, 'guide:step-1')
            expect(tooSmall.getCacheUsage().entries).toBeLessThan(family.length)
            expect(tooSmall.getCacheUsage().documentBytes).toBeLessThanOrEqual(size(focused) + 64)
            expect(screensV2).not.toHaveBeenCalled()
        } finally {
            store.dispose()
            tooSmall.dispose()
        }
    })

    it('does not occupy a warm-up flight when active documents leave no room for another complete background entry', () => {
        const session = manual(2)
        const focused = guide(session, 'step-1')
        const family = [focused, ...futureDocumentStates(focused)]
        const budget =
            family.reduce(
                (sum, context) => sum + new TextEncoder().encode(JSON.stringify(fixture(context))).byteLength,
                0,
            ) + 64
        const recordings = vi.fn((context: ScreenContextInputsV2) =>
            context.stepId === 'step-1' ? fixture(context) : null,
        )
        const screensV2 = vi.fn<ModelApiClient['screensV2']>(() => new Promise(() => undefined))
        const store = new DocumentStore({
            client: { screensV2 },
            mode: 'steps',
            id: (): string => 'pressure',
            recordings,
            maxDocumentBytes: budget,
        })
        try {
            store.precompute(session, 'guide:step-1')
            expect(recordings).toHaveBeenCalledTimes(10)
            expect(screensV2).not.toHaveBeenCalled()
            for (const context of family) expect(store.peek(context)?.document.metadata.source).toBe('generated')
            const other = guide(session, 'step-2')
            for (const context of [other, ...futureDocumentStates(other)]) {
                expect(store.peek(context)).toBeUndefined()
                expect(store.cacheIssue(context)).toBe('budget_exhausted')
            }
            // A later component can enqueue more work after the original queue drained. Evicted pending
            // documents must not leave its two warm-up slots occupied by flights that never started.
            const later: ScreenContextInputsV2 = { ...other, uiState: { busy: { activity: 'working' } } }
            store.warmup([later])
            expect(recordings).toHaveBeenCalledTimes(11)
            expect(store.cacheIssue(later)).toBe('budget_exhausted')
            expect(store.getCacheUsage().documentBytes).toBeLessThanOrEqual(budget)
            // Moving to that step releases the old priorities and makes room. Its two real flights must
            // start immediately, even though all earlier uncached background previews were pending.
            store.precompute(session, 'guide:step-2')
            expect(screensV2).toHaveBeenCalledTimes(2)
            expect(screensV2.mock.calls.every(([metadata]) => metadata.stepId === 'step-2')).toBe(true)
        } finally {
            store.dispose()
        }
    })
})
