import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { inspectSourceImage } from '../../media/image-header'
import { LibraryStorage, type KeyValueStorage } from '../capture/library'
import { createDemoManual } from '@truebuild/contracts'
import { resolveProofConfig } from './config'
import { createProofPorts, proofCaptureAsset, proofManualIndex } from './runtime'

const inputs = { development: true, enabled: '1', providerMode: 'fixture', baseUrl: 'http://127.0.0.1:3101' }
const digest = async (bytes: Uint8Array): Promise<string> => createHash('sha256').update(bytes).digest('hex')

describe('proof isolation guard', () => {
    it('stays absent in production or without explicit opt-in', () => {
        expect(resolveProofConfig({ ...inputs, development: false })).toBeNull()
        expect(resolveProofConfig({ ...inputs, enabled: undefined })).toBeNull()
        expect(resolveProofConfig({ ...inputs, enabled: '0' })).toBeNull()
    })
    it.each([
        { enabled: 'yes' },
        { providerMode: 'meta' },
        { baseUrl: 'http://127.0.0.1:3002' },
        { baseUrl: 'https://example.com:3101' },
        { baseUrl: 'http://user:password@localhost:3101' },
        { baseUrl: 'http://localhost:3101/x' },
        { baseUrl: 'http://localhost:3101/?x=1' },
        { runId: '../live-library' },
    ])('rejects active misconfiguration %j', (override) => {
        expect(() => resolveProofConfig({ ...inputs, ...override })).toThrow()
    })
})

describe('proof source IO', () => {
    const memory = (): { storage: KeyValueStorage; values: Map<string, string> } => {
        const values = new Map<string, string>()
        return {
            values,
            storage: {
                getItem: async (key) => values.get(key) ?? null,
                setItem: async (key, value): Promise<void> => {
                    values.set(key, value)
                },
                removeItem: async (key): Promise<void> => {
                    values.delete(key)
                },
                getAllKeys: async () => [...values.keys()],
            },
        }
    }

    it('round-trips a real library through the isolated namespace and never edits the pre-existing library', async () => {
        const { storage, values } = memory()
        values.set('truebuild/library/v1', 'original-data')
        const config = resolveProofConfig(inputs)!
        const proof = createProofPorts({ config, storage, digest })
        const normalized = await proof.normalize(proof.captureAsset({ kind: 'page' }, { manualIndex: 0, pageIndex: 0 }))
        const session = createDemoManual()
        const page = session.pages[0]!
        page.width = normalized.width
        page.height = normalized.height
        page.mimeType = normalized.mimeType
        page.contentHash = await digest(normalized.bytes)
        const library = new LibraryStorage(proof.storage, digest)
        await library.restore()
        await library.save(
            [{ session, stepIndex: 0, completedStepIds: [], capture: null }],
            [{ assetId: page.assetId, bytes: normalized.bytes }],
        )
        const restored = await new LibraryStorage(proof.storage, digest).restore()
        expect(restored.entries[0]?.session.manualId).toBe(session.manualId)
        expect(restored.readOnly).toBe(false)
        expect(values.get('truebuild/library/v1')).toBe('original-data')
        expect((await proof.storage.getAllKeys()).every((key) => key.startsWith('truebuild/library/'))).toBe(true)
        for (const key of await proof.storage.getAllKeys()) await proof.storage.removeItem(key)
        expect(values.get('truebuild/library/v1')).toBe('original-data')
    })

    it('uses genuine decodable distinct PNG bytes with their exact dimensions, copying every normalization', async () => {
        const { storage } = memory()
        const proof = createProofPorts({ config: resolveProofConfig(inputs)!, storage, digest })
        const seen = new Set<string>()
        for (const [manualIndex, pageIndex] of [
            [0, 0],
            [1, 0],
            [1, 1],
        ]) {
            const source = proofCaptureAsset({ kind: 'page' }, { manualIndex: manualIndex!, pageIndex: pageIndex! })
            const image = await proof.normalize(source)
            expect(inspectSourceImage(image.bytes)).toMatchObject({ width: image.width, height: image.height })
            seen.add(await digest(image.bytes))
            const before = image.bytes[0]
            image.bytes[0] = 0
            expect((await proof.normalize(source)).bytes[0]).toBe(before)
        }
        expect(seen.size).toBe(3)
        await expect(proof.normalize({ uri: 'file:///private-photo.jpg', width: 960, height: 1280 })).rejects.toThrow()
        const source = proof.captureAsset({ kind: 'check' }, { manualIndex: 0, pageIndex: 0 })
        await expect(proof.normalize({ ...source, width: source.width + 1 })).rejects.toThrow()
    })

    it('selects existing witnesses by step identities and new drafts by other parsed manuals only', () => {
        expect(proofManualIndex(['step-1', 'step-2'], 1)).toBe(0)
        expect(proofManualIndex(['arm-step-1', 'arm-step-2'], 0)).toBe(1)
        expect(proofManualIndex([], 0)).toBe(0)
        expect(proofManualIndex([], 1)).toBe(1)
        expect(() => proofCaptureAsset({ kind: 'page' }, { manualIndex: -1, pageIndex: 0 })).toThrow()
    })

    it('keeps an unparsed draft bound to its captured pages when another draft finishes parsing', () => {
        const source = proofCaptureAsset({ kind: 'page' }, { manualIndex: 1, pageIndex: 0 })
        expect(proofManualIndex([], 0, [source.uri])).toBe(1)
        expect(proofManualIndex([], 1, [source.uri])).toBe(1)
    })
})
