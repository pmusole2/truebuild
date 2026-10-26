import { createDemoManual, LIMITS, type ManualSession } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import {
    digestToHex,
    isSyntheticPage,
    prepareSave,
    verifyStoredBytes,
    type ContentDigest,
    type ManualStorageError,
} from './manual-store.core'
import type { StoredPageAsset } from './manual-store.types'
import { assetFor, bytesFor, nodeDigest, pageFor, sessionOf, sha256Hex } from './storage-test-fixtures'

const MANUAL_ID = 'rules-manual'
const PAGE_ID = 'page-1'
const ASSET_ID = 'asset-1'

async function singlePageSession(
    bytes: Uint8Array<ArrayBuffer>,
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg',
): Promise<ManualSession> {
    return sessionOf(MANUAL_ID, [await pageFor(PAGE_ID, ASSET_ID, bytes, mimeType)])
}

async function expectStorageError(promise: Promise<unknown>, code: ManualStorageError['code']): Promise<void> {
    await expect(promise).rejects.toMatchObject({ name: 'ManualStorageError', code })
}

interface RejectionInput {
    readonly session: ManualSession
    readonly assets: StoredPageAsset[]
}

interface RejectionCase {
    readonly name: string
    readonly code: ManualStorageError['code']
    readonly build: () => Promise<RejectionInput>
}

const rejectionCases: RejectionCase[] = [
    {
        name: 'an asset no page references',
        code: 'invalid_input',
        build: async (): Promise<RejectionInput> => {
            const bytes = bytesFor('a', 32)
            return {
                session: await singlePageSession(bytes),
                assets: [assetFor(ASSET_ID, bytes), assetFor('orphan', bytesFor('o', 8))],
            }
        },
    },
    {
        name: 'the same asset supplied twice',
        code: 'invalid_input',
        build: async (): Promise<RejectionInput> => {
            const bytes = bytesFor('a', 32)
            return {
                session: await singlePageSession(bytes),
                assets: [assetFor(ASSET_ID, bytes), assetFor(ASSET_ID, bytes)],
            }
        },
    },
    {
        name: 'a MIME type that differs from the page',
        code: 'invalid_input',
        build: async (): Promise<RejectionInput> => {
            const bytes = bytesFor('a', 32)
            return {
                session: await singlePageSession(bytes, 'image/png'),
                assets: [assetFor(ASSET_ID, bytes, 'image/jpeg')],
            }
        },
    },
    {
        name: 'empty bytes',
        code: 'invalid_input',
        build: async (): Promise<RejectionInput> => {
            const bytes = bytesFor('a', 32)
            return { session: await singlePageSession(bytes), assets: [assetFor(ASSET_ID, new Uint8Array(0))] }
        },
    },
    {
        name: 'bytes one byte over the 4 MiB limit',
        code: 'invalid_input',
        build: async (): Promise<RejectionInput> => {
            const bytes = bytesFor('a', LIMITS.imageBytes + 1)
            return { session: await singlePageSession(bytes), assets: [assetFor(ASSET_ID, bytes)] }
        },
    },
    {
        name: 'bytes whose SHA-256 differs from the page metadata',
        code: 'hash_mismatch',
        build: async (): Promise<RejectionInput> => {
            const original = bytesFor('a', 64)
            const tampered = new Uint8Array(original)
            tampered[63] = (tampered[63] ?? 0) ^ 1
            return { session: await singlePageSession(original), assets: [assetFor(ASSET_ID, tampered)] }
        },
    },
    {
        name: 'bytes supplied for the synthetic demo page',
        code: 'invalid_input',
        build: async (): Promise<RejectionInput> => {
            const demo = createDemoManual()
            const page = demo.pages[0]

            if (page === undefined) {
                throw new Error('demo fixture has no page')
            }

            return { session: demo, assets: [assetFor(page.assetId, bytesFor('d', 16))] }
        },
    },
]

