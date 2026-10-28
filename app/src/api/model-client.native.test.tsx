/// <reference types="node" />

import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type * as NodeFS from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodePath from 'node:path'
import type * as NodeURL from 'node:url'
import type { ManualBinding, ManualPage } from '@truebuild/contracts'
import { ModelApiClient, type ImageBytes, type ModelFetch } from './model-client'

// Only the native filesystem bridge and UUID source are replaced. Files are written/read/deleted on disk.
// The client, buildForm, native append, RN FormData, Expo patch, and Expo converter all execute their real code.
let mockCacheDirectory: string
let mockFailSecondRead = false

jest.mock('expo-file-system', () => {
    const fs = jest.requireActual<typeof NodeFS>('node:fs')
    const path = jest.requireActual<typeof NodePath>('node:path')
    const url = jest.requireActual<typeof NodeURL>('node:url')
    return {
        Paths: {
            get cache(): string {
                return mockCacheDirectory
            },
        },
        File: class {
            readonly uri: string
            private readonly path: string

            constructor(directory: string, filename: string) {
                this.path = path.join(directory, filename)
                this.uri = url.pathToFileURL(this.path).href
            }

            writeSync(bytes: Uint8Array): void {
                fs.writeFileSync(this.path, bytes)
            }

            async bytes(): Promise<Uint8Array> {
                if (mockFailSecondRead && this.path.endsWith('source-1.png')) {
                    throw new Error('Test cache read failed')
                }
                return new Uint8Array(await fs.promises.readFile(this.path))
            }

            delete(): void {
                fs.unlinkSync(this.path)
            }
        },
    }
})
jest.mock('expo-crypto', () => ({ randomUUID: (): string => '00000000-0000-4000-8000-000000000000' }))
jest.mock('./multipart-image', () => jest.requireActual('./multipart-image.native'))

const NativeFormData = jest.requireActual<{ default: typeof FormData }>(
    'react-native/Libraries/Network/FormData',
).default
const { installFormDataPatch } = jest.requireActual<{
    installFormDataPatch: (constructor: typeof FormData) => typeof FormData
}>('expo/src/winter/FormData')
const { convertFormDataAsync } = jest.requireActual<{
    convertFormDataAsync: (form: FormData, boundary: string) => Promise<{ body: Uint8Array; boundary: string }>
}>('expo/src/winter/fetch/convertFormData')

const originalFormData = globalThis.FormData
const boundary = '----TrueBuildNativeRegression'
const binding: ManualBinding = { kind: 'manual', manualId: 'native-manual', revision: 1 }
const requestId = 'native-parse'
const images: ImageBytes[] = [
    { bytes: new Uint8Array([0, 127, 128, 255]), mimeType: 'image/jpeg', width: 4, height: 3 },
    { bytes: new Uint8Array([137, 80, 0, 254]), mimeType: 'image/png', width: 3, height: 4 },
    { bytes: new Uint8Array([82, 73, 0, 253]), mimeType: 'image/webp', width: 4, height: 3 },
]
const filenames = ['source-0.jpg', 'source-1.png', 'source-2.webp']
const pages: ManualPage[] = images.map((image, index) => ({
    pageId: `page-${index}`,
    assetId: `asset-${index}`,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    contentHash: createHash('sha256').update(image.bytes).digest('hex'),
}))

beforeAll(() => {
    mockCacheDirectory = mkdtempSync(join(tmpdir(), 'truebuild-native-multipart-'))
    globalThis.FormData = installFormDataPatch(NativeFormData)
})
beforeEach(() => {
    mockFailSecondRead = false
    jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
    jest.restoreAllMocks()
    for (const name of readdirSync(mockCacheDirectory)) rmSync(join(mockCacheDirectory, name))
})
afterAll(() => {
    globalThis.FormData = originalFormData
    rmSync(mockCacheDirectory, { recursive: true })
})

function expectedBody(): Uint8Array {
    const metadata = JSON.stringify({ mode: 'model', requestId, binding, pages })
    const chunks: (string | Uint8Array)[] = [
        `--${boundary}\r\ncontent-disposition: form-data; name="metadata"\r\n\r\n${metadata}\r\n`,
    ]
    images.forEach((image, index) => {
        chunks.push(
            `--${boundary}\r\ncontent-disposition: form-data; name="source-${index}"; filename="${filenames[index]}"\r\ncontent-type: ${image.mimeType}\r\n\r\n`,
            image.bytes,
            '\r\n',
        )
    })
    chunks.push(`--${boundary}--\r\n`)
    return new Uint8Array(
        chunks.flatMap((chunk) => Array.from(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)),
    )
}

describe('native parse multipart with the installed Expo converter', () => {
    it('serializes metadata and every image with the original bytes, wire filename, and MIME type', async () => {
        let serialized: Awaited<ReturnType<typeof convertFormDataAsync>> | undefined
        let conversionError: unknown
        const fetch: ModelFetch = async (_url, init): Promise<Response> => {
            try {
                serialized = await convertFormDataAsync(init.body as FormData, boundary)
            } catch (error: unknown) {
                conversionError = error
                throw error
            }
            // Response delivery is a local fixture; this test makes no network/model call or accuracy claim.
            return new Response(
                JSON.stringify({
                    status: 'ok',
                    mode: 'model',
                    requestId,
                    binding,
                    value: { parts: [], steps: [], unknowns: [] },
                }),
                { status: 200 },
            )
        }
        const client = new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', secret: 'public-test-only', fetch })

        const result = await client.parse(binding, pages, images, { requestId })

        expect(conversionError).toBeUndefined()
        expect(serialized?.boundary).toBe(boundary)
        expect(serialized?.body).toEqual(expectedBody())
        expect(result.status).toBe('ok')
        expect(readdirSync(mockCacheDirectory)).toEqual([])
    })

    it('removes every temporary image if an asynchronous file read fails during conversion', async () => {
        mockFailSecondRead = true
        let conversionError: unknown
        const fetch: ModelFetch = async (_url, init): Promise<Response> => {
            try {
                await convertFormDataAsync(init.body as FormData, boundary)
            } catch (error: unknown) {
                conversionError = error
                throw error
            }
            throw new Error('The second image should fail to read')
        }
        const client = new ModelApiClient({ baseUrl: 'http://127.0.0.1:3001', secret: 'public-test-only', fetch })

        const result = await client.parse(binding, pages, images, { requestId })

        expect(conversionError).toEqual(new Error('Test cache read failed'))
        expect(result).toMatchObject({ status: 'unavailable', code: 'provider_error' })
        expect(readdirSync(mockCacheDirectory)).toEqual([])
    })
})
