import { describe, expect, it, vi } from 'vitest'
import {
    createDemoManual,
    PIECE_GEOMETRY_PROMPT_VERSION,
    type PieceBatchResult,
    type PieceSpec,
} from '@truebuild/contracts'
import type { KeyValueStorage } from '../capture/library'
import {
    manualPieceContentHash,
    manualPieceInputOf,
    manualPieceInputs,
    PieceRegistry,
    stepPiecesForStep,
    type PieceGenerationPort,
    type PieceManualInput,
} from './piece-registry'

const CUTOUT = 'data:image/png;base64,iVBORw0KGgo='
const page = { pageId: 'page-1', width: 800, height: 600, mimeType: 'image/png' as const, contentHash: 'b'.repeat(64) }
const manual: PieceManualInput = {
    pages: [page],
    parts: Array.from({ length: 10 }, (_, index) => ({
        id: `part-${index}`,
        name: `Part ${index}`,
        quantity: 1,
        label: null,
        dimensions: null,
        pageId: page.pageId,
    })),
}
const hash = manualPieceContentHash(manual)
const manifestKey = `truebuild/pieces/v1/${hash}/manifest`
const pageUris = { [page.pageId]: 'data:image/png;base64,AAAA' }

function memoryStorage(): KeyValueStorage & { readonly values: Map<string, string>; failWrites: boolean } {
    const values = new Map<string, string>()
    const storage = {
        values,
        failWrites: false,
        async getItem(key: string): Promise<string | null> {
            return values.get(key) ?? null
        },
        async setItem(key: string, value: string): Promise<void> {
            if (storage.failWrites) throw new Error('quota')
            values.set(key, value)
        },
        async removeItem(key: string): Promise<void> {
            values.delete(key)
        },
        async getAllKeys(): Promise<readonly string[]> {
            return [...values.keys()]
        },
    }
    return storage
}

/** part-3 fails once and passes its repair; part-5 always fails and must end as a cutout card. */
function piece(id: string, name: string): PieceSpec {
    return {
        id,
        name,
        color: '#5978a5',
        parts: [
            { type: 'box', dimensions: { width: 1, height: 1, depth: 1 }, position: [0, 0, 0], rotation: [0, 0, 0] },
        ],
    }
}

type Call = {
    readonly ids: string[]
    readonly exclusions: (readonly string[] | undefined)[]
    readonly repairIds: string[]
    readonly cutouts: (string | null)[]
    readonly marked: boolean
}

function scriptedGenerate(
    storage: ReturnType<typeof memoryStorage>,
    onCall: () => void = (): void => undefined,
): { generate: PieceGenerationPort; calls: Call[]; maxInFlight: () => number } {
    const calls: Call[] = []
    let inFlight = 0
    let peak = 0
    const generate: PieceGenerationPort = async ({ request }): Promise<PieceBatchResult> => {
        onCall()
        const stored = JSON.parse(storage.values.get(manifestKey) ?? 'null') as {
            batches: { state: string; ids: string[] }[]
        } | null
        const ids = request.parts.map((part) => part.id)
        const marked =
            stored?.batches.some((batch) => batch.state === 'dispatching' && batch.ids.join() === ids.join()) === true
        calls.push({
            ids,
            exclusions: request.parts.map((part) => part.notPartOfThisPiece),
            repairIds: request.parts.filter((part) => part.repair !== undefined).map((part) => part.id),
            cutouts: request.parts.map((part) => part.cutoutUri ?? null),
            marked,
        })
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 0))
        inFlight--
        const results: PieceBatchResult['results'] = request.parts.map((part): PieceBatchResult['results'][number] => {
            const repair = part.repair !== undefined
            if (part.id === 'part-5' || (part.id === 'part-3' && !repair))
                return {
                    id: part.id,
                    name: part.name,
                    status: 'invalid',
                    piece: null,
                    cutoutUri: CUTOUT,
                    issueCodes: ['bad_geometry'],
                }
            return {
                id: part.id,
                name: part.name,
                status: repair ? 'repaired' : 'passed',
                piece: piece(part.id, part.name),
                cutoutUri: CUTOUT,
                issueCodes: [],
            }
        })
        return { contentHash: hash, results, model: null, effort: null, durationMs: 1 }
    }
    return { generate, calls, maxInFlight: (): number => peak }
}