describe('prepareSave validation at the persistence boundary', () => {
    it.each(rejectionCases)('rejects $name', async ({ build, code }) => {
        const { session, assets } = await build()

        await expectStorageError(prepareSave(session, assets, nodeDigest), code)
    })

    it('rejects a session that fails schema validation before inspecting any asset', async () => {
        const bytes = bytesFor('a', 8)
        const session = await singlePageSession(bytes)

        await expectStorageError(prepareSave({ ...session, manualId: '' }, [], nodeDigest), 'invalid_input')
    })

    it('accepts an exact 4 MiB image whose digest matches its page', async () => {
        const bytes = bytesFor('max', LIMITS.imageBytes)
        const prepared = await prepareSave(await singlePageSession(bytes), [assetFor(ASSET_ID, bytes)], nodeDigest)

        expect(prepared.assets.get(ASSET_ID)?.contentHash).toBe(await sha256Hex(bytes))
        expect(prepared.assets.get(ASSET_ID)?.bytes.byteLength).toBe(LIMITS.imageBytes)
    })

    it('copies accepted bytes so a later caller mutation cannot change the persisted value', async () => {
        const bytes = bytesFor('snapshot', 40)
        const expected = new Uint8Array(bytes)
        const session = await singlePageSession(bytes)
        const pending = prepareSave(session, [assetFor(ASSET_ID, bytes)], nodeDigest)

        bytes[0] = ((bytes[0] ?? 0) + 1) % 256

        const prepared = await pending

        expect(prepared.assets.get(ASSET_ID)?.bytes).toEqual(expected)
    })

    it('accepts a demo manual without bytes because its page is synthetic', async () => {
        const prepared = await prepareSave(createDemoManual(), [], nodeDigest)

        expect(prepared.assets.size).toBe(0)
    })
})

describe('synthetic page identity', () => {
    it('recognises only the exact code-defined demo page', async () => {
        const demo = createDemoManual()
        const page = demo.pages[0]

        if (page === undefined) {
            throw new Error('demo fixture has no page')
        }

        expect(isSyntheticPage(demo.manualId, page)).toBe(true)
        expect(isSyntheticPage('other-manual', page)).toBe(false)
        expect(isSyntheticPage(demo.manualId, { ...page, contentHash: await sha256Hex(bytesFor('x', 4)) })).toBe(false)
    })
})

describe('digests and stored byte verification', () => {
    it('matches the standard SHA-256 known-answer vectors for empty and "abc" input', async () => {
        const abc = new TextEncoder().encode('abc')

        expect(await sha256Hex(new Uint8Array(0))).toBe(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        )
        expect(await sha256Hex(abc)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
        expect(digestToHex(new Uint8Array(0).buffer)).toBe('')
    })

    it('returns a detached copy when stored bytes still match their metadata', async () => {
        const bytes = bytesFor('stored', 24)
        const verified = await verifyStoredBytes(
            bytes,
            { byteLength: bytes.byteLength, contentHash: await sha256Hex(bytes) },
            nodeDigest,
        )

        expect(verified).toEqual(bytes)
        expect(verified.buffer).not.toBe(bytes.buffer)
    })

    it('fails closed as corruption when stored bytes do not match their metadata', async () => {
        const bytes = bytesFor('stored', 24)
        const otherHash = await sha256Hex(bytesFor('other', 24))

        await expectStorageError(
            verifyStoredBytes(bytes, { byteLength: bytes.byteLength, contentHash: otherHash }, nodeDigest),
            'corrupt',
        )
    })

    it('uses the injected digest rather than a fixed algorithm', async () => {
        const constant: ContentDigest = async (): Promise<string> => 'f'.repeat(64)
        const bytes = bytesFor('injected', 8)

        await expectStorageError(
            verifyStoredBytes(bytes, { byteLength: bytes.byteLength, contentHash: await sha256Hex(bytes) }, constant),
            'corrupt',
        )
    })
})
