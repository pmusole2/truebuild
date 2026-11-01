import { describe, expect, it } from 'vitest'
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
    PieceRegistry,
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
        expect(withBoxes([0.9, 0.2, 0.3, 0.4]).parts[0]?.drawingBox).toBeUndefined()
        expect(manualPieceInputOf(session).parts[0]?.drawingBox).toBeUndefined()
    })

    it('pins each screen identity to the snapshot it first displayed', async () => {
        const storage = memoryStorage()
        const { generate } = scriptedGenerate(storage)
        const registry = new PieceRegistry({ storage, generate, newId: (): string => 'request' })
        const early = registry.pin('quick-check:overview')
        registry.pin('hidden-page', hash, false)
        expect(early.status).toBe('idle')
        await registry.prepare(manual, async (): Promise<Record<string, string>> => pageUris)
        expect(registry.pin('quick-check:overview')).toBe(early)
        expect(registry.pin('quick-check:overview').pieces).toHaveLength(0)
        const late = registry.pin('completion:summary')
        expect(late.status).toBe('ready')
        expect(late.pieces.length).toBeGreaterThan(0)
        expect(registry.pin('hidden-page', hash).pieces.length).toBeGreaterThan(0)
        expect(registry.pin('different-manual', 'd'.repeat(64)).pieces).toHaveLength(0)
    })
})
