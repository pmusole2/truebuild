import * as ImagePicker from 'expo-image-picker'
import { ImageManipulator } from 'expo-image-manipulator'
import { LIMITS } from '@truebuild/contracts'
import { IMPORT_MESSAGES, ImportRejectedError, userMessageForImportError } from './import-errors'
import { pickAndNormalizePages } from './import-pages'

jest.mock('expo-image-picker', () => ({
    launchImageLibraryAsync: jest.fn(),
}))

jest.mock('expo-image-manipulator', () => ({
    ImageManipulator: { manipulate: jest.fn() },
    SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}))

jest.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: jest.fn(async (): Promise<ArrayBuffer> => new ArrayBuffer(32)),
    randomUUID: (): string => 'test-uuid',
}))

const launch = jest.mocked(ImagePicker.launchImageLibraryAsync)
const manipulate = jest.mocked(ImageManipulator.manipulate)

function pngBytes(width: number, height: number): Uint8Array {
    const u32 = (value: number): number[] => [
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
    ]
    return new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0,
        0,
        0,
        13,
        0x49,
        0x48,
        0x44,
        0x52,
        ...u32(width),
        ...u32(height),
        8,
        6,
        0,
        0,
        0,
    ])
}

function pickerAsset(
    uri: string,
    extra: { width?: number; height?: number; fileSize?: number } = {},
): ImagePicker.ImagePickerAsset {
    return { uri, width: extra.width ?? 0, height: extra.height ?? 0, fileSize: extra.fileSize }
}

function pickerResult(assets: ImagePicker.ImagePickerAsset[]): ImagePicker.ImagePickerResult {
    return { canceled: false, assets }
}

// Fake the platform fetch: source reads and normalized output reads both go through here.
function respondWith(bytes: Uint8Array): void {
    // Copy into an ArrayBuffer-backed view so Response accepts it.
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(copy))
}

function renderedOutput(width: number, height: number): void {
    manipulate.mockReturnValue({
        renderAsync: async () => ({
            saveAsync: async (): Promise<{ uri: string; width: number; height: number }> => ({
                uri: 'file:///normalized.jpg',
                width,
                height,
            }),
        }),
    } as unknown as ReturnType<typeof ImageManipulator.manipulate>)
}

async function failureOf(run: () => Promise<unknown>): Promise<string | null> {
    try {
        await run()
        return null
    } catch (error: unknown) {
        return error instanceof ImportRejectedError ? error.failure : 'other'
    }
}

beforeEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
})

describe('pickAndNormalizePages gates', () => {
    it('rejects an unsupported original with missing picker metadata before the manipulator runs', async () => {
        launch.mockResolvedValue(pickerResult([pickerAsset('file:///page.gif')]))
        const gif = new TextEncoder().encode('GIF89a' + '\0'.repeat(40))
        respondWith(gif)

        expect(await failureOf(pickAndNormalizePages)).toBe('unsupported')
        expect(manipulate).not.toHaveBeenCalled()
    })

    it('rejects actual oversize bytes when picker metadata is missing, before any decode', async () => {
        launch.mockResolvedValue(pickerResult([pickerAsset('file:///huge.png')]))
        respondWith(new Uint8Array(LIMITS.imageBytes + 1))

        expect(await failureOf(pickAndNormalizePages)).toBe('oversize')
        expect(manipulate).not.toHaveBeenCalled()
    })

    it('rejects a declared oversize file without reading it', async () => {
        const fetchSpy = jest.spyOn(globalThis, 'fetch')
        launch.mockResolvedValue(pickerResult([pickerAsset('file:///big.jpg', { fileSize: LIMITS.imageBytes + 1 })]))

        expect(await failureOf(pickAndNormalizePages)).toBe('oversize')
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(manipulate).not.toHaveBeenCalled()
    })

    it('rejects a pixel count above the limit from the header alone when metadata is missing', async () => {
        launch.mockResolvedValue(pickerResult([pickerAsset('file:///wide.png')]))
        respondWith(pngBytes(60000, 60000))

        expect(await failureOf(pickAndNormalizePages)).toBe('pixels')
        expect(manipulate).not.toHaveBeenCalled()
    })

    it('rejects more than the page limit before reading any image', async () => {
        const assets = Array.from({ length: LIMITS.manualPages + 1 }, (_value, index) =>
            pickerAsset(`file:///${index}.png`),
        )
        launch.mockResolvedValue(pickerResult(assets))
        const fetchSpy = jest.spyOn(globalThis, 'fetch')

        expect(await failureOf(pickAndNormalizePages)).toBe('pageCount')
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('returns null when the user cancels', async () => {
        launch.mockResolvedValue({ canceled: true, assets: null })
        expect(await pickAndNormalizePages()).toBeNull()
    })
})

describe('pickAndNormalizePages success and output checks', () => {
    it('normalizes a valid PNG into a JPEG page with a content hash and stored bytes', async () => {
        launch.mockResolvedValue(pickerResult([pickerAsset('file:///page.png')]))
        respondWith(pngBytes(100, 50))
        renderedOutput(100, 50)
        respondWith(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))

        const imported = await pickAndNormalizePages()

        expect(imported).toHaveLength(1)
        const [item] = imported ?? []
        expect(item?.page).toEqual({
            pageId: 'page-test-uuid',
            assetId: 'asset-test-uuid',
            width: 100,
            height: 50,
            mimeType: 'image/jpeg',
            contentHash: '0'.repeat(64),
        })
        expect(item?.asset.bytes).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    })

    it('rejects normalized output above the pixel limit and keeps nothing', async () => {
        launch.mockResolvedValue(pickerResult([pickerAsset('file:///page.png')]))
        respondWith(pngBytes(100, 50))
        renderedOutput(6000, 5000)
        respondWith(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))

        expect(await failureOf(pickAndNormalizePages)).toBe('pixels')
    })
})

describe('user-facing import messages', () => {
    it('never exposes a raw platform message', () => {
        expect(userMessageForImportError(new Error('/Users/private/secret.png failed'))).toBe(IMPORT_MESSAGES.generic)
    })

    it('shows the fixed text for our own rejections', () => {
        expect(userMessageForImportError(new ImportRejectedError('unsupported'))).toBe(IMPORT_MESSAGES.unsupported)
    })
})