describe('piece registry', () => {
    it('runs two batches in flight, repairs each failure once, keeps rejects as cutouts, and never repays a stored or unknown attempt', async () => {
        const storage = memoryStorage()
        const first = scriptedGenerate(storage)
        const registry = new PieceRegistry({ storage, generate: first.generate, newId: (): string => 'request' })
        await registry.prepare(manual, async (): Promise<Record<string, string>> => pageUris)
        const ready = registry.getSnapshot()
        expect(ready.status).toBe('ready')
        expect(first.calls.map((call) => call.ids.length)).toEqual([8, 2, 2])
        expect(first.maxInFlight()).toBe(2)
        expect(first.calls[2]?.repairIds).toEqual(['part-3', 'part-5'])
        expect(first.calls[2]?.cutouts).toEqual([CUTOUT, CUTOUT])
        for (const call of first.calls)
            for (const [index, id] of call.ids.entries())
                expect(call.exclusions[index]).toEqual(
                    manual.parts.filter((part) => part.id !== id).map((part) => part.name),
                )
        expect(first.calls.every((call) => call.marked)).toBe(true)
        expect(ready.pieces.map((item) => item.id)).toHaveLength(9)
        expect(ready.pieces.some((item) => item.id === 'part-5')).toBe(false)
        expect(ready.cards).toEqual([{ id: 'part-5', name: 'Part 5', state: 'rejected', issueCodes: ['bad_geometry'] }])
        expect(ready.cardCutouts['part-5']).toBe(CUTOUT)
        expect(ready.cutouts['part-5']).toBeUndefined()

        const revisit = scriptedGenerate(storage)
        const reloaded = new PieceRegistry({ storage, generate: revisit.generate, newId: (): string => 'request' })
        await reloaded.prepare(manual, async (): Promise<Record<string, string>> => pageUris)
        expect(revisit.calls).toHaveLength(0)
        expect(reloaded.getSnapshot().status).toBe('ready')
        expect(reloaded.getSnapshot().pieces).toHaveLength(9)
        expect(reloaded.getSnapshot().cutouts['part-0']).toBe(CUTOUT)
        const readOnly = new PieceRegistry({ storage, generate: null, newId: (): string => 'never-sent' })
        await readOnly.prepare(manual, async (): Promise<never> => {
            throw new Error('Read-only cache must not load pages')
        })
        expect(readOnly.getSnapshot().status).toBe('ready')
        expect(readOnly.getSnapshot().pieces).toEqual(reloaded.getSnapshot().pieces)

        const failing = memoryStorage()
        const halted = scriptedGenerate(failing, (): void => {
            failing.failWrites = true
        })
        const haltedRegistry = new PieceRegistry({
            storage: failing,
            generate: halted.generate,
            newId: (): string => 'request',
        })
        await haltedRegistry.prepare(manual, async (): Promise<Record<string, string>> => pageUris)
        expect(halted.calls).toHaveLength(2)
        expect(haltedRegistry.getSnapshot().status).toBe('incomplete')
        failing.failWrites = false
        const restored = scriptedGenerate(failing)
        const afterHalt = new PieceRegistry({
            storage: failing,
            generate: restored.generate,
            newId: (): string => 'request',
        })
        await afterHalt.prepare(manual, async (): Promise<Record<string, string>> => pageUris)
        expect(restored.calls).toHaveLength(0)
        expect(afterHalt.getSnapshot().status).toBe('incomplete')

        const unknownStorage = memoryStorage()
        const unknown: PieceGenerationPort = async (): Promise<null> => null
        const unknownRegistry = new PieceRegistry({
            storage: unknownStorage,
            generate: unknown,
            newId: (): string => 'request',
        })
        await unknownRegistry.prepare(manual, async (): Promise<Record<string, string>> => pageUris)
        expect(unknownRegistry.getSnapshot().status).toBe('incomplete')
        const later = scriptedGenerate(unknownStorage)
        await new PieceRegistry({
            storage: unknownStorage,
            generate: later.generate,
            newId: (): string => 'request',
        }).prepare(manual, async (): Promise<Record<string, string>> => pageUris)
        expect(later.calls).toHaveLength(0)

        let unavailableCalls = 0
        const providerFailure = new PieceRegistry({
            storage: memoryStorage(),
            newId: (): string => 'provider-error',
            generate: async ({ request }): Promise<PieceBatchResult> => {
                unavailableCalls++
                return {
                    contentHash: request.contentHash,
                    model: null,
                    effort: null,
                    durationMs: 1,
                    results: request.parts.map((part) => ({
                        id: part.id,
                        name: part.name,
                        status: 'invalid',
                        piece: null,
                        cutoutUri: CUTOUT,
                        issueCodes: ['response:provider_error'],
                    })),
                }
            },
        })
        await providerFailure.prepare(manual, async (): Promise<Record<string, string>> => pageUris)
        expect(unavailableCalls).toBe(2)
        expect(providerFailure.getSnapshot().status).toBe('incomplete')
        expect(providerFailure.getSnapshot().cardCutouts['part-0']).toBe(CUTOUT)

        let concurrent = 0
        let peak = 0
        const acrossManuals = new PieceRegistry({
            storage: memoryStorage(),
            newId: (): string => 'cross-manual',
            generate: async ({ request }): Promise<PieceBatchResult> => {
                concurrent++
                peak = Math.max(peak, concurrent)
                await new Promise((resolve) => setTimeout(resolve, 1))
                concurrent--
                return {
                    contentHash: request.contentHash,
                    results: request.parts.map((part) => ({
                        id: part.id,
                        name: part.name,
                        status: 'passed',
                        piece: piece(part.id, part.name),
                        cutoutUri: null,
                        issueCodes: [],
                    })),
                    model: 'muse-wonder-1.0',
                    effort: 'high',
                    durationMs: 1,
                }
            },
        })
        await Promise.all([
            acrossManuals.prepare(manual, async (): Promise<Record<string, string>> => pageUris),
            acrossManuals.prepare(
                { ...manual, pages: [{ ...page, contentHash: 'c'.repeat(64) }] },
                async (): Promise<Record<string, string>> => pageUris,
            ),
        ])
        expect(peak).toBe(2)
    })

    it('starts the opening-step batch and disjoint remaining pieces before either batch settles', async () => {
        const storage = memoryStorage()
        const calls: { ids: string[]; marked: boolean }[] = []
        const releases = new Map<string, () => void>()
        let releaseAll = false
        const selectedManual = { ...manual, parts: manual.parts.slice(0, 5) }
        const selectedHash = manualPieceContentHash(selectedManual)
        const registry = new PieceRegistry({
            storage,
            newId: (): string => 'parallel-opening',
            generate: async ({ request }): Promise<PieceBatchResult> => {
                const ids = request.parts.map((part) => part.id)
                const manifest = JSON.parse(
                    storage.values.get(`truebuild/pieces/v1/${selectedHash}/manifest`) ?? 'null',
                ) as { batches: { state: string; ids: string[] }[] } | null
                calls.push({
                    ids,
                    marked:
                        manifest?.batches.some(
                            (batch) => batch.state === 'dispatching' && batch.ids.join() === ids.join(),
                        ) === true,
                })
                if (!releaseAll) await new Promise<void>((resolve) => releases.set(ids[0]!, resolve))
                return {
                    contentHash: request.contentHash,
                    results: request.parts.map((part) => ({
                        id: part.id,
                        name: part.name,
                        status: 'passed',
                        piece: piece(part.id, part.name),
                        cutoutUri: null,
                        issueCodes: [],
                    })),
                    model: 'muse-wonder-1.0',
                    effort: 'high',
                    durationMs: 1,
                }
            },
        })
        const running = registry.prepare(selectedManual, async () => pageUris, ['part-0'])
        try {
            await vi.waitFor(() => expect(calls).toHaveLength(2))
            expect(calls.map((call) => call.ids)).toEqual([['part-0'], ['part-1', 'part-2', 'part-3', 'part-4']])
            expect(calls.every((call) => call.marked)).toBe(true)
            expect(new Set(calls.flatMap((call) => call.ids)).size).toBe(5)
            releases.get('part-0')!()
            await vi.waitFor(() => expect(registry.getSnapshot().pieces.map((item) => item.id)).toEqual(['part-0']))
            expect(registry.getSnapshot().status).toBe('pending')
            expect(calls).toHaveLength(2)
        } finally {
            releaseAll = true
            for (const release of releases.values()) release()
            await running
        }
        expect(registry.getSnapshot().pieces).toHaveLength(5)
        expect(calls).toHaveLength(2)

        for (const failure of ['unknown', 'listener'] as const) {
            const isolatedStorage = memoryStorage()
            let sends = 0
            const isolated = new PieceRegistry({
                storage: isolatedStorage,
                newId: (): string => `settlement-${failure}`,
                generate: async ({ request }): Promise<PieceBatchResult | null> => {
                    sends++
                    if (request.parts[0]?.id === 'part-0' && failure === 'unknown') return null
                    return {
                        contentHash: request.contentHash,
                        model: 'muse-wonder-1.0',
                        effort: 'high',
                        durationMs: 1,
                        results: request.parts.map((part) => ({
                            id: part.id,
                            name: part.name,
                            status: 'passed',
                            piece: piece(part.id, part.name),
                            cutoutUri: null,
                            issueCodes: [],
                        })),
                    }
                },
            })
            const unsubscribe = isolated.subscribe(() => {
                if (failure === 'listener' && isolated.getSnapshot().pieces.some((item) => item.id === 'part-0')) {
                    unsubscribe()
                    throw new Error('display subscriber failed')
                }
            })
            await isolated.prepare(selectedManual, async () => pageUris, ['part-0'])
            unsubscribe()
            expect(sends).toBe(2)
            expect(isolated.getSnapshot().status).toBe('incomplete')
            let repeatSends = 0
            const restored = new PieceRegistry({
                storage: isolatedStorage,
                newId: (): string => 'must-not-dispatch',
                generate: async (): Promise<never> => {
                    repeatSends++
                    throw new Error('must not repay')
                },
            })
            await restored.prepare(selectedManual, async () => pageUris, ['part-0'])
            expect(repeatSends).toBe(0)
            expect(restored.getSnapshot().status).toBe('incomplete')
            expect(restored.getSnapshot().pieces.map((item) => item.id)).toEqual(
                failure === 'unknown'
                    ? ['part-1', 'part-2', 'part-3', 'part-4']
                    : selectedManual.parts.map((part) => part.id),
            )
            const manifest = JSON.parse(
                isolatedStorage.values.get(`truebuild/pieces/v1/${selectedHash}/manifest`) ?? 'null',
            ) as { batches: { state: string; ids: string[] }[] }
            expect(manifest.batches.find((batch) => batch.ids[0] === 'part-1')?.state).toBe('settled')
        }
    })

    it('keys the cache by prompt version and each box with its cited page content, and keeps only a valid box as written', () => {
        const second = { ...page, pageId: 'page-2', contentHash: 'c'.repeat(64) }
        const twin = { ...page, pageId: 'page-3' }
        const citing = (
            pageId: string,
            value: [number, number, number, number] = [0.1, 0.2, 0.3, 0.4],
            pages: PieceManualInput['pages'] = [page, second],
        ): PieceManualInput => ({
            pages,
            parts: manual.parts.map((part, index) => (index === 0 ? { ...part, pageId, drawingBox: value } : part)),
        })
        const boxedHash = manualPieceContentHash(citing('page-1'))
        expect(boxedHash).not.toBe(manualPieceContentHash({ pages: [page, second], parts: manual.parts }))
        expect(manualPieceContentHash(manual, PIECE_GEOMETRY_PROMPT_VERSION - 1)).not.toBe(hash)
        expect(manualPieceContentHash(citing('page-1', [0.1, 0.2, 0.3, 0.5]))).not.toBe(boxedHash)
        expect(manualPieceContentHash(citing('page-2'))).not.toBe(boxedHash)
        const originalFigure = citing('page-1')
        const first = originalFigure.parts[0]!
        const figure = {
            ...originalFigure,
            parts: [{ ...first, drawingBox: undefined, figureBox: first.drawingBox }, ...originalFigure.parts.slice(1)],
        }
        expect(manualPieceContentHash(figure)).not.toBe(boxedHash)
        const changedFigure = {
            ...figure,
            parts: [
                { ...figure.parts[0]!, figureBox: [0.2, 0.2, 0.3, 0.4] as [number, number, number, number] },
                ...figure.parts.slice(1),
            ],
        }
        expect(manualPieceContentHash(changedFigure)).not.toBe(manualPieceContentHash(figure))
        expect(manualPieceContentHash(citing('page-1', undefined, [page, twin]))).toBe(
            manualPieceContentHash(citing('page-3', undefined, [page, twin])),
        )

        const session = createDemoManual()
        const withBoxes = (value: [number, number, number, number]): PieceManualInput =>
            manualPieceInputOf({
                ...session,
                parts: session.parts.map((part, index) => (index === 0 ? { ...part, drawingBox: value } : part)),
            })
        expect(withBoxes([0.1234567, 0.2, 0.3, 0.4]).parts[0]?.drawingBox).toEqual([0.1234567, 0.2, 0.3, 0.4])
        // An invalid box is no own drawing, so the part takes its step figure (the cited step page, whole frame).
        expect(withBoxes([0.9, 0.2, 0.3, 0.4]).parts[0]).toMatchObject({
            pageId: 'demo-page-1',
            figureBox: [0, 0, 1, 1],
        })
        expect(manualPieceInputOf(session).parts[0]).toMatchObject({ pageId: 'demo-page-1', figureBox: [0, 0, 1, 1] })
        expect(manualPieceInputOf(session).parts[0]?.drawingBox).toBeUndefined()
    })

    it('binds own sub-boxes to their drawing page and gives every missing part cited figure context without claiming it as its own drawing', () => {
        const source = createDemoManual()
        const cite = (...pageIds: string[]): { pageId: string; region: null }[] =>
            pageIds.map((pageId) => ({ pageId, region: null }))
        const named = (
            value: string,
        ): { state: 'known'; value: string; sourceRefs: { pageId: string; region: null }[] } => ({
            state: 'known',
            value,
            sourceRefs: cite('page-1'),
        })
        const known1 = (
            pageId: string,
        ): { state: 'known'; value: number; sourceRefs: { pageId: string; region: null }[] } => ({
            state: 'known',
            value: 1,
            sourceRefs: cite(pageId),
        })
        const grouped: [number, number, number, number] = [0.19, 0.385, 0.155, 0.14]
        const session = {
            ...source,
            pages: ['page-1', 'page-2', 'page-3'].map((pageId) => ({
                ...source.pages[0]!,
                pageId,
                assetId: `asset-${pageId}`,
            })),
            parts: [
                { partId: 'blade-a', name: named('Blade A'), drawingBox: grouped },
                { partId: 'blade-b', name: named('Blade B'), drawingBox: grouped },
                { partId: 'battery', name: named('Battery') },
            ],
            reviewedSteps: [
                {
                    ...source.reviewedSteps[0]!,
                    stepId: 'step-1',
                    order: 1,
                    parts: [
                        { partId: 'blade-a', quantity: known1('page-2'), quantityBasis: null },
                        { partId: 'blade-b', quantity: known1('page-2'), quantityBasis: null },
                    ],
                    sourceRefs: cite('page-2', 'page-3'),
                },
                {
                    ...source.reviewedSteps[1]!,
                    stepId: 'step-2',
                    order: 2,
                    kind: 'remove' as const,
                    parts: [{ partId: 'battery', quantity: known1('page-3'), quantityBasis: null }],
                    sourceRefs: cite('page-3'),
                },
            ],
        }
        const requested = manualPieceInputs(session)
        const byPart = new Map(requested.map((part) => [part.partId, part]))
        for (const id of ['blade-a', 'blade-b']) {
            expect(byPart.get(id)).toMatchObject({ pageId: 'page-2', figureBox: [0, 0, 1, 1] })
            expect(byPart.get(id)?.drawingBox).toBeUndefined()
        }
        expect(byPart.get('battery')).toMatchObject({ pageId: 'page-3', figureBox: [0, 0, 1, 1] })
        const boxes: [number, number, number, number][] = [
            [0.1, 0.2, 0.2, 0.3],
            [0.6, 0.2, 0.2, 0.3],
        ]
        const own = manualPieceInputs({
            ...session,
            parts: session.parts.map((part, index) =>
                index < 2
                    ? {
                          ...part,
                          name: { ...part.name, sourceRefs: cite('page-2', 'page-1') },
                          drawingBox: boxes[index],
                      }
                    : part,
            ),
        })
        expect(own.slice(0, 2).map((part) => ({ pageId: part.pageId, box: part.drawingBox }))).toEqual(
            boxes.map((box) => ({ pageId: 'page-2', box })),
        )
        const region = { x: 0.2, y: 0.3, width: 0.5, height: 0.4 }
        const regional = manualPieceInputs({
            ...session,
            reviewedSteps: session.reviewedSteps.map((step) => ({
                ...step,
                sourceRefs: [
                    { pageId: 'page-2', region: null },
                    { pageId: 'page-3', region },
                ],
            })),
        })
        expect(regional.every((part) => part.figureBox?.join(',') === '0.2,0.3,0.5,0.4')).toBe(true)
    })

    it('maps only a step’s linked pieces and quantities, and pins only after its pieces settle', async () => {
        const source = createDemoManual()
        const linked = source.reviewedSteps[1]!
        const session = {
            ...source,
            reviewedSteps: source.reviewedSteps.map((step) =>
                step.stepId !== linked.stepId
                    ? step
                    : {
                          ...step,
                          parts: step.parts.map((part, index) =>
                              index !== 1
                                  ? part
                                  : {
                                        ...part,
                                        quantity: { state: 'known' as const, value: 4, sourceRefs: step.sourceRefs },
                                    },
                          ),
                      },
            ),
        }
        const mapped = manualPieceInputs(session)
        expect(mapped.map((part) => part.partId)).toEqual(session.parts.map((part) => part.partId))
        expect(stepPiecesForStep(session, linked.stepId)).toEqual([
            { pieceId: mapped[0]!.id, quantity: 1 },
            { pieceId: mapped[1]!.id, quantity: 4 },
        ])
        expect(stepPiecesForStep({ ...session, reviewedSteps: [{ ...linked, parts: [] }] }, linked.stepId)).toEqual([])
        expect(stepPiecesForStep(session, 'not-a-step')).toEqual([])
        const storage = memoryStorage()
        const scripted = scriptedGenerate(storage)
        let releaseRepair: (() => void) | undefined
        const repairGate = new Promise<void>((resolve) => {
            releaseRepair = resolve
        })
        const generate: PieceGenerationPort = async (input) => {
            expect(input.request.parts.every((part) => !('partId' in part))).toBe(true)
            if (input.request.parts.some((part) => part.repair !== undefined)) await repairGate
            return scripted.generate(input)
        }
        const registry = new PieceRegistry({ storage, generate, newId: (): string => 'request' })
        const early = registry.pin('guide:early', hash, true, ['part-3'])
        const frozenOtherScreen = registry.pin('quick-check:overview')
        registry.pin('hidden-page', hash, false)
        expect(early.status).toBe('idle')
        const running = registry.prepare(
            { ...manual, parts: manual.parts.map((part, index) => ({ ...part, partId: `parse-${index}` })) },
            async (): Promise<Record<string, string>> => pageUris,
        )
        await vi.waitFor(() => expect(registry.getSnapshot().pieces.length).toBeGreaterThan(0))
        const pending = registry.pin('guide:part-3', hash, true, ['part-3'])
        expect(pending.status).toBe('pending')
        expect(pending.pieces.some((part) => part.id === 'part-3')).toBe(false)
        const partialOther = registry.pin('more:mid-wave', hash)
        expect(partialOther.pieces).toHaveLength(0)
        expect(partialOther.timing.readyAt).toBeNull()
        releaseRepair!()
        await running
        expect(storage.values.get(manifestKey)).not.toContain('"partId"')
        expect(registry.pin('guide:early', hash, true, ['part-3'])).not.toBe(early)
        expect(registry.pin('guide:early', hash, true, ['part-3']).pieces.length).toBeGreaterThan(0)
        expect(registry.pin('quick-check:overview')).toBe(frozenOtherScreen)
        expect(registry.pin('more:mid-wave', hash)).toBe(partialOther)
        expect(partialOther.timing.readyAt).toBeNull()
        expect(registry.pin('quick-check:overview').pieces).toHaveLength(0)
        expect(registry.pin('guide:part-3', hash, true, ['part-3']).pieces.some((part) => part.id === 'part-3')).toBe(
            true,
        )
        const late = registry.pin('completion:summary')
        expect(late.status).toBe('ready')
        expect(late.pieces.length).toBeGreaterThan(0)
        expect(registry.pin('hidden-page', hash).pieces.length).toBeGreaterThan(0)
        expect(registry.pin('different-manual', 'd'.repeat(64)).pieces).toHaveLength(0)
    })
})
